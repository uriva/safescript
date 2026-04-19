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
};

type AnalysisState = {
  readonly varSources: Map<string, ReadonlySet<string>>;
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

type FnMap = ReadonlyMap<string, FnDef>;

const analyzeValue = (
  value: Value,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ReadonlySet<string> => {
  switch (value.kind) {
    case "string":
    case "number":
    case "boolean":
      return new Set();
    case "reference":
      return state.varSources.get(value.name) ?? new Set();
    case "dot_access":
      return analyzeValue(value.base, state, registry, fns, analyzing);
    case "index_access":
      return unionSources(
        analyzeValue(value.base, state, registry, fns, analyzing),
        analyzeValue(value.index, state, registry, fns, analyzing),
      );
    case "binary_op":
      return unionSources(
        analyzeValue(value.left, state, registry, fns, analyzing),
        analyzeValue(value.right, state, registry, fns, analyzing),
      );
    case "unary_op":
      return analyzeValue(value.operand, state, registry, fns, analyzing);
    case "ternary":
      return unionSources(
        analyzeValue(value.condition, state, registry, fns, analyzing),
        analyzeValue(value.then, state, registry, fns, analyzing),
        analyzeValue(value.else, state, registry, fns, analyzing),
      );
    case "array":
      return unionSources(
        ...value.elements.map((e) =>
          analyzeValue(e, state, registry, fns, analyzing)
        ),
      );
    case "object":
      return unionSources(
        ...value.fields.map((f) =>
          analyzeValue(f.value, state, registry, fns, analyzing)
        ),
      );
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
      const arraySources = analyzeValue(
        value.array,
        state,
        registry,
        fns,
        analyzing,
      );
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      const fnSig = analyzeFn(fn, registry, fns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Propagate data flow sinks with param substitution
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        const substituted = substituteSources(sources, fn.params, [
          arraySources,
        ]);
        addToSink(state, sink, substituted);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      // Result sources: function sources with param substitution
      return substituteSources(fnSig.sources, fn.params, [arraySources]);
    }
    case "filter": {
      const arraySources = analyzeValue(
        value.array,
        state,
        registry,
        fns,
        analyzing,
      );
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      const fnSig = analyzeFn(fn, registry, fns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Propagate data flow sinks with param substitution
      for (const [sink, sources] of fnSig.dataFlow) {
        if (sink === "return") continue;
        const substituted = substituteSources(sources, fn.params, [
          arraySources,
        ]);
        addToSink(state, sink, substituted);
      }
      state.memoryBytes += fnSig.memoryBytes;
      state.runtimeMs += fnSig.runtimeMs;
      state.diskBytes += fnSig.diskBytes;
      // Filter returns original elements, so sources = array sources
      return arraySources;
    }
    case "reduce": {
      const arraySources = analyzeValue(
        value.array,
        state,
        registry,
        fns,
        analyzing,
      );
      const initialSources = analyzeValue(
        value.initial,
        state,
        registry,
        fns,
        analyzing,
      );
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      const fnSig = analyzeFn(fn, registry, fns, analyzing);
      // Propagate side effects
      for (const h of fnSig.hosts) state.hosts.add(h);
      for (const e of fnSig.envReads) state.envReads.add(e);
      // Conservative: both params get union of initial + array sources
      const bothSources = unionSources(initialSources, arraySources);
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
      // Result sources: function sources with both param substitutions
      return substituteSources(fnSig.sources, fn.params, [
        bothSources,
        bothSources,
      ]);
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
): ReadonlySet<string> => {
  const fn = fns.get(fnName);
  if (!fn) throw new Error(`Unknown function: '${fnName}'`);
  const paramSourcesByName = new Map<string, ReadonlySet<string>>();
  for (const arg of args) {
    paramSourcesByName.set(
      arg.key,
      analyzeValue(arg.value, state, registry, fns, analyzing),
    );
  }
  const paramSources = fn.params.map(
    (p) => paramSourcesByName.get(p.name) ?? new Set<string>(),
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
  return substituteSources(fnSig.sources, fn.params, paramSources);
};

const analyzeCall = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): ReadonlySet<string> => {
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

  const inputSources = unionSources(
    ...args
      .filter((a) => !entry.staticFields.has(a.key))
      .map((a) => analyzeValue(a.value, state, registry, fns, analyzing)),
  );

  for (const h of manifest.hosts) {
    state.hosts.add(h);
    addToSink(state, `host:${h}`, inputSources);
  }

  if (manifest.tags.has("network")) {
    return new Set([...manifest.hosts].map((h) => `host:${h}`));
  }
  if (manifest.tags.has("time")) {
    state.envReads.add("timestamp");
    return new Set(["env:timestamp"]);
  }
  if (manifest.tags.has("random")) {
    state.envReads.add("randomBytes");
    return new Set(["env:randomBytes"]);
  }
  return inputSources;
};

const analyzeStatements = (
  stmts: readonly Statement[],
  state: AnalysisState,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
  analyzing?: Set<string>,
): void => {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        const sources = analyzeValue(
          stmt.value,
          state,
          registry,
          fns,
          analyzing,
        );
        state.varSources.set(stmt.name, sources);
        break;
      }
      case "void_call":
        analyzeCall(
          stmt.call.op,
          stmt.call.args,
          state,
          registry,
          fns,
          analyzing,
        );
        break;
      case "user_void_call":
        analyzeUserCall(stmt.fn, stmt.args, state, registry, fns, analyzing);
        break;
      case "if_else": {
        // Condition sources contribute to any variable assigned in branches
        analyzeValue(stmt.condition, state, registry, fns, analyzing);
        // Snapshot state before branches for conservative union
        const preMem = state.memoryBytes;
        const preRt = state.runtimeMs;
        const preDisk = state.diskBytes;
        const preVars = new Map(
          [...state.varSources.entries()].map(([k, v]) =>
            [k, new Set(v)] as const
          ),
        );
        // Analyze then branch
        analyzeStatements(stmt.then, state, registry, fns, analyzing);
        const thenMem = state.memoryBytes - preMem;
        const thenRt = state.runtimeMs - preRt;
        const thenDisk = state.diskBytes - preDisk;
        const thenVars = new Map(state.varSources);
        // Reset to pre-branch state for else analysis
        state.memoryBytes = preMem;
        state.runtimeMs = preRt;
        state.diskBytes = preDisk;
        for (const [k, v] of preVars) state.varSources.set(k, v);
        // Analyze else branch (if present)
        let elseMem = 0;
        let elseRt = 0;
        let elseDisk = 0;
        if (stmt.else) {
          analyzeStatements(stmt.else, state, registry, fns, analyzing);
          elseMem = state.memoryBytes - preMem;
          elseRt = state.runtimeMs - preRt;
          elseDisk = state.diskBytes - preDisk;
        }
        const elseVars = new Map(state.varSources);
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
        }
        break;
      }
    }
  }
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
    hosts: new Set(),
    envReads: new Set(),
    dataFlow: new Map(),
    memoryBytes: 0,
    runtimeMs: 0,
    diskBytes: 0,
  };

  for (const param of fn.params) {
    state.varSources.set(param.name, new Set([`param:${param.name}`]));
  }

  analyzeStatements(fn.body, state, registry, fns, stack);

  const sources = analyzeValue(
    fn.returnValue,
    state,
    registry,
    fns,
    stack,
  );
  addToSink(state, "return", sources);

  stack.delete(fn.name);

  return {
    name: fn.name,
    params: fn.params,
    returnType: fn.returnType,
    hosts: state.hosts,
    envReads: state.envReads,
    dataFlow: state.dataFlow,
    sources: sources,
    memoryBytes: state.memoryBytes,
    runtimeMs: state.runtimeMs,
    diskBytes: state.diskBytes,
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
