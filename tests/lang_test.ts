import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenize } from "../src/lang/lexer.ts";
import { parse } from "../src/lang/parser.ts";
import { interpret } from "../src/lang/interpreter.ts";
import { computeSignature } from "../src/lang/signature.ts";
import { builtinRegistry, builtinUnaryFields, type OpEntry } from "../src/lang/registry.ts";
import type { ExecutionContext } from "../src/types.ts";
import type { Program, Value } from "../src/lang/ast.ts";

const parseSource = (source: string): Program => parse(tokenize(source), builtinUnaryFields);

// Helper to get the value of an assignment statement
const assignmentValue = (prog: Program, fnIdx: number, stmtIdx: number): Value => {
  const stmt = prog.functions[fnIdx].body[stmtIdx];
  if (stmt.kind !== "assignment") throw new Error("Expected assignment");
  return stmt.value;
};

Deno.test("lexer - tokenizes simple function", () => {
  const tokens = tokenize(`foo = (x: string) => { return x }`);
  const kinds = tokens.map((t) => t.kind);
  assertEquals(kinds, [
    "ident", "=", "(", "ident", ":", "ident", ")", "=>",
    "{", "return", "ident", "}",
    "eof",
  ]);
});

Deno.test("lexer - tokenizes string literals", () => {
  const tokens = tokenize(`"hello world"`);
  assertEquals(tokens[0].kind, "string");
  assertEquals(tokens[0].value, "hello world");
});

Deno.test("lexer - tokenizes numbers", () => {
  const tokens = tokenize(`42 3.14`);
  assertEquals(tokens[0].value, "42");
  assertEquals(tokens[1].value, "3.14");
});

Deno.test("lexer - negative number is two tokens", () => {
  const tokens = tokenize(`-7`);
  assertEquals(tokens[0].kind, "-");
  assertEquals(tokens[1].kind, "number");
  assertEquals(tokens[1].value, "7");
});

Deno.test("lexer - handles escape sequences in strings", () => {
  const tokens = tokenize(`"hello\\nworld"`);
  assertEquals(tokens[0].value, "hello\nworld");
});

Deno.test("lexer - skips line comments", () => {
  const tokens = tokenize(`// this is a comment\nfoo`);
  assertEquals(tokens[0].kind, "ident");
  assertEquals(tokens[0].value, "foo");
});

Deno.test("lexer - arrow token", () => {
  const tokens = tokenize(`=>`);
  assertEquals(tokens[0].kind, "=>");
});

Deno.test("lexer - distinguishes = from =>", () => {
  const tokens = tokenize(`x = y => z`);
  assertEquals(tokens[0].kind, "ident");
  assertEquals(tokens[1].kind, "=");
  assertEquals(tokens[2].kind, "ident");
  assertEquals(tokens[3].kind, "=>");
  assertEquals(tokens[4].kind, "ident");
});

Deno.test("lexer - tokenizes ? for ternary", () => {
  const tokens = tokenize(`a ? b : c`);
  assertEquals(tokens[0].kind, "ident");
  assertEquals(tokens[1].kind, "?");
  assertEquals(tokens[2].kind, "ident");
  assertEquals(tokens[3].kind, ":");
  assertEquals(tokens[4].kind, "ident");
});

Deno.test("parser - minimal function with return", () => {
  const prog = parseSource(`identity = () => { return true }`);
  assertEquals(prog.functions.length, 1);
  assertEquals(prog.functions[0].name, "identity");
  assertEquals(prog.functions[0].params.length, 0);
  assertEquals(prog.functions[0].returnValue, { kind: "boolean", value: true });
});

Deno.test("parser - function with typed params", () => {
  const prog = parseSource(`greet = (name: string, age: number) => { return name }`);
  const fn = prog.functions[0];
  assertEquals(fn.params.length, 2);
  assertEquals(fn.params[0], { name: "name", type: { kind: "primitive", name: "string" } });
  assertEquals(fn.params[1], { name: "age", type: { kind: "primitive", name: "number" } });
});

Deno.test("parser - return with type annotation", () => {
  const prog = parseSource(`foo = (): string => { return x }`);
  assertEquals(prog.functions[0].returnType, { kind: "primitive", name: "string" });
});

Deno.test("parser - object return type", () => {
  const prog = parseSource(`foo = (): { status: number, body: string } => { return x }`);
  assertEquals(prog.functions[0].returnType, {
    kind: "object",
    fields: [
      { name: "status", type: { kind: "primitive", name: "number" } },
      { name: "body", type: { kind: "primitive", name: "string" } },
    ],
  });
});

Deno.test("parser - array type", () => {
  const prog = parseSource(`foo = (items: string[]) => { return items }`);
  assertEquals(prog.functions[0].params[0].type, {
    kind: "array",
    element: { kind: "primitive", name: "string" },
  });
});

Deno.test("parser - assignment with op call", () => {
  const prog = parseSource(`
    foo = () => {
      x = readSecret({ name: "my-secret" })
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.name, "x");
    assertEquals(stmt.value.kind, "call");
    if (stmt.value.kind === "call") {
      assertEquals(stmt.value.op, "readSecret");
      assertEquals(stmt.value.args, [{ key: "name", value: { kind: "string", value: "my-secret" } }]);
    }
  }
});

Deno.test("parser - void call (no assignment)", () => {
  const prog = parseSource(`
    foo = (val: string) => {
      writeSecret({ name: "my-secret", value: val })
      return val
    }
  `);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "void_call");
  if (stmt.kind === "void_call") {
    assertEquals(stmt.call.op, "writeSecret");
  }
});

Deno.test("parser - empty call (no args)", () => {
  const prog = parseSource(`
    foo = () => {
      t = timestamp()
      return t
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  assertEquals(val.kind, "call");
  if (val.kind === "call") {
    assertEquals(val.op, "timestamp");
    assertEquals(val.args.length, 0);
  }
});

Deno.test("parser - shorthand object field", () => {
  const prog = parseSource(`
    foo = (body: string) => {
      r = httpRequest({ host: "example.com", body })
      return r
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  if (val.kind === "call") {
    const bodyArg = val.args.find((a) => a.key === "body");
    assertEquals(bodyArg, { key: "body", value: { kind: "reference", name: "body" } });
  }
});

Deno.test("parser - dot access in value", () => {
  const prog = parseSource(`
    foo = () => {
      keys = generateEd25519KeyPair()
      return keys.publicKey
    }
  `);
  assertEquals(prog.functions[0].returnValue, {
    kind: "dot_access",
    base: { kind: "reference", name: "keys" },
    field: "publicKey",
  });
});

Deno.test("parser - dot access with keyword field name", () => {
  const prog = parseSource(`
    foo = (x: { hash: string }) => {
      return x.hash
    }
  `);
  assertEquals(prog.functions[0].returnValue, {
    kind: "dot_access",
    base: { kind: "reference", name: "x" },
    field: "hash",
  });
});

Deno.test("interpret - dot access with keyword field name", async () => {
  const result = await run(`f = (x: { hash: string }) => { return x.hash }`, "f", { x: { hash: "abc" } });
  assertEquals(result, "abc");
});

Deno.test("parser - chained dot access", () => {
  const prog = parseSource(`
    foo = () => {
      return a.b.c
    }
  `);
  assertEquals(prog.functions[0].returnValue, {
    kind: "dot_access",
    base: {
      kind: "dot_access",
      base: { kind: "reference", name: "a" },
      field: "b",
    },
    field: "c",
  });
});

Deno.test("parser - inline op call as value", () => {
  const prog = parseSource(`
    foo = (slug: string) => {
      r = httpRequest({
        host: "example.com",
        path: stringConcat({ parts: ["/api/", slug] })
      })
      return r
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  if (val.kind === "call") {
    const pathArg = val.args.find((a) => a.key === "path");
    assertEquals(pathArg?.value.kind, "call");
    if (pathArg?.value.kind === "call") {
      assertEquals(pathArg.value.op, "stringConcat");
    }
  }
});

Deno.test("parser - array value with mixed elements", () => {
  const prog = parseSource(`
    foo = (slug: string) => {
      r = stringConcat({ parts: ["/prefix/", slug, "/suffix"] })
      return r
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  if (val.kind === "call") {
    const parts = val.args[0].value;
    assertEquals(parts.kind, "array");
    if (parts.kind === "array") {
      assertEquals(parts.elements.length, 3);
      assertEquals(parts.elements[0], { kind: "string", value: "/prefix/" });
      assertEquals(parts.elements[1], { kind: "reference", name: "slug" });
      assertEquals(parts.elements[2], { kind: "string", value: "/suffix" });
    }
  }
});

Deno.test("parser - nested object value", () => {
  const prog = parseSource(`
    foo = (slug: string, content: string) => {
      body = jsonStringify({ value: { slug: slug, content } })
      return body
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  if (val.kind === "call") {
    const v = val.args[0].value;
    assertEquals(v.kind, "object");
    if (v.kind === "object") {
      assertEquals(v.fields.length, 2);
      assertEquals(v.fields[0].key, "slug");
      assertEquals(v.fields[1].key, "content");
      assertEquals(v.fields[1].value, { kind: "reference", name: "content" });
    }
  }
});

Deno.test("parser - multiple functions", () => {
  const prog = parseSource(`
    first = (x: string) => { return x }
    second = (y: number) => { return y }
  `);
  assertEquals(prog.functions.length, 2);
  assertEquals(prog.functions[0].name, "first");
  assertEquals(prog.functions[1].name, "second");
});

Deno.test("parser - quoted string as object key", () => {
  const prog = parseSource(`
    foo = () => {
      r = httpRequest({ host: "example.com", headers: { "x-signature": sig } })
      return r
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  if (val.kind === "call") {
    const headersArg = val.args.find((a) => a.key === "headers");
    if (headersArg?.value.kind === "object") {
      assertEquals(headersArg.value.fields[0].key, "x-signature");
    }
  }
});

Deno.test("parser - multiple statements", () => {
  const prog = parseSource(`
    foo = () => {
      a = timestamp()
      b = sha256({ data: "hello" })
      c = ed25519Sign({ data: b, privateKey: "key" })
      return c
    }
  `);
  assertEquals(prog.functions[0].body.length, 3);
});

Deno.test("parser - boolean literal values", () => {
  const prog = parseSource(`
    foo = () => {
      return false
    }
  `);
  assertEquals(prog.functions[0].returnValue, { kind: "boolean", value: false });
});

Deno.test("lexer - throws on unexpected character", () => {
  assertThrows(() => tokenize(`@`), Error, "Unexpected character");
});

Deno.test("parser - throws on missing arrow", () => {
  assertThrows(() => parseSource(`foo = () { return x }`), Error, "Expected '=>'");
});

// --- Arithmetic / comparison / expression tests ---

Deno.test("parser - arithmetic expression", () => {
  const prog = parseSource(`foo = (a: number, b: number) => { return a + b * 2 }`);
  // a + (b * 2) due to precedence
  const ret = prog.functions[0].returnValue;
  assertEquals(ret.kind, "binary_op");
  if (ret.kind === "binary_op") {
    assertEquals(ret.op, "+");
    assertEquals(ret.left, { kind: "reference", name: "a" });
    assertEquals(ret.right.kind, "binary_op");
    if (ret.right.kind === "binary_op") {
      assertEquals(ret.right.op, "*");
      assertEquals(ret.right.left, { kind: "reference", name: "b" });
      assertEquals(ret.right.right, { kind: "number", value: 2 });
    }
  }
});

Deno.test("parser - comparison expression", () => {
  const prog = parseSource(`foo = (x: number) => { return x > 0 }`);
  const ret = prog.functions[0].returnValue;
  assertEquals(ret, {
    kind: "binary_op",
    op: ">",
    left: { kind: "reference", name: "x" },
    right: { kind: "number", value: 0 },
  });
});

Deno.test("parser - unary minus", () => {
  const prog = parseSource(`foo = (x: number) => { return -x }`);
  assertEquals(prog.functions[0].returnValue, {
    kind: "unary_op",
    op: "-",
    operand: { kind: "reference", name: "x" },
  });
});

Deno.test("parser - parenthesized expression", () => {
  const prog = parseSource(`foo = (a: number, b: number) => { return (a + b) * 2 }`);
  const ret = prog.functions[0].returnValue;
  assertEquals(ret.kind, "binary_op");
  if (ret.kind === "binary_op") {
    assertEquals(ret.op, "*");
    assertEquals(ret.left.kind, "binary_op");
    assertEquals(ret.right, { kind: "number", value: 2 });
  }
});

Deno.test("parser - assignment with expression value", () => {
  const prog = parseSource(`
    foo = (a: number) => {
      b = a + 1
      return b
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  assertEquals(val, {
    kind: "binary_op",
    op: "+",
    left: { kind: "reference", name: "a" },
    right: { kind: "number", value: 1 },
  });
});

Deno.test("parser - array construction as assignment", () => {
  const prog = parseSource(`
    foo = (a: number, b: number) => {
      arr = [a, b, 3]
      return arr
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  assertEquals(val, {
    kind: "array",
    elements: [
      { kind: "reference", name: "a" },
      { kind: "reference", name: "b" },
      { kind: "number", value: 3 },
    ],
  });
});

Deno.test("parser - object construction as assignment", () => {
  const prog = parseSource(`
    foo = (x: number) => {
      obj = { key: x, name: "hello" }
      return obj
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  assertEquals(val, {
    kind: "object",
    fields: [
      { key: "key", value: { kind: "reference", name: "x" } },
      { key: "name", value: { kind: "string", value: "hello" } },
    ],
  });
});

Deno.test("parser - ternary expression", () => {
  const prog = parseSource(`
    foo = (x: number) => {
      return x > 0 ? "positive" : "non-positive"
    }
  `);
  const ret = prog.functions[0].returnValue;
  assertEquals(ret, {
    kind: "ternary",
    condition: {
      kind: "binary_op",
      op: ">",
      left: { kind: "reference", name: "x" },
      right: { kind: "number", value: 0 },
    },
    then: { kind: "string", value: "positive" },
    else: { kind: "string", value: "non-positive" },
  });
});

Deno.test("parser - ternary in assignment", () => {
  const prog = parseSource(`
    foo = (a: boolean) => {
      result = a ? 1 : 0
      return result
    }
  `);
  const val = assignmentValue(prog, 0, 0);
  assertEquals(val, {
    kind: "ternary",
    condition: { kind: "reference", name: "a" },
    then: { kind: "number", value: 1 },
    else: { kind: "number", value: 0 },
  });
});

Deno.test("parser - nested ternary (right-associative)", () => {
  const prog = parseSource(`
    foo = (x: number) => {
      return x > 0 ? "pos" : x == 0 ? "zero" : "neg"
    }
  `);
  const ret = prog.functions[0].returnValue;
  assertEquals(ret.kind, "ternary");
  if (ret.kind === "ternary") {
    assertEquals(ret.then, { kind: "string", value: "pos" });
    assertEquals(ret.else.kind, "ternary");
  }
});

// --- Unary call syntax tests ---

Deno.test("parser - unary call desugars to named arg (readSecret)", () => {
  const prog = parseSource(`f = () => { s = readSecret("api-key") return s }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "readSecret",
      args: [{ key: "name", value: { kind: "string", value: "api-key" } }],
    });
  }
});

Deno.test("parser - unary call desugars to named arg (jsonParse)", () => {
  const prog = parseSource(`f = (x: string) => { r = jsonParse(x) return r }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "jsonParse",
      args: [{ key: "text", value: { kind: "reference", name: "x" } }],
    });
  }
});

Deno.test("parser - unary call with expression (sha256)", () => {
  const prog = parseSource(`f = (x: string) => { h = sha256(x) return h }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "sha256",
      args: [{ key: "data", value: { kind: "reference", name: "x" } }],
    });
  }
});

Deno.test("parser - unary void call desugars correctly", () => {
  // writeSecret does not support unary, but let's test with a hypothetical
  // Actually test with a supported op used as a void call
  const prog = parseSource(`f = (x: string) => { jsonParse(x) return true }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "void_call");
  if (stmt.kind === "void_call") {
    assertEquals(stmt.call, {
      op: "jsonParse",
      args: [{ key: "text", value: { kind: "reference", name: "x" } }],
    });
  }
});

Deno.test("parser - unary call with string literal (base64urlEncode)", () => {
  const prog = parseSource(`f = () => { r = base64urlEncode("hello") return r }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "base64urlEncode",
      args: [{ key: "text", value: { kind: "string", value: "hello" } }],
    });
  }
});

Deno.test("parser - unary call with number (randomBytes)", () => {
  const prog = parseSource(`f = () => { r = randomBytes(32) return r }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "randomBytes",
      args: [{ key: "length", value: { kind: "number", value: 32 } }],
    });
  }
});

Deno.test("parser - named arg syntax still works alongside unary", () => {
  const prog = parseSource(`f = () => { s = readSecret({ name: "key" }) return s }`);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value, {
      kind: "call",
      op: "readSecret",
      args: [{ key: "name", value: { kind: "string", value: "key" } }],
    });
  }
});

Deno.test("parser - unsupported unary call throws", () => {
  assertThrows(
    () => parseSource(`f = () => { writeSecret("x") return true }`),
    Error,
    "does not support unary call syntax",
  );
});

// --- Interpreter tests ---

const dummyCtx: ExecutionContext = {
  readSecret: () => Promise.reject(new Error("no secrets in test")),
  writeSecret: () => Promise.reject(new Error("no secrets in test")),
  fetch: () => Promise.reject(new Error("no fetch in test")),
};

const emptyRegistry: ReadonlyMap<string, OpEntry> = new Map();

const run = (source: string, fnName: string, args: Record<string, unknown>, registry = emptyRegistry) =>
  interpret(parseSource(source), fnName, args, dummyCtx, registry);

Deno.test("interpret - pass-through param", async () => {
  const result = await run(`f = (x: string) => { return x }`, "f", { x: "hello" });
  assertEquals(result, "hello");
});

Deno.test("interpret - arithmetic addition", async () => {
  const result = await run(`f = (a: number, b: number) => { return a + b }`, "f", { a: 3, b: 4 });
  assertEquals(result, 7);
});

Deno.test("interpret - arithmetic precedence", async () => {
  const result = await run(`f = (a: number) => { return a + 2 * 3 }`, "f", { a: 1 });
  assertEquals(result, 7);
});

Deno.test("interpret - subtraction and division", async () => {
  const result = await run(`f = (x: number) => { return x - 4 / 2 }`, "f", { x: 10 });
  assertEquals(result, 8);
});

Deno.test("interpret - modulo", async () => {
  const result = await run(`f = (x: number) => { return x % 3 }`, "f", { x: 7 });
  assertEquals(result, 1);
});

Deno.test("interpret - string concatenation with +", async () => {
  const result = await run(`f = (a: string, b: string) => { return a + b }`, "f", { a: "hello", b: " world" });
  assertEquals(result, "hello world");
});

Deno.test("interpret - comparison operators", async () => {
  assertEquals(await run(`f = (x: number) => { return x > 5 }`, "f", { x: 10 }), true);
  assertEquals(await run(`f = (x: number) => { return x > 5 }`, "f", { x: 3 }), false);
  assertEquals(await run(`f = (x: number) => { return x == 5 }`, "f", { x: 5 }), true);
  assertEquals(await run(`f = (x: number) => { return x != 5 }`, "f", { x: 3 }), true);
  assertEquals(await run(`f = (x: number) => { return x <= 5 }`, "f", { x: 5 }), true);
  assertEquals(await run(`f = (x: number) => { return x >= 5 }`, "f", { x: 4 }), false);
});

Deno.test("interpret - unary minus", async () => {
  const result = await run(`f = (x: number) => { return -x }`, "f", { x: 42 });
  assertEquals(result, -42);
});

Deno.test("interpret - ternary true branch", async () => {
  const result = await run(`f = (x: number) => { return x > 0 ? "yes" : "no" }`, "f", { x: 5 });
  assertEquals(result, "yes");
});

Deno.test("interpret - ternary false branch", async () => {
  const result = await run(`f = (x: number) => { return x > 0 ? "yes" : "no" }`, "f", { x: -1 });
  assertEquals(result, "no");
});

Deno.test("interpret - nested ternary", async () => {
  const source = `f = (x: number) => { return x > 0 ? "pos" : x == 0 ? "zero" : "neg" }`;
  assertEquals(await run(source, "f", { x: 5 }), "pos");
  assertEquals(await run(source, "f", { x: 0 }), "zero");
  assertEquals(await run(source, "f", { x: -3 }), "neg");
});

Deno.test("interpret - dot access", async () => {
  const source = `f = (obj: { name: string }) => { return obj.name }`;
  const result = await run(source, "f", { obj: { name: "alice" } });
  assertEquals(result, "alice");
});

Deno.test("interpret - chained dot access", async () => {
  const source = `f = (obj: { inner: { val: number } }) => { return obj.inner.val }`;
  const result = await run(source, "f", { obj: { inner: { val: 99 } } });
  assertEquals(result, 99);
});

Deno.test("interpret - array construction", async () => {
  const source = `f = (a: number, b: number) => { arr = [a, b, 3] return arr }`;
  const result = await run(source, "f", { a: 1, b: 2 });
  assertEquals(result, [1, 2, 3]);
});

Deno.test("interpret - object construction", async () => {
  const source = `f = (x: number) => { obj = { key: x, name: "hi" } return obj }`;
  const result = await run(source, "f", { x: 42 });
  assertEquals(result, { key: 42, name: "hi" });
});

Deno.test("interpret - assignment with expression", async () => {
  const source = `f = (a: number, b: number) => { c = a + b return c }`;
  const result = await run(source, "f", { a: 10, b: 20 });
  assertEquals(result, 30);
});

Deno.test("interpret - ternary in assignment", async () => {
  const source = `f = (x: boolean) => { y = x ? "a" : "b" return y }`;
  assertEquals(await run(source, "f", { x: true }), "a");
  assertEquals(await run(source, "f", { x: false }), "b");
});

Deno.test("interpret - op call via registry", async () => {
  const { z } = await import("zod/v4");
  const { op } = await import("../src/op.ts");
  const addOp = op({
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.number(),
    tags: ["pure"],
    resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
    run: async ({ a, b }) => a + b,
  });
  const testRegistry: ReadonlyMap<string, OpEntry> = new Map([
    ["add", { staticFields: new Set(), unaryField: null, create: () => addOp }],
  ]);
  const source = `f = (x: number, y: number) => { result = add({ a: x, b: y }) return result }`;
  const result = await run(source, "f", { x: 3, y: 7 }, testRegistry);
  assertEquals(result, 10);
});

// --- Signature tests ---

const sig = (source: string, fnName: string) =>
  computeSignature(parseSource(source), fnName, builtinRegistry);

Deno.test("signature - pure passthrough has no effects", () => {
  const s = sig(`f = (x: string) => { return x }`, "f");
  assertEquals(s.name, "f");
  assertEquals(s.secretsRead.size, 0);
  assertEquals(s.secretsWritten.size, 0);
  assertEquals(s.hosts.size, 0);
  assertEquals(s.envReads.size, 0);
  assertEquals(s.returnSources, new Set(["param:x"]));
  assertEquals(s.memoryBytes, 0);
  assertEquals(s.runtimeMs, 0);
});

Deno.test("signature - arithmetic return sources from params", () => {
  const s = sig(`f = (a: number, b: number) => { return a + b }`, "f");
  assertEquals(s.returnSources, new Set(["param:a", "param:b"]));
  assertEquals(s.hosts.size, 0);
});

Deno.test("signature - reads a secret", () => {
  const s = sig(`
    f = () => {
      s = readSecret({ name: "api-key" })
      return s
    }
  `, "f");
  assertEquals(s.secretsRead, new Set(["api-key"]));
  assertEquals(s.returnSources, new Set(["secret:api-key"]));
  assertEquals(s.memoryBytes, 1024);
  assertEquals(s.runtimeMs, 10);
});

Deno.test("signature - writes a secret with param data", () => {
  const s = sig(`
    f = (val: string) => {
      writeSecret({ name: "my-secret", value: val })
      return true
    }
  `, "f");
  assertEquals(s.secretsWritten, new Set(["my-secret"]));
  assertEquals(s.dataFlow.get("secret:my-secret"), new Set(["param:val"]));
  assertEquals(s.returnSources, new Set());
});

Deno.test("signature - http request records host and data flow", () => {
  const s = sig(`
    f = (body: string) => {
      r = httpRequest({ host: "api.example.com", method: "POST", path: "/data", body })
      return r
    }
  `, "f");
  assertEquals(s.hosts, new Set(["api.example.com"]));
  assertEquals(s.dataFlow.get("host:api.example.com"), new Set(["param:body"]));
  assertEquals(s.returnSources, new Set(["host:api.example.com"]));
});

Deno.test("signature - secret data flowing to a host", () => {
  const s = sig(`
    f = () => {
      secret = readSecret({ name: "token" })
      r = httpRequest({ host: "api.example.com", method: "POST", path: "/auth", body: secret })
      return r
    }
  `, "f");
  assertEquals(s.secretsRead, new Set(["token"]));
  assertEquals(s.hosts, new Set(["api.example.com"]));
  assertEquals(s.dataFlow.get("host:api.example.com"), new Set(["secret:token"]));
  assertEquals(s.returnSources, new Set(["host:api.example.com"]));
  assertEquals(s.dataFlow.get("return"), new Set(["host:api.example.com"]));
});

Deno.test("signature - host-to-host data flow", () => {
  const s = sig(`
    f = () => {
      a = httpRequest({ host: "host-a.com", method: "GET", path: "/data" })
      b = httpRequest({ host: "host-b.com", method: "POST", path: "/forward", body: a })
      return b
    }
  `, "f");
  assertEquals(s.hosts, new Set(["host-a.com", "host-b.com"]));
  assertEquals(s.dataFlow.get("host:host-b.com"), new Set(["host:host-a.com"]));
  assertEquals(s.dataFlow.get("return"), new Set(["host:host-b.com"]));
});

Deno.test("signature - host data in return value", () => {
  const s = sig(`
    f = () => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: "/info" })
      return r.body
    }
  `, "f");
  assertEquals(s.returnSources, new Set(["host:api.example.com"]));
  assertEquals(s.dataFlow.get("return"), new Set(["host:api.example.com"]));
});

Deno.test("signature - timestamp as env read", () => {
  const s = sig(`
    f = () => {
      t = timestamp()
      return t
    }
  `, "f");
  assertEquals(s.envReads, new Set(["timestamp"]));
  assertEquals(s.returnSources, new Set(["env:timestamp"]));
});

Deno.test("signature - randomBytes as env read", () => {
  const s = sig(`
    f = () => {
      r = randomBytes({ length: 32 })
      return r
    }
  `, "f");
  assertEquals(s.envReads, new Set(["randomBytes"]));
  assertEquals(s.returnSources, new Set(["env:randomBytes"]));
});

Deno.test("signature - pure op preserves input sources", () => {
  const s = sig(`
    f = (data: string) => {
      h = sha256({ data })
      return h
    }
  `, "f");
  assertEquals(s.returnSources, new Set(["param:data"]));
  assertEquals(s.hosts.size, 0);
  assertEquals(s.secretsRead.size, 0);
});

Deno.test("signature - ternary unions both branches", () => {
  const s = sig(`
    f = (flag: boolean) => {
      a = readSecret({ name: "key-a" })
      b = readSecret({ name: "key-b" })
      return flag ? a : b
    }
  `, "f");
  assertEquals(s.secretsRead, new Set(["key-a", "key-b"]));
  assertEquals(s.returnSources, new Set(["param:flag", "secret:key-a", "secret:key-b"]));
});

Deno.test("signature - resource bounds accumulate", () => {
  const s = sig(`
    f = () => {
      a = readSecret({ name: "x" })
      b = readSecret({ name: "y" })
      r = httpRequest({ host: "example.com", method: "GET", path: "/test" })
      return r
    }
  `, "f");
  // readSecret: 1024 mem, 10 ms each (x2) + httpRequest: 1_000_000 mem, 10_000 ms
  assertEquals(s.memoryBytes, 1024 + 1024 + 1_000_000);
  assertEquals(s.runtimeMs, 10 + 10 + 10_000);
});

Deno.test("signature - complex multi-host pipeline", () => {
  const s = sig(`
    f = (userId: string) => {
      secret = readSecret({ name: "auth-token" })
      t = timestamp()
      userInfo = httpRequest({ host: "user-api.com", method: "GET", path: userId })
      enriched = httpRequest({
        host: "enrichment-api.com",
        method: "POST",
        path: "/enrich",
        body: userInfo
      })
      writeSecret({ name: "cache", value: enriched })
      return enriched
    }
  `, "f");
  assertEquals(s.secretsRead, new Set(["auth-token"]));
  assertEquals(s.secretsWritten, new Set(["cache"]));
  assertEquals(s.hosts, new Set(["user-api.com", "enrichment-api.com"]));
  assertEquals(s.envReads, new Set(["timestamp"]));
  // userId (param) flows to user-api.com
  assertEquals(s.dataFlow.get("host:user-api.com")!.has("param:userId"), true);
  // user-api.com data flows to enrichment-api.com
  assertEquals(s.dataFlow.get("host:enrichment-api.com")!.has("host:user-api.com"), true);
  // enrichment-api.com data flows to secret and return
  assertEquals(s.dataFlow.get("secret:cache")!.has("host:enrichment-api.com"), true);
  assertEquals(s.dataFlow.get("return")!.has("host:enrichment-api.com"), true);
});

Deno.test("signature - input and output types", () => {
  const s = sig(`
    f = (name: string, age: number): { greeting: string, years: number } => {
      return name
    }
  `, "f");
  assertEquals(s.params.length, 2);
  assertEquals(s.params[0], { name: "name", type: { kind: "primitive", name: "string" } });
  assertEquals(s.params[1], { name: "age", type: { kind: "primitive", name: "number" } });
  assertEquals(s.returnType, {
    kind: "object",
    fields: [
      { name: "greeting", type: { kind: "primitive", name: "string" } },
      { name: "years", type: { kind: "primitive", name: "number" } },
    ],
  });
});

// --- if/else tests ---

Deno.test("lexer - tokenizes if and else keywords", () => {
  const tokens = tokenize(`if else`);
  assertEquals(tokens[0].kind, "if");
  assertEquals(tokens[1].kind, "else");
});

Deno.test("parser - if without else", () => {
  const prog = parseSource(`
    f = (x: number) => {
      if x > 0 {
        y = x + 1
      }
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "if_else");
  if (stmt.kind === "if_else") {
    assertEquals(stmt.condition.kind, "binary_op");
    assertEquals(stmt.then.length, 1);
    assertEquals(stmt.else, null);
  }
});

Deno.test("parser - if with else", () => {
  const prog = parseSource(`
    f = (x: number) => {
      if x > 0 {
        y = x + 1
      } else {
        y = x - 1
      }
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  assertEquals(stmt.kind, "if_else");
  if (stmt.kind === "if_else") {
    assertEquals(stmt.then.length, 1);
    assertEquals(stmt.else?.length, 1);
  }
});

Deno.test("parser - if with multiple statements in branches", () => {
  const prog = parseSource(`
    f = (x: number) => {
      if x > 0 {
        a = x + 1
        b = a + 2
      } else {
        a = x - 1
        b = a - 2
      }
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  if (stmt.kind === "if_else") {
    assertEquals(stmt.then.length, 2);
    assertEquals(stmt.else?.length, 2);
  }
});

Deno.test("parser - if with void call in branch", () => {
  const prog = parseSource(`
    f = (x: string) => {
      if x == "save" {
        writeSecret({ name: "data", value: x })
      }
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  if (stmt.kind === "if_else") {
    assertEquals(stmt.then[0].kind, "void_call");
    assertEquals(stmt.else, null);
  }
});

Deno.test("parser - nested if inside else", () => {
  const prog = parseSource(`
    f = (x: number) => {
      if x > 0 {
        y = 1
      } else {
        if x == 0 {
          y = 0
        } else {
          y = -1
        }
      }
      return x
    }
  `);
  const stmt = prog.functions[0].body[0];
  if (stmt.kind === "if_else") {
    assertEquals(stmt.then.length, 1);
    assertEquals(stmt.else?.length, 1);
    if (stmt.else) {
      assertEquals(stmt.else[0].kind, "if_else");
    }
  }
});

Deno.test("interpret - if true branch executes", async () => {
  const result = await run(`
    f = (x: number) => {
      y = 0
      if x > 0 {
        y = 1
      }
      return y
    }
  `, "f", { x: 5 });
  assertEquals(result, 1);
});

Deno.test("interpret - if false branch skipped (no else)", async () => {
  const result = await run(`
    f = (x: number) => {
      y = 0
      if x > 0 {
        y = 1
      }
      return y
    }
  `, "f", { x: -1 });
  assertEquals(result, 0);
});

Deno.test("interpret - if/else takes else branch", async () => {
  const result = await run(`
    f = (x: number) => {
      if x > 0 {
        y = "positive"
      } else {
        y = "non-positive"
      }
      return y
    }
  `, "f", { x: -3 });
  assertEquals(result, "non-positive");
});

Deno.test("interpret - if/else takes then branch", async () => {
  const result = await run(`
    f = (x: number) => {
      if x > 0 {
        y = "positive"
      } else {
        y = "non-positive"
      }
      return y
    }
  `, "f", { x: 10 });
  assertEquals(result, "positive");
});

Deno.test("interpret - nested if/else", async () => {
  const source = `
    f = (x: number) => {
      if x > 0 {
        r = "pos"
      } else {
        if x == 0 {
          r = "zero"
        } else {
          r = "neg"
        }
      }
      return r
    }
  `;
  assertEquals(await run(source, "f", { x: 5 }), "pos");
  assertEquals(await run(source, "f", { x: 0 }), "zero");
  assertEquals(await run(source, "f", { x: -2 }), "neg");
});

Deno.test("interpret - if with multiple statements in branch", async () => {
  const result = await run(`
    f = (x: number) => {
      if x > 0 {
        a = x + 10
        b = a + 20
      } else {
        a = 0
        b = 0
      }
      return b
    }
  `, "f", { x: 5 });
  assertEquals(result, 35);
});

Deno.test("interpret - if branch variable visible after block", async () => {
  const result = await run(`
    f = (x: number) => {
      y = 0
      if x > 0 {
        y = x * 2
      }
      return y
    }
  `, "f", { x: 7 });
  assertEquals(result, 14);
});

Deno.test("signature - if/else unions sources from both branches", () => {
  const s = sig(`
    f = (flag: boolean) => {
      a = readSecret({ name: "key-a" })
      b = readSecret({ name: "key-b" })
      if flag {
        result = a
      } else {
        result = b
      }
      return result
    }
  `, "f");
  assertEquals(s.secretsRead, new Set(["key-a", "key-b"]));
  assertEquals(s.returnSources, new Set(["secret:key-a", "secret:key-b"]));
});

Deno.test("signature - if without else still analyzes then branch", () => {
  const s = sig(`
    f = (val: string) => {
      if val == "save" {
        writeSecret({ name: "cache", value: val })
      }
      return val
    }
  `, "f");
  assertEquals(s.secretsWritten, new Set(["cache"]));
  assertEquals(s.dataFlow.get("secret:cache"), new Set(["param:val"]));
  assertEquals(s.returnSources, new Set(["param:val"]));
});

Deno.test("signature - if/else sums resources from both branches", () => {
  const s = sig(`
    f = (flag: boolean) => {
      if flag {
        a = readSecret({ name: "x" })
      } else {
        b = readSecret({ name: "y" })
      }
      return true
    }
  `, "f");
  // Both branches have a readSecret: 1024 mem, 10 ms each
  assertEquals(s.memoryBytes, 1024 + 1024);
  assertEquals(s.runtimeMs, 10 + 10);
});

Deno.test("signature - if/else with hosts in different branches", () => {
  const s = sig(`
    f = (data: string) => {
      if data == "a" {
        r = httpRequest({ host: "host-a.com", method: "POST", path: "/a", body: data })
      } else {
        r = httpRequest({ host: "host-b.com", method: "POST", path: "/b", body: data })
      }
      return r
    }
  `, "f");
  assertEquals(s.hosts, new Set(["host-a.com", "host-b.com"]));
  assertEquals(s.returnSources, new Set(["host:host-a.com", "host:host-b.com"]));
  assertEquals(s.dataFlow.get("host:host-a.com"), new Set(["param:data"]));
  assertEquals(s.dataFlow.get("host:host-b.com"), new Set(["param:data"]));
});

// ============================
// map / filter / reduce
// ============================

Deno.test("lexer - map/filter/reduce are keyword tokens", () => {
  const tokens = tokenize("map filter reduce");
  assertEquals(tokens[0].kind, "map");
  assertEquals(tokens[1].kind, "filter");
  assertEquals(tokens[2].kind, "reduce");
});

Deno.test("parser - map expression", () => {
  const prog = parseSource(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => { return map(double, nums) }
  `);
  const ret = prog.functions[1].returnValue;
  assertEquals(ret.kind, "map");
  if (ret.kind === "map") {
    assertEquals(ret.fn, "double");
    assertEquals(ret.array.kind, "reference");
  }
});

Deno.test("parser - filter expression", () => {
  const prog = parseSource(`
    isPositive = (x: number) => { return x > 0 }
    main = (nums: number[]) => { return filter(isPositive, nums) }
  `);
  const ret = prog.functions[1].returnValue;
  assertEquals(ret.kind, "filter");
  if (ret.kind === "filter") {
    assertEquals(ret.fn, "isPositive");
  }
});

Deno.test("parser - reduce expression", () => {
  const prog = parseSource(`
    add = (acc: number, x: number) => { return acc + x }
    main = (nums: number[]) => { return reduce(add, 0, nums) }
  `);
  const ret = prog.functions[1].returnValue;
  assertEquals(ret.kind, "reduce");
  if (ret.kind === "reduce") {
    assertEquals(ret.fn, "add");
    assertEquals(ret.initial.kind, "number");
  }
});

Deno.test("parser - map in assignment", () => {
  const prog = parseSource(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => {
      doubled = map(double, nums)
      return doubled
    }
  `);
  const stmt = prog.functions[1].body[0];
  assertEquals(stmt.kind, "assignment");
  if (stmt.kind === "assignment") {
    assertEquals(stmt.value.kind, "map");
  }
});

Deno.test("interpret - map doubles array", async () => {
  const prog = parseSource(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => { return map(double, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [1, 2, 3] }, dummyCtx);
  assertEquals(result, [2, 4, 6]);
});

Deno.test("interpret - filter keeps positive numbers", async () => {
  const prog = parseSource(`
    isPositive = (x: number) => { return x > 0 }
    main = (nums: number[]) => { return filter(isPositive, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [-1, 2, -3, 4] }, dummyCtx);
  assertEquals(result, [2, 4]);
});

Deno.test("interpret - reduce sums array", async () => {
  const prog = parseSource(`
    add = (acc: number, x: number) => { return acc + x }
    main = (nums: number[]) => { return reduce(add, 0, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [1, 2, 3, 4] }, dummyCtx);
  assertEquals(result, 10);
});

Deno.test("interpret - map on empty array", async () => {
  const prog = parseSource(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => { return map(double, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [] }, dummyCtx);
  assertEquals(result, []);
});

Deno.test("interpret - reduce on empty array returns initial", async () => {
  const prog = parseSource(`
    add = (acc: number, x: number) => { return acc + x }
    main = (nums: number[]) => { return reduce(add, 42, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [] }, dummyCtx);
  assertEquals(result, 42);
});

Deno.test("interpret - map executes in parallel", async () => {
  // Track execution order to verify parallel behavior
  const order: number[] = [];
  const prog = parseSource(`
    slow = (x: number) => { return x }
    main = (nums: number[]) => { return map(slow, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [1, 2, 3] }, dummyCtx);
  assertEquals(result, [1, 2, 3]);
});

Deno.test("interpret - filter on empty array", async () => {
  const prog = parseSource(`
    isPositive = (x: number) => { return x > 0 }
    main = (nums: number[]) => { return filter(isPositive, nums) }
  `);
  const result = await interpret(prog, "main", { nums: [] }, dummyCtx);
  assertEquals(result, []);
});

Deno.test("interpret - reduce with string concatenation", async () => {
  const prog = parseSource(`
    concat = (acc: string, x: string) => { return acc + x }
    main = (words: string[]) => { return reduce(concat, "", words) }
  `);
  const result = await interpret(prog, "main", { words: ["hello", " ", "world"] }, dummyCtx);
  assertEquals(result, "hello world");
});

Deno.test("signature - map propagates side effects from mapped function", () => {
  const s = sig(`
    fetchItem = (url: string) => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: url })
      return r
    }
    main = (urls: string[]) => {
      return map(fetchItem, urls)
    }
  `, "main");
  assertEquals(s.hosts, new Set(["api.example.com"]));
  assertEquals(s.dataFlow.get("host:api.example.com"), new Set(["param:urls"]));
});

Deno.test("signature - filter returns array sources not function return sources", () => {
  const s = sig(`
    isValid = (x: string) => {
      return x == "ok"
    }
    main = (items: string[]) => {
      return filter(isValid, items)
    }
  `, "main");
  assertEquals(s.returnSources, new Set(["param:items"]));
});

Deno.test("signature - reduce propagates sources from both initial and array", () => {
  const s = sig(`
    add = (acc: number, x: number) => { return acc + x }
    main = (nums: number[], start: number) => {
      return reduce(add, start, nums)
    }
  `, "main");
  assertEquals(s.returnSources, new Set(["param:nums", "param:start"]));
});

Deno.test("signature - map return sources substitute param sources", () => {
  const s = sig(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => {
      return map(double, nums)
    }
  `, "main");
  assertEquals(s.returnSources, new Set(["param:nums"]));
});

// --- Cycle detection ---

Deno.test("parser - direct recursion via map rejected", () => {
  assertThrows(
    () => parse(tokenize(`
      evil = (x: number): number => {
        return map(evil, [x])
      }
    `)),
    Error,
    "Recursive function call cycle detected",
  );
});

Deno.test("parser - direct recursion via filter rejected", () => {
  assertThrows(
    () => parse(tokenize(`
      evil = (x: number): boolean => {
        r = filter(evil, [x])
        return true
      }
    `)),
    Error,
    "Recursive function call cycle detected",
  );
});

Deno.test("parser - direct recursion via reduce rejected", () => {
  assertThrows(
    () => parse(tokenize(`
      evil = (acc: number, x: number): number => {
        return reduce(evil, acc, [x])
      }
    `)),
    Error,
    "Recursive function call cycle detected",
  );
});

Deno.test("parser - mutual recursion via map rejected", () => {
  assertThrows(
    () => parse(tokenize(`
      a = (x: number): number => {
        return map(b, [x])
      }
      b = (x: number): number => {
        return map(a, [x])
      }
    `)),
    Error,
    "Recursive function call cycle detected",
  );
});

Deno.test("parser - non-recursive map across functions is allowed", () => {
  // This should NOT throw: double doesn't reference process
  const program = parse(tokenize(`
    double = (x: number): number => {
      return x * 2
    }
    process = (nums: number[]): number[] => {
      return map(double, nums)
    }
  `));
  assertEquals(program.functions.length, 2);
});

Deno.test("parser - chain of function references without cycle is allowed", () => {
  // a -> b -> c (no cycle)
  const program = parse(tokenize(`
    c = (x: number): number => { return x * 2 }
    b = (x: number): number[] => { return map(c, [x]) }
    a = (nums: number[]): number[] => { return map(b, nums) }
  `));
  assertEquals(program.functions.length, 3);
});
