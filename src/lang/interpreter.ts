import type { FnDef, OpCall, Program, Statement, Value } from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import type { ExecutionContext } from "../types.ts";
import { runWithContext } from "../context.ts";
import { builtinRegistry } from "./registry.ts";

type Env = ReadonlyMap<string, unknown>;

const resolveValue = async (
  value: Value,
  env: Env,
  registry: ReadonlyMap<string, OpEntry>,
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
      const base = await resolveValue(value.base, env, registry);
      if (typeof base !== "object" || base === null) {
        throw new Error(`Cannot access field '${value.field}' on non-object`);
      }
      return (base as Record<string, unknown>)[value.field];
    }
    case "array": {
      const elements = [];
      for (const el of value.elements) {
        elements.push(await resolveValue(el, env, registry));
      }
      return elements;
    }
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const f of value.fields) {
        obj[f.key] = await resolveValue(f.value, env, registry);
      }
      return obj;
    }
    case "call":
      return executeCall({ op: value.op, args: value.args }, env, registry);
    case "binary_op": {
      const left = await resolveValue(value.left, env, registry);
      const right = await resolveValue(value.right, env, registry);
      return evalBinaryOp(value.op, left, right);
    }
    case "unary_op": {
      const operand = await resolveValue(value.operand, env, registry);
      if (typeof operand !== "number") {
        throw new Error(`Unary '-' requires a number, got ${typeof operand}`);
      }
      return -operand;
    }
    case "ternary": {
      const condition = await resolveValue(value.condition, env, registry);
      return condition
        ? resolveValue(value.then, env, registry)
        : resolveValue(value.else, env, registry);
    }
  }
};

const evalBinaryOp = (op: string, left: unknown, right: unknown): unknown => {
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
): Promise<unknown> => {
  const entry = registry.get(call.op);
  if (!entry) throw new Error(`Unknown op: '${call.op}'`);

  const staticParams: Record<string, unknown> = {};
  const dynamicParams: Record<string, unknown> = {};

  for (const arg of call.args) {
    if (entry.staticFields.has(arg.key)) {
      if (arg.value.kind !== "string" && arg.value.kind !== "number" && arg.value.kind !== "boolean") {
        throw new Error(
          `Static field '${arg.key}' on op '${call.op}' must be a literal, got '${arg.value.kind}'`,
        );
      }
      staticParams[arg.key] = arg.value.value;
    } else {
      dynamicParams[arg.key] = await resolveValue(arg.value, env, registry);
    }
  }

  const dagOp = entry.create(staticParams);
  return dagOp.run(dynamicParams);
};

const executeStatements = async (
  stmts: readonly Statement[],
  env: Map<string, unknown>,
  registry: ReadonlyMap<string, OpEntry>,
): Promise<void> => {
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment": {
        const result = await resolveValue(stmt.value, env, registry);
        env.set(stmt.name, result);
        break;
      }
      case "void_call":
        await executeCall(stmt.call, env, registry);
        break;
      case "if_else": {
        const condition = await resolveValue(stmt.condition, env, registry);
        if (condition) {
          await executeStatements(stmt.then, env, registry);
        } else if (stmt.else) {
          await executeStatements(stmt.else, env, registry);
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
): Promise<unknown> => {
  const env = new Map<string, unknown>();

  for (const param of fn.params) {
    if (!(param.name in args)) {
      throw new Error(`Missing argument: '${param.name}'`);
    }
    env.set(param.name, args[param.name]);
  }

  await executeStatements(fn.body, env, registry);

  return resolveValue(fn.returnValue, env, registry);
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
  return runWithContext(ctx, () => executeFn(fn, args, registry));
};
