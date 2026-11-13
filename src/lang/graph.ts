// Graph IR — flat-with-pointers representation of a safescript fn body.
//
// Each Dag is an immutable flat array of nodes plus a flat list of effects.
// Nodes reference each other and parent params by index (NodeId). Calls into
// other user fns or fn-valued args become `dagvalue` nodes that hold a Dag
// pointer; the executor recurses into a separate flat Dag when invoking.

import type {
  BinaryOp,
  FnDef,
  Param,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";
import { validateUserIdentifier } from "./parser.ts";

export type NodeId = number;

export type GraphNode =
  | { readonly kind: "param"; readonly name: string }
  | { readonly kind: "var_read"; readonly name: string }
  | {
    readonly kind: "literal";
    readonly value: string | number | boolean | null | undefined;
  }
  | { readonly kind: "array"; readonly elements: readonly NodeId[] }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  }
  | { readonly kind: "field"; readonly base: NodeId; readonly field: string }
  | { readonly kind: "index"; readonly base: NodeId; readonly index: NodeId }
  | {
    readonly kind: "binary";
    readonly op: BinaryOp;
    readonly left: NodeId;
    readonly right: NodeId;
  }
  | { readonly kind: "unary"; readonly op: "-" | "!"; readonly operand: NodeId }
  | {
    readonly kind: "ternary";
    readonly cond: NodeId;
    readonly then: NodeId;
    readonly else: NodeId;
  }
  | {
    readonly kind: "op";
    readonly label: string;
    readonly staticArgs: ReadonlyArray<
      { readonly key: string; readonly value: string | number | boolean }
    >;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  }
  | {
    readonly kind: "compose";
    readonly label: string;
    readonly dag: Dag | null;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  }
  | { readonly kind: "dagvalue"; readonly label: string; readonly dag: Dag }
  | {
    readonly kind: "apply";
    readonly fn: NodeId;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  };

export type EffectNode =
  | { readonly kind: "assign"; readonly name: string; readonly value: NodeId }
  | {
    readonly kind: "void_op";
    readonly label: string;
    readonly staticArgs: ReadonlyArray<
      { readonly key: string; readonly value: string | number | boolean }
    >;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  }
  | {
    readonly kind: "void_compose";
    readonly label: string;
    readonly dag: Dag | null;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: NodeId }
    >;
  }
  | {
    readonly kind: "if_else";
    readonly cond: NodeId;
    readonly then: readonly EffectNode[];
    readonly else: readonly EffectNode[] | null;
  };

export type Dag = {
  readonly label: string;
  readonly params: readonly Param[];
  readonly returnType: TypeExpr | null;
  readonly nodes: readonly GraphNode[];
  readonly effects: readonly EffectNode[];
  readonly output: NodeId;
};

// Module-private brand set: only Dag objects constructed by buildDag are
// admitted by executeDag / apply / __map / __filter / __reduce / evalCompose.
// Prevents user-constructed plain objects with `{ nodes: [...] }` from being
// executed as forged Graph IR.
const genuineDags = new WeakSet<Dag>();

export const isGenuineDag = (value: unknown): value is Dag =>
  typeof value === "object" && value !== null && genuineDags.has(value as Dag);

export type FnMap = ReadonlyMap<string, FnDef>;
export type Replacements = ReadonlyMap<string, string>;
type BuildCache = Map<string, Dag>;

const replacementsKey = (r: Replacements): string =>
  [...r.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`).join(",");

type Builder = {
  nodes: GraphNode[];
  effects: EffectNode[];
  // Parameter name → stable param NodeId.
  scope: Map<string, NodeId>;
  // Local variable names assigned in the current function body.
  locals: Set<string>;
};

const newBuilder = (): Builder => ({
  nodes: [],
  effects: [],
  scope: new Map(),
  locals: new Set(),
});

const addNode = (b: Builder, n: GraphNode): NodeId => {
  b.nodes.push(n);
  return b.nodes.length - 1;
};

const inlineDagFor = (
  fnName: string,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
  building: Set<string>,
): Dag | null => {
  if (reps.size === 0) return null;
  const fn = fns.get(fnName);
  if (!fn) return null;
  return buildDagInternal(fn, fns, reps, cache, building);
};

const buildValue = (
  v: Value,
  b: Builder,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
  building: Set<string>,
): NodeId => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
      return addNode(b, { kind: "literal", value: v.value });
    case "null":
      return addNode(b, { kind: "literal", value: null });
    case "undefined":
      return addNode(b, { kind: "literal", value: undefined });
    case "reference": {
      validateUserIdentifier(v.name, "reference", undefined, true);
      const nid = b.scope.get(v.name);
      if (nid !== undefined) {
        return nid;
      }
      if (b.locals.has(v.name)) {
        return addNode(b, { kind: "var_read", name: v.name });
      }
      const fnName = reps.get(v.name) ?? v.name;
      const fn = fns.get(fnName);
      if (fn) {
        const innerDag = buildDagInternal(fn, fns, reps, cache, building);
        return addNode(b, { kind: "dagvalue", label: fnName, dag: innerDag });
      }
      throw new Error(`Undefined reference: '${v.name}'`);
    }
    case "dot_access": {
      const base = buildValue(v.base, b, fns, reps, cache, building);
      return addNode(b, { kind: "field", base, field: v.field });
    }
    case "index_access": {
      const base = buildValue(v.base, b, fns, reps, cache, building);
      const index = buildValue(v.index, b, fns, reps, cache, building);
      return addNode(b, { kind: "index", base, index });
    }
    case "array": {
      const elements = v.elements.map((e) =>
        buildValue(e, b, fns, reps, cache, building)
      );
      return addNode(b, { kind: "array", elements });
    }
    case "object": {
      const fields = v.fields.map((f) => {
        if (f.key.startsWith("__arg")) {
          throw new Error(
            `Reserved key '${f.key}' is not permitted in object literals`,
          );
        }
        return {
          key: f.key,
          value: buildValue(f.value, b, fns, reps, cache, building),
        };
      });
      return addNode(b, { kind: "object", fields });
    }
    case "binary_op": {
      const left = buildValue(v.left, b, fns, reps, cache, building);
      const right = buildValue(v.right, b, fns, reps, cache, building);
      return addNode(b, { kind: "binary", op: v.op, left, right });
    }
    case "unary_op": {
      const operand = buildValue(v.operand, b, fns, reps, cache, building);
      return addNode(b, { kind: "unary", op: v.op, operand });
    }
    case "ternary": {
      const cond = buildValue(v.condition, b, fns, reps, cache, building);
      const then = buildValue(v.then, b, fns, reps, cache, building);
      const els = buildValue(v.else, b, fns, reps, cache, building);
      return addNode(b, { kind: "ternary", cond, then, else: els });
    }
    case "call": {
      const remapped = reps.get(v.op);
      if (remapped !== undefined) {
        const args = v.args.map((a) => ({
          key: a.key,
          value: buildValue(a.value, b, fns, reps, cache, building),
        }));
        return addNode(b, {
          kind: "compose",
          label: remapped,
          dag: inlineDagFor(remapped, fns, reps, cache, building),
          args,
        });
      }
      const staticArgs: { key: string; value: string | number | boolean }[] =
        [];
      const args: { key: string; value: NodeId }[] = [];
      for (const a of v.args) {
        if (a.key.startsWith("__arg")) {
          throw new Error(
            `Reserved key '${a.key}' is not permitted in call arguments`,
          );
        }
        if (
          a.value.kind === "string" || a.value.kind === "number" ||
          a.value.kind === "boolean"
        ) {
          staticArgs.push({ key: a.key, value: a.value.value });
        } else {
          args.push({
            key: a.key,
            value: buildValue(a.value, b, fns, reps, cache, building),
          });
        }
      }
      return addNode(b, { kind: "op", label: v.op, staticArgs, args });
    }
    case "user_call": {
      const remapped = reps.get(v.fn) ?? v.fn;
      if (!fns.has(remapped)) {
        const staticArgs: { key: string; value: string | number | boolean }[] =
          [];
        const args: { key: string; value: NodeId }[] = [];
        for (const a of v.args) {
          if (a.key.startsWith("__arg")) {
            throw new Error(
              `Reserved key '${a.key}' is not permitted in call arguments`,
            );
          }
          if (
            a.value.kind === "string" || a.value.kind === "number" ||
            a.value.kind === "boolean"
          ) {
            staticArgs.push({ key: a.key, value: a.value.value });
          } else {
            args.push({
              key: a.key,
              value: buildValue(a.value, b, fns, reps, cache, building),
            });
          }
        }
        return addNode(b, { kind: "op", label: remapped, staticArgs, args });
      }
      const args = v.args.map((a) => {
        if (a.key.startsWith("__arg")) {
          throw new Error(
            `Reserved key '${a.key}' is not permitted in call arguments`,
          );
        }
        return {
          key: a.key,
          value: buildValue(a.value, b, fns, reps, cache, building),
        };
      });
      return addNode(b, {
        kind: "compose",
        label: remapped,
        dag: inlineDagFor(remapped, fns, reps, cache, building),
        args,
      });
    }
    case "map":
    case "filter": {
      const fnNode = buildValue(v.fn, b, fns, reps, cache, building);
      const arrNode = buildValue(v.array, b, fns, reps, cache, building);
      const capArgs = (v.captures ?? []).map((c) => ({
        key: `cap:${c.key}`,
        value: buildValue(c.value, b, fns, reps, cache, building),
      }));
      return addNode(b, {
        kind: "op",
        label: v.kind === "map" ? "__map" : "__filter",
        staticArgs: [],
        args: [
          { key: "fn", value: fnNode },
          { key: "array", value: arrNode },
          ...capArgs,
        ],
      });
    }
    case "reduce": {
      const fnNode = buildValue(v.fn, b, fns, reps, cache, building);
      const initNode = buildValue(v.initial, b, fns, reps, cache, building);
      const arrNode = buildValue(v.array, b, fns, reps, cache, building);
      const capArgs = (v.captures ?? []).map((c) => ({
        key: `cap:${c.key}`,
        value: buildValue(c.value, b, fns, reps, cache, building),
      }));
      return addNode(b, {
        kind: "op",
        label: "__reduce",
        staticArgs: [],
        args: [
          { key: "fn", value: fnNode },
          { key: "initial", value: initNode },
          { key: "array", value: arrNode },
          ...capArgs,
        ],
      });
    }
    case "override": {
      const targetFn = fns.get(v.target);
      if (!targetFn) {
        throw new Error(`override target '${v.target}' is not a user function`);
      }
      const merged = new Map<string, string>(reps);
      for (const r of v.replacements) {
        if (!fns.has(r.value)) {
          throw new Error(
            `override replacement '${r.value}' is not a user function`,
          );
        }
        if (r.value === v.target) {
          throw new Error(
            `override cannot self-reference target '${v.target}'`,
          );
        }
        merged.set(r.key, r.value);
      }
      const innerDag = buildDagInternal(targetFn, fns, merged, cache, building);
      return addNode(b, { kind: "dagvalue", label: v.target, dag: innerDag });
    }
    case "dag_call": {
      const fnNode = buildValue(v.fn, b, fns, reps, cache, building);
      const args = v.args.map((a) => {
        if (a.key.startsWith("__arg") && v.fn.kind !== "override") {
          throw new Error(
            `Reserved key '${a.key}' is not permitted in call arguments`,
          );
        }
        return {
          key: a.key,
          value: buildValue(a.value, b, fns, reps, cache, building),
        };
      });
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
  building: Set<string>,
): void => {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        validateUserIdentifier(stmt.name, "variable", undefined, true);
        if (b.scope.has(stmt.name)) {
          throw new Error(`Cannot reassign parameter '${stmt.name}'`);
        }
        if (fns.has(stmt.name)) {
          throw new Error(
            `Variable '${stmt.name}' cannot shadow function '${stmt.name}'`,
          );
        }
        const nid = buildValue(stmt.value, b, fns, reps, cache, building);
        b.locals.add(stmt.name);
        effects.push({ kind: "assign", name: stmt.name, value: nid });
        break;
      }
      case "return":
        break;
      case "void_call": {
        if (stmt.call.op === "doc") break;
        const remapped = reps.get(stmt.call.op);
        if (remapped !== undefined) {
          const args = stmt.call.args.map((a) => ({
            key: a.key,
            value: buildValue(a.value, b, fns, reps, cache, building),
          }));
          effects.push({
            kind: "void_compose",
            label: remapped,
            dag: inlineDagFor(remapped, fns, reps, cache, building),
            args,
          });
        } else {
          const staticArgs: {
            key: string;
            value: string | number | boolean;
          }[] = [];
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
                value: buildValue(a.value, b, fns, reps, cache, building),
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
          value: buildValue(a.value, b, fns, reps, cache, building),
        }));
        effects.push({
          kind: "void_compose",
          label: remapped,
          dag: inlineDagFor(remapped, fns, reps, cache, building),
          args,
        });
        break;
      }
      case "if_else": {
        const cond = buildValue(stmt.condition, b, fns, reps, cache, building);
        const preLocals = new Set(b.locals);
        const thenE: EffectNode[] = [];
        buildStatements(stmt.then, b, fns, reps, cache, thenE, building);
        const thenLocals = new Set(b.locals);
        b.locals = new Set(preLocals);
        const elsE = stmt.else
          ? (() => {
            const list: EffectNode[] = [];
            buildStatements(stmt.else, b, fns, reps, cache, list, building);
            return list;
          })()
          : null;
        for (const k of thenLocals) b.locals.add(k);
        effects.push({ kind: "if_else", cond, then: thenE, else: elsE });
        break;
      }
    }
  }
};

const buildDagInternal = (
  fn: FnDef,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
  building: Set<string>,
): Dag => {
  const key = `${fn.name}|${replacementsKey(reps)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (building.has(key)) {
    throw new Error(`Recursive function call cycle detected: '${fn.name}'`);
  }
  building.add(key);
  try {
    validateUserIdentifier(fn.name, "function", undefined, true);
    const b = newBuilder();
    for (const p of fn.params) {
      validateUserIdentifier(p.name, "parameter", undefined, true);
      if (b.scope.has(p.name)) {
        throw new Error(`Duplicate parameter '${p.name}' in '${fn.name}'`);
      }
      if (fns.has(p.name)) {
        throw new Error(
          `Parameter '${p.name}' in '${fn.name}' cannot shadow function '${p.name}'`,
        );
      }
      const nid = addNode(b, { kind: "param", name: p.name });
      b.scope.set(p.name, nid);
    }
    const effects: EffectNode[] = [];
    buildStatements(fn.body, b, fns, reps, cache, effects, building);
    const output = buildValue(fn.returnValue, b, fns, reps, cache, building);
    const dag: Dag = {
      label: fn.name,
      params: fn.params,
      returnType: fn.returnType,
      nodes: b.nodes,
      effects,
      output,
    };
    genuineDags.add(dag);
    cache.set(key, dag);
    return dag;
  } finally {
    building.delete(key);
  }
};

export const buildDag = (
  fn: FnDef,
  fns: FnMap,
  reps: Replacements,
  cache: BuildCache,
): Dag => buildDagInternal(fn, fns, reps, cache, new Set());

export const buildEntryDag = (entry: FnDef, fns: FnMap): Dag =>
  buildDag(entry, fns, new Map(), new Map());

export const buildOverrideDag = (
  target: FnDef,
  fns: FnMap,
  reps: Replacements,
): Dag => buildDag(target, fns, reps, new Map());
