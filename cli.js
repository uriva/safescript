#!/usr/bin/env node
import { parse, tokenize, interpret, computeSignature, toTypescript, toPython, builtinUnaryFields, builtinRegistry } from "./mod.js";
import { readFileSync } from "node:fs";

const USAGE = `safescript \u2014 run .ss programs from the command line

Usage:
  safescript [command]

Commands:
  run <file.ss> [function] [--args '{"key":"value"}']   Execute a .ss program
  signature <file.ss> [function]                         Print the program signature
  transpile-ts <file.ss> [function]                      Transpile to TypeScript
  transpile-py <file.ss> [function]                      Transpile to Python
  test <file.ss> [--args '{"key":"value"}']               Run all functions in a .ss file as tests

Examples:
  safescript run script.ss
  safescript run script.ss main --args '{"name":"world"}'
  safescript signature script.ss
  safescript transpile-ts script.ss > script.ts
  safescript transpile-py script.ss > script.py
  safescript test`;

const COMMANDS = new Set(["run", "signature", "transpile-ts", "transpile-py", "test"]);

const resolveArgs = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Arguments must be a JSON object");
    }
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON for --args: ${e.message}`);
    }
    throw e;
  }
};

const runRun = async (args) => {
  let filePath = "", functionName = "", fnArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--args") {
      i++;
      if (i >= args.length) { console.error("Error: --args requires a JSON string argument"); process.exit(1); }
      fnArgs = resolveArgs(args[i]);
    } else if (!filePath) {
      filePath = arg;
    } else if (!functionName) {
      functionName = arg;
    } else {
      console.error(`Error: Unexpected argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!filePath) { console.error("Error: No .ss file specified"); process.exit(1); }
  const source = readFileSync(filePath, "utf-8");
  const program = parse(tokenize(source), builtinUnaryFields);
  if (!functionName) {
    const mainFn = program.functions.find((f) => f.name === "main");
    functionName = mainFn?.name ?? program.functions[0]?.name;
    if (!functionName) { console.error("Error: No functions found in the program"); process.exit(1); }
  }
  const ctx = { fetch: globalThis.fetch.bind(globalThis) };
  const result = await interpret(program, functionName, fnArgs, ctx, builtinRegistry, filePath);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
};

const runSignature = async (args) => {
  const filePath = args[0];
  if (!filePath) { console.error("Error: No .ss file specified"); process.exit(1); }
  const source = readFileSync(filePath, "utf-8");
  const program = parse(tokenize(source), builtinUnaryFields);
  const mainFn = program.functions.find((f) => f.name === "main");
  const functionName = args[1] ?? mainFn?.name ?? program.functions[0]?.name;
  if (!functionName) { console.error("Error: No functions found"); process.exit(1); }
  const sig = computeSignature(program, functionName, builtinRegistry);
  console.log(JSON.stringify(sig, (key, value) => {
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries([...value]);
    return value;
  }, 2));
};

const runTranspile = async (args, lang) => {
  const filePath = args[0];
  if (!filePath) { console.error("Error: No .ss file specified"); process.exit(1); }
  const source = readFileSync(filePath, "utf-8");
  const program = parse(tokenize(source), builtinUnaryFields);
  const mainFn = program.functions.find((f) => f.name === "main");
  const functionName = args[1] ?? mainFn?.name;
  if (!functionName && program.functions.length === 0) { console.error("Error: No functions found"); process.exit(1); }
  const code = lang === "ts" ? toTypescript(program, functionName) : toPython(program, functionName);
  console.log(code);
};

const runTest = async (args) => {
  let filePath = "", fnArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--args") {
      i++;
      if (i >= args.length) { console.error("Error: --args requires a JSON string argument"); process.exit(1); }
      fnArgs = resolveArgs(args[i]);
    } else if (!filePath) filePath = arg;
    else { console.error(`Error: Unexpected argument: ${arg}`); process.exit(1); }
  }
  if (!filePath) { console.error("Error: No .ss file specified"); process.exit(1); }
  const source = readFileSync(filePath, "utf-8");
  const program = parse(tokenize(source), builtinUnaryFields);
  if (program.functions.length === 0) { console.error("Error: No functions found"); process.exit(1); }
  const ctx = { fetch: globalThis.fetch.bind(globalThis) };
  let failed = 0;
  for (const fn of program.functions) {
    try {
      await interpret(program, fn.name, fnArgs, ctx, builtinRegistry, filePath);
      console.log(`ok  ${fn.name}`);
    } catch (e) {
      console.log(`FAIL  ${fn.name}  ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${program.functions.length - failed}/${program.functions.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
};

const main = async () => {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  let cmd = rawArgs[0], rest;
  if (COMMANDS.has(cmd)) {
    rest = rawArgs.slice(1);
  } else {
    cmd = "run";
    rest = rawArgs.slice(0);
  }
  try {
    switch (cmd) {
      case "run":
        await runRun(rest);
        break;
      case "signature":
        await runSignature(rest);
        break;
      case "transpile-ts":
        await runTranspile(rest, "ts");
        break;
      case "transpile-py":
        await runTranspile(rest, "py");
        break;
      case "test":
        await runTest(rest);
        break;
      default:
        console.error(`Error: Unknown command '${cmd}'`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
};

main();
