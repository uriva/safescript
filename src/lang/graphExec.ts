// Graph IR executor — runs a Dag with given param bindings.
//
// Lazy memoized evaluation of nodes within a single Dag: each NodeId computes
// at most once per invocation. Effects run sequentially in declaration order
// (assignments rebind names in the local env, void calls perform their
// side effects, if/else branches recurse).
//
// Calls into other Dags (compose nodes, dagvalue invocations from
// __map/__filter/__reduce) recurse via executeDag with a fresh per-call cache.

import type { Dag, EffectNode, GraphNode, NodeId } from "./graph.ts";
import type { OpEntry } from "./registry.ts";

type NodeCache = Map<NodeId, unknown>;
type Env = Map<string, unknown>;

const evalNode = async (
  id: NodeId,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<unknown> => {
  const node = dag.nodes[id];
  // var_read is not cacheable: its value depends on the current env at the
  // moment of read, which may change as assign effects run.
  if (node.kind === "var_read") {
    if (!env.has(node.name)) {
      throw new Error(`Undefined reference: '${node.name}'`);
    }
    return env.get(node.name);
  }
  if (cache.has(id)) return cache.get(id);
  const result = await computeNode(node, dag, cache, env, registry);
  cache.set(id, result);
  return result;
};

const computeNode = async (
  node: GraphNode,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<unknown> => {
  switch (node.kind) {
    case "param":
      throw new Error(`Internal: param '${node.name}' not bound in cache`);
    case "var_read":
      throw new Error(`Internal: var_read should not reach computeNode`);
    case "literal":
      return node.value;
    case "array": {
      const out: unknown[] = [];
      for (const e of node.elements) {
        out.push(await evalNode(e, dag, cache, env, registry));
      }
      return out;
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) {
        out[f.key] = await evalNode(f.value, dag, cache, env, registry);
      }
      return out;
    }
    case "field": {
      const base = await evalNode(node.base, dag, cache, env, registry);
      if (Array.isArray(base) && node.field === "length") return base.length;
      if (typeof base !== "object" || base === null) {
        throw new Error(`Cannot access field '${node.field}' on non-object`);
      }
      return (base as Record<string, unknown>)[node.field];
    }
    case "index": {
      const base = await evalNode(node.base, dag, cache, env, registry);
      const idx = await evalNode(node.index, dag, cache, env, registry);
      if (!Array.isArray(base)) throw new Error("Cannot index non-array value");
      if (typeof idx !== "number") {
        throw new Error(`Array index must be a number, got ${typeof idx}`);
      }
      return base[idx];
    }
    case "binary": {
      const l = await evalNode(node.left, dag, cache, env, registry);
      const r = await evalNode(node.right, dag, cache, env, registry);
      return evalBinary(node.op, l, r);
    }
    case "unary": {
      const v = await evalNode(node.operand, dag, cache, env, registry);
      if (node.op === "!") return !v;
      if (typeof v !== "number") {
        throw new Error(`Unary '-' requires number, got ${typeof v}`);
      }
      return -v;
    }
    case "ternary": {
      const c = await evalNode(node.cond, dag, cache, env, registry);
      const branch = c ? node.then : node.else;
      return evalNode(branch, dag, cache, env, registry);
    }
    case "op":
      return evalOp(node, dag, cache, env, registry);
    case "compose":
      return evalCompose(node, dag, cache, env, registry);
    case "dagvalue":
      return node.dag;
  }
};

const evalOp = async (
  node: Extract<GraphNode, { kind: "op" }>,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<unknown> => {
  if (node.label === "__map" || node.label === "__filter") {
    const fnArg = node.args.find((a) => a.key === "fn");
    const arrArg = node.args.find((a) => a.key === "array");
    if (!fnArg || !arrArg) {
      throw new Error(`${node.label} missing required args`);
    }
    const innerDag = await evalNode(fnArg.value, dag, cache, env, registry) as Dag;
    const arr = await evalNode(arrArg.value, dag, cache, env, registry) as unknown[];
    if (innerDag.params.length !== 1) {
      throw new Error(
        `${node.label} fn '${innerDag.label}' must take 1 parameter, got ${innerDag.params.length}`,
      );
    }
    const pname = innerDag.params[0].name;
    if (node.label === "__map") {
      return Promise.all(
        arr.map((el) => executeDag(innerDag, { [pname]: el }, registry)),
      );
    }
    const flags = await Promise.all(
      arr.map((el) => executeDag(innerDag, { [pname]: el }, registry)),
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
    const innerDag = await evalNode(fnArg.value, dag, cache, env, registry) as Dag;
    const init = await evalNode(initArg.value, dag, cache, env, registry);
    const arr = await evalNode(arrArg.value, dag, cache, env, registry) as unknown[];
    if (innerDag.params.length !== 2) {
      throw new Error(
        `reduce fn '${innerDag.label}' must take 2 parameters, got ${innerDag.params.length}`,
      );
    }
    const p0 = innerDag.params[0].name;
    const p1 = innerDag.params[1].name;
    return arr.reduce(
      async (accP, el) => executeDag(
        innerDag,
        { [p0]: await accP, [p1]: el },
        registry,
      ),
      Promise.resolve(init),
    );
  }
  const entry = registry.get(node.label);
  if (!entry) throw new Error(`Unknown op: '${node.label}'`);
  const staticParams: Record<string, unknown> = {};
  const dynamicParams: Record<string, unknown> = {};
  for (const a of node.staticArgs) {
    if (entry.staticFields.has(a.key)) staticParams[a.key] = a.value;
    else dynamicParams[a.key] = a.value;
  }
  for (const a of node.args) {
    dynamicParams[a.key] = await evalNode(a.value, dag, cache, env, registry);
  }
  for (const f of entry.staticFields) {
    if (!(f in staticParams) && !(f in dynamicParams)) {
      throw new Error(`Op '${node.label}' missing static field '${f}'`);
    }
  }
  const dagOp = entry.create(staticParams);
  return dagOp.run(dynamicParams);
};

const evalCompose = async (
  node: Extract<GraphNode, { kind: "compose" }>,
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<unknown> => {
  const innerDag = node.dag ?? (() => {
    const lookup = composeRegistry.get();
    if (!lookup) throw new Error("Internal: compose registry not bound");
    const found = lookup(node.label);
    if (!found) throw new Error(`Unknown function: '${node.label}'`);
    return found;
  })();
  const args: Record<string, unknown> = {};
  for (const a of node.args) {
    args[a.key] = await evalNode(a.value, dag, cache, env, registry);
  }
  return executeDag(innerDag, args, registry);
};

// Per-execution-tree registry for resolving compose labels → Dag. Module-level
// stack so nested executeDag calls inherit the outer lookup.
const composeRegistry = (() => {
  const stack: Array<(name: string) => Dag | undefined> = [];
  return {
    get: () => stack[stack.length - 1],
    push: (lookup: (name: string) => Dag | undefined) => stack.push(lookup),
    pop: () => stack.pop(),
  };
})();

const evalBinary = (op: string, left: unknown, right: unknown): unknown => {
  if (op === "+") {
    if (typeof left === "string" && typeof right === "string") return left + right;
    if (typeof left === "number" && typeof right === "number") return left + right;
    throw new Error(`Cannot apply '+' to ${typeof left} and ${typeof right}`);
  }
  if (typeof left !== "number" || typeof right !== "number") {
    if (op === "==" || op === "!=") {
      return op === "==" ? left === right : left !== right;
    }
    throw new Error(`Cannot apply '${op}' to ${typeof left} and ${typeof right}`);
  }
  switch (op) {
    case "-": return left - right;
    case "*": return left * right;
    case "/": return left / right;
    case "%": return left % right;
    case "==": return left === right;
    case "!=": return left !== right;
    case "<": return left < right;
    case ">": return left > right;
    case "<=": return left <= right;
    case ">=": return left >= right;
    default: throw new Error(`Unknown binary op: '${op}'`);
  }
};

const runEffects = async (
  effects: readonly EffectNode[],
  dag: Dag,
  cache: NodeCache,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<void> => {
  for (const e of effects) {
    switch (e.kind) {
      case "assign": {
        const v = await evalNode(e.value, dag, cache, env, registry);
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
        await evalOp(fakeNode, dag, cache, env, registry);
        break;
      }
      case "void_compose": {
        const fakeNode: GraphNode = {
          kind: "compose",
          label: e.label,
          dag: e.dag,
          args: e.args,
        };
        await evalCompose(fakeNode, dag, cache, env, registry);
        break;
      }
      case "if_else": {
        const c = await evalNode(e.cond, dag, cache, env, registry);
        if (c) {
          await runEffects(e.then, dag, cache, env, registry);
        } else if (e.else) {
          await runEffects(e.else, dag, cache, env, registry);
        }
        break;
      }
    }
  }
};

export const executeDag = async (
  dag: Dag,
  args: Record<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<unknown> => {
  const cache: NodeCache = new Map();
  const env: Env = new Map();
  for (const i of dag.nodes.keys()) {
    const n = dag.nodes[i];
    if (n.kind !== "param") break;
    if (!(n.name in args)) throw new Error(`Missing argument: '${n.name}'`);
    cache.set(i, args[n.name]);
  }
  await runEffects(dag.effects, dag, cache, env, registry);
  return evalNode(dag.output, dag, cache, env, registry);
};

// Bind a compose-label resolver for the duration of `body`. Used by the
// top-level interpreter to wire user-fn dispatch.
export const withComposeRegistry = async <T>(
  lookup: (name: string) => Dag | undefined,
  body: () => Promise<T>,
): Promise<T> => {
  composeRegistry.push(lookup);
  try {
    return await body();
  } finally {
    composeRegistry.pop();
  }
};
