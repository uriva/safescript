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
import { validateProgramSemantics } from "./parser.ts";
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

type CandidateTarget =
  | { readonly kind: "top_fn"; readonly name: string }
  | {
    readonly kind: "override";
    readonly value: Extract<Value, { kind: "override" }>;
  };

type AnalysisState = {
  readonly paramNames: ReadonlySet<string>;
  readonly varSources: Map<string, ReadonlySet<string>>;
  readonly varShapes: Map<string, ValueShape>;
  readonly varSizes: Map<string, ComplexityExpr>;
  readonly varCandidates: Map<string, readonly CandidateTarget[]>;
  readonly varAmbiguous: Set<string>;
  readonly hosts: Set<string>;
  readonly envReads: Set<string>;
  readonly dataFlow: Map<string, Set<string>>;
  pcSources: ReadonlySet<string>;
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
  const effective = sink === "return"
    ? sources
    : unionSources(sources, state.pcSources);
  const existing = state.dataFlow.get(sink);
  if (existing) {
    for (const s of effective) existing.add(s);
  } else {
    state.dataFlow.set(sink, new Set(effective));
  }
};

const substituteComplexity = (
  expr: ComplexityExpr,
  params: readonly Param[],
  paramSizes: ComplexityExpr[],
): ComplexityExpr => {
  const resultTerms: ComplexityTerm[] = [];
  for (const t of expr.terms) {
    const coeff = t.coeff;
    const remainingVars: string[] = [];
    const subExpr = t.vars.reduce<ComplexityExpr>((acc, v) => {
      const paramIdx = params.findIndex((p) => v === `param:${p.name}`);
      if (paramIdx >= 0 && paramIdx < paramSizes.length) {
        return multiply(acc, paramSizes[paramIdx]);
      }
      remainingVars.push(v);
      return acc;
    }, one);
    for (const st of subExpr.terms) {
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

const collectAssignedNames = (
  stmts: readonly Statement[],
  out: Set<string>,
): void => {
  for (const s of stmts) {
    if (s.kind === "assignment") {
      out.add(s.name);
    } else if (s.kind === "if_else") {
      collectAssignedNames(s.then, out);
      if (s.else) collectAssignedNames(s.else, out);
    }
  }
};

const collectLocalScopeNames = (fn: FnDef): ReadonlySet<string> => {
  const names = new Set<string>(fn.params.map((p) => p.name));
  collectAssignedNames(fn.body, names);
  return names;
};

// Apply override replacements to a Value tree, matching graph.ts semantics
// for `reference` (function references), `call`, `user_call`, and nested `override`.
const substituteValue = (
  v: Value,
  reps: ReadonlyMap<string, string>,
  localNames: ReadonlySet<string>,
): Value => {
  switch (v.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "undefined":
      return v;
    case "reference": {
      if (!localNames.has(v.name) && reps.has(v.name)) {
        return { kind: "reference", name: reps.get(v.name)! };
      }
      return v;
    }
    case "dot_access":
      return { ...v, base: substituteValue(v.base, reps, localNames) };
    case "index_access":
      return {
        ...v,
        base: substituteValue(v.base, reps, localNames),
        index: substituteValue(v.index, reps, localNames),
      };
    case "array":
      return {
        ...v,
        elements: v.elements.map((e) => substituteValue(e, reps, localNames)),
      };
    case "object":
      return {
        ...v,
        fields: v.fields.map((f) => ({
          key: f.key,
          value: substituteValue(f.value, reps, localNames),
        })),
      };
    case "binary_op":
      return {
        ...v,
        left: substituteValue(v.left, reps, localNames),
        right: substituteValue(v.right, reps, localNames),
      };
    case "unary_op":
      return { ...v, operand: substituteValue(v.operand, reps, localNames) };
    case "ternary":
      return {
        ...v,
        condition: substituteValue(v.condition, reps, localNames),
        then: substituteValue(v.then, reps, localNames),
        else: substituteValue(v.else, reps, localNames),
      };
    case "call": {
      const args = v.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps, localNames),
      }));
      const repl = reps.get(v.op);
      if (repl !== undefined) return { kind: "user_call", fn: repl, args };
      return { ...v, args };
    }
    case "user_call": {
      const args = v.args.map((a) => ({
        key: a.key,
        value: substituteValue(a.value, reps, localNames),
      }));
      const repl = reps.get(v.fn);
      return { kind: "user_call", fn: repl ?? v.fn, args };
    }
    case "map":
      return {
        ...v,
        fn: substituteValue(v.fn, reps, localNames),
        array: substituteValue(v.array, reps, localNames),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps, localNames),
            })),
          }
          : {}),
      };
    case "filter":
      return {
        ...v,
        fn: substituteValue(v.fn, reps, localNames),
        array: substituteValue(v.array, reps, localNames),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps, localNames),
            })),
          }
          : {}),
      };
    case "reduce":
      return {
        ...v,
        fn: substituteValue(v.fn, reps, localNames),
        initial: substituteValue(v.initial, reps, localNames),
        array: substituteValue(v.array, reps, localNames),
        ...(v.captures
          ? {
            captures: v.captures.map((c) => ({
              key: c.key,
              value: substituteValue(c.value, reps, localNames),
            })),
          }
          : {}),
      };
    case "override": {
      // Compose outer replacements with inner replacements (inner wins on same key),
      // matching graph.ts `case "override"`.
      const merged = new Map<string, string>(reps);
      for (const r of v.replacements) {
        merged.set(r.key, r.value);
      }
      return {
        kind: "override",
        target: v.target,
        replacements: [...merged.entries()].map(([key, value]) => ({
          key,
          value,
        })),
      };
    }
    case "dag_call":
      return {
        ...v,
        fn: substituteValue(v.fn, reps, localNames),
        args: v.args.map((a) => ({
          key: a.key,
          value: substituteValue(a.value, reps, localNames),
        })),
      };
  }
};

const substituteStatements = (
  stmts: readonly Statement[],
  reps: ReadonlyMap<string, string>,
  inScope: Set<string>,
): readonly Statement[] =>
  stmts.map((s) => {
    switch (s.kind) {
      case "assignment": {
        const value = substituteValue(s.value, reps, inScope);
        inScope.add(s.name);
        return { ...s, value };
      }
      case "return":
        return { ...s, value: substituteValue(s.value, reps, inScope) };
      case "void_call": {
        const args = s.call.args.map((a) => ({
          key: a.key,
          value: substituteValue(a.value, reps, inScope),
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
          value: substituteValue(a.value, reps, inScope),
        }));
        const repl = reps.get(s.fn);
        return { kind: "user_void_call", fn: repl ?? s.fn, args };
      }
      case "if_else": {
        const condition = substituteValue(s.condition, reps, inScope);
        const thenScope = new Set(inScope);
        const then = substituteStatements(s.then, reps, thenScope);
        const elseScope = new Set(inScope);
        const elseBody = s.else === null
          ? null
          : substituteStatements(s.else, reps, elseScope);
        for (const k of thenScope) inScope.add(k);
        for (const k of elseScope) inScope.add(k);
        return { ...s, condition, then, else: elseBody };
      }
    }
  });

const repsKey = (reps: ReadonlyMap<string, string>): string =>
  [...reps.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join(",");

const collectCalleeNames = (
  v: Value,
  acc: Set<string>,
  localNames: ReadonlySet<string>,
): void => {
  switch (v.kind) {
    case "reference":
      if (!localNames.has(v.name)) acc.add(v.name);
      return;
    case "user_call":
      acc.add(v.fn);
      v.args.forEach((a) => collectCalleeNames(a.value, acc, localNames));
      return;
    case "call":
      v.args.forEach((a) => collectCalleeNames(a.value, acc, localNames));
      return;
    case "dot_access":
      collectCalleeNames(v.base, acc, localNames);
      return;
    case "index_access":
      collectCalleeNames(v.base, acc, localNames);
      collectCalleeNames(v.index, acc, localNames);
      return;
    case "array":
      v.elements.forEach((e) => collectCalleeNames(e, acc, localNames));
      return;
    case "object":
      v.fields.forEach((f) => collectCalleeNames(f.value, acc, localNames));
      return;
    case "binary_op":
      collectCalleeNames(v.left, acc, localNames);
      collectCalleeNames(v.right, acc, localNames);
      return;
    case "unary_op":
      collectCalleeNames(v.operand, acc, localNames);
      return;
    case "ternary":
      collectCalleeNames(v.condition, acc, localNames);
      collectCalleeNames(v.then, acc, localNames);
      collectCalleeNames(v.else, acc, localNames);
      return;
    case "map":
    case "filter":
      collectCalleeNames(v.fn, acc, localNames);
      collectCalleeNames(v.array, acc, localNames);
      v.captures?.forEach((c) => collectCalleeNames(c.value, acc, localNames));
      return;
    case "reduce":
      collectCalleeNames(v.fn, acc, localNames);
      collectCalleeNames(v.initial, acc, localNames);
      collectCalleeNames(v.array, acc, localNames);
      v.captures?.forEach((c) => collectCalleeNames(c.value, acc, localNames));
      return;
    case "dag_call":
      collectCalleeNames(v.fn, acc, localNames);
      v.args.forEach((a) => collectCalleeNames(a.value, acc, localNames));
      return;
    case "override":
      acc.add(v.target);
      for (const r of v.replacements) acc.add(r.value);
      return;
    default:
      return;
  }
};

const collectStatementCallees = (
  s: Statement,
  acc: Set<string>,
  localNames: ReadonlySet<string>,
): void => {
  switch (s.kind) {
    case "assignment":
      collectCalleeNames(s.value, acc, localNames);
      return;
    case "return":
      collectCalleeNames(s.value, acc, localNames);
      return;
    case "void_call":
      s.call.args.forEach((a) => collectCalleeNames(a.value, acc, localNames));
      return;
    case "user_void_call":
      acc.add(s.fn);
      s.args.forEach((a) => collectCalleeNames(a.value, acc, localNames));
      return;
    case "if_else":
      collectCalleeNames(s.condition, acc, localNames);
      s.then.forEach((st) => collectStatementCallees(st, acc, localNames));
      if (s.else) {
        s.else.forEach((st) => collectStatementCallees(st, acc, localNames));
      }
      return;
  }
};

const baseFnMap = (fns: FnMap): FnMap =>
  new Map([...fns.entries()].filter(([k]) => !k.includes("@@")));

const buildOverrideFnMap = (
  targetName: string,
  reps: ReadonlyMap<string, string>,
  fns: FnMap,
): { rootName: string; map: FnMap } => {
  const cleanFns = baseFnMap(fns);
  if (!cleanFns.has(targetName)) {
    throw new Error(`override target '${targetName}' is not a user function`);
  }
  for (const [k, replName] of reps) {
    if (!cleanFns.has(replName)) {
      throw new Error(
        `override replacement '${replName}' for '${k}' is not a user function`,
      );
    }
    if (replName === targetName) {
      throw new Error(`override cannot self-reference target '${targetName}'`);
    }
  }

  const key = repsKey(reps);
  const out = new Map<string, FnDef>(fns);
  const synth = (n: string) => `${n}@@${key}`;
  const built = new Set<string>();

  const visit = (name: string): void => {
    const sName = synth(name);
    if (built.has(sName)) return;
    built.add(sName);
    const orig = cleanFns.get(name);
    if (!orig) return;
    const subScope = new Set<string>(orig.params.map((p) => p.name));
    const rewrittenBody = substituteStatements(orig.body, reps, subScope);
    const rewrittenReturn = substituteValue(orig.returnValue, reps, subScope);

    const rewireValue = (v: Value, activeScope: ReadonlySet<string>): Value => {
      switch (v.kind) {
        case "reference":
          if (!activeScope.has(v.name) && cleanFns.has(v.name)) {
            visit(v.name);
            return { kind: "reference", name: synth(v.name) };
          }
          return v;
        case "user_call": {
          const args = v.args.map((a) => ({
            key: a.key,
            value: rewireValue(a.value, activeScope),
          }));
          if (cleanFns.has(v.fn)) {
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
              value: rewireValue(a.value, activeScope),
            })),
          };
        case "dot_access":
          return { ...v, base: rewireValue(v.base, activeScope) };
        case "index_access":
          return {
            ...v,
            base: rewireValue(v.base, activeScope),
            index: rewireValue(v.index, activeScope),
          };
        case "array":
          return {
            ...v,
            elements: v.elements.map((e) => rewireValue(e, activeScope)),
          };
        case "object":
          return {
            ...v,
            fields: v.fields.map((f) => ({
              key: f.key,
              value: rewireValue(f.value, activeScope),
            })),
          };
        case "binary_op":
          return {
            ...v,
            left: rewireValue(v.left, activeScope),
            right: rewireValue(v.right, activeScope),
          };
        case "unary_op":
          return { ...v, operand: rewireValue(v.operand, activeScope) };
        case "ternary":
          return {
            ...v,
            condition: rewireValue(v.condition, activeScope),
            then: rewireValue(v.then, activeScope),
            else: rewireValue(v.else, activeScope),
          };
        case "map":
          return {
            ...v,
            fn: rewireValue(v.fn, activeScope),
            array: rewireValue(v.array, activeScope),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value, activeScope),
                })),
              }
              : {}),
          };
        case "filter":
          return {
            ...v,
            fn: rewireValue(v.fn, activeScope),
            array: rewireValue(v.array, activeScope),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value, activeScope),
                })),
              }
              : {}),
          };
        case "reduce":
          return {
            ...v,
            fn: rewireValue(v.fn, activeScope),
            initial: rewireValue(v.initial, activeScope),
            array: rewireValue(v.array, activeScope),
            ...(v.captures
              ? {
                captures: v.captures.map((c) => ({
                  key: c.key,
                  value: rewireValue(c.value, activeScope),
                })),
              }
              : {}),
          };
        case "dag_call":
          return {
            ...v,
            fn: rewireValue(v.fn, activeScope),
            args: v.args.map((a) => ({
              key: a.key,
              value: rewireValue(a.value, activeScope),
            })),
          };
        default:
          return v;
      }
    };

    const rewireStatements = (
      stmts: readonly Statement[],
      activeScope: Set<string>,
    ): readonly Statement[] =>
      stmts.map((s) => {
        switch (s.kind) {
          case "assignment": {
            const value = rewireValue(s.value, activeScope);
            activeScope.add(s.name);
            return { ...s, value };
          }
          case "return":
            return { ...s, value: rewireValue(s.value, activeScope) };
          case "void_call":
            return {
              ...s,
              call: {
                ...s.call,
                args: s.call.args.map((a) => ({
                  key: a.key,
                  value: rewireValue(a.value, activeScope),
                })),
              },
            };
          case "user_void_call": {
            const args = s.args.map((a) => ({
              key: a.key,
              value: rewireValue(a.value, activeScope),
            }));
            if (cleanFns.has(s.fn)) {
              visit(s.fn);
              return { kind: "user_void_call", fn: synth(s.fn), args };
            }
            return { kind: "user_void_call", fn: s.fn, args };
          }
          case "if_else": {
            const condition = rewireValue(s.condition, activeScope);
            const thenScope = new Set(activeScope);
            const then = rewireStatements(s.then, thenScope);
            const elseScope = new Set(activeScope);
            const elseBody = s.else === null
              ? null
              : rewireStatements(s.else, elseScope);
            for (const k of thenScope) activeScope.add(k);
            for (const k of elseScope) activeScope.add(k);
            return { ...s, condition, then, else: elseBody };
          }
        }
      });

    const localNames = collectLocalScopeNames(orig);
    const rewireScope = new Set<string>(orig.params.map((p) => p.name));
    const finalBody = rewireStatements(rewrittenBody, rewireScope);
    const finalReturn = rewireValue(rewrittenReturn, rewireScope);
    out.set(sName, {
      ...orig,
      name: sName,
      body: finalBody,
      returnValue: finalReturn,
    });
    const callees = new Set<string>();
    finalBody.forEach((s) => collectStatementCallees(s, callees, localNames));
    collectCalleeNames(finalReturn, callees, localNames);
    callees.forEach((c) => {
      if (c.includes("@@")) return;
      if (cleanFns.has(c)) visit(c);
    });
  };

  visit(targetName);
  return { rootName: synth(targetName), map: out };
};

type ResolvedFnTarget = {
  readonly fn: FnDef;
  readonly fns: FnMap;
};

const resolveCandidateTarget = (
  cand: CandidateTarget,
  fns: FnMap,
): ResolvedFnTarget => {
  if (cand.kind === "override") {
    const reps = new Map<string, string>();
    for (const r of cand.value.replacements) reps.set(r.key, r.value);
    const { rootName, map } = buildOverrideFnMap(cand.value.target, reps, fns);
    const fn = map.get(rootName);
    if (!fn) {
      throw new Error(
        `Failed to build override target: '${cand.value.target}'`,
      );
    }
    return { fn, fns: map };
  }
  const fn = fns.get(cand.name);
  if (!fn) throw new Error(`Unknown function: '${cand.name}'`);
  return { fn, fns };
};

// Resolve a callable Value expression to all candidate (FnDef, FnMap) pairs it
// may evaluate to at runtime. Checks parameter and local scope BEFORE top-level
// `fns` so parameters/locals can never shadow a function and cause desync.
const resolveFnCandidates = (
  v: Value,
  state: AnalysisState,
  fns: FnMap,
): readonly ResolvedFnTarget[] => {
  if (v.kind === "override") {
    return [resolveCandidateTarget({ kind: "override", value: v }, fns)];
  }
  if (v.kind === "ternary") {
    return [
      ...resolveFnCandidates(v.then, state, fns),
      ...resolveFnCandidates(v.else, state, fns),
    ];
  }
  if (v.kind === "reference") {
    if (state.paramNames.has(v.name)) {
      throw new Error(
        `Cannot statically analyze invocation of parameter '${v.name}'`,
      );
    }
    if (state.varAmbiguous.has(v.name)) {
      throw new Error(
        `Local '${v.name}' does not resolve to a valid function on all control-flow paths`,
      );
    }
    const bound = state.varCandidates.get(v.name);
    if (bound !== undefined) {
      return bound.map((cand) => resolveCandidateTarget(cand, fns));
    }
    const fn = fns.get(v.name);
    if (!fn) throw new Error(`Unknown function: '${v.name}'`);
    return [{ fn, fns }];
  }
  throw new Error(
    `Callable slot must be a function reference or override(...), got ${v.kind}`,
  );
};

const extractAssignmentCandidates = (
  v: Value,
  state: AnalysisState,
  fns: FnMap,
): readonly CandidateTarget[] | null => {
  if (v.kind === "override") return [{ kind: "override", value: v }];
  if (v.kind === "reference") {
    if (state.paramNames.has(v.name) || state.varAmbiguous.has(v.name)) {
      return null;
    }
    if (state.varCandidates.has(v.name)) {
      return state.varCandidates.get(v.name)!;
    }
    if (fns.has(v.name)) return [{ kind: "top_fn", name: v.name }];
    return null;
  }
  if (v.kind === "ternary") {
    const t = extractAssignmentCandidates(v.then, state, fns);
    const e = extractAssignmentCandidates(v.else, state, fns);
    if (t && e) return [...t, ...e];
    return null;
  }
  return null;
};

const dedupValues = (
  vals: readonly CandidateTarget[],
): readonly CandidateTarget[] => {
  const out: CandidateTarget[] = [];
  const seen = new Set<string>();
  for (const v of vals) {
    const k = v.kind === "top_fn"
      ? `fn:${v.name}`
      : `ov:${v.value.target}:${
        v.value.replacements.map((r) => `${r.key}=${r.value}`).join(",")
      }`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
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
      const candidates = resolveFnCandidates(value.fn, state, fns);
      const positionalShapes = [
        elementShapeOf(array.shape),
        ...capAnalyses.map((c) => c.shape),
      ];
      const paramSizes = [array.size, ...capAnalyses.map((c) => c.size)];

      const candResults = candidates.map((resolved) => {
        const fn = resolved.fn;
        const localFns = resolved.fns;
        const paramShapes = new Map<string, ValueShape>(
          fn.params.map((p, idx) => [
            p.name,
            positionalShapes[idx] ?? emptyShape,
          ]),
        );
        const fnRes = analyzeFnWithShapes(
          fn,
          registry,
          localFns,
          analyzing,
          paramShapes,
        );
        const fnSig = fnRes.sig;
        for (const h of fnSig.hosts) {
          state.hosts.add(h);
          if (state.pcSources.size > 0) {
            addToSink(state, `host:${h}`, state.pcSources);
          }
        }
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
        return {
          returnShape: fnRes.returnShape,
          mapComplexity: multiply(array.size, fnComplexity),
        };
      });

      const mergedElemShape = candResults
        .map((r) => r.returnShape)
        .reduce(mergeShapes, emptyShape);
      const totalMapComplexity = add(
        ...candResults.map((r) => r.mapComplexity),
      );
      const shape: ValueShape = {
        kind: "array",
        element: mergedElemShape,
        extra: array.shape.kind === "array" ? array.shape.extra : new Set(),
      };
      return {
        sources: collapseShape(shape),
        shape,
        size: array.size,
        complexity: add(
          array.complexity,
          ...capAnalyses.map((c) => c.complexity),
          totalMapComplexity,
        ),
      };
    }
    case "filter": {
      const array = analyzeValue(value.array, state, registry, fns, analyzing);
      const capAnalyses = (value.captures ?? []).map((c) =>
        analyzeValue(c.value, state, registry, fns, analyzing)
      );
      const candidates = resolveFnCandidates(value.fn, state, fns);
      const positionalShapes = [
        elementShapeOf(array.shape),
        ...capAnalyses.map((c) => c.shape),
      ];
      // Scale inner element size with array.size so nested filter/map/reduce
      // properly increases polynomial degree instead of collapsing to O(1).
      const paramSizes = [array.size, ...capAnalyses.map((c) => c.size)];

      const candResults = candidates.map((resolved) => {
        const fn = resolved.fn;
        const localFns = resolved.fns;
        const paramShapes = new Map<string, ValueShape>(
          fn.params.map((p, idx) => [
            p.name,
            positionalShapes[idx] ?? emptyShape,
          ]),
        );
        const fnSig = analyzeFnWithShapes(
          fn,
          registry,
          localFns,
          analyzing,
          paramShapes,
        ).sig;
        for (const h of fnSig.hosts) {
          state.hosts.add(h);
          if (state.pcSources.size > 0) {
            addToSink(state, `host:${h}`, state.pcSources);
          }
        }
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
        return {
          predSources: fnSig.sources,
          filterComplexity: multiply(array.size, fnComplexity),
        };
      });

      const predTaint = unionSources(
        ...candResults.map((r) => r.predSources),
        ...capAnalyses.map((c) => c.sources),
      );
      const outShape = addExtraToShape(array.shape, predTaint);
      return {
        sources: collapseShape(outShape),
        shape: outShape,
        size: array.size,
        complexity: add(
          array.complexity,
          ...capAnalyses.map((c) => c.complexity),
          ...candResults.map((r) => r.filterComplexity),
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
      const candidates = resolveFnCandidates(value.fn, state, fns);
      const elemShape = elementShapeOf(array.shape);
      const capShapes = capAnalyses.map((c) => c.shape);
      // Scale accumulator & element sizes with array.size so nested reductions
      // properly increase polynomial degree instead of collapsing to O(1).
      const paramSizes = [
        maxExpr(initial.size, array.size),
        array.size,
        ...capAnalyses.map((c) => c.size),
      ];

      const candResults = candidates.map((resolved) => {
        const fn = resolved.fn;
        const localFns = resolved.fns;
        const pass1Positional = [initial.shape, elemShape, ...capShapes];
        const pass1Shapes = new Map<string, ValueShape>(
          fn.params.map((p, idx) => [
            p.name,
            pass1Positional[idx] ?? emptyShape,
          ]),
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
          fn.params.map((p, idx) => [
            p.name,
            pass2Positional[idx] ?? emptyShape,
          ]),
        );
        const pass2 = analyzeFnWithShapes(
          fn,
          registry,
          localFns,
          analyzing,
          pass2Shapes,
        );
        const fnSig = pass2.sig;
        for (const h of fnSig.hosts) {
          state.hosts.add(h);
          if (state.pcSources.size > 0) {
            addToSink(state, `host:${h}`, state.pcSources);
          }
        }
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
        return {
          returnShape: pass2.returnShape,
          reduceComplexity: multiply(array.size, fnComplexity),
        };
      });

      const finalShape = candResults.reduce<ValueShape>(
        (acc, r) => mergeShapes(acc, r.returnShape),
        initial.shape,
      );
      return {
        sources: collapseShape(finalShape),
        shape: finalShape,
        size: maxExpr(initial.size, array.size),
        complexity: add(
          add(array.complexity, initial.complexity),
          ...capAnalyses.map((c) => c.complexity),
          ...candResults.map((r) => r.reduceComplexity),
        ),
      };
    }
    case "override": {
      // Validate target and replacements eagerly at override creation so
      // invalid or self-referential overrides cannot silently pass analysis.
      const reps = new Map<string, string>();
      for (const r of value.replacements) reps.set(r.key, r.value);
      buildOverrideFnMap(value.target, reps, fns);
      return emptyAnalysis;
    }
    case "dag_call": {
      const candidates = resolveFnCandidates(value.fn, state, fns);
      const candAnalyses = candidates.map((resolved) =>
        analyzeUserCall(
          resolved.fn.name,
          value.args,
          state,
          registry,
          resolved.fns,
          analyzing,
        )
      );
      const mergedShape = candAnalyses
        .map((a) => a.shape)
        .reduce(mergeShapes, emptyShape);
      const mergedSize = candAnalyses.reduce<ComplexityExpr>(
        (acc, a) => maxExpr(acc, a.size),
        zero,
      );
      return {
        sources: collapseShape(mergedShape),
        shape: mergedShape,
        size: mergedSize.terms.length === 0 ? one : mergedSize,
        complexity: add(...candAnalyses.map((a) => a.complexity)),
      };
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
  const argComplexities: ComplexityExpr[] = [];
  for (const arg of args) {
    const analysis = analyzeValue(arg.value, state, registry, fns, analyzing);
    paramShapesByName.set(arg.key, analysis.shape);
    paramSizesByName.set(arg.key, analysis.size);
    argComplexities.push(analysis.complexity);
  }
  // Match executeDag positional fallback (`__arg${idx}`) so positional
  // dag_call invocations never lose taint or complexity on parameters.
  const paramShapes = new Map<string, ValueShape>(
    fn.params.map((p, idx) => [
      p.name,
      paramShapesByName.get(p.name) ??
        paramShapesByName.get(`__arg${idx}`) ??
        emptyShape,
    ]),
  );
  const paramSizes = fn.params.map(
    (p, idx) =>
      paramSizesByName.get(p.name) ??
        paramSizesByName.get(`__arg${idx}`) ??
        one,
  );
  const fnRes = analyzeFnWithShapes(fn, registry, fns, analyzing, paramShapes);
  const fnSig = fnRes.sig;
  for (const h of fnSig.hosts) {
    state.hosts.add(h);
    if (state.pcSources.size > 0) {
      addToSink(state, `host:${h}`, state.pcSources);
    }
  }
  for (const e of fnSig.envReads) state.envReads.add(e);
  for (const [sink, sources] of fnSig.dataFlow) {
    if (sink === "return") continue;
    addToSink(state, sink, sources);
  }
  state.memoryBytes += fnSig.memoryBytes;
  state.runtimeMs += fnSig.runtimeMs;
  state.diskBytes += fnSig.diskBytes;
  const callComplexity = add(
    substituteComplexity(fnSig.complexity, fn.params, paramSizes),
    ...argComplexities,
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
        return analyzeValue(lenArg.value, state, registry, fns, analyzing).size;
      }
      return one;
    }
    case "jsonParse":
    case "parseJson": {
      const textArg = args.find((a) => a.key === "text");
      if (textArg) {
        return analyzeValue(textArg.value, state, registry, fns, analyzing)
          .size;
      }
      return one;
    }
    case "jsonStringify": {
      const valArg = args.find((a) => a.key === "value");
      if (valArg) {
        return analyzeValue(valArg.value, state, registry, fns, analyzing).size;
      }
      return one;
    }
    case "stringConcat": {
      const partsArg = args.find((a) => a.key === "parts");
      if (partsArg) {
        return analyzeValue(partsArg.value, state, registry, fns, analyzing)
          .size;
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
        return analyzeValue(inputArg.value, state, registry, fns, analyzing)
          .size;
      }
      return one;
    }
    case "buildMultipartBody": {
      const fieldsArg = args.find((a) => a.key === "fields");
      const filesArg = args.find((a) => a.key === "files");
      const fSize = fieldsArg
        ? analyzeValue(fieldsArg.value, state, registry, fns, analyzing).size
        : zero;
      const fileSize = filesArg
        ? analyzeValue(filesArg.value, state, registry, fns, analyzing).size
        : zero;
      return add(fSize, fileSize);
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
        ].includes(a.key)
      );
      if (inputArg) {
        return analyzeValue(inputArg.value, state, registry, fns, analyzing)
          .size;
      }
      return one;
    }
    case "ed25519Sign": {
      const dataArg = args.find((a) => a.key === "data");
      if (dataArg) {
        return analyzeValue(dataArg.value, state, registry, fns, analyzing)
          .size;
      }
      return one;
    }
    case "aesEncrypt": {
      const ptArg = args.find((a) => a.key === "plaintext");
      if (ptArg) {
        return analyzeValue(ptArg.value, state, registry, fns, analyzing).size;
      }
      return one;
    }
    case "aesDecrypt": {
      const ctArg = args.find((a) => a.key === "ciphertext");
      if (ctArg) {
        return analyzeValue(ctArg.value, state, registry, fns, analyzing).size;
      }
      return one;
    }
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
    if (
      resolvedStaticParams[field] === undefined ||
      resolvedStaticParams[field] === ""
    ) {
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

  // Union inputSources into network, time, and random op outputs so passing
  // tainted/secret data through impure or imported ops never erases taint.
  if (
    manifest.tags.has("network") ||
    manifest.tags.has("time") ||
    manifest.tags.has("random")
  ) {
    const tagSources = new Set<string>();
    if (manifest.tags.has("network")) {
      for (const h of manifest.hosts) tagSources.add(`host:${h}`);
    }
    if (manifest.tags.has("time")) {
      state.envReads.add("timestamp");
      tagSources.add("env:timestamp");
    }
    if (manifest.tags.has("random")) {
      state.envReads.add("randomBytes");
      tagSources.add("env:randomBytes");
    }
    const combined = unionSources(inputSources, tagSources, emitted);
    return {
      sources: combined,
      shape: leafShape(combined),
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
        fallback: mergeShapes(
          aAnalysis.shape.fallback,
          bAnalysis.shape.fallback,
        ),
        extra: unionSources(
          aAnalysis.shape.extra,
          bAnalysis.shape.extra,
          emitted,
        ),
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
  const complexities: ComplexityExpr[] = [];
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        if (state.paramNames.has(stmt.name)) {
          throw new Error(`Cannot reassign parameter '${stmt.name}'`);
        }
        const analysis = analyzeValue(
          stmt.value,
          state,
          registry,
          fns,
          analyzing,
        );
        const taintedShape = addExtraToShape(analysis.shape, state.pcSources);
        const taintedSources = collapseShape(taintedShape);
        state.varSources.set(stmt.name, taintedSources);
        state.varShapes.set(stmt.name, taintedShape);
        state.varSizes.set(stmt.name, analysis.size);

        const cands = extractAssignmentCandidates(stmt.value, state, fns);
        if (cands !== null) {
          state.varCandidates.set(stmt.name, dedupValues(cands));
          state.varAmbiguous.delete(stmt.name);
        } else {
          state.varCandidates.delete(stmt.name);
          state.varAmbiguous.add(stmt.name);
        }
        complexities.push(analysis.complexity);
        break;
      }
      case "return":
        break;
      case "void_call": {
        if (stmt.call.op === "doc") break;
        const analysis = analyzeCall(
          stmt.call.op,
          stmt.call.args,
          state,
          registry,
          fns,
          analyzing,
        );
        complexities.push(analysis.complexity);
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
        complexities.push(analysis.complexity);
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
        complexities.push(cond.complexity);

        const preMem = state.memoryBytes;
        const preRt = state.runtimeMs;
        const preDisk = state.diskBytes;
        const prePc = state.pcSources;
        const branchPc = unionSources(prePc, cond.sources);

        const preVars = new Map(
          [...state.varSources.entries()].map(([k, v]) =>
            [k, new Set(v)] as const
          ),
        );
        const preShapes = new Map(state.varShapes);
        const preSizes = new Map(state.varSizes);
        const preCandidates = new Map(state.varCandidates);
        const preAmbiguous = new Set(state.varAmbiguous);

        // Analyze then branch under branchPc
        state.pcSources = branchPc;
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
        const thenCandidates = new Map(state.varCandidates);
        const thenAmbiguous = new Set(state.varAmbiguous);

        // Reset to pre-branch state for else analysis
        state.memoryBytes = preMem;
        state.runtimeMs = preRt;
        state.diskBytes = preDisk;
        state.varSources.clear();
        state.varShapes.clear();
        state.varSizes.clear();
        state.varCandidates.clear();
        state.varAmbiguous.clear();
        for (const [k, v] of preVars) state.varSources.set(k, v);
        for (const [k, v] of preShapes) state.varShapes.set(k, v);
        for (const [k, v] of preSizes) state.varSizes.set(k, v);
        for (const [k, v] of preCandidates) state.varCandidates.set(k, v);
        for (const k of preAmbiguous) state.varAmbiguous.add(k);

        const elseBranchResult = stmt.else
          ? (() => {
            state.pcSources = branchPc;
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
              elseCandidates: new Map(state.varCandidates),
              elseAmbiguous: new Set(state.varAmbiguous),
            };
          })()
          : {
            elseTotal: zero,
            elseMem: 0,
            elseRt: 0,
            elseDisk: 0,
            elseVars: new Map(preVars),
            elseShapes: new Map(preShapes),
            elseSizes: new Map(preSizes),
            elseCandidates: new Map(preCandidates),
            elseAmbiguous: new Set(preAmbiguous),
          };

        state.pcSources = prePc;
        state.memoryBytes = preMem + thenMem + elseBranchResult.elseMem;
        state.runtimeMs = preRt + thenRt + elseBranchResult.elseRt;
        state.diskBytes = preDisk + thenDisk + elseBranchResult.elseDisk;

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

        // Merge callable candidates soundly across both branches
        state.varCandidates.clear();
        state.varAmbiguous.clear();
        const candKeys = new Set([
          ...thenCandidates.keys(),
          ...elseBranchResult.elseCandidates.keys(),
          ...thenAmbiguous,
          ...elseBranchResult.elseAmbiguous,
        ]);
        for (const key of candKeys) {
          const tCands = thenCandidates.get(key);
          const eCands = elseBranchResult.elseCandidates.get(key);
          const isAmb = thenAmbiguous.has(key) ||
            elseBranchResult.elseAmbiguous.has(key) ||
            !tCands ||
            !eCands;
          if (isAmb) {
            state.varAmbiguous.add(key);
          } else {
            state.varCandidates.set(key, dedupValues([...tCands, ...eCands]));
          }
        }

        complexities.push(thenTotal, elseBranchResult.elseTotal);
        break;
      }
    }
  }
  return add(...complexities);
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
    paramNames: new Set(fn.params.map((p) => p.name)),
    varSources: new Map(),
    varShapes: new Map(),
    varSizes: new Map(),
    varCandidates: new Map(),
    varAmbiguous: new Set(),
    hosts: new Set(),
    envReads: new Set(),
    dataFlow: new Map(),
    pcSources: new Set(),
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

  try {
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
  } finally {
    stack.delete(fn.name);
  }
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
  validateProgramSemantics(program, [fn]);
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
): boolean => {
  const lowerHost = hostname.toLowerCase();
  return [...allowedHosts].some((allowedHost) => {
    const normalized = allowedHost.toLowerCase();
    return normalized.length > 0 &&
      (lowerHost === normalized || lowerHost.endsWith(`.${normalized}`));
  });
};

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

const collectTransitiveLabelsForSink = (
  sinkKey: string,
  dataFlow: ReadonlyMap<string, ReadonlySet<string>>,
  visited = new Set<string>(),
): Set<string> => {
  const result = new Set<string>();
  if (visited.has(sinkKey)) return result;
  visited.add(sinkKey);

  const direct = dataFlow.get(sinkKey) ?? new Set();
  for (const label of direct) {
    result.add(label);
    if (label.startsWith("host:") && dataFlow.has(label)) {
      const transitive = collectTransitiveLabelsForSink(
        label,
        dataFlow,
        visited,
      );
      for (const t of transitive) result.add(t);
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

    const contributingSecrets = [
      ...new Set(
        [...contributingParams]
          .map((p) => paramToSecret.get(p))
          .filter((s): s is string => !!s),
      ),
    ];

    // EVERY secret flowing to `host` must authorize `host`; emit a violation
    // for each secret whose policy does not allow `host`.
    for (const secretName of contributingSecrets) {
      const allowedHostsForSecret = hostsBySecret.get(secretName) ??
        new Set<string>();
      if (!hostAllowed(host, allowedHostsForSecret)) {
        violations.push({
          kind: "hosts",
          allowed: new Set(allowedHostsForSecret),
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

export type LabelFlowRelation = (
  arrivingLabels: ReadonlySet<string>,
  sink: string,
) => boolean;

export type LabelPolicyViolation = {
  readonly kind: "labels";
  readonly sink: string;
  readonly labels: ReadonlySet<string>;
};

export const checkSignatureAgainstRelation = (
  sig: Signature,
  relation: LabelFlowRelation,
): LabelPolicyViolation[] => {
  const violations: LabelPolicyViolation[] = [];

  for (const [sink] of sig.dataFlow) {
    const labels = collectTransitiveLabelsForSink(sink, sig.dataFlow);
    if (!relation(labels, sink)) {
      violations.push({ kind: "labels", sink, labels });
    }
  }

  return violations;
};
