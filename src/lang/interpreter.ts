import type { FnDef, OpCall, Program, Statement, Value } from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import type { ExecutionContext } from "../types.ts";
import { runWithContext } from "../context.ts";
import { builtinRegistry } from "./registry.ts";

type Env = ReadonlyMap<string, unknown>;
type FnMap = ReadonlyMap<string, FnDef>;

const resolveValue = async (
  value: Value,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
): Promise<unknown> => {
  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "reference": {
      if (!env.has(value.name)) {
        throw new Error(`Undefined reference: '${value.name}'`);
      }
      return env.get(value.name);
    }
    case "dot_access": {
      const base = await resolveValue(value.base, env, registry, fns);
      if (typeof base !== "object" || base === null) {
        throw new Error(`Cannot access field '${value.field}' on non-object`);
      }
      return (base as Record<string, unknown>)[value.field];
    }
    case "array": {
      const elements = [];
      for (const el of value.elements) {
        elements.push(await resolveValue(el, env, registry, fns));
      }
      return elements;
    }
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const f of value.fields) {
        obj[f.key] = await resolveValue(f.value, env, registry, fns);
      }
      return obj;
    }
    case "call":
      return executeCall(
        { op: value.op, args: value.args },
        env,
        registry,
        fns,
      );
    case "binary_op": {
      const left = await resolveValue(value.left, env, registry, fns);
      const right = await resolveValue(value.right, env, registry, fns);
      return evalBinaryOp(value.op, left, right);
    }
    case "unary_op": {
      const operand = await resolveValue(value.operand, env, registry, fns);
      if (typeof operand !== "number") {
        throw new Error(`Unary '-' requires a number, got ${typeof operand}`);
      }
      return -operand;
    }
    case "ternary": {
      const condition = await resolveValue(value.condition, env, registry, fns);
      return condition
        ? resolveValue(value.then, env, registry, fns)
        : resolveValue(value.else, env, registry, fns);
    }
    case "map": {
      const arr = await resolveValue(
        value.array,
        env,
        registry,
        fns,
      ) as unknown[];
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      if (fn.params.length !== 1) {
        throw new Error(
          `map function '${value.fn}' must take exactly 1 parameter, got ${fn.params.length}`,
        );
      }
      return Promise.all(
        arr.map((el) =>
          executeFn(fn, { [fn.params[0].name]: el }, registry, fns)
        ),
      );
    }
    case "filter": {
      const arr = await resolveValue(
        value.array,
        env,
        registry,
        fns,
      ) as unknown[];
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      if (fn.params.length !== 1) {
        throw new Error(
          `filter function '${value.fn}' must take exactly 1 parameter, got ${fn.params.length}`,
        );
      }
      const results = await Promise.all(arr.map(async (el) => ({
        el,
        keep: await executeFn(fn, { [fn.params[0].name]: el }, registry, fns),
      })));
      return results.filter((r) => r.keep).map((r) => r.el);
    }
    case "reduce": {
      const arr = await resolveValue(
        value.array,
        env,
        registry,
        fns,
      ) as unknown[];
      const initial = await resolveValue(value.initial, env, registry, fns);
      const fn = fns.get(value.fn);
      if (!fn) throw new Error(`Unknown function: '${value.fn}'`);
      if (fn.params.length !== 2) {
        throw new Error(
          `reduce function '${value.fn}' must take exactly 2 parameters, got ${fn.params.length}`,
        );
      }
      let acc = initial;
      for (const el of arr) {
        acc = await executeFn(
          fn,
          { [fn.params[0].name]: acc, [fn.params[1].name]: el },
          registry,
          fns,
        );
      }
      return acc;
    }
  }
};

const evalBinaryOp = (op: string, left: unknown, right: unknown): unknown => {
  if (op === "+") {
    if (typeof left === "string" && typeof right === "string") {
      return left + right;
    }
    if (typeof left === "number" && typeof right === "number") {
      return left + right;
    }
    throw new Error(`Cannot apply '+' to ${typeof left} and ${typeof right}`);
  }
  if (typeof left !== "number" || typeof right !== "number") {
    if (op === "==" || op === "!=") {
      return op === "==" ? left === right : left !== right;
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
    case "==":
      return left === right;
    case "!=":
      return left !== right;
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

const executeCall = async (
  call: OpCall,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
): Promise<unknown> => {
  const entry = registry.get(call.op);
  if (!entry) throw new Error(`Unknown op: '${call.op}'`);

  const staticParams: Record<string, unknown> = {};
  const dynamicParams: Record<string, unknown> = {};

  for (const arg of call.args) {
    if (entry.staticFields.has(arg.key)) {
      if (
        arg.value.kind !== "string" && arg.value.kind !== "number" &&
        arg.value.kind !== "boolean"
      ) {
        throw new Error(
          `Static field '${arg.key}' on op '${call.op}' must be a literal, got '${arg.value.kind}'`,
        );
      }
      staticParams[arg.key] = arg.value.value;
    } else {
      dynamicParams[arg.key] = await resolveValue(
        arg.value,
        env,
        registry,
        fns,
      );
    }
  }

  const dagOp = entry.create(staticParams);
  return dagOp.run(dynamicParams);
};

const executeStatements = async (
  stmts: readonly Statement[],
  env: Map<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
): Promise<void> => {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        const result = await resolveValue(stmt.value, env, registry, fns);
        env.set(stmt.name, result);
        break;
      }
      case "void_call":
        await executeCall(stmt.call, env, registry, fns);
        break;
      case "if_else": {
        const condition = await resolveValue(
          stmt.condition,
          env,
          registry,
          fns,
        );
        if (condition) {
          await executeStatements(stmt.then, env, registry, fns);
        } else if (stmt.else) {
          await executeStatements(stmt.else, env, registry, fns);
        }
        break;
      }
    }
  }
};

const executeFn = async (
  fn: FnDef,
  args: Record<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
  fns: FnMap,
): Promise<unknown> => {
  const env = new Map<string, unknown>();

  for (const param of fn.params) {
    if (!(param.name in args)) {
      throw new Error(`Missing argument: '${param.name}'`);
    }
    env.set(param.name, args[param.name]);
  }

  await executeStatements(fn.body, env, registry, fns);

  return resolveValue(fn.returnValue, env, registry, fns);
};

export const interpret = async (
  program: Program,
  functionName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  registry: ReadonlyMap<string, OpEntry> = builtinRegistry,
): Promise<unknown> => {
  const fn = program.functions.find((f) => f.name === functionName);
  if (!fn) throw new Error(`Function '${functionName}' not found`);
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  return runWithContext(ctx, () => executeFn(fn, args, registry, fns));
};
