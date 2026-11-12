import type {
  FnDef,
  Param,
  Program,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";
import type { LabelShape } from "../types.ts";
import type { OpEntry } from "./registry.ts";
import { builtinRegistry } from "./registry.ts";
import {
  add,
  type ComplexityExpr,
  type ComplexityTerm,
  constant,
  maxExpr,
  multiply,
  normalize,
  one,
  variable,
  zero,
} from "./complexity.ts";

// Sources are labeled strings describing where data originates:
//   "param:<name>"      — function parameter
//   "env:timestamp"     — non-deterministic time read
//   "env:randomBytes"   — non-deterministic randomness read
//   "host:<hostname>"   — data received from a network host
//
// Labels are the general mechanism behind sources: any opaque
// `kind:id` string (e.g. `owner:alice`, `viewer:bob`) declared by an
// op's manifest `emits` or by consumer policy. The analyzer never
// interprets a label — mixing is always set union, and meaning is
// assigned only by the policy checked at sinks
// (see checkSignatureAgainstRelation).

// Sinks in dataFlow:
//   "host:<hostname>"   — data sent to a network host
//   "return"            — data reaching the function return value

export type Signature = {
  readonly name: string;
  readonly params: readonly Param[];
  readonly returnType: TypeExpr | null;
  readonly hosts: ReadonlySet<string>;
  readonly envReads: ReadonlySet<string>;
  readonly dataFlow: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sources: ReadonlySet<string>;
  readonly memoryBytes: number;
  readonly runtimeMs: number;
  readonly diskBytes: number;
  readonly complexity: ComplexityExpr;
};

type ValueShape =
  | { readonly kind: "leaf"; readonly sources: ReadonlySet<string> }
  | {
    readonly kind: "record";
    readonly prefix: string;
    readonly extra: ReadonlySet<string>;
  }
  | {
    readonly kind: "array";
    readonly element: ValueShape;
    readonly extra: ReadonlySet<string>;
  }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyMap<string, ValueShape>;
    readonly fallback: ValueShape;
    readonly extra: ReadonlySet<string>;
  };

const emptyShape: ValueShape = { kind: "leaf", sources: new Set() };

const leafShape = (sources: ReadonlySet<string>): ValueShape => ({
  kind: "leaf",
  sources,
});

type AnalysisState = {
  readonly varSources: Map<string, ReadonlySet<string>>;
  readonly varShapes: Map<string, ValueShape>;
  readonly varSizes: Map<string, ComplexityExpr>;
  // For locals bound to Dag-producing expressions (reference to user fn,
  // override(...), or another local that resolves to one). Used to resolve
  // `dag_call` whose fn is a `reference` to a local. Last assignment wins.
  readonly varValues: Map<string, Value>;
  readonly hosts: Set<string>;
  readonly envReads: Set<string>;
  readonly dataFlow: Map<string, Set<string>>;
  memoryBytes: number;
  runtimeMs: number;
  diskBytes: number;
};

const unionSources = (
  ...sets: ReadonlySet<string>[]
): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const s of sets) for (const v of s) result.add(v);
  return result;
};

const collapseShape = (shape: ValueShape): ReadonlySet<string> => {
  switch (shape.kind) {
    case "leaf":
      return shape.sources;
    case "record":
      return unionSources(new Set([`${shape.prefix}.*`]), shape.extra);
    case "array":
      return unionSources(collapseShape(shape.element), shape.extra);
    case "object":
      return unionSources(
        shape.extra,
        collapseShape(shape.fallback),
        ...[...shape.fields.values()].map(collapseShape),
      );
  }
};

const addExtraToShape = (
  shape: ValueShape,
  extra: ReadonlySet<string>,
): ValueShape => {
  if (extra.size === 0) return shape;
  switch (shape.kind) {
    case "leaf":
      return leafShape(unionSources(shape.sources, extra));
    case "record":
    case "array":
    case "object":
      return { ...shape, extra: unionSources(shape.extra, extra) };
  }
};

const labelShapeToValueShape = (
  ls: LabelShape,
  extra: ReadonlySet<string>,
): ValueShape => {
  switch (ls.kind) {
    case "record":
      return { kind: "record", prefix: ls.prefix, extra };
    case "array":
      return {
        kind: "array",
        element: labelShapeToValueShape(ls.element, new Set()),
        extra,
      };
    case "object": {
      const fields = new Map(
        Object.entries(ls.fields).map(([k, v]) => [
          k,
          labelShapeToValueShape(v, new Set()),
        ]),
      );
      const allCollapsed = unionSources(
        ...[...fields.values()].map(collapseShape),
      );
      return {
        kind: "object",
        fields,
        fallback: leafShape(allCollapsed),
        extra,
      };
    }
  }
};

const isEmptyLeaf = (s: ValueShape): boolean =>
  s.kind === "leaf" && s.sources.size === 0;

const mergeShapes = (a: ValueShape, b: ValueShape): ValueShape => {
  if (isEmptyLeaf(a)) return b;
  if (isEmptyLeaf(b)) return a;
  if (a.kind === "leaf" && b.kind === "leaf") {
    return leafShape(unionSources(a.sources, b.sources));
  }
  if (a.kind === "record" && b.kind === "record" && a.prefix === b.prefix) {
    return {
      kind: "record",
      prefix: a.prefix,
      extra: unionSources(a.extra, b.extra),
    };
  }
  if (a.kind === "array" && b.kind === "array") {
    return {
      kind: "array",
      element: mergeShapes(a.element, b.element),
      extra: unionSources(a.extra, b.extra),
    };
  }
  if (a.kind === "object" && b.kind === "object") {
    const allKeys = new Set([...a.fields.keys(), ...b.fields.keys()]);
    return {
      kind: "object",
      fields: new Map(
        [...allKeys].map((k) => [
          k,
          mergeShapes(
            a.fields.get(k) ?? a.fallback,
            b.fields.get(k) ?? b.fallback,
          ),
        ]),
      ),
      fallback: mergeShapes(a.fallback, b.fallback),
      extra: unionSources(a.extra, b.extra),
    };
  }
  return leafShape(unionSources(collapseShape(a), collapseShape(b)));
};

const projectDotShape = (shape: ValueShape, field: string): ValueShape => {
  switch (shape.kind) {
    case "leaf":
      return shape;
    case "record":
      return leafShape(
        unionSources(new Set([`${shape.prefix}.${field}`]), shape.extra),
      );
    case "object": {
      const sub = shape.fields.get(field) ?? shape.fallback;
      return addExtraToShape(sub, shape.extra);
    }
    case "array":
      return leafShape(collapseShape(shape));
  }
};

const projectIndexShape = (
  shape: ValueShape,
  indexValue: Value,
  indexSources: ReadonlySet<string>,
): ValueShape => {
  switch (shape.kind) {
    case "array":
      return addExtraToShape(
        shape.element,
        unionSources(shape.extra, indexSources),
      );
    case "record":
      return indexValue.kind === "string"
        ? leafShape(
          unionSources(
            new Set([`${shape.prefix}.${indexValue.value}`]),
            shape.extra,
            indexSources,
          ),
        )
        : leafShape(unionSources(collapseShape(shape), indexSources));
    case "object":
      return indexValue.kind === "string"
        ? projectDotShape(
          addExtraToShape(shape, indexSources),
          indexValue.value,
        )
        : leafShape(unionSources(collapseShape(shape), indexSources));
    case "leaf":
      return leafShape(unionSources(shape.sources, indexSources));
  }
};

const elementShapeOf = (shape: ValueShape): ValueShape =>
  shape.kind === "array"
    ? addExtraToShape(shape.element, shape.extra)
    : leafShape(collapseShape(shape));

const addToSink = (
  state: AnalysisState,
  sink: string,
  sources: ReadonlySet<string>,
): void => {
  const existing = state.dataFlow.get(sink);
  if (existing) {
    for (const s of sources) existing.add(s);
  } else {
    state.dataFlow.set(sink, new Set(sources));
  }
};

// Substitute param:X sources with the actual sources for each parameter position.
const substituteSources = (
  sources: ReadonlySet<string>,
  params: readonly Param[],
  paramSources: ReadonlySet<string>[],
): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const s of sources) {
    const paramIdx = params.findIndex((p) => s === `param:${p.name}`);
    if (paramIdx >= 0 && paramIdx < paramSources.length) {
      for (const ps of paramSources[paramIdx]) result.add(ps);
    } else {
      result.add(s);
    }
  }
  return result;
};

// Substitute param:X size variables with the actual size expressions.
const substituteComplexity = (
  expr: ComplexityExpr,
  params: readonly Param[],
  paramSizes: ComplexityExpr[],
): ComplexityExpr => {
  const resultTerms: ComplexityTerm[] = [];
  for (const t of expr.terms) {
    let coeff = t.coeff;
    let substitutionExpr: ComplexityExpr = one;
    const remainingVars: string[] = [];
    for (const v of t.vars) {
      const paramIdx = params.findIndex((p) => v === `param:${p.name}`);
      if (paramIdx >= 0 && paramIdx < paramSizes.length) {
        substitutionExpr = multiply(substitutionExpr, paramSizes[paramIdx]);
      } else {
        remainingVars.push(v);
      }
    }
    for (const st of substitutionExpr.terms) {
      resultTerms.push({
        coeff: coeff * st.coeff,
        vars: [...remainingVars, ...st.vars].sort(),
      });
    }
  }
  return normalize({ terms: resultTerms });
};

const typeSizeVar = (paramName: string, type: TypeExpr): ComplexityExpr => {
  switch (type.kind) {
    case "primitive":
      return type.name === "string" ? variable(`param:${paramName}`) : one;
    case "array":
      return variable(`param:${paramName}`);
    case "object":
      return one;
  }
};

type ValueAnalysis = {
  readonly sources: ReadonlySet<string>;
  readonly shape: ValueShape;
  readonly size: ComplexityExpr;
  readonly complexity: ComplexityExpr;
};

const emptyAnalysis: ValueAnalysis = {
  sources: new Set(),
  shape: emptyShape,
  size: one,
  complexity: zero,
};

type FnMap = ReadonlyMap<string, FnDef>;

// Apply override replacements to a Value tree. `reps` maps either a builtin op
// label or a user-fn name to a replacement user-fn name. `call` (op) sites
// matching a key become `user_call`s to the replacement. `user_call` sites
// matching a key become `user_call`s to the replacement. Nested `user_call`s
// to non-replaced fns are left alone here; the caller is responsible for
// rebuilding callees transitively (so analysis recurses into rewritten copies).
const substituteValue = (
  v: Value,
  reps: ReadonlyMap<string, string>,
): Value => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "undefined":
    case "reference":
      return v;
    case "dot_access":
      return { ...v, base: substituteValue(v.base, reps) };
    case "index_access":
      return {
        ...v,
        base: substituteValue(v.base, reps),
        index: substituteValue(v.index, reps),
      };
    case "array":
      return {
        ...v,
        elements: v.elements.map((e) => substituteValue(e, reps)),
      };
    case "object":
      return {
        ...v,
        fields: v.fields.map((f) => ({
          key: f.key,
          value: substituteValue(f.value, reps),
        })),
      };
    case "binary_op":
      return {
        ...v,
        left: substituteValue(v.left, reps),
        right: substituteValue(v.right, reps),
      };
    case "unary_op":
      return { ...v, operand: substituteValue(v.operand, reps) };
    case "ternary":
      return {
        ...v,
        condition: substituteValue(v.condition, reps),
        then: substituteValue(v.then, reps),
        else: substituteValue(v.else, reps),
      };
    case "call": {
      const args = v.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps),
      }));
      const repl = reps.get(v.op);
      if (repl !== undefined) return { kind: "user_call", fn: repl, args };
      return { ...v, args };
    }
    case "user_call": {
      const args = v.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps),
      }));
      const repl = reps.get(v.fn);
      return { kind: "user_call", fn: repl ?? v.fn, args };
    }
    case "map":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        array: substituteValue(v.array, reps),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps),
            })),
          }
          : {}),
      };
    case "filter":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        array: substituteValue(v.array, reps),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps),
            })),
          }
          : {}),
      };
    case "reduce":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        initial: substituteValue(v.initial, reps),
        array: substituteValue(v.array, reps),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps),
            })),
          }
          : {}),
      };
    case "override":
      // Nested override: leave as-is; analysis of the outer rewritten fn will
      // descend into it via map/filter/reduce. Replacement keys do not apply
      // across an inner override boundary.
      return v;
    case "dag_call":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        args: v.args.map((a) => ({
          key: a.key,
          value: substituteValue(a.value, reps),
        })),
      };
  }
};

const substituteStatement = (
  s: Statement,
  reps: ReadonlyMap<string, string>,
): Statement => {
  switch (s.kind) {
    case "assignment":
      return { ...s, value: substituteValue(s.value, reps) };
    case "return":
      return { ...s, value: substituteValue(s.value, reps) };
    case "void_call": {
      const args = s.call.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps),
      }));
      const repl = reps.get(s.call.op);
      if (repl !== undefined) {
        return { kind: "user_void_call", fn: repl, args };
      }
      return { ...s, call: { ...s.call, args } };
    }
    case "user_void_call": {
      const args = s.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps),
      }));
      const repl = reps.get(s.fn);
      return { kind: "user_void_call", fn: repl ?? s.fn, args };
    }
    case "if_else":
      return {
        ...s,
        condition: substituteValue(s.condition, reps),
        then: s.then.map((st) => substituteStatement(st, reps)),
        else: s.else === null
          ? null
          : s.else.map((st) => substituteStatement(st, reps)),
      };
  }
};

// Rebuild a FnDef under override replacements, transitively rebuilding any
// user_call/user_void_call callees so analysis sees the rewritten target
// throughout. Returns an extended FnMap containing synthetic entries keyed by
// `${origName}@@${repsKey}`. The synthetic root is returned alongside the map.
const repsKey = (reps: ReadonlyMap<string, string>): string =>
  [...reps.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join(",");

const collectCalleeNames = (v: Value, acc: Set<string>): void => {
  switch (v.kind) {
    case "user_call":
      acc.add(v.fn);
      v.args.forEach((a) => collectCalleeNames(a.value, acc));
      return;
    case "call":
      v.args.forEach((a) => collectCalleeNames(a.value, acc));
      return;
    case "dot_access":
      collectCalleeNames(v.base, acc);
      return;
    case "index_access":
      collectCalleeNames(v.base, acc);
      collectCalleeNames(v.index, acc);
      return;
    case "array":
      v.elements.forEach((e) => collectCalleeNames(e, acc));
      return;
    case "object":
      v.fields.forEach((f) => collectCalleeNames(f.value, acc));
      return;
    case "binary_op":
      collectCalleeNames(v.left, acc);
      collectCalleeNames(v.right, acc);
      return;
    case "unary_op":
      collectCalleeNames(v.operand, acc);
      return;
    case "ternary":
      collectCalleeNames(v.condition, acc);
      collectCalleeNames(v.then, acc);
      collectCalleeNames(v.else, acc);
      return;
    case "map":
    case "filter":
      collectCalleeNames(v.fn, acc);
      collectCalleeNames(v.array, acc);
      v.captures?.forEach((c) => collectCalleeNames(c.value, acc));
      return;
    case "reduce":
      collectCalleeNames(v.fn, acc);
      collectCalleeNames(v.initial, acc);
      collectCalleeNames(v.array, acc);
      v.captures?.forEach((c) => collectCalleeNames(c.value, acc));
      return;
    case "dag_call":
      collectCalleeNames(v.fn, acc);
      v.args.forEach((a) => collectCalleeNames(a.value, acc));
      return;
    case "override":
      acc.add(v.target);
      for (const r of v.replacements) acc.add(r.value);
      return;
    default:
      return;
  }
};

const collectStatementCallees = (s: Statement, acc: Set<string>): void => {
  switch (s.kind) {
    case "assignment":
      collectCalleeNames(s.value, acc);
      return;
    case "return":
      collectCalleeNames(s.value, acc);
      return;
    case "void_call":
      s.call.args.forEach((a) => collectCalleeNames(a.value, acc));
      return;
    case "user_void_call":
      acc.add(s.fn);
      s.args.forEach((a) => collectCalleeNames(a.value, acc));
      return;
    case "if_else":
      collectCalleeNames(s.condition, acc);
      s.then.forEach((st) => collectStatementCallees(st, acc));
      if (s.else) s.else.forEach((st) => collectStatementCallees(st, acc));
      return;
  }
};

// Build a FnMap with the target rewritten under replacements, plus rewritten
// copies of every transitively-reachable callee. Returns the synthetic root
// fn name (a key in the returned map) and the extended map.
const buildOverrideFnMap = (
  targetName: string,
  reps: ReadonlyMap<string, string>,
  fns: FnMap,
): { rootName: string; map: FnMap } => {
  const key = repsKey(reps);
  const out = new Map<string, FnDef>(fns);
  const synth = (n: string) => `${n}@@${key}`;
  const built = new Set<string>();
  const visit = (name: string): void => {
    const sName = synth(name);
    if (built.has(sName)) return;
    built.add(sName);
    const orig = fns.get(name);
    if (!orig) return; // replacement targets must be user fns; if missing, leave name as-is
    const rewrittenBody = orig.body.map((s) => substituteStatement(s, reps));
    const rewrittenReturn = substituteValue(orig.returnValue, reps);
    // Now rewire user_call targets: any user_call whose fn is a known user fn
    // should be redirected to its synthetic counterpart, so analyzeUserCall
    // recurses into the rewritten copy.
    const rewireValue = (v: Value): Value => {
      switch (v.kind) {
        case "user_call": {
          const args = v.args.map((a) => ({
            key: a.key,
            value: rewireValue(a.value),
          }));
          if (fns.has(v.fn)) {
            visit(v.fn);
            return { kind: "user_call", fn: synth(v.fn), args };
          }
          return { kind: "user_call", fn: v.fn, args };
        }
        case "call":
          return {
            ...v,
            args: v.args.map((a) => ({
              key: a.key,
              value: rewireValue(a.value),
            })),
          };
        case "dot_access":
          return { ...v, base: rewireValue(v.base) };
        case "index_access":
          return {
            ...v,
            base: rewireValue(v.base),
            index: rewireValue(v.index),
          };
        case "array":
          return { ...v, elements: v.elements.map(rewireValue) };
        case "object":
          return {
            ...v,
            fields: v.fields.map((f) => ({
              key: f.key,
              value: rewireValue(f.value),
            })),
          };
        case "binary_op":
          return {
            ...v,
            left: rewireValue(v.left),
            right: rewireValue(v.right),
          };
        case "unary_op":
          return { ...v, operand: rewireValue(v.operand) };
        case "ternary":
          return {
            ...v,
            condition: rewireValue(v.condition),
            then: rewireValue(v.then),
            else: rewireValue(v.else),
          };
        case "map":
          return {
            ...v,
            fn: rewireValue(v.fn),
            array: rewireValue(v.array),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value),
                })),
              }
              : {}),
          };
        case "filter":
          return {
            ...v,
            fn: rewireValue(v.fn),
            array: rewireValue(v.array),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value),
                })),
              }
              : {}),
          };
        case "reduce":
          return {
            ...v,
            fn: rewireValue(v.fn),
            initial: rewireValue(v.initial),
            array: rewireValue(v.array),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value),
                })),
              }
              : {}),
          };
        case "dag_call":
          return {
            ...v,
            fn: rewireValue(v.fn),
            args: v.args.map((a) => ({
              key: a.key,
              value: rewireValue(a.value),
            })),
          };
        default:
          return v;
      }
    };
    const rewireStatement = (s: Statement): Statement => {
      switch (s.kind) {
        case "assignment":
          return { ...s, value: rewireValue(s.value) };
        case "return":
          return { ...s, value: rewireValue(s.value) };
        case "void_call":
          return {
            ...s,
            call: {
              ...s.call,
              args: s.call.args.map((a) => ({
                key: a.key,
                value: rewireValue(a.value),
              })),
            },
          };
        case "user_void_call": {
          const args = s.args.map((a) => ({
            key: a.key,
            value: rewireValue(a.value),
          }));
          if (fns.has(s.fn)) {
            visit(s.fn);
            return { kind: "user_void_call", fn: synth(s.fn), args };
          }
          return { kind: "user_void_call", fn: s.fn, args };
        }
        case "if_else":
          return {
            ...s,
            condition: rewireValue(s.condition),
            then: s.then.map(rewireStatement),
            else: s.else === null ? null : s.else.map(rewireStatement),
          };
      }
    };
    const finalBody = rewrittenBody.map(rewireStatement);
    const finalReturn = rewireValue(rewrittenReturn);
    out.set(sName, {
      ...orig,
      name: sName,
      body: finalBody,
      returnValue: finalReturn,
    });
    // Ensure transitively-reachable callees are also built so map/filter/reduce
    // inside them resolve correctly.
    const callees = new Set<string>();
    finalBody.forEach((s) => collectStatementCallees(s, callees));
    collectCalleeNames(finalReturn, callees);
    // (already triggered via rewire's visit() calls, but this is a safety net)
    callees.forEach((c) => {
      if (c.endsWith(`@@${key}`)) return;
      if (fns.has(c)) visit(c);
    });
  };
  visit(targetName);
  return { rootName: synth(targetName), map: out };
};

// Resolve a fn-value (the `fn` slot of map/filter/reduce) to a concrete FnDef
// plus the FnMap to analyze it under. For a bare `reference`, returns the
// original fn and the original map. For an `override(target, {...})`, returns
// the rewritten target and an extended map containing all rebuilt callees, so
// downstream analysis recurses into rewritten copies (effects, sources,
// complexity all reflect the substitution).
const resolveFnValue = (
  v: Value,
  fns: FnMap,
): { readonly fn: FnDef; readonly fns: FnMap } => {
  if (v.kind === "reference") {
    const fn = fns.get(v.name);
    if (!fn) throw new Error(`Unknown function: '${v.name}'`);
    return { fn, fns };
  }
  if (v.kind === "override") {
    const reps = new Map<string, string>();
    for (const r of v.replacements) reps.set(r.key, r.value);
    const { rootName, map } = buildOverrideFnMap(v.target, reps, fns);
    const fn = map.get(rootName);
    if (!fn) throw new Error(`Failed to build override target: '${v.target}'`);
    return { fn, fns: map };
  }
  throw new Error(
    `map/filter/reduce fn must be a function reference or override(...), got ${v.kind}`,
  );
};

const analyzeValue = (
  value: Value,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ValueAnalysis => {
  switch (value.kind) {
    case "string":
      return {
        sources: new Set(),
        shape: emptyShape,
        size: constant(value.value.length),
        complexity: zero,
      };
    case "number":
    case "boolean":
    case "null":
    case "undefined":
      return emptyAnalysis;
    case "reference": {
      const size = state.varSizes.get(value.name) ?? one;
      const shape = state.varShapes.get(value.name) ??
        leafShape(state.varSources.get(value.name) ?? new Set());
      return {
        sources: collapseShape(shape),
        shape,
        size,
        complexity: zero,
      };
    }
    case "dot_access": {
      const base = analyzeValue(value.base, state, registry, fns, analyzing);
      const shape = projectDotShape(base.shape, value.field);
      return {
        sources: collapseShape(shape),
        shape,
        size: base.size,
        complexity: base.complexity,
      };
    }
    case "index_access": {
      const base = analyzeValue(value.base, state, registry, fns, analyzing);
      const index = analyzeValue(value.index, state, registry, fns, analyzing);
      const shape = projectIndexShape(base.shape, value.index, index.sources);
      return {
        sources: collapseShape(shape),
        shape,
        size: base.size,
        complexity: add(base.complexity, index.complexity),
      };
    }
    case "binary_op": {
      const left = analyzeValue(value.left, state, registry, fns, analyzing);
      const right = analyzeValue(value.right, state, registry, fns, analyzing);
      const sources = unionSources(left.sources, right.sources);
      return {
        sources,
        shape: leafShape(sources),
        size: one,
        complexity: add(add(left.complexity, right.complexity), one),
      };
    }
    case "unary_op": {
      const operand = analyzeValue(
        value.operand,
        state,
        registry,
        fns,
        analyzing,
      );
      return {
        sources: operand.sources,
        shape: leafShape(operand.sources),
        size: one,
        complexity: add(operand.complexity, one),
      };
    }
    case "ternary": {
      const cond = analyzeValue(
        value.condition,
        state,
        registry,
        fns,
        analyzing,
      );
      const then_ = analyzeValue(value.then, state, registry, fns, analyzing);
      const else_ = analyzeValue(value.else, state, registry, fns, analyzing);
      const shape = addExtraToShape(
        mergeShapes(then_.shape, else_.shape),
        cond.sources,
      );
      return {
        sources: collapseShape(shape),
        shape,
        size: maxExpr(then_.size, else_.size),
        complexity: add(
          cond.complexity,
          maxExpr(then_.complexity, else_.complexity),
        ),
      };
    }
    case "array": {
      const elements = value.elements.map((e) =>
        analyzeValue(e, state, registry, fns, analyzing)
      );
      const elemShape = elements
        .map((e) => e.shape)
        .reduce(mergeShapes, emptyShape);
      const shape: ValueShape = {
        kind: "array",
        element: elemShape,
        extra: new Set(),
      };
      return {
        sources: unionSources(...elements.map((e) => e.sources)),
        shape,
        size: constant(value.elements.length),
        complexity: add(...elements.map((e) => e.complexity)),
      };
    }
    case "object": {
      const fields = value.fields.map((f) =>
        analyzeValue(f.value, state, registry, fns, analyzing)
      );
      const shape: ValueShape = {
        kind: "object",
        fields: new Map(
          value.fields.map((f, idx) => [f.key, fields[idx].shape]),
        ),
        fallback: emptyShape,
        extra: new Set(),
      };
      return {
        sources: unionSources(...fields.map((f) => f.sources)),
        shape,
        size: constant(value.fields.length),
        complexity: add(...fields.map((f) => f.complexity)),
      };
    }
    case "call":
      return analyzeCall(value.op, value.args, state, registry, fns, analyzing);
    case "user_call":
      return analyzeUserCall(
        value.fn,
        value.args,
        state,
        registry,
        fns,
        analyzing,
      );
    case "map": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const capAnalyses = (value.captures ?? []).map((c) =>
        analyzeValue(c.value, state, registry, fns, analyzing)
      );
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const positionalShapes = [
        elementShapeOf(array.shape),
        ...capAnalyses.map((c) => c.shape),
      ];
      const paramShapes = new Map<string, ValueShape>(
        fn.params.map((p, idx) => [p.name, positionalShapes[idx] ?? emptyShape]),
      );
      const fnRes = analyzeFnWithShapes(
        fn,
        registry,
        localFns,
        analyzing,
        paramShapes,
      );
      const fnSig = fnRes.sig;
      const paramSizes = [array.size, ...capAnalyses.map((c) => c.size)];
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        addToSink(state, sink, sources);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      // Map complexity: array_size * fn_complexity (element size approximated by array size)
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        paramSizes,
      );
      const mapComplexity = multiply(array.size, fnComplexity);
      const shape: ValueShape = {
        kind: "array",
        element: fnRes.returnShape,
        extra: array.shape.kind === "array" ? array.shape.extra : new Set(),
      };
      return {
        sources: collapseShape(shape),
        shape,
        size: array.size,
        complexity: add(
          array.complexity,
          ...capAnalyses.map((c) => c.complexity),
          mapComplexity,
        ),
      };
    }
    case "filter": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const capAnalyses = (value.captures ?? []).map((c) =>
        analyzeValue(c.value, state, registry, fns, analyzing)
      );
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const positionalShapes = [
        elementShapeOf(array.shape),
        ...capAnalyses.map((c) => c.shape),
      ];
      const paramShapes = new Map<string, ValueShape>(
        fn.params.map((p, idx) => [p.name, positionalShapes[idx] ?? emptyShape]),
      );
      const fnSig = analyzeFnWithShapes(
        fn,
        registry,
        localFns,
        analyzing,
        paramShapes,
      ).sig;
      const paramSizes = [one, ...capAnalyses.map((c) => c.size)];
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        addToSink(state, sink, sources);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        paramSizes,
      );
      const filterComplexity = multiply(array.size, fnComplexity);
      // Filter returns original elements, preserving element field shapes
      return {
        sources: array.sources,
        shape: array.shape,
        size: array.size,
        complexity: add(
          array.complexity,
          ...capAnalyses.map((c) => c.complexity),
          filterComplexity,
        ),
      };
    }
    case "reduce": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const initial = analyzeValue(
        value.initial,
        state,
        registry,
        fns,
        analyzing,
      );
      const capAnalyses = (value.captures ?? []).map((c) =>
        analyzeValue(c.value, state, registry, fns, analyzing)
      );
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const elemShape = elementShapeOf(array.shape);
      const capShapes = capAnalyses.map((c) => c.shape);
      const pass1Positional = [initial.shape, elemShape, ...capShapes];
      const pass1Shapes = new Map<string, ValueShape>(
        fn.params.map((p, idx) => [p.name, pass1Positional[idx] ?? emptyShape]),
      );
      const pass1 = analyzeFnWithShapes(
        fn,
        registry,
        localFns,
        analyzing,
        pass1Shapes,
      );
      const accMerged = mergeShapes(initial.shape, pass1.returnShape);
      const pass2Positional = [accMerged, elemShape, ...capShapes];
      const pass2Shapes = new Map<string, ValueShape>(
        fn.params.map((p, idx) => [p.name, pass2Positional[idx] ?? emptyShape]),
      );
      const pass2 = analyzeFnWithShapes(
        fn,
        registry,
        localFns,
        analyzing,
        pass2Shapes,
      );
      const fnSig = pass2.sig;
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      const paramSizes = [one, one, ...capAnalyses.map((c) => c.size)];
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        addToSink(state, sink, sources);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        paramSizes,
      );
      const reduceComplexity = multiply(array.size, fnComplexity);
      const finalShape = mergeShapes(initial.shape, pass2.returnShape);
      return {
        sources: collapseShape(finalShape),
        shape: finalShape,
        size: maxExpr(initial.size, array.size),
        complexity: add(
          add(array.complexity, initial.complexity),
          ...capAnalyses.map((c) => c.complexity),
          reduceComplexity,
        ),
      };
    }
    case "override":
      // An override expression yields a callable DAG value. Its mere existence
      // produces no effects; effects manifest only when the resulting DAG is
      // invoked. Phase 1: treat it as an opaque empty-effect value. Phase 2
      // will analyze the rewritten target.
      return emptyAnalysis;
    case "dag_call": {
      // Generic Dag invocation. The fn slot may be:
      //   - override(...) → resolve via buildOverrideFnMap
      //   - reference to a user fn → resolve directly
      //   - reference to a local bound to a Dag-producing expression →
      //     follow varValues chain until we hit override or user-fn ref
      const resolveLocalChain = (v: Value): Value => {
        if (v.kind !== "reference") return v;
        if (fns.has(v.name)) return v;
        const bound = state.varValues.get(v.name);
        if (!bound) {
          throw new Error(
            `dag_call: local '${v.name}' has no Dag-producing assignment in scope`,
          );
        }
        return resolveLocalChain(bound);
      };
      const resolved = resolveFnValue(resolveLocalChain(value.fn), fns);
      return analyzeUserCall(
        resolved.fn.name,
        value.args,
        state,
        registry,
        resolved.fns,
        analyzing,
      );
    }
  }
};

const analyzeUserCall = (
  fnName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ValueAnalysis => {
  const fn = fns.get(fnName);
  if (!fn) {
    if (registry.has(fnName)) {
      return analyzeCall(fnName, args, state, registry, fns, analyzing);
    }
    throw new Error(`Unknown function: '${fnName}'`);
  }
  const paramShapesByName = new Map<string, ValueShape>();
  const paramSizesByName = new Map<string, ComplexityExpr>();
  for (const arg of args) {
    const analysis = analyzeValue(arg.value, state, registry, fns, analyzing);
    paramShapesByName.set(arg.key, analysis.shape);
    paramSizesByName.set(arg.key, analysis.size);
  }
  const paramShapes = new Map<string, ValueShape>(
    fn.params.map((p) => [p.name, paramShapesByName.get(p.name) ?? emptyShape]),
  );
  const paramSizes = fn.params.map(
    (p) => paramSizesByName.get(p.name) ?? one,
  );
  const fnRes = analyzeFnWithShapes(fn, registry, fns, analyzing, paramShapes);
  const fnSig = fnRes.sig;
  for (const h of fnSig.hosts) state.hosts.add(h);
  for (const e of fnSig.envReads) state.envReads.add(e);
  for (const [sink, sources] of fnSig.dataFlow) {
    if (sink === "return") continue;
    addToSink(state, sink, sources);
  }
  state.memoryBytes += fnSig.memoryBytes;
  state.runtimeMs += fnSig.runtimeMs;
  state.diskBytes += fnSig.diskBytes;
  const callComplexity = substituteComplexity(
    fnSig.complexity,
    fn.params,
    paramSizes,
  );
  return {
    sources: collapseShape(fnRes.returnShape),
    shape: fnRes.returnShape,
    size: substituteComplexity(fnSig.complexity, fn.params, paramSizes),
    complexity: callComplexity,
  };
};

const opResultSize = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ComplexityExpr => {
  switch (opName) {
    case "httpRequest": {
      const hostArg = args.find((a) => a.key === "host");
      if (hostArg?.value.kind === "string") {
        return variable(`host:${hostArg.value.value}`);
      }
      const urlArg = args.find((a) => a.key === "url");
      if (urlArg?.value.kind === "string") {
        try {
          return variable(`host:${new URL(urlArg.value.value).hostname}`);
        } catch {
          // ignore
        }
      }
      return one;
    }
    case "randomBytes": {
      const lenArg = args.find((a) => a.key === "length");
      if (lenArg?.value.kind === "number") {
        return constant(lenArg.value.value);
      }
      if (lenArg) {
        const analysis = analyzeValue(
          lenArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "jsonParse":
    case "parseJson": {
      const textArg = args.find((a) => a.key === "text");
      if (textArg) {
        const analysis = analyzeValue(
          textArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "jsonStringify": {
      const valArg = args.find((a) => a.key === "value");
      if (valArg) {
        const analysis = analyzeValue(
          valArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "stringConcat": {
      const partsArg = args.find((a) => a.key === "parts");
      if (partsArg) {
        const analysis = analyzeValue(
          partsArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "sha256":
    case "stringLower":
    case "urlEncode":
    case "base64urlEncode":
    case "base64urlDecode":
    case "stringRegex": {
      const inputArg = args.find((a) =>
        ["data", "text", "encoded"].includes(a.key)
      );
      if (inputArg) {
        const analysis = analyzeValue(
          inputArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "buildMultipartBody": {
      const fieldsArg = args.find((a) => a.key === "fields");
      const filesArg = args.find((a) => a.key === "files");
      let sizeExpr = zero;
      if (fieldsArg) {
        sizeExpr = add(
          sizeExpr,
          analyzeValue(fieldsArg.value, state, registry, fns, analyzing).size,
        );
      }
      if (filesArg) {
        sizeExpr = add(
          sizeExpr,
          analyzeValue(filesArg.value, state, registry, fns, analyzing).size,
        );
      }
      return sizeExpr;
    }
    default:
      return one;
  }
};

const opComplexity = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ComplexityExpr => {
  switch (opName) {
    case "sha256":
    case "jsonParse":
    case "parseJson":
    case "jsonStringify":
    case "stringConcat":
    case "stringLower":
    case "urlEncode":
    case "base64urlEncode":
    case "base64urlDecode":
    case "stringIncludes":
    case "stringRegex":
    case "stringSplit":
    case "split":
    case "stringSlice":
    case "slice": {
      const inputArg = args.find((a) =>
        [
          "data",
          "text",
          "value",
          "s",
          "array",
          "parts",
          "haystack",
          "needle",
          "search",
          "substring",
          "encoded",
        ]
          .includes(a.key)
      );
      if (inputArg) {
        const analysis = analyzeValue(
          inputArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "ed25519Sign": {
      const dataArg = args.find((a) => a.key === "data");
      if (dataArg) {
        const analysis = analyzeValue(
          dataArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "aesEncrypt": {
      const ptArg = args.find((a) => a.key === "plaintext");
      if (ptArg) {
        const analysis = analyzeValue(
          ptArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "aesDecrypt": {
      const ctArg = args.find((a) => a.key === "ciphertext");
      if (ctArg) {
        const analysis = analyzeValue(
          ctArg.value,
          state,
          registry,
          fns,
          analyzing,
        );
        return analysis.size;
      }
      return one;
    }
    case "httpRequest":
    case "timestamp":
    case "randomBytes":
    case "generateEd25519KeyPair":
    case "generateX25519KeyPair":
    case "ed25519PublicFromPrivate":
    case "x25519PublicFromPrivate":
    case "aesGenerateKey":
    case "x25519DeriveKey":
    case "pick":
    case "merge":
    case "buildMultipartBody":
      return one;
    default:
      return one;
  }
};

const analyzeCall = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ValueAnalysis => {
  const entry = registry.get(opName);
  if (!entry) throw new Error(`Unknown op: '${opName}'`);

  const staticParams: Record<string, unknown> = {};
  for (const arg of args) {
    if (
      entry.staticFields.has(arg.key) ||
      (entry.resolveStaticParams && arg.key === "url")
    ) {
      if (
        arg.value.kind !== "string" &&
        arg.value.kind !== "number" &&
        arg.value.kind !== "boolean"
      ) {
        throw new Error(
          `Static field '${arg.key}' on op '${opName}' must be a literal, got '${arg.value.kind}'`,
        );
      }
      staticParams[arg.key] = arg.value.value;
    }
  }

  const resolvedStaticParams = entry.resolveStaticParams
    ? entry.resolveStaticParams(staticParams)
    : staticParams;

  for (const field of entry.staticFields) {
    if (resolvedStaticParams[field] === undefined) {
      throw new Error(
        `Missing required static field '${field}' on op '${opName}'`,
      );
    }
  }

  const dagOp = entry.create(resolvedStaticParams);
  const manifest = dagOp.manifest;

  state.memoryBytes += manifest.memoryBytes;
  state.runtimeMs += manifest.runtimeMs;
  state.diskBytes += manifest.diskBytes;

  const dynamicArgs = args.filter((a) => !entry.staticFields.has(a.key));
  const argAnalysesByKey = new Map<string, ValueAnalysis>(
    dynamicArgs.map((a) => [
      a.key,
      analyzeValue(a.value, state, registry, fns, analyzing),
    ]),
  );
  const argAnalyses = [...argAnalysesByKey.values()];

  const inputSources = unionSources(...argAnalyses.map((a) => a.sources));

  for (const h of manifest.hosts) {
    state.hosts.add(h);
    addToSink(state, `host:${h}`, inputSources);
  }

  const callComplexity = add(
    opComplexity(opName, args, state, registry, fns, analyzing),
    ...argAnalyses.map((a) => a.complexity),
  );

  const resultSize = opResultSize(
    opName,
    args,
    state,
    registry,
    fns,
    analyzing,
  );

  // Labels the op itself emits (manifest `emits`), unioned with
  // input-derived labels. The analyzer never interprets them.
  const emitted: ReadonlySet<string> = manifest.emits ?? new Set();

  if (manifest.emitsShape) {
    const shape = labelShapeToValueShape(
      manifest.emitsShape,
      unionSources(inputSources, emitted),
    );
    return {
      sources: collapseShape(shape),
      shape,
      size: resultSize,
      complexity: callComplexity,
    };
  }

  if (manifest.tags.has("network")) {
    const netSources = unionSources(
      new Set([...manifest.hosts].map((h) => `host:${h}`)),
      emitted,
    );
    return {
      sources: netSources,
      shape: leafShape(netSources),
      size: resultSize,
      complexity: callComplexity,
    };
  }
  if (manifest.tags.has("time")) {
    state.envReads.add("timestamp");
    const timeSources = unionSources(new Set(["env:timestamp"]), emitted);
    return {
      sources: timeSources,
      shape: leafShape(timeSources),
      size: resultSize,
      complexity: callComplexity,
    };
  }
  if (manifest.tags.has("random")) {
    state.envReads.add("randomBytes");
    const randSources = unionSources(new Set(["env:randomBytes"]), emitted);
    return {
      sources: randSources,
      shape: leafShape(randSources),
      size: resultSize,
      complexity: callComplexity,
    };
  }

  if (opName === "pick") {
    const objAnalysis = argAnalysesByKey.get("obj");
    const keysArg = args.find((a) => a.key === "keys");
    if (
      objAnalysis &&
      keysArg?.value.kind === "array" &&
      keysArg.value.elements.every((el) => el.kind === "string")
    ) {
      const pickedFields = new Map<string, ValueShape>(
        keysArg.value.elements.map((el) => {
          const k = (el as Extract<Value, { kind: "string" }>).value;
          return [k, projectDotShape(objAnalysis.shape, k)];
        }),
      );
      const pickedShape: ValueShape = {
        kind: "object",
        fields: pickedFields,
        fallback: emptyShape,
        extra: emitted,
      };
      const wrapperShape: ValueShape = {
        kind: "object",
        fields: new Map([
          ["obj", pickedShape],
          ["result", pickedShape],
        ]),
        fallback: emptyShape,
        extra: new Set(),
      };
      return {
        sources: collapseShape(pickedShape),
        shape: wrapperShape,
        size: resultSize,
        complexity: callComplexity,
      };
    }
  }

  if (opName === "merge") {
    const aAnalysis = argAnalysesByKey.get("a");
    const bAnalysis = argAnalysesByKey.get("b");
    if (
      aAnalysis?.shape.kind === "object" &&
      bAnalysis?.shape.kind === "object"
    ) {
      const mergedInner: ValueShape = {
        kind: "object",
        fields: new Map([...aAnalysis.shape.fields, ...bAnalysis.shape.fields]),
        fallback: mergeShapes(aAnalysis.shape.fallback, bAnalysis.shape.fallback),
        extra: unionSources(aAnalysis.shape.extra, bAnalysis.shape.extra, emitted),
      };
      const wrapperShape: ValueShape = {
        kind: "object",
        fields: new Map([["result", mergedInner]]),
        fallback: emptyShape,
        extra: new Set(),
      };
      return {
        sources: collapseShape(mergedInner),
        shape: wrapperShape,
        size: resultSize,
        complexity: callComplexity,
      };
    }
  }

  const outSources = unionSources(inputSources, emitted);
  return {
    sources: outSources,
    shape: leafShape(outSources),
    size: resultSize,
    complexity: callComplexity,
  };
};

const analyzeStatements = (
  stmts: readonly Statement[],
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ComplexityExpr => {
  let total = zero;
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        const analysis = analyzeValue(
          stmt.value,
          state,
          registry,
          fns,
          analyzing,
        );
        state.varSources.set(stmt.name, analysis.sources);
        state.varShapes.set(stmt.name, analysis.shape);
        state.varSizes.set(stmt.name, analysis.size);
        // Track Dag-producing assignments so dag_call on a reference can
        // resolve to the bound expression. Last write wins.
        state.varValues.set(stmt.name, stmt.value);
        total = add(total, analysis.complexity);
        break;
      }
      case "return": {
        /* analyzed via fn.returnValue */ break;
      }
      case "void_call": {
        const analysis = analyzeCall(
          stmt.call.op,
          stmt.call.args,
          state,
          registry,
          fns,
          analyzing,
        );
        total = add(total, analysis.complexity);
        break;
      }
      case "user_void_call": {
        const analysis = analyzeUserCall(
          stmt.fn,
          stmt.args,
          state,
          registry,
          fns,
          analyzing,
        );
        total = add(total, analysis.complexity);
        break;
      }
      case "if_else": {
        const cond = analyzeValue(
          stmt.condition,
          state,
          registry,
          fns,
          analyzing,
        );
        total = add(total, cond.complexity);

        const preMem = state.memoryBytes;
        const preRt = state.runtimeMs;
        const preDisk = state.diskBytes;
        const preVars = new Map(
          [...state.varSources.entries()].map(([k, v]) =>
            [k, new Set(v)] as const
          ),
        );
        const preShapes = new Map(state.varShapes);
        const preSizes = new Map(state.varSizes);

        // Analyze then branch
        const thenTotal = analyzeStatements(
          stmt.then,
          state,
          registry,
          fns,
          analyzing,
        );
        const thenMem = state.memoryBytes - preMem;
        const thenRt = state.runtimeMs - preRt;
        const thenDisk = state.diskBytes - preDisk;
        const thenVars = new Map(state.varSources);
        const thenShapes = new Map(state.varShapes);
        const thenSizes = new Map(state.varSizes);

        // Reset to pre-branch state for else analysis
        state.memoryBytes = preMem;
        state.runtimeMs = preRt;
        state.diskBytes = preDisk;
        state.varSources.clear();
        state.varShapes.clear();
        state.varSizes.clear();
        for (const [k, v] of preVars) state.varSources.set(k, v);
        for (const [k, v] of preShapes) state.varShapes.set(k, v);
        for (const [k, v] of preSizes) state.varSizes.set(k, v);

        // Analyze else branch (if present)
        const elseBranchResult = stmt.else
          ? (() => {
            const eTotal = analyzeStatements(
              stmt.else,
              state,
              registry,
              fns,
              analyzing,
            );
            return {
              elseTotal: eTotal,
              elseMem: state.memoryBytes - preMem,
              elseRt: state.runtimeMs - preRt,
              elseDisk: state.diskBytes - preDisk,
              elseVars: new Map(state.varSources),
              elseShapes: new Map(state.varShapes),
              elseSizes: new Map(state.varSizes),
            };
          })()
          : {
            elseTotal: zero,
            elseMem: 0,
            elseRt: 0,
            elseDisk: 0,
            elseVars: new Map(state.varSources),
            elseShapes: new Map(state.varShapes),
            elseSizes: new Map(state.varSizes),
          };

        // Conservative: sum resources from both branches
        state.memoryBytes = preMem + thenMem + elseBranchResult.elseMem;
        state.runtimeMs = preRt + thenRt + elseBranchResult.elseRt;
        state.diskBytes = preDisk + thenDisk + elseBranchResult.elseDisk;

        // Union variable sources and shapes from both branches
        const allKeys = new Set([
          ...thenVars.keys(),
          ...elseBranchResult.elseVars.keys(),
        ]);
        for (const key of allKeys) {
          const thenSrc = thenVars.get(key) ?? new Set<string>();
          const elseSrc = elseBranchResult.elseVars.get(key) ??
            new Set<string>();
          const thenShape = thenShapes.get(key) ?? leafShape(thenSrc);
          const elseShape = elseBranchResult.elseShapes.get(key) ??
            leafShape(elseSrc);
          const mergedShape = mergeShapes(thenShape, elseShape);
          state.varShapes.set(key, mergedShape);
          state.varSources.set(key, collapseShape(mergedShape));
          const thenSize = thenSizes.get(key) ?? one;
          const elseSize = elseBranchResult.elseSizes.get(key) ?? one;
          state.varSizes.set(key, maxExpr(thenSize, elseSize));
        }

        total = add(total, thenTotal, elseBranchResult.elseTotal);
        break;
      }
    }
  }
  return total;
};

const analyzeFnWithShapes = (
  fn: FnDef,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
  paramShapes?: ReadonlyMap<string, ValueShape>,
): { readonly sig: Signature; readonly returnShape: ValueShape } => {
  const stack = analyzing ?? new Set<string>();
  if (stack.has(fn.name)) {
    throw new Error(`Recursive function call cycle detected: '${fn.name}'`);
  }
  stack.add(fn.name);
  const state: AnalysisState = {
    varSources: new Map(),
    varShapes: new Map(),
    varSizes: new Map(),
    varValues: new Map(),
    hosts: new Set(),
    envReads: new Set(),
    dataFlow: new Map(),
    memoryBytes: 0,
    runtimeMs: 0,
    diskBytes: 0,
  };

  for (const param of fn.params) {
    const pShape = paramShapes?.get(param.name) ??
      leafShape(new Set([`param:${param.name}`]));
    state.varShapes.set(param.name, pShape);
    state.varSources.set(param.name, collapseShape(pShape));
    state.varSizes.set(param.name, typeSizeVar(param.name, param.type));
  }

  const bodyComplexity = analyzeStatements(
    fn.body,
    state,
    registry,
    fns,
    stack,
  );

  const returnAnalysis = analyzeValue(
    fn.returnValue,
    state,
    registry,
    fns,
    stack,
  );
  addToSink(state, "return", returnAnalysis.sources);

  stack.delete(fn.name);

  return {
    sig: {
      name: fn.name,
      params: fn.params,
      returnType: fn.returnType,
      hosts: state.hosts,
      envReads: state.envReads,
      dataFlow: state.dataFlow,
      sources: returnAnalysis.sources,
      memoryBytes: state.memoryBytes,
      runtimeMs: state.runtimeMs,
      diskBytes: state.diskBytes,
      complexity: add(bodyComplexity, returnAnalysis.complexity),
    },
    returnShape: returnAnalysis.shape,
  };
};

const analyzeFn = (
  fn: FnDef,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): Signature => analyzeFnWithShapes(fn, registry, fns, analyzing).sig;

export const computeSignature = (
  program: Program,
  functionName: string,
  registry: ReadonlyMap<string, OpEntry> = builtinRegistry,
): Signature => {
  const fn = program.functions.find((f) => f.name === functionName);
  if (!fn) throw new Error(`Function '${functionName}' not found`);
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  return analyzeFn(fn, registry, fns);
};

export type HostPolicyViolation = {
  readonly kind: "hosts";
  readonly allowed: ReadonlySet<string>;
  readonly requested: ReadonlySet<string>;
};

export type ComplexityPolicyViolation = {
  readonly kind: "complexity";
  readonly allowed: number;
  readonly requested: number;
};

export type PolicyViolation = HostPolicyViolation | ComplexityPolicyViolation;

export const hostAllowed = (
  hostname: string,
  allowedHosts: ReadonlySet<string>,
): boolean =>
  [...allowedHosts].some((allowedHost) => {
    const normalized = allowedHost.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });

const collectParamSourcesForSink = (
  sinkKey: string,
  dataFlow: ReadonlyMap<string, ReadonlySet<string>>,
  visited = new Set<string>(),
): Set<string> => {
  const result = new Set<string>();
  if (visited.has(sinkKey)) return result;
  visited.add(sinkKey);

  const sources = dataFlow.get(sinkKey) ?? new Set();
  for (const src of sources) {
    if (src.startsWith("param:")) {
      result.add(src.slice("param:".length));
    } else if (src.startsWith("host:")) {
      const subParams = collectParamSourcesForSink(src, dataFlow, visited);
      for (const p of subParams) result.add(p);
    }
  }
  return result;
};

export const complexityMaxDegree = (sig: Signature): number =>
  Math.max(0, ...sig.complexity.terms.map((t) => t.vars.length));

export const checkSignatureAgainstPolicy = (
  sig: Signature,
  paramToSecret: ReadonlyMap<string, string>,
  hostsBySecret: ReadonlyMap<string, ReadonlySet<string>>,
  maxComplexityDegree = 3,
): PolicyViolation[] => {
  const violations: PolicyViolation[] = [];

  for (const host of sig.hosts) {
    const sinkKey = `host:${host}`;
    const contributingParams = collectParamSourcesForSink(
      sinkKey,
      sig.dataFlow,
    );

    // Find any secrets flowing into this host
    const contributingSecrets = [...contributingParams]
      .map((p) => paramToSecret.get(p))
      .filter((s): s is string => !!s);

    if (contributingSecrets.length > 0) {
      // If there are secrets flowing to this host, the host MUST be allowed by at least one of those secrets' policies
      const isAllowed = contributingSecrets.some((secretName) => {
        const allowedHostsForSecret = hostsBySecret.get(secretName) ??
          new Set();
        return hostAllowed(host, allowedHostsForSecret);
      });

      if (!isAllowed) {
        violations.push({
          kind: "hosts",
          allowed: new Set(
            contributingSecrets.flatMap((
              s,
            ) => [...(hostsBySecret.get(s) ?? [])]),
          ),
          requested: new Set([host]),
        });
      }
    }
  }

  const degree = complexityMaxDegree(sig);
  if (degree > maxComplexityDegree) {
    violations.push({
      kind: "complexity",
      allowed: maxComplexityDegree,
      requested: degree,
    });
  }

  return violations;
};

// A consumer-supplied can-flow-to relation: given the full label set
// arriving at a sink, decide whether the flow is allowed. Labels are
// opaque to the analyzer; all meaning lives in this predicate.
export type LabelFlowRelation = (
  arrivingLabels: ReadonlySet<string>,
  sink: string,
) => boolean;

export type LabelPolicyViolation = {
  readonly kind: "labels";
  readonly sink: string;
  readonly labels: ReadonlySet<string>;
};

// Check every sink in the signature against a generic label relation.
// Unlike checkSignatureAgainstPolicy (frozen secret→host + complexity
// behavior), this function knows no policy vocabulary of its own —
// consumers express secrets, owners, viewers, and readers as labels
// and enforce them here. Returns one violation per rejected sink.
export const checkSignatureAgainstRelation = (
  sig: Signature,
  relation: LabelFlowRelation,
): LabelPolicyViolation[] => {
  const violations: LabelPolicyViolation[] = [];

  for (const [sink, labels] of sig.dataFlow) {
    if (!relation(labels, sink)) {
      violations.push({ kind: "labels", sink, labels: new Set(labels) });
    }
  }

  return violations;
};
