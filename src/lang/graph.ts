// Graph IR — flat-with-pointers representation of a safescript fn body.
//
// Each Dag is an immutable flat array of nodes plus a flat list of effects.
// Nodes reference each other and parent params by index (NodeId). Calls into
// other user fns or fn-valued args become `dagvalue` nodes that hold a Dag
// pointer; the executor recurses into a separate flat Dag when invoking.
//
// `buildDag` lowers an FnDef into a Dag, recursing into callees through a
// shared cache so each user fn produces exactly one Dag per (fn, replacementSet)
// rewrite. `overrideDag` performs the rebinding rewrite that `override(...)`
// expressions produce: it walks the target's flat node list, swapping op
// labels and dagvalue references whose label matches a replacement, and
// recurses into referenced Dags so transitive replacement works.

import type { BinaryOp, FnDef, Param, Statement, TypeExpr, Value } from "./ast.ts";

export type NodeId = number;

export type GraphNode =
  | { readonly kind: "param"; readonly name: string }
  // Read of a local variable bound by an `assign` effect. Resolved at runtime
  // through the executor's env. Can't be cached at the NodeId level because
  // its value depends on which assignments have run by the time it's read.
  | { readonly kind: "var_read"; readonly name: string }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly elements: readonly NodeId[] }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  }
  | { readonly kind: "field"; readonly base: NodeId; readonly field: string }
  | { readonly kind: "index"; readonly base: NodeId; readonly index: NodeId }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: NodeId; readonly right: NodeId }
  | { readonly kind: "unary"; readonly op: "-" | "!"; readonly operand: NodeId }
  | { readonly kind: "ternary"; readonly cond: NodeId; readonly then: NodeId; readonly else: NodeId }
  // Builtin op application. `staticArgs` are literal-only fields per the op's
  // registry entry; `args` are dynamic NodeIds.
  | {
    readonly kind: "op";
    readonly label: string;
    readonly staticArgs: ReadonlyArray<{ readonly key: string; readonly value: string | number | boolean }>;
    readonly args: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  }
  // User-fn invocation. If `dag` is set, execute that Dag directly (used when
  // the call site was built under an active override rewrite, so the callee
  // body must use the rewritten Dag rather than the registry's clean one).
  // If `dag` is null, dispatch by `label` through the executor's compose
  // registry (the standard top-level path).
  | {
    readonly kind: "compose";
    readonly label: string;
    readonly dag: Dag | null;
    readonly args: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  }
  // A first-class Dag value (produced by override(...)). Carries the inner
  // Dag plus its declared label for static analysis and override matching.
  | { readonly kind: "dagvalue"; readonly label: string; readonly dag: Dag }
  // Runtime invocation of a Dag-valued node. The `fn` node must evaluate to
  // a Dag at execution time (e.g. a `dagvalue` node, or a `var_read` of a
  // local that was assigned a Dag). The executor evaluates `fn`, then runs
  // executeDag on it with the resolved args. This is how locals bound to
  // override(...) results get invoked: `f = override(...); f(x)`.
  | {
    readonly kind: "apply";
    readonly fn: NodeId;
    readonly args: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  };

export type EffectNode =
  | { readonly kind: "assign"; readonly name: string; readonly value: NodeId }
  | {
    readonly kind: "void_op";
    readonly label: string;
    readonly staticArgs: ReadonlyArray<{ readonly key: string; readonly value: string | number | boolean }>;
    readonly args: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  }
  | {
    readonly kind: "void_compose";
    readonly label: string;
    readonly dag: Dag | null;
    readonly args: ReadonlyArray<{ readonly key: string; readonly value: NodeId }>;
  }
  | {
    readonly kind: "if_else";
    readonly cond: NodeId;
    readonly then: readonly EffectNode[];
    readonly else: readonly EffectNode[] | null;
  };

export type Dag = {
  readonly label: string;            // user-fn name (or synthesized for overrides)
  readonly params: readonly Param[];
  readonly returnType: TypeExpr | null;
  readonly nodes: readonly GraphNode[];
  readonly effects: readonly EffectNode[];
  readonly output: NodeId;
};

export type FnMap = ReadonlyMap<string, FnDef>;

// Replacement table for an override: maps op-label or fn-name → user fn name.
export type Replacements = ReadonlyMap<string, string>;

// Cache key for buildDag: a fn name plus a stable serialization of the active
// replacements. Same fn+replacements → same Dag instance (memoized).
type BuildCache = Map<string, Dag>;

const replacementsKey = (r: Replacements): string =>
  [...r.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join(",");

// Mutable builder used while lowering a single fn. After build it's frozen
// into a Dag.
type Builder = {
  nodes: GraphNode[];
  effects: EffectNode[];
  // Local var name → NodeId. Variables are SSA-ish: an assignment binds the
  // name to a NodeId for subsequent reads. Reassignment shadows.
  scope: Map<string, NodeId>;
};

const newBuilder = (): Builder => ({
  nodes: [],
  effects: [],
  scope: new Map(),
});

const addNode = (b: Builder, n: GraphNode): NodeId => {
  b.nodes.push(n);
  return b.nodes.length - 1;
};

// When a callee is invoked from inside an override rewrite (reps non-empty),
// we eagerly build the callee's Dag with the same replacements and embed it
// inline so transitive rewriting reaches into it. At top level (reps empty)
// we leave dispatch to the executor's compose registry.
const inlineDagFor = (
  fnName: string,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
): Dag | null => {
  if (reps.size === 0) return null;
  const fn = fns.get(fnName);
  if (!fn) return null;
  return buildDag(fn, fns, reps, cache);
};

const buildValue = (
  v: Value,
  b: Builder,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
): NodeId => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
      return addNode(b, { kind: "literal", value: v.value });
    case "reference": {
      const nid = b.scope.get(v.name);
      if (nid !== undefined) {
        // Param NodeId (params are pre-seeded with stable NodeIds).
        return nid;
      }
      // User-fn name used as a value (e.g. `map(hashIt, xs)`): materialize
      // a Dag value. Override may rebind this name to another fn.
      const fnName = reps.get(v.name) ?? v.name;
      const fn = fns.get(fnName);
      if (fn) {
        const innerDag = buildDag(fn, fns, reps, cache);
        return addNode(b, { kind: "dagvalue", label: fnName, dag: innerDag });
      }
      // Local variable — read goes through the runtime env.
      return addNode(b, { kind: "var_read", name: v.name });
    }
    case "dot_access": {
      const base = buildValue(v.base, b, fns, reps, cache);
      return addNode(b, { kind: "field", base, field: v.field });
    }
    case "index_access": {
      const base = buildValue(v.base, b, fns, reps, cache);
      const index = buildValue(v.index, b, fns, reps, cache);
      return addNode(b, { kind: "index", base, index });
    }
    case "array": {
      const elements = v.elements.map((e) => buildValue(e, b, fns, reps, cache));
      return addNode(b, { kind: "array", elements });
    }
    case "object": {
      const fields = v.fields.map((f) => ({
        key: f.key,
        value: buildValue(f.value, b, fns, reps, cache),
      }));
      return addNode(b, { kind: "object", fields });
    }
    case "binary_op": {
      const left = buildValue(v.left, b, fns, reps, cache);
      const right = buildValue(v.right, b, fns, reps, cache);
      return addNode(b, { kind: "binary", op: v.op, left, right });
    }
    case "unary_op": {
      const operand = buildValue(v.operand, b, fns, reps, cache);
      return addNode(b, { kind: "unary", op: v.op, operand });
    }
    case "ternary": {
      const cond = buildValue(v.condition, b, fns, reps, cache);
      const then = buildValue(v.then, b, fns, reps, cache);
      const els = buildValue(v.else, b, fns, reps, cache);
      return addNode(b, { kind: "ternary", cond, then, else: els });
    }
    case "call": {
      // Builtin op (post-override remap). If the label is in `reps`, it's
      // being replaced by a user fn — emit a `compose` instead. Otherwise
      // emit a normal `op` node, splitting static literal args from dynamic.
      const remapped = reps.get(v.op);
      if (remapped !== undefined) {
        const args = v.args.map((a) => ({
          key: a.key,
          value: buildValue(a.value, b, fns, reps, cache),
        }));
        return addNode(b, {
          kind: "compose",
          label: remapped,
          dag: inlineDagFor(remapped, fns, reps, cache),
          args,
        });
      }
      const staticArgs: { key: string; value: string | number | boolean }[] = [];
      const args: { key: string; value: NodeId }[] = [];
      for (const a of v.args) {
        if (
          a.value.kind === "string" || a.value.kind === "number" ||
          a.value.kind === "boolean"
        ) {
          // Whether it's truly static depends on the registry; the executor
          // distinguishes. We over-include literals as staticArgs and let the
          // executor merge the appropriate ones.
          staticArgs.push({ key: a.key, value: a.value.value });
        } else {
          args.push({ key: a.key, value: buildValue(a.value, b, fns, reps, cache) });
        }
      }
      return addNode(b, { kind: "op", label: v.op, staticArgs, args });
    }
    case "user_call": {
      // Direct user-fn call. Override may rebind this name too.
      const remapped = reps.get(v.fn) ?? v.fn;
      // If the target isn't a known user-fn (e.g. import resolved via
      // resolveImports as an op), fall back to an op call.
      if (!fns.has(remapped)) {
        const staticArgs: { key: string; value: string | number | boolean }[] = [];
        const args: { key: string; value: NodeId }[] = [];
        for (const a of v.args) {
          if (
            a.value.kind === "string" || a.value.kind === "number" ||
            a.value.kind === "boolean"
          ) {
            staticArgs.push({ key: a.key, value: a.value.value });
          } else {
            args.push({ key: a.key, value: buildValue(a.value, b, fns, reps, cache) });
          }
        }
        return addNode(b, { kind: "op", label: remapped, staticArgs, args });
      }
      const args = v.args.map((a) => ({
        key: a.key,
        value: buildValue(a.value, b, fns, reps, cache),
      }));
      return addNode(b, {
        kind: "compose",
        label: remapped,
        dag: inlineDagFor(remapped, fns, reps, cache),
        args,
      });
    }
    case "map":
    case "filter": {
      // map(fnExpr, arr) — fn is an arbitrary expression that must produce
      // a Dag value at build time. Currently we resolve at build time
      // (no runtime first-class fn dispatch through map yet): the fn must
      // be a `reference` to a user-fn, a `user_call` returning a fn (rare),
      // or an `override(...)` expression. We evaluate by lowering: if the
      // expression lowers to a `dagvalue` node, we use its Dag.
      const fnNode = buildValue(v.fn, b, fns, reps, cache);
      const arrNode = buildValue(v.array, b, fns, reps, cache);
      return addNode(b, {
        kind: "op",
        label: v.kind === "map" ? "__map" : "__filter",
        staticArgs: [],
        args: [
          { key: "fn", value: fnNode },
          { key: "array", value: arrNode },
        ],
      });
    }
    case "reduce": {
      const fnNode = buildValue(v.fn, b, fns, reps, cache);
      const initNode = buildValue(v.initial, b, fns, reps, cache);
      const arrNode = buildValue(v.array, b, fns, reps, cache);
      return addNode(b, {
        kind: "op",
        label: "__reduce",
        staticArgs: [],
        args: [
          { key: "fn", value: fnNode },
          { key: "initial", value: initNode },
          { key: "array", value: arrNode },
        ],
      });
    }
    case "override": {
      // override(target, {k: v, ...}) — produce a Dag value. The rewrite is
      // composition with the *current* replacements (so nested overrides
      // accumulate). Self-reference is rejected at the parser, so we don't
      // re-check here.
      const targetFn = fns.get(v.target);
      if (!targetFn) {
        throw new Error(`override target '${v.target}' is not a user function`);
      }
      // Compose: outer replacements first, then inner ones (inner wins for
      // identical keys).
      const merged = new Map<string, string>(reps);
      for (const r of v.replacements) {
        if (!fns.has(r.value)) {
          throw new Error(
            `override replacement '${r.value}' is not a user function`,
          );
        }
        merged.set(r.key, r.value);
      }
      const innerDag = buildDag(targetFn, fns, merged, cache);
      return addNode(b, { kind: "dagvalue", label: v.target, dag: innerDag });
    }
    case "dag_call": {
      // Generic Dag invocation: lower fn-Value to a node, lower args, emit an
      // `apply` node. Works for override(...) (whose lowering yields a
      // dagvalue node), bare references to locals bound to a Dag, or any
      // other expression that produces a Dag at runtime.
      const fnNode = buildValue(v.fn, b, fns, reps, cache);
      const args = v.args.map((a) => ({
        key: a.key,
        value: buildValue(a.value, b, fns, reps, cache),
      }));
      return addNode(b, { kind: "apply", fn: fnNode, args });
    }
  }
};

const buildStatements = (
  stmts: readonly Statement[],
  b: Builder,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
  effects: EffectNode[],
): void => {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        const nid = buildValue(stmt.value, b, fns, reps, cache);
        effects.push({ kind: "assign", name: stmt.name, value: nid });
        break;
      }
      case "return":
        break;
      case "void_call": {
        const remapped = reps.get(stmt.call.op);
        if (remapped !== undefined) {
          const args = stmt.call.args.map((a) => ({
            key: a.key,
            value: buildValue(a.value, b, fns, reps, cache),
          }));
          effects.push({
            kind: "void_compose",
            label: remapped,
            dag: inlineDagFor(remapped, fns, reps, cache),
            args,
          });
        } else {
          const staticArgs: { key: string; value: string | number | boolean }[] = [];
          const args: { key: string; value: NodeId }[] = [];
          for (const a of stmt.call.args) {
            if (
              a.value.kind === "string" || a.value.kind === "number" ||
              a.value.kind === "boolean"
            ) {
              staticArgs.push({ key: a.key, value: a.value.value });
            } else {
              args.push({
                key: a.key,
                value: buildValue(a.value, b, fns, reps, cache),
              });
            }
          }
          effects.push({
            kind: "void_op",
            label: stmt.call.op,
            staticArgs,
            args,
          });
        }
        break;
      }
      case "user_void_call": {
        const remapped = reps.get(stmt.fn) ?? stmt.fn;
        const args = stmt.args.map((a) => ({
          key: a.key,
          value: buildValue(a.value, b, fns, reps, cache),
        }));
        effects.push({
          kind: "void_compose",
          label: remapped,
          dag: inlineDagFor(remapped, fns, reps, cache),
          args,
        });
        break;
      }
      case "if_else": {
        const cond = buildValue(stmt.condition, b, fns, reps, cache);
        const thenE: EffectNode[] = [];
        buildStatements(stmt.then, b, fns, reps, cache, thenE);
        let elsE: EffectNode[] | null = null;
        if (stmt.else) {
          elsE = [];
          buildStatements(stmt.else, b, fns, reps, cache, elsE);
        }
        effects.push({ kind: "if_else", cond, then: thenE, else: elsE });
        break;
      }
    }
  }
};

export const buildDag = (
  fn: FnDef,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
): Dag => {
  const key = `${fn.name}|${replacementsKey(reps)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const b = newBuilder();
  // Seed param NodeIds.
  for (const p of fn.params) {
    const nid = addNode(b, { kind: "param", name: p.name });
    b.scope.set(p.name, nid);
  }
  // Pre-insert into cache before recursing to break cycles. It's a placeholder
  // until we finalize; cycles in user-fn graphs are rejected by the parser
  // (`checkFnCallCycles`) so this guard is defensive only.
  const placeholder: Dag = {
    label: fn.name,
    params: fn.params,
    returnType: fn.returnType,
    nodes: [],
    effects: [],
    output: 0,
  };
  cache.set(key, placeholder);
  const effects: EffectNode[] = [];
  buildStatements(fn.body, b, fns, reps, cache, effects);
  const output = buildValue(fn.returnValue, b, fns, reps, cache);
  const dag: Dag = {
    label: fn.name,
    params: fn.params,
    returnType: fn.returnType,
    nodes: b.nodes,
    effects,
    output,
  };
  cache.set(key, dag);
  return dag;
};

export const buildEntryDag = (entry: FnDef, fns: FnMap): Dag =>
  buildDag(entry, fns, new Map(), new Map());

// Convenience — build a Dag for a fn with a given replacement set, fresh cache.
export const buildOverrideDag = (
  target: FnDef,
  fns: FnMap,
  reps: Replacements,
): Dag => buildDag(target, fns, reps, new Map());
