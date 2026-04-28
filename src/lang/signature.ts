import type {
  FnDef,
  Param,
  Program,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import { builtinRegistry } from "./registry.ts";
import {
  add,
  constant,
  multiply,
  one,
  type ComplexityExpr,
  type ComplexityTerm,
  normalize,
  zero,
  maxExpr,
  variable,
} from "./complexity.ts";

// Sources are labeled strings describing where data originates:
//   "param:<name>"      — function parameter
//   "env:timestamp"     — non-deterministic time read
//   "env:randomBytes"   — non-deterministic randomness read
//   "host:<hostname>"   — data received from a network host

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

type AnalysisState = {
  readonly varSources: Map<string, ReadonlySet<string>>;
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
      return type.name === "string"
        ? variable(`param:${paramName}`)
        : one;
    case "array":
      return variable(`param:${paramName}`);
    case "object":
      return one;
  }
};

type ValueAnalysis = {
  readonly sources: ReadonlySet<string>;
  readonly size: ComplexityExpr;
  readonly complexity: ComplexityExpr;
};

const emptyAnalysis: ValueAnalysis = {
  sources: new Set(),
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
const substituteValue = (v: Value, reps: ReadonlyMap<string, string>): Value => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
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
      return { ...v, elements: v.elements.map((e) => substituteValue(e, reps)) };
    case "object":
      return {
        ...v,
        fields: v.fields.map((f) => ({ key: f.key, value: substituteValue(f.value, reps) })),
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
      const args = v.args.map((a) => ({ key: a.key, value: substituteValue(a.value, reps) }));
      const repl = reps.get(v.op);
      if (repl !== undefined) return { kind: "user_call", fn: repl, args };
      return { ...v, args };
    }
    case "user_call": {
      const args = v.args.map((a) => ({ key: a.key, value: substituteValue(a.value, reps) }));
      const repl = reps.get(v.fn);
      return { kind: "user_call", fn: repl ?? v.fn, args };
    }
    case "map":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        array: substituteValue(v.array, reps),
      };
    case "filter":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        array: substituteValue(v.array, reps),
      };
    case "reduce":
      return {
        ...v,
        fn: substituteValue(v.fn, reps),
        initial: substituteValue(v.initial, reps),
        array: substituteValue(v.array, reps),
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
        args: v.args.map((a) => ({ key: a.key, value: substituteValue(a.value, reps) })),
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
        else: s.else === null ? null : s.else.map((st) => substituteStatement(st, reps)),
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
      return;
    case "reduce":
      collectCalleeNames(v.fn, acc);
      collectCalleeNames(v.initial, acc);
      collectCalleeNames(v.array, acc);
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
          const args = v.args.map((a) => ({ key: a.key, value: rewireValue(a.value) }));
          if (fns.has(v.fn)) {
            visit(v.fn);
            return { kind: "user_call", fn: synth(v.fn), args };
          }
          return { kind: "user_call", fn: v.fn, args };
        }
        case "call":
          return { ...v, args: v.args.map((a) => ({ key: a.key, value: rewireValue(a.value) })) };
        case "dot_access":
          return { ...v, base: rewireValue(v.base) };
        case "index_access":
          return { ...v, base: rewireValue(v.base), index: rewireValue(v.index) };
        case "array":
          return { ...v, elements: v.elements.map(rewireValue) };
        case "object":
          return { ...v, fields: v.fields.map((f) => ({ key: f.key, value: rewireValue(f.value) })) };
        case "binary_op":
          return { ...v, left: rewireValue(v.left), right: rewireValue(v.right) };
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
          return { ...v, fn: rewireValue(v.fn), array: rewireValue(v.array) };
        case "filter":
          return { ...v, fn: rewireValue(v.fn), array: rewireValue(v.array) };
        case "reduce":
          return {
            ...v,
            fn: rewireValue(v.fn),
            initial: rewireValue(v.initial),
            array: rewireValue(v.array),
          };
        case "dag_call":
          return {
            ...v,
            fn: rewireValue(v.fn),
            args: v.args.map((a) => ({ key: a.key, value: rewireValue(a.value) })),
          };
        default:
          return v;
      }
    };
    const rewireStatement = (s: Statement): Statement => {
      switch (s.kind) {
        case "assignment":
          return { ...s, value: rewireValue(s.value) };
        case "void_call":
          return {
            ...s,
            call: {
              ...s.call,
              args: s.call.args.map((a) => ({ key: a.key, value: rewireValue(a.value) })),
            },
          };
        case "user_void_call": {
          const args = s.args.map((a) => ({ key: a.key, value: rewireValue(a.value) }));
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
        size: constant(value.value.length),
        complexity: zero,
      };
    case "number":
    case "boolean":
      return emptyAnalysis;
    case "reference": {
      const size = state.varSizes.get(value.name) ?? one;
      return {
        sources: state.varSources.get(value.name) ?? new Set(),
        size,
        complexity: zero,
      };
    }
    case "dot_access": {
      const base = analyzeValue(value.base, state, registry, fns, analyzing);
      return { sources: base.sources, size: base.size, complexity: base.complexity };
    }
    case "index_access": {
      const base = analyzeValue(value.base, state, registry, fns, analyzing);
      const index = analyzeValue(value.index, state, registry, fns, analyzing);
      return {
        sources: unionSources(base.sources, index.sources),
        size: base.size,
        complexity: add(base.complexity, index.complexity),
      };
    }
    case "binary_op": {
      const left = analyzeValue(value.left, state, registry, fns, analyzing);
      const right = analyzeValue(value.right, state, registry, fns, analyzing);
      return {
        sources: unionSources(left.sources, right.sources),
        size: one,
        complexity: add(add(left.complexity, right.complexity), one),
      };
    }
    case "unary_op": {
      const operand = analyzeValue(value.operand, state, registry, fns, analyzing);
      return {
        sources: operand.sources,
        size: one,
        complexity: add(operand.complexity, one),
      };
    }
    case "ternary": {
      const cond = analyzeValue(value.condition, state, registry, fns, analyzing);
      const then_ = analyzeValue(value.then, state, registry, fns, analyzing);
      const else_ = analyzeValue(value.else, state, registry, fns, analyzing);
      return {
        sources: unionSources(cond.sources, then_.sources, else_.sources),
        size: maxExpr(then_.size, else_.size),
        complexity: add(cond.complexity, maxExpr(then_.complexity, else_.complexity)),
      };
    }
    case "array": {
      const elements = value.elements.map((e) =>
        analyzeValue(e, state, registry, fns, analyzing)
      );
      return {
        sources: unionSources(...elements.map((e) => e.sources)),
        size: constant(value.elements.length),
        complexity: add(...elements.map((e) => e.complexity)),
      };
    }
    case "object": {
      const fields = value.fields.map((f) =>
        analyzeValue(f.value, state, registry, fns, analyzing)
      );
      return {
        sources: unionSources(...fields.map((f) => f.sources)),
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
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const fnSig = analyzeFn(fn, registry, localFns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Propagate data flow sinks with param substitution
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        const substituted = substituteSources(sources, fn.params, [
          array.sources,
        ]);
        addToSink(state, sink, substituted);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      // Map complexity: array_size * fn_complexity (element size approximated by array size)
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        [array.size],
      );
      const mapComplexity = multiply(array.size, fnComplexity);
      // Result sources: function sources with param substitution
      return {
        sources: substituteSources(fnSig.sources, fn.params, [array.sources]),
        size: array.size,
        complexity: add(array.complexity, mapComplexity),
      };
    }
    case "filter": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const fnSig = analyzeFn(fn, registry, localFns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Propagate data flow sinks with param substitution
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        const substituted = substituteSources(sources, fn.params, [
          array.sources,
        ]);
        addToSink(state, sink, substituted);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        [one],
      );
      const filterComplexity = multiply(array.size, fnComplexity);
      // Filter returns original elements, so sources = array sources
      return {
        sources: array.sources,
        size: array.size,
        complexity: add(array.complexity, filterComplexity),
      };
    }
    case "reduce": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const initial = analyzeValue(value.initial, state, registry, fns, analyzing);
      const resolved = resolveFnValue(value.fn, fns);
      const fn = resolved.fn;
      const localFns = resolved.fns;
      const fnSig = analyzeFn(fn, registry, localFns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Conservative: both params get union of initial + array sources
      const bothSources = unionSources(initial.sources, array.sources);
      // Propagate data flow sinks with param substitution
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        const substituted = substituteSources(sources, fn.params, [
          bothSources,
          bothSources,
        ]);
        addToSink(state, sink, substituted);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      const fnComplexity = substituteComplexity(
        fnSig.complexity,
        fn.params,
        [one, one],
      );
      const reduceComplexity = multiply(array.size, fnComplexity);
      // Result sources: function sources with both param substitutions
      return {
        sources: substituteSources(fnSig.sources, fn.params, [
          bothSources,
          bothSources,
        ]),
        size: maxExpr(initial.size, array.size),
        complexity: add(
          add(array.complexity, initial.complexity),
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
  const paramSourcesByName = new Map<string, ReadonlySet<string>>();
  const paramSizesByName = new Map<string, ComplexityExpr>();
  for (const arg of args) {
    const analysis = analyzeValue(arg.value, state, registry, fns, analyzing);
    paramSourcesByName.set(arg.key, analysis.sources);
    paramSizesByName.set(arg.key, analysis.size);
  }
  const paramSources = fn.params.map(
    (p) => paramSourcesByName.get(p.name) ?? new Set<string>(),
  );
  const paramSizes = fn.params.map(
    (p) => paramSizesByName.get(p.name) ?? one,
  );
  const fnSig = analyzeFn(fn, registry, fns, analyzing);
  for (const h of fnSig.hosts) state.hosts.add(h);
  for (const e of fnSig.envReads) state.envReads.add(e);
  for (const [sink, sources] of fnSig.dataFlow) {
    if (sink === "return") continue;
    addToSink(state, sink, substituteSources(sources, fn.params, paramSources));
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
    sources: substituteSources(fnSig.sources, fn.params, paramSources),
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
      return one;
    }
    case "randomBytes": {
      const lenArg = args.find((a) => a.key === "length");
      if (lenArg?.value.kind === "number") {
        return constant(lenArg.value.value);
      }
      if (lenArg) {
        const analysis = analyzeValue(lenArg.value, state, registry, fns, analyzing);
        return analysis.size;
      }
      return one;
    }
    case "jsonParse": {
      const textArg = args.find((a) => a.key === "text");
      if (textArg) {
        const analysis = analyzeValue(textArg.value, state, registry, fns, analyzing);
        return analysis.size;
      }
      return one;
    }
    case "jsonStringify": {
      const valArg = args.find((a) => a.key === "value");
      if (valArg) {
        const analysis = analyzeValue(valArg.value, state, registry, fns, analyzing);
        return analysis.size;
      }
      return one;
    }
    case "stringConcat": {
      const partsArg = args.find((a) => a.key === "parts");
      if (partsArg) {
        const analysis = analyzeValue(partsArg.value, state, registry, fns, analyzing);
        return analysis.size;
      }
      return one;
    }
    case "sha256":
    case "stringLower":
    case "urlEncode":
    case "base64urlEncode":
    case "base64urlDecode": {
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
    case "jsonStringify":
    case "stringConcat":
    case "stringLower":
    case "urlEncode":
    case "base64urlEncode":
    case "base64urlDecode":
    case "stringIncludes": {
      const inputArg = args.find((a) =>
        ["data", "text", "value", "parts", "haystack", "needle", "encoded"]
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
    if (entry.staticFields.has(arg.key)) {
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

  const dagOp = entry.create(staticParams);
  const manifest = dagOp.manifest;

  state.memoryBytes += manifest.memoryBytes;
  state.runtimeMs += manifest.runtimeMs;
  state.diskBytes += manifest.diskBytes;

  const argAnalyses = args
    .filter((a) => !entry.staticFields.has(a.key))
    .map((a) => analyzeValue(a.value, state, registry, fns, analyzing));

  const inputSources = unionSources(...argAnalyses.map((a) => a.sources));

  for (const h of manifest.hosts) {
    state.hosts.add(h);
    addToSink(state, `host:${h}`, inputSources);
  }

  const callComplexity = add(
    opComplexity(opName, args, state, registry, fns, analyzing),
    ...argAnalyses.map((a) => a.complexity),
  );

  const resultSize = opResultSize(opName, args, state, registry, fns, analyzing);

  if (manifest.tags.has("network")) {
    return {
      sources: new Set([...manifest.hosts].map((h) => `host:${h}`)),
      size: resultSize,
      complexity: callComplexity,
    };
  }
  if (manifest.tags.has("time")) {
    state.envReads.add("timestamp");
    return {
      sources: new Set(["env:timestamp"]),
      size: resultSize,
      complexity: callComplexity,
    };
  }
  if (manifest.tags.has("random")) {
    state.envReads.add("randomBytes");
    return {
      sources: new Set(["env:randomBytes"]),
      size: resultSize,
      complexity: callComplexity,
    };
  }
  return {
    sources: inputSources,
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
        state.varSizes.set(stmt.name, analysis.size);
        // Track Dag-producing assignments so dag_call on a reference can
        // resolve to the bound expression. Last write wins.
        state.varValues.set(stmt.name, stmt.value);
        total = add(total, analysis.complexity);
        break;
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
        const cond = analyzeValue(stmt.condition, state, registry, fns, analyzing);
        total = add(total, cond.complexity);

        const preMem = state.memoryBytes;
        const preRt = state.runtimeMs;
        const preDisk = state.diskBytes;
        const preVars = new Map(
          [...state.varSources.entries()].map(([k, v]) =>
            [k, new Set(v)] as const
          ),
        );
        const preSizes = new Map(state.varSizes);

        // Analyze then branch
        const thenTotal = analyzeStatements(stmt.then, state, registry, fns, analyzing);
        const thenMem = state.memoryBytes - preMem;
        const thenRt = state.runtimeMs - preRt;
        const thenDisk = state.diskBytes - preDisk;
        const thenVars = new Map(state.varSources);
        const thenSizes = new Map(state.varSizes);

        // Reset to pre-branch state for else analysis
        state.memoryBytes = preMem;
        state.runtimeMs = preRt;
        state.diskBytes = preDisk;
        for (const [k, v] of preVars) state.varSources.set(k, v);
        for (const [k, v] of preSizes) state.varSizes.set(k, v);

        // Analyze else branch (if present)
        let elseTotal = zero;
        let elseMem = 0;
        let elseRt = 0;
        let elseDisk = 0;
        let elseVars = new Map(state.varSources);
        let elseSizes = new Map(state.varSizes);

        if (stmt.else) {
          elseTotal = analyzeStatements(stmt.else, state, registry, fns, analyzing);
          elseMem = state.memoryBytes - preMem;
          elseRt = state.runtimeMs - preRt;
          elseDisk = state.diskBytes - preDisk;
          elseVars = new Map(state.varSources);
          elseSizes = new Map(state.varSizes);
        }

        // Conservative: sum resources from both branches
        state.memoryBytes = preMem + thenMem + elseMem;
        state.runtimeMs = preRt + thenRt + elseRt;
        state.diskBytes = preDisk + thenDisk + elseDisk;

        // Union variable sources from both branches
        const allKeys = new Set([...thenVars.keys(), ...elseVars.keys()]);
        for (const key of allKeys) {
          const thenSrc = thenVars.get(key) ?? new Set<string>();
          const elseSrc = elseVars.get(key) ?? new Set<string>();
          state.varSources.set(key, unionSources(thenSrc, elseSrc));
          const thenSize = thenSizes.get(key) ?? one;
          const elseSize = elseSizes.get(key) ?? one;
          state.varSizes.set(key, maxExpr(thenSize, elseSize));
        }

        total = add(total, thenTotal, elseTotal);
        break;
      }
    }
  }
  return total;
};

const analyzeFn = (
  fn: FnDef,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): Signature => {
  const stack = analyzing ?? new Set<string>();
  if (stack.has(fn.name)) {
    throw new Error(`Recursive function call cycle detected: '${fn.name}'`);
  }
  stack.add(fn.name);
  const state: AnalysisState = {
    varSources: new Map(),
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
    state.varSources.set(param.name, new Set([`param:${param.name}`]));
    state.varSizes.set(param.name, typeSizeVar(param.name, param.type));
  }

  const bodyComplexity = analyzeStatements(fn.body, state, registry, fns, stack);

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
  };
};

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
