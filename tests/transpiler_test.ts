import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenize } from "../src/lang/lexer.ts";
import { parse } from "../src/lang/parser.ts";
import { toTypescript } from "../src/lang/toTypescript.ts";
import { toPython } from "../src/lang/toPython.ts";
import type { Program } from "../src/lang/ast.ts";

const parseSource = (source: string): Program => parse(tokenize(source));

// ============================
// toTypescript tests
// ============================

Deno.test("toTypescript - simple identity function", () => {
  const prog = parseSource(`f = (x: string) => { return x }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "const f = async");
  assertStringIncludes(code, "_ctx: ExecutionContext");
  assertStringIncludes(code, "return x;");
});

Deno.test("toTypescript - arithmetic expression", () => {
  const prog = parseSource(`add = (a: number, b: number) => { return a + b }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "return (a + b);");
});

Deno.test("toTypescript - string literal", () => {
  const prog = parseSource(`f = () => { return "hello" }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'return "hello";');
});

Deno.test("toTypescript - number literal", () => {
  const prog = parseSource(`f = (x: number) => { return 42 }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "return 42;");
});

Deno.test("toTypescript - boolean literal", () => {
  const prog = parseSource(`f = () => { return true }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "return true;");
});

Deno.test("toTypescript - assignment statement", () => {
  const prog = parseSource(`f = (x: number) => { y = x + 1 return y }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "const y = (x + 1);");
  assertStringIncludes(code, "return y;");
});

Deno.test("toTypescript - op call (pure)", () => {
  const prog = parseSource(`f = (data: string) => { h = sha256({ data }) return h }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'await _ops["sha256"]');
  assertStringIncludes(code, '"data": data');
});

Deno.test("toTypescript - op call (io) passes ctx", () => {
  const prog = parseSource(`f = () => { s = readSecret({ name: "key" }) return s }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'await _ops["readSecret"]');
  assertStringIncludes(code, ", _ctx)");
});

Deno.test("toTypescript - httpRequest passes ctx", () => {
  const prog = parseSource(`f = () => { r = httpRequest({ host: "example.com", method: "GET", path: "/" }) return r }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'await _ops["httpRequest"]');
  assertStringIncludes(code, ", _ctx)");
});

Deno.test("toTypescript - writeSecret passes ctx", () => {
  const prog = parseSource(`f = () => { writeSecret({ name: "k", value: "v" }) return true }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'await _ops["writeSecret"]');
  assertStringIncludes(code, ", _ctx)");
});

Deno.test("toTypescript - dot access", () => {
  const prog = parseSource(`f = (x: { a: string }) => { return x.a }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'x["a"]');
});

Deno.test("toTypescript - array literal", () => {
  const prog = parseSource(`f = () => { return ["a", "b"] }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, '["a", "b"]');
});

Deno.test("toTypescript - object literal", () => {
  const prog = parseSource(`f = (x: number) => { return { a: x, b: 2 } }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, '"a": x');
  assertStringIncludes(code, '"b": 2');
});

Deno.test("toTypescript - ternary expression", () => {
  const prog = parseSource(`f = (x: boolean) => { return x ? 1 : 0 }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "? 1 : 0");
});

Deno.test("toTypescript - if/else statement", () => {
  const prog = parseSource(`f = (x: boolean) => { if x { y = 1 } else { y = 2 } return y }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "if (x)");
  assertStringIncludes(code, "} else {");
});

Deno.test("toTypescript - if without else", () => {
  const prog = parseSource(`f = (x: boolean) => { y = 0 if x { y = 1 } return y }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "if (x)");
});

Deno.test("toTypescript - comparison operators", () => {
  const prog = parseSource(`f = (a: number, b: number) => { return a == b }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "===");
});

Deno.test("toTypescript - not-equal operator", () => {
  const prog = parseSource(`f = (a: number, b: number) => { return a != b }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "!==");
});

Deno.test("toTypescript - unary negation", () => {
  const prog = parseSource(`f = (x: number) => { return -x }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "(-x)");
});

Deno.test("toTypescript - multiple functions", () => {
  const prog = parseSource(`
    add = (a: number, b: number) => { return a + b }
    sub = (a: number, b: number) => { return a - b }
  `);
  const code = toTypescript(prog);
  assertStringIncludes(code, "const add = async");
  assertStringIncludes(code, "const sub = async");
});

Deno.test("toTypescript - filter by function name", () => {
  const prog = parseSource(`
    add = (a: number, b: number) => { return a + b }
    sub = (a: number, b: number) => { return a - b }
  `);
  const code = toTypescript(prog, "add");
  assertStringIncludes(code, "const add = async");
  assertEquals(code.includes("const sub"), false);
});

Deno.test("toTypescript - function not found throws", () => {
  const prog = parseSource(`f = (x: number) => { return x }`);
  let threw = false;
  try {
    toTypescript(prog, "nonexistent");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "nonexistent");
  }
  assertEquals(threw, true);
});

Deno.test("toTypescript - includes preamble with ExecutionContext", () => {
  const prog = parseSource(`f = () => { return 1 }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, "type ExecutionContext");
  assertStringIncludes(code, "_ops");
  assertStringIncludes(code, "_b64url");
});

Deno.test("toTypescript - void call (writeSecret)", () => {
  const prog = parseSource(`f = () => { writeSecret({ name: "k", value: "v" }) return true }`);
  const code = toTypescript(prog);
  // The void call should appear as a standalone statement
  assertStringIncludes(code, 'await _ops["writeSecret"]');
  assertStringIncludes(code, "return true;");
});

Deno.test("toTypescript - stringConcat op", () => {
  const prog = parseSource(`f = (a: string, b: string) => { r = stringConcat({ parts: [a, b] }) return r }`);
  const code = toTypescript(prog);
  assertStringIncludes(code, 'await _ops["stringConcat"]');
});

// ============================
// toPython tests
// ============================

Deno.test("toPython - simple identity function", () => {
  const prog = parseSource(`f = (x: string) => { return x }`);
  const code = toPython(prog);
  assertStringIncludes(code, "async def f(");
  assertStringIncludes(code, "_ctx: ExecutionContext");
  assertStringIncludes(code, "return x");
});

Deno.test("toPython - arithmetic expression", () => {
  const prog = parseSource(`add = (a: number, b: number) => { return a + b }`);
  const code = toPython(prog);
  assertStringIncludes(code, "return (a + b)");
});

Deno.test("toPython - string literal", () => {
  const prog = parseSource(`f = () => { return "hello" }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'return "hello"');
});

Deno.test("toPython - boolean uses Python True/False", () => {
  const prog = parseSource(`f = () => { return true }`);
  const code = toPython(prog);
  assertStringIncludes(code, "return True");
});

Deno.test("toPython - boolean false", () => {
  const prog = parseSource(`f = () => { return false }`);
  const code = toPython(prog);
  assertStringIncludes(code, "return False");
});

Deno.test("toPython - assignment statement", () => {
  const prog = parseSource(`f = (x: number) => { y = x + 1 return y }`);
  const code = toPython(prog);
  assertStringIncludes(code, "y = (x + 1)");
  assertStringIncludes(code, "return y");
});

Deno.test("toPython - op call (pure)", () => {
  const prog = parseSource(`f = (data: string) => { h = sha256({ data }) return h }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'await _OPS["sha256"]');
  assertStringIncludes(code, '"data": data');
});

Deno.test("toPython - op call (io) passes ctx", () => {
  const prog = parseSource(`f = () => { s = readSecret({ name: "key" }) return s }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'await _OPS["readSecret"]');
  assertStringIncludes(code, ", _ctx)");
});

Deno.test("toPython - httpRequest passes ctx", () => {
  const prog = parseSource(`f = () => { r = httpRequest({ host: "example.com", method: "GET", path: "/" }) return r }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'await _OPS["httpRequest"]');
  assertStringIncludes(code, ", _ctx)");
});

Deno.test("toPython - dot access uses bracket notation", () => {
  const prog = parseSource(`f = (x: { a: string }) => { return x.a }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'x["a"]');
});

Deno.test("toPython - array literal", () => {
  const prog = parseSource(`f = () => { return ["a", "b"] }`);
  const code = toPython(prog);
  assertStringIncludes(code, '["a", "b"]');
});

Deno.test("toPython - object emits as dict", () => {
  const prog = parseSource(`f = (x: number) => { return { a: x, b: 2 } }`);
  const code = toPython(prog);
  assertStringIncludes(code, '"a": x');
  assertStringIncludes(code, '"b": 2');
});

Deno.test("toPython - ternary uses Python if/else expression", () => {
  const prog = parseSource(`f = (x: boolean) => { return x ? 1 : 0 }`);
  const code = toPython(prog);
  // Python ternary: (then if condition else else)
  assertStringIncludes(code, "1 if x else 0");
});

Deno.test("toPython - if/else statement", () => {
  const prog = parseSource(`f = (x: boolean) => { if x { y = 1 } else { y = 2 } return y }`);
  const code = toPython(prog);
  assertStringIncludes(code, "if x:");
  assertStringIncludes(code, "else:");
});

Deno.test("toPython - if without else", () => {
  const prog = parseSource(`f = (x: boolean) => { y = 0 if x { y = 1 } return y }`);
  const code = toPython(prog);
  assertStringIncludes(code, "if x:");
});

Deno.test("toPython - comparison operators", () => {
  const prog = parseSource(`f = (a: number, b: number) => { return a == b }`);
  const code = toPython(prog);
  assertStringIncludes(code, "==");
});

Deno.test("toPython - unary negation", () => {
  const prog = parseSource(`f = (x: number) => { return -x }`);
  const code = toPython(prog);
  assertStringIncludes(code, "(-x)");
});

Deno.test("toPython - multiple functions", () => {
  const prog = parseSource(`
    add = (a: number, b: number) => { return a + b }
    sub = (a: number, b: number) => { return a - b }
  `);
  const code = toPython(prog);
  assertStringIncludes(code, "async def add(");
  assertStringIncludes(code, "async def sub(");
});

Deno.test("toPython - filter by function name", () => {
  const prog = parseSource(`
    add = (a: number, b: number) => { return a + b }
    sub = (a: number, b: number) => { return a - b }
  `);
  const code = toPython(prog, "add");
  assertStringIncludes(code, "async def add(");
  assertEquals(code.includes("async def sub"), false);
});

Deno.test("toPython - function not found throws", () => {
  const prog = parseSource(`f = (x: number) => { return x }`);
  let threw = false;
  try {
    toPython(prog, "nonexistent");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "nonexistent");
  }
  assertEquals(threw, true);
});

Deno.test("toPython - includes preamble", () => {
  const prog = parseSource(`f = () => { return 1 }`);
  const code = toPython(prog);
  assertStringIncludes(code, "import json");
  assertStringIncludes(code, "ExecutionContext");
  assertStringIncludes(code, "_OPS");
  assertStringIncludes(code, "_b64url_encode");
});

Deno.test("toPython - keyword-only params with *", () => {
  const prog = parseSource(`f = (x: number, y: number) => { return x + y }`);
  const code = toPython(prog);
  assertStringIncludes(code, "*, x, y");
});

Deno.test("toPython - no params still has ctx", () => {
  const prog = parseSource(`f = () => { return 1 }`);
  const code = toPython(prog);
  assertStringIncludes(code, "_ctx: ExecutionContext");
});

Deno.test("toPython - void call (writeSecret)", () => {
  const prog = parseSource(`f = () => { writeSecret({ name: "k", value: "v" }) return true }`);
  const code = toPython(prog);
  assertStringIncludes(code, 'await _OPS["writeSecret"]');
  assertStringIncludes(code, "return True");
});

Deno.test("toPython - uses 4-space indentation", () => {
  const prog = parseSource(`f = (x: number) => { y = x return y }`);
  const code = toPython(prog);
  // Body should be indented 4 spaces
  const lines = code.split("\n");
  const bodyLines = lines.filter((l) => l.includes("y = x") || l.includes("return y"));
  for (const line of bodyLines) {
    assertEquals(line.startsWith("    "), true, `Expected 4-space indent: "${line}"`);
  }
});

// ============================
// Cross-transpiler consistency
// ============================

Deno.test("both transpilers handle all pure ops without error", () => {
  const ops = [
    `f = (t: string) => { r = jsonParse({ text: t }) return r }`,
    `f = (v: string) => { r = jsonStringify({ value: v }) return r }`,
    `f = (a: string, b: string) => { r = stringConcat({ parts: [a, b] }) return r }`,
    `f = (t: string) => { r = base64urlEncode({ text: t }) return r }`,
    `f = (e: string) => { r = base64urlDecode({ encoded: e }) return r }`,
    `f = (d: string) => { r = sha256({ data: d }) return r }`,
    `f = () => { r = timestamp() return r }`,
    `f = () => { r = randomBytes({ length: 16 }) return r }`,
    `f = () => { r = generateEd25519KeyPair() return r }`,
    `f = () => { r = generateX25519KeyPair() return r }`,
    `f = () => { r = aesGenerateKey() return r }`,
  ];
  for (const source of ops) {
    const prog = parseSource(source);
    // Should not throw
    const ts = toTypescript(prog);
    const py = toPython(prog);
    assertEquals(ts.length > 0, true);
    assertEquals(py.length > 0, true);
  }
});

Deno.test("both transpilers handle complex nested expressions", () => {
  const source = `
    f = (x: { a: number, b: number }) => {
      sum = x.a + x.b
      doubled = sum * 2
      result = doubled > 10 ? "big" : "small"
      return result
    }
  `;
  const prog = parseSource(source);
  const ts = toTypescript(prog);
  const py = toPython(prog);
  assertStringIncludes(ts, 'x["a"]');
  assertStringIncludes(ts, 'x["b"]');
  assertStringIncludes(py, 'x["a"]');
  assertStringIncludes(py, 'x["b"]');
});
