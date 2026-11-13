// Graph IR executor — runs a branded Dag with given param bindings.
//
// Execution state (ExecutionContext, composeLookup, step counter, recursion
// depth) is threaded explicitly through every call so concurrent executions
// never share mutable module-level stacks across awaits.

import { runWithContext } from "../context.ts";
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from "../ops/pure.ts";
import type { ExecutionContext } from "../types.ts";
import {
  type Dag,
  type EffectNode,
  type GraphNode,
  isGenuineDag,
  type NodeId,
} from "./graph.ts";
import type { OpEntry } from "./registry.ts";

export const MAX_EXECUTION_STEPS = 100_000;
export const MAX_CALL_DEPTH = 64;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type NodeCache = Map<NodeId, unknown>;
type Env = Map<string, unknown>;

export type ExecOptions = {
  readonly ctx?: ExecutionContext;
  readonly composeLookup?: (name: string) => Dag | undefined;
  readonly steps?: { count: number };
  readonly depth?: number;
};

type ExecState = {
  readonly ctx?: ExecutionContext;
  readonly composeLookup?: (name: string) => Dag | undefined;
  readonly steps: { count: number };
  readonly depth: number;
};

const tickStep = (exec: ExecState): void => {
  exec.steps.count++;
  if (exec.steps.count > MAX_EXECUTION_STEPS) {
    throw new Error(
      `Execution step budget exceeded (${MAX_EXECUTION_STEPS})`,
    );
  }
};

const defineSafeProp = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (key === "then" && typeof value === "function") {
    throw new Error("Function-valued 'then' property (thenable) is forbidden");
  }
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

const assertNotThenable = (value: unknown): void => {
  if (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new Error("Thenable objects are forbidden in Safescript values");
  }
};

const evalNode = async (
  id: NodeId,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<unknown> => {
  const node = dag.nodes[id];
  if (!node) {
    throw new Error(`Internal: invalid NodeId ${id}`);
  }
  if (node.kind === "var_read") {
    tickStep(exec);
    if (!env.has(node.name)) {
      throw new Error(`Undefined reference: '${node.name}'`);
    }
    return env.get(node.name);
  }
  if (cache.has(id)) return cache.get(id);
  tickStep(exec);
  const result = await computeNode(node, dag, cache, env, registry, exec);
  assertNotThenable(result);
  cache.set(id, result);
  return result;
};

const computeNode = async (
  node: GraphNode,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<unknown> => {
  switch (node.kind) {
    case "param":
      throw new Error(`Internal: param '${node.name}' not bound in cache`);
    case "var_read":
      throw new Error(`Internal: var_read should not reach computeNode`);
    case "literal":
      return node.value;
    case "array": {
      if (node.elements.length > MAX_ARRAY_LENGTH) {
        throw new Error(
          `Array length exceeds maximum allowed (${MAX_ARRAY_LENGTH})`,
        );
      }
      const out: unknown[] = [];
      for (const e of node.elements) {
        out.push(await evalNode(e, dag, cache, env, registry, exec));
      }
      return out;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) {
        const val = await evalNode(f.value, dag, cache, env, registry, exec);
        defineSafeProp(out, f.key, val);
      }
      return out;
    }
    case "field": {
      if (FORBIDDEN_KEYS.has(node.field)) {
        throw new Error(`Forbidden property access: '${node.field}'`);
      }
      const base = await evalNode(node.base, dag, cache, env, registry, exec);
      if (base === null || base === undefined) return undefined;
      if (Array.isArray(base)) {
        if (node.field === "length") return base.length;
        if (
          node.field === "value" ||
          node.field === "result" ||
          node.field === "array" ||
          node.field === "parts"
        ) {
          return base;
        }
        return undefined;
      }
      if (typeof base === "string") {
        if (node.field === "length") return base.length;
        if (
          node.field === "text" ||
          node.field === "result" ||
          node.field === "value" ||
          node.field === "encoded" ||
          node.field === "hash" ||
          node.field === "bytes"
        ) {
          return base;
        }
        throw new Error(`Cannot access field '${node.field}' on non-object`);
      }
      if (typeof base === "number") {
        if (
          node.field === "value" ||
          node.field === "result" ||
          node.field === "timestamp" ||
          node.field === "length"
        ) {
          return base;
        }
        throw new Error(`Cannot access field '${node.field}' on non-object`);
      }
      if (typeof base === "boolean") {
        if (
          node.field === "value" ||
          node.field === "result" ||
          node.field === "ok"
        ) {
          return base;
        }
        throw new Error(`Cannot access field '${node.field}' on non-object`);
      }
      if (typeof base !== "object") {
        throw new Error(`Cannot access field '${node.field}' on non-object`);
      }
      const obj = base as Record<string, unknown>;
      if (
        (node.field === "value" ||
          node.field === "result" ||
          node.field === "obj") &&
        !Object.hasOwn(obj, node.field)
      ) {
        return obj;
      }
      return Object.hasOwn(obj, node.field) ? obj[node.field] : undefined;
    }
    case "index": {
      const base = await evalNode(node.base, dag, cache, env, registry, exec);
      const idx = await evalNode(node.index, dag, cache, env, registry, exec);
      if (typeof idx === "string" && FORBIDDEN_KEYS.has(idx)) {
        throw new Error(`Forbidden property access: '${idx}'`);
      }
      if (Array.isArray(base)) {
        if (typeof idx !== "number" || !Number.isInteger(idx)) {
          throw new Error(`Array index must be an integer, got ${typeof idx}`);
        }
        return idx >= 0 && idx < base.length && Object.hasOwn(base, idx)
          ? base[idx]
          : undefined;
      }
      if (
        base !== null && typeof base === "object" && typeof idx === "string"
      ) {
        const obj = base as Record<string, unknown>;
        return Object.hasOwn(obj, idx) ? obj[idx] : undefined;
      }
      throw new Error("Cannot index non-array value");
    }
    case "binary": {
      if (node.op === "&&") {
        const l = await evalNode(node.left, dag, cache, env, registry, exec);
        if (!l) return l;
        return await evalNode(node.right, dag, cache, env, registry, exec);
      }
      if (node.op === "||") {
        const l = await evalNode(node.left, dag, cache, env, registry, exec);
        if (l) return l;
        return await evalNode(node.right, dag, cache, env, registry, exec);
      }
      const l = await evalNode(node.left, dag, cache, env, registry, exec);
      const r = await evalNode(node.right, dag, cache, env, registry, exec);
      return evalBinary(node.op, l, r);
    }
    case "unary": {
      const v = await evalNode(node.operand, dag, cache, env, registry, exec);
      if (node.op === "!") return !v;
      if (typeof v !== "number") {
        throw new Error(`Unary '-' requires number, got ${typeof v}`);
      }
      return -v;
    }
    case "ternary": {
      const c = await evalNode(node.cond, dag, cache, env, registry, exec);
      const branch = c ? node.then : node.else;
      return evalNode(branch, dag, cache, env, registry, exec);
    }
    case "op":
      return evalOp(node, dag, cache, env, registry, exec);
    case "compose":
      return evalCompose(node, dag, cache, env, registry, exec);
    case "dagvalue":
      return node.dag;
    case "apply": {
      const innerDag = await evalNode(
        node.fn,
        dag,
        cache,
        env,
        registry,
        exec,
      );
      if (!isGenuineDag(innerDag)) {
        throw new Error(
          `apply: fn expression did not evaluate to a valid Dag (got ${typeof innerDag})`,
        );
      }
      const argMap: Record<string, unknown> = {};
      for (const a of node.args) {
        const val = await evalNode(a.value, dag, cache, env, registry, exec);
        defineSafeProp(argMap, a.key, val);
      }
      return executeDagInternal(innerDag, argMap, registry, {
        ...exec,
        depth: exec.depth + 1,
      });
    }
  }
};

const evalOp = async (
  node: Extract<GraphNode, { kind: "op" }>,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<unknown> => {
  if (node.label === "__map" || node.label === "__filter") {
    const fnArg = node.args.find((a) => a.key === "fn");
    const arrArg = node.args.find((a) => a.key === "array");
    if (!fnArg || !arrArg) {
      throw new Error(`${node.label} missing required args`);
    }
    const innerDag = await evalNode(
      fnArg.value,
      dag,
      cache,
      env,
      registry,
      exec,
    );
    if (!isGenuineDag(innerDag)) {
      const opName = node.label === "__map" ? "map" : "filter";
      throw new Error(
        `${opName}() first argument did not evaluate to a valid function Dag`,
      );
    }
    const arr = await evalNode(
      arrArg.value,
      dag,
      cache,
      env,
      registry,
      exec,
    );
    if (!Array.isArray(arr)) {
      const opName = node.label === "__map" ? "map" : "filter";
      const actualDesc = arr === null
        ? "null"
        : typeof arr === "object"
        ? `object with keys [${
          Object.keys(arr as Record<string, unknown>).join(", ")
        }]`
        : typeof arr;
      throw new Error(
        `${opName}() expects an array as its second argument, got ${actualDesc}`,
      );
    }
    if (arr.length > MAX_ARRAY_LENGTH) {
      throw new Error(
        `Array length exceeds maximum allowed (${MAX_ARRAY_LENGTH})`,
      );
    }
    const capArgs = node.args.filter((a) => a.key.startsWith("cap:"));
    const capEntries: Array<readonly [string, unknown]> = [];
    for (const ca of capArgs) {
      const val = await evalNode(ca.value, dag, cache, env, registry, exec);
      capEntries.push([ca.key.slice(4), val]);
    }
    const expectedArity = 1 + capArgs.length;
    if (innerDag.params.length !== expectedArity) {
      throw new Error(
        `${node.label} fn '${innerDag.label}' must take 1 parameter, got ${innerDag.params.length}`,
      );
    }
    const pname = innerDag.params[0].name;
    const buildIterArgs = (el: unknown): Record<string, unknown> => {
      const callArgs: Record<string, unknown> = {};
      for (const [k, v] of capEntries) defineSafeProp(callArgs, k, v);
      defineSafeProp(callArgs, pname, el);
      return callArgs;
    };
    const nextExec: ExecState = { ...exec, depth: exec.depth + 1 };
    if (node.label === "__map") {
      return Promise.all(
        arr.map((el) =>
          executeDagInternal(innerDag, buildIterArgs(el), registry, nextExec)
        ),
      );
    }
    const flags = await Promise.all(
      arr.map((el) =>
        executeDagInternal(innerDag, buildIterArgs(el), registry, nextExec)
      ),
    );
    return arr.filter((_, i) => flags[i]);
  }
  if (node.label === "__reduce") {
    const fnArg = node.args.find((a) => a.key === "fn");
    const initArg = node.args.find((a) => a.key === "initial");
    const arrArg = node.args.find((a) => a.key === "array");
    if (!fnArg || !initArg || !arrArg) {
      throw new Error("reduce missing required args");
    }
    const innerDag = await evalNode(
      fnArg.value,
      dag,
      cache,
      env,
      registry,
      exec,
    );
    if (!isGenuineDag(innerDag)) {
      throw new Error(
        "reduce() first argument did not evaluate to a valid function Dag",
      );
    }
    const init = await evalNode(initArg.value, dag, cache, env, registry, exec);
    const arr = await evalNode(
      arrArg.value,
      dag,
      cache,
      env,
      registry,
      exec,
    );
    if (!Array.isArray(arr)) {
      const actualDesc = arr === null
        ? "null"
        : typeof arr === "object"
        ? `object with keys [${
          Object.keys(arr as Record<string, unknown>).join(", ")
        }]`
        : typeof arr;
      throw new Error(
        `reduce() expects an array as its third argument, got ${actualDesc}`,
      );
    }
    if (arr.length > MAX_ARRAY_LENGTH) {
      throw new Error(
        `Array length exceeds maximum allowed (${MAX_ARRAY_LENGTH})`,
      );
    }
    const capArgs = node.args.filter((a) => a.key.startsWith("cap:"));
    const capEntries: Array<readonly [string, unknown]> = [];
    for (const ca of capArgs) {
      const val = await evalNode(ca.value, dag, cache, env, registry, exec);
      capEntries.push([ca.key.slice(4), val]);
    }
    const expectedArity = 2 + capArgs.length;
    if (innerDag.params.length !== expectedArity) {
      throw new Error(
        `reduce fn '${innerDag.label}' must take 2 parameters, got ${innerDag.params.length}`,
      );
    }
    const p0 = innerDag.params[0].name;
    const p1 = innerDag.params[1].name;
    const nextExec: ExecState = { ...exec, depth: exec.depth + 1 };
    return arr.reduce(
      async (accP, el) => {
        const accVal = await accP;
        const callArgs: Record<string, unknown> = {};
        for (const [k, v] of capEntries) defineSafeProp(callArgs, k, v);
        defineSafeProp(callArgs, p0, accVal);
        defineSafeProp(callArgs, p1, el);
        return executeDagInternal(innerDag, callArgs, registry, nextExec);
      },
      Promise.resolve(init),
    );
  }
  if (node.label === "len") {
    const valArg = node.args.find((a) => a.key === "value") ?? node.args[0];
    if (!valArg) return 0;
    const val = await evalNode(valArg.value, dag, cache, env, registry, exec);
    return Array.isArray(val) || typeof val === "string" ? val.length : 0;
  }
  const entry = registry.get(node.label);
  if (!entry) throw new Error(`Unknown op: '${node.label}'`);
  const staticParams: Record<string, unknown> = {};
  const dynamicParams: Record<string, unknown> = {};
  for (const a of node.staticArgs) {
    if (
      entry.staticFields.has(a.key) ||
      (entry.resolveStaticParams && a.key === "url")
    ) {
      defineSafeProp(staticParams, a.key, a.value);
    }
    defineSafeProp(dynamicParams, a.key, a.value);
  }
  for (const a of node.args) {
    const val = await evalNode(a.value, dag, cache, env, registry, exec);
    defineSafeProp(dynamicParams, a.key, val);
  }
  const resolvedStaticParams = entry.resolveStaticParams
    ? entry.resolveStaticParams(staticParams)
    : staticParams;
  for (const f of entry.staticFields) {
    const sv = resolvedStaticParams[f];
    const dv = dynamicParams[f];
    if ((sv === undefined || sv === "") && (dv === undefined || dv === "")) {
      throw new Error(`Op '${node.label}' missing static field '${f}'`);
    }
  }
  const dagOp = entry.create(resolvedStaticParams);
  return exec.ctx
    ? runWithContext(exec.ctx, () => Promise.resolve(dagOp.run(dynamicParams)))
    : dagOp.run(dynamicParams);
};

const evalCompose = async (
  node: Extract<GraphNode, { kind: "compose" }>,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<unknown> => {
  const innerDag = node.dag ?? (() => {
    if (!exec.composeLookup) {
      throw new Error("Internal: compose registry not bound");
    }
    const found = exec.composeLookup(node.label);
    if (!found) throw new Error(`Unknown function: '${node.label}'`);
    return found;
  })();
  if (!isGenuineDag(innerDag)) {
    throw new Error(`compose target '${node.label}' is not a valid Dag`);
  }
  const args: Record<string, unknown> = {};
  for (const a of node.args) {
    const val = await evalNode(a.value, dag, cache, env, registry, exec);
    defineSafeProp(args, a.key, val);
  }
  return executeDagInternal(innerDag, args, registry, {
    ...exec,
    depth: exec.depth + 1,
  });
};

const isNullish = (v: unknown): boolean => v === null || v === undefined;

const evalBinary = (op: string, left: unknown, right: unknown): unknown => {
  if (op === "+") {
    if (typeof left === "number" && typeof right === "number") {
      return left + right;
    }
    const isPrimStr = (v: unknown) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    if (
      (typeof left === "string" && isPrimStr(right)) ||
      (isPrimStr(left) && typeof right === "string")
    ) {
      const sl = String(left);
      const sr = String(right);
      if (sl.length + sr.length > MAX_STRING_LENGTH) {
        throw new Error(
          `String concatenation exceeds maximum string length (${MAX_STRING_LENGTH})`,
        );
      }
      return sl + sr;
    }
    throw new Error(`Cannot apply '+' to ${typeof left} and ${typeof right}`);
  }
  if (op === "==" || op === "!=") {
    const eq = (isNullish(left) && isNullish(right)) || left === right;
    return op === "==" ? eq : !eq;
  }
  if (typeof left !== "number" || typeof right !== "number") {
    if (op === "&&") {
      return Boolean(left) && Boolean(right);
    }
    if (op === "||") {
      return Boolean(left) || Boolean(right);
    }
    throw new Error(
      `Cannot apply '${op}' to ${typeof left} and ${typeof right}`,
    );
  }
  switch (op) {
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    case "<":
      return left < right;
    case ">":
      return left > right;
    case "<=":
      return left <= right;
    case ">=":
      return left >= right;
    default:
      throw new Error(`Unknown binary op: '${op}'`);
  }
};

const runEffects = async (
  effects: readonly EffectNode[],
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<void> => {
  for (const e of effects) {
    tickStep(exec);
    switch (e.kind) {
      case "assign": {
        const v = await evalNode(e.value, dag, cache, env, registry, exec);
        env.set(e.name, v);
        break;
      }
      case "void_op": {
        const fakeNode: GraphNode = {
          kind: "op",
          label: e.label,
          staticArgs: e.staticArgs,
          args: e.args,
        };
        await evalOp(fakeNode, dag, cache, env, registry, exec);
        break;
      }
      case "void_compose": {
        const fakeNode: GraphNode = {
          kind: "compose",
          label: e.label,
          dag: e.dag,
          args: e.args,
        };
        await evalCompose(fakeNode, dag, cache, env, registry, exec);
        break;
      }
      case "if_else": {
        const c = await evalNode(e.cond, dag, cache, env, registry, exec);
        if (c) {
          await runEffects(e.then, dag, cache, env, registry, exec);
        } else if (e.else) {
          await runEffects(e.else, dag, cache, env, registry, exec);
        }
        break;
      }
    }
  }
};

const executeDagInternal = async (
  dag: Dag,
  args: Record<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
  exec: ExecState,
): Promise<unknown> => {
  if (!isGenuineDag(dag)) {
    throw new Error("Refusing to execute unbranded or forged Dag");
  }
  if (exec.depth > MAX_CALL_DEPTH) {
    throw new Error(
      `Maximum call recursion depth (${MAX_CALL_DEPTH}) exceeded`,
    );
  }
  tickStep(exec);
  const cache: NodeCache = new Map();
  const env: Env = new Map();
  for (let i = 0; i < dag.params.length; i++) {
    const param = dag.params[i];
    const name = param.name;
    const hasNamed = Object.hasOwn(args, name);
    const hasPos = Object.hasOwn(args, `__arg${i}`);
    const rawVal = hasNamed && args[name] !== undefined
      ? args[name]
      : hasPos && args[`__arg${i}`] !== undefined
      ? args[`__arg${i}`]
      : undefined;
    const resolvedVal = rawVal !== undefined
      ? rawVal
      : param.defaultValue
      ? param.defaultValue.value
      : (hasNamed || hasPos)
      ? undefined
      : (() => {
        throw new Error(`Missing argument: '${name}'`);
      })();
    assertNotThenable(resolvedVal);
    cache.set(i, resolvedVal);
  }
  await runEffects(dag.effects, dag, cache, env, registry, exec);
  return evalNode(dag.output, dag, cache, env, registry, exec);
};

export const executeDag = (
  dag: Dag,
  args: Record<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
  options?: ExecOptions,
): Promise<unknown> =>
  executeDagInternal(dag, args, registry, {
    ctx: options?.ctx,
    composeLookup: options?.composeLookup,
    steps: options?.steps ?? { count: 0 },
    depth: options?.depth ?? 0,
  });
