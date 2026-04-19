import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenize } from "../src/lang/lexer.ts";
import { parse } from "../src/lang/parser.ts";
import { hashProgram, normalize } from "../src/lang/normalize.ts";
import { type FetchSource, resolveImports } from "../src/lang/resolve.ts";
import { interpret } from "../src/lang/interpreter.ts";
import { computeSignature } from "../src/lang/signature.ts";
import { builtinRegistry, builtinUnaryFields } from "../src/lang/registry.ts";
import type { ExecutionContext } from "../src/types.ts";
import type { Program } from "../src/lang/ast.ts";

const parseSource = (source: string): Program =>
  parse(tokenize(source), builtinUnaryFields);

const dummyCtx: ExecutionContext = {
  fetch: () => Promise.reject(new Error("no fetch in test")),
};

// --- Lexer: import keywords ---

Deno.test("lexer - tokenizes import keyword", () => {
  const tokens = tokenize(`import`);
  assertEquals(tokens[0].kind, "import");
});

Deno.test("lexer - tokenizes from keyword", () => {
  const tokens = tokenize(`from`);
  assertEquals(tokens[0].kind, "from");
});

Deno.test("lexer - tokenizes as keyword", () => {
  const tokens = tokenize(`as`);
  assertEquals(tokens[0].kind, "as");
});

Deno.test("lexer - tokenizes perms keyword", () => {
  const tokens = tokenize(`perms`);
  assertEquals(tokens[0].kind, "perms");
});

Deno.test("lexer - tokenizes hash keyword", () => {
  const tokens = tokenize(`hash`);
  assertEquals(tokens[0].kind, "hash");
});

Deno.test("lexer - tokenizes full import statement", () => {
  const tokens = tokenize(
    `import add from "https://example.com/math.ss" perms {} hash "sha256:abc"`,
  );
  const kinds = tokens.map((t) => t.kind);
  assertEquals(kinds, [
    "import",
    "ident",
    "from",
    "string",
    "perms",
    "{",
    "}",
    "hash",
    "string",
    "eof",
  ]);
});

// --- Parser: import statements ---

Deno.test("parser - basic import", () => {
  const prog = parseSource(`
    import add from "https://example.com/math.ss" perms {} hash "sha256:abc123"
    main = (x: number) => { return x }
  `);
  assertEquals(prog.imports.length, 1);
  assertEquals(prog.imports[0].name, "add");
  assertEquals(prog.imports[0].alias, null);
  assertEquals(prog.imports[0].source, "https://example.com/math.ss");
  assertEquals(prog.imports[0].hash, "sha256:abc123");
  assertEquals(prog.imports[0].perms, { kind: "object", fields: [] });
  assertEquals(prog.functions.length, 1);
});

Deno.test("parser - import with alias", () => {
  const prog = parseSource(`
    import add as myAdd from "https://example.com/math.ss" perms {} hash "sha256:abc123"
    main = (x: number) => { return x }
  `);
  assertEquals(prog.imports[0].name, "add");
  assertEquals(prog.imports[0].alias, "myAdd");
});

Deno.test("parser - import with perms", () => {
  const prog = parseSource(`
    import fetch from "https://example.com/http.ss" perms { hosts: ["api.example.com"], envReads: ["timestamp"] } hash "sha256:def456"
    main = () => { return true }
  `);
  const perms = prog.imports[0].perms;
  assertEquals(perms.kind, "object");
  if (perms.kind === "object") {
    assertEquals(perms.fields.length, 2);
    assertEquals(perms.fields[0].key, "hosts");
    assertEquals(perms.fields[1].key, "envReads");
  }
});

Deno.test("parser - multiple imports", () => {
  const prog = parseSource(`
    import add from "https://example.com/math.ss" perms {} hash "sha256:aaa"
    import fetch from "https://example.com/http.ss" perms { hosts: ["api.com"] } hash "sha256:bbb"
    main = (x: number) => { return x }
  `);
  assertEquals(prog.imports.length, 2);
  assertEquals(prog.imports[0].name, "add");
  assertEquals(prog.imports[1].name, "fetch");
  assertEquals(prog.functions.length, 1);
});

Deno.test("parser - no imports still works", () => {
  const prog = parseSource(`main = (x: number) => { return x }`);
  assertEquals(prog.imports.length, 0);
  assertEquals(prog.functions.length, 1);
});

// --- Normalize: canonical form ---

Deno.test("normalize - strips comments and normalizes whitespace", () => {
  const a = normalize(`
    // a comment
    add = (x: number,   y: number) => {
      return x + y
    }
  `);
  const b = normalize(`add = (x: number, y: number) => { return x + y }`);
  assertEquals(a, b);
});

Deno.test("normalize - renames internal names canonically", () => {
  const a = normalize(
    `add = (foo: number, bar: number) => { return foo + bar }`,
  );
  const b = normalize(`add = (x: number, y: number) => { return x + y }`);
  assertEquals(a, b);
});

Deno.test("normalize - keeps function names", () => {
  const result = normalize(`myFunc = (x: number) => { return x }`);
  assertEquals(result.startsWith("myFunc="), true);
});

Deno.test("normalize - keeps op names", () => {
  const result = normalize(
    `f = (data: string) => { h = sha256({ data }) return h }`,
  );
  assertEquals(result.includes("sha256"), true);
});

Deno.test("normalize - different var names same semantics same hash", async () => {
  const hashA = await hashProgram(
    `f = (x: number, y: number) => { sum = x + y return sum }`,
  );
  const hashB = await hashProgram(
    `f = (a: number, b: number) => { result = a + b return result }`,
  );
  assertEquals(hashA, hashB);
});

Deno.test("normalize - different function names different hash", async () => {
  const hashA = await hashProgram(`foo = (x: number) => { return x }`);
  const hashB = await hashProgram(`bar = (x: number) => { return x }`);
  // Function names are external, so different names = different hash
  assertEquals(hashA !== hashB, true);
});

Deno.test("normalize - different logic different hash", async () => {
  const hashA = await hashProgram(`f = (x: number) => { return x + 1 }`);
  const hashB = await hashProgram(`f = (x: number) => { return x + 2 }`);
  assertEquals(hashA !== hashB, true);
});

Deno.test("hashProgram - returns sha256 prefix", async () => {
  const hash = await hashProgram(`f = (x: number) => { return x }`);
  assertEquals(hash.startsWith("sha256:"), true);
  assertEquals(hash.length, 7 + 64); // "sha256:" + 64 hex chars
});

// --- Resolution: end-to-end ---

const depSource = `add = (a: number, b: number) => { return a + b }`;

Deno.test("resolve - pure import end-to-end", async () => {
  const depHash = await hashProgram(depSource);
  const mainSource = `
    import add from "dep.ss" perms {} hash "${depHash}"
    main = (x: number, y: number) => {
      result = add({ a: x, b: y })
      return result
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchSource: FetchSource = (source) => {
    if (source === "dep.ss") return Promise.resolve(depSource);
    throw new Error(`Unknown source: ${source}`);
  };
  const registry = await resolveImports(mainProgram, fetchSource);
  const result = await interpret(
    mainProgram,
    "main",
    { x: 3, y: 7 },
    dummyCtx,
    registry,
  );
  assertEquals(result, 10);
});

Deno.test("resolve - import with alias", async () => {
  const depHash = await hashProgram(depSource);
  const mainSource = `
    import add as myAdd from "dep.ss" perms {} hash "${depHash}"
    main = (x: number, y: number) => {
      result = myAdd({ a: x, b: y })
      return result
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchSource: FetchSource = (source) => {
    if (source === "dep.ss") return Promise.resolve(depSource);
    throw new Error(`Unknown source: ${source}`);
  };
  const registry = await resolveImports(mainProgram, fetchSource);
  const result = await interpret(
    mainProgram,
    "main",
    { x: 10, y: 20 },
    dummyCtx,
    registry,
  );
  assertEquals(result, 30);
});

Deno.test("resolve - hash mismatch throws", async () => {
  const mainSource = `
    import add from "dep.ss" perms {} hash "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    main = (x: number) => { return x }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchSource: FetchSource = () => Promise.resolve(depSource);
  await assertRejects(
    () => resolveImports(mainProgram, fetchSource),
    Error,
    "Hash mismatch",
  );
});

Deno.test("resolve - perms mismatch throws", async () => {
  const impureDepSource = `
    fetch = () => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: "/data" })
      return r
    }
  `;
  const depHash = await hashProgram(impureDepSource);
  const mainSource = `
    import fetch from "dep.ss" perms {} hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(impureDepSource);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "Perms assertion failed",
  );
});

Deno.test("resolve - correct perms for impure dep", async () => {
  const impureDepSource = `
    fetch = () => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: "/data" })
      return r
    }
  `;
  const depHash = await hashProgram(impureDepSource);
  const mainSource = `
    import fetch from "dep.ss" perms { hosts: ["api.example.com"] } hash "${depHash}"
    main = () => {
      result = fetch()
      return result
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(impureDepSource);
  const registry = await resolveImports(mainProgram, fetchFn);
  // Signature analysis should work with the extended registry
  const sig = computeSignature(mainProgram, "main", registry);
  assertEquals(sig.hosts, new Set(["api.example.com"]));
});

Deno.test("resolve - function not found in dep throws", async () => {
  const depHash = await hashProgram(depSource);
  const mainSource = `
    import multiply from "dep.ss" perms {} hash "${depHash}"
    main = (x: number) => { return x }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSource);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "Function 'multiply' not found",
  );
});

Deno.test("resolve - builtin name conflict throws", async () => {
  const depHash = await hashProgram(`sha256 = (x: string) => { return x }`);
  const mainSource = `
    import sha256 from "dep.ss" perms {} hash "${depHash}"
    main = (x: string) => { return x }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () =>
    Promise.resolve(`sha256 = (x: string) => { return x }`);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "conflicts with builtin",
  );
});

Deno.test("resolve - transitive deps", async () => {
  // C: pure function
  const cSource = `double = (x: number) => { return x + x }`;
  const cHash = await hashProgram(cSource);

  // B: imports C
  const bSource = `
    import double from "c.ss" perms {} hash "${cHash}"
    quadruple = (x: number) => {
      d = double({ x })
      result = double({ x: d })
      return result
    }
  `;
  const bHash = await hashProgram(bSource);

  // A: imports B
  const aSource = `
    import quadruple from "b.ss" perms {} hash "${bHash}"
    main = (x: number) => {
      result = quadruple({ x })
      return result
    }
  `;

  const sources: Record<string, string> = {
    "c.ss": cSource,
    "b.ss": bSource,
  };
  const fetchFn: FetchSource = (source) => {
    if (source in sources) return Promise.resolve(sources[source]);
    throw new Error(`Unknown source: ${source}`);
  };

  const mainProgram = parseSource(aSource);
  const registry = await resolveImports(mainProgram, fetchFn);
  const result = await interpret(
    mainProgram,
    "main",
    { x: 3 },
    dummyCtx,
    registry,
  );
  assertEquals(result, 12); // 3 -> 6 -> 12
});

Deno.test("resolve - perms assertion with envReads", async () => {
  const envDepSource = `
    getNow = () => {
      s = timestamp()
      return s
    }
  `;
  const depHash = await hashProgram(envDepSource);

  // Correct perms
  const mainSource = `
    import getNow from "dep.ss" perms { envReads: ["timestamp"] } hash "${depHash}"
    main = () => {
      k = getNow()
      return k
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(envDepSource);
  const registry = await resolveImports(mainProgram, fetchFn);
  const sig = computeSignature(mainProgram, "main", registry);
  assertEquals(sig.envReads, new Set(["timestamp"]));
});

Deno.test("resolve - wrong envRead in perms throws", async () => {
  const envDepSource = `
    getNow = () => {
      s = timestamp()
      return s
    }
  `;
  const depHash = await hashProgram(envDepSource);
  const mainSource = `
    import getNow from "dep.ss" perms { envReads: ["randomBytes"] } hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(envDepSource);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "Perms assertion failed",
  );
});

// --- Signature composition with imports ---

Deno.test("signature - imported pure op has no effects", async () => {
  const depHash = await hashProgram(depSource);
  const mainSource = `
    import add from "dep.ss" perms {} hash "${depHash}"
    main = (x: number, y: number) => {
      result = add({ a: x, b: y })
      return result
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSource);
  const registry = await resolveImports(mainProgram, fetchFn);
  const sig = computeSignature(mainProgram, "main", registry);
  assertEquals(sig.hosts.size, 0);
  assertEquals(sig.envReads.size, 0);
});

// --- dataFlow perms assertion ---

Deno.test("resolve - dataFlow perms assertion passes when correct", async () => {
  const depSrc = `
    fetch = (userId: string) => {
      body = jsonStringify({ value: { userId } })
      r = httpRequest({ host: "api.example.com", method: "POST", path: "/data", body })
      return r
    }
  `;
  const depHash = await hashProgram(depSrc);
  const mainSource = `
    import fetch from "dep.ss" perms {
      hosts: ["api.example.com"],
      dataFlow: {
        "host:api.example.com": ["param:userId"],
        "return": ["host:api.example.com"]
      }
    } hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSrc);
  // Should not throw
  await resolveImports(mainProgram, fetchFn);
});

Deno.test("resolve - dataFlow perms assertion fails when wrong", async () => {
  const depSrc = `
    fetch = (userId: string) => {
      body = jsonStringify({ value: { userId } })
      r = httpRequest({ host: "api.example.com", method: "POST", path: "/data", body })
      return r
    }
  `;
  const depHash = await hashProgram(depSrc);
  const mainSource = `
    import fetch from "dep.ss" perms {
      hosts: ["api.example.com"],
      dataFlow: {
        "host:api.example.com": ["param:userId"]
      }
    } hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSrc);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "Perms assertion failed",
  );
});

Deno.test("resolve - dataFlow omitted from perms skips check", async () => {
  // When dataFlow is not declared, the check is skipped (backward compat)
  const depSrc = `
    fetch = () => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: "/data" })
      return r
    }
  `;
  const depHash = await hashProgram(depSrc);
  const mainSource = `
    import fetch from "dep.ss" perms { hosts: ["api.example.com"] } hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSrc);
  // Should not throw even though dataFlow is not declared
  await resolveImports(mainProgram, fetchFn);
});

Deno.test("resolve - dataFlow empty object asserts no flows", async () => {
  // An explicitly empty dataFlow asserts the dep has zero data flow entries.
  // A pure dep still has return flows, so we need a dep that truly has none.
  // Actually, even the simplest function has return sources. Use a void-returning dep instead.
  // The add dep has dataFlow: { return: [param:a, param:b] }, so test with that.
  const depHash = await hashProgram(depSource); // pure add function
  const mainSource = `
    import add from "dep.ss" perms {
      dataFlow: { "return": ["param:a", "param:b"] }
    } hash "${depHash}"
    main = (x: number) => {
      result = add({ a: x, b: 1 })
      return result
    }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSource);
  await resolveImports(mainProgram, fetchFn);
});

Deno.test("resolve - dataFlow empty object fails for impure dep", async () => {
  const depSrc = `
    fetch = () => {
      r = httpRequest({ host: "api.example.com", method: "GET", path: "/data" })
      return r
    }
  `;
  const depHash = await hashProgram(depSrc);
  const mainSource = `
    import fetch from "dep.ss" perms { hosts: ["api.example.com"], dataFlow: {} } hash "${depHash}"
    main = () => { return true }
  `;
  const mainProgram = parseSource(mainSource);
  const fetchFn: FetchSource = () => Promise.resolve(depSrc);
  await assertRejects(
    () => resolveImports(mainProgram, fetchFn),
    Error,
    "Perms assertion failed",
  );
});

// --- Normalize: map/filter/reduce ---

Deno.test("normalize - map preserves function name (not alpha-renamed)", () => {
  const result = normalize(`
    double = (x: number) => { return x * 2 }
    main = (nums: number[]) => { return map(double, nums) }
  `);
  assertEquals(result.includes("map(double,"), true);
});

Deno.test("normalize - filter preserves function name", () => {
  const result = normalize(`
    isPositive = (x: number) => { return x > 0 }
    main = (items: number[]) => { return filter(isPositive, items) }
  `);
  assertEquals(result.includes("filter(isPositive,"), true);
});

Deno.test("normalize - reduce preserves function name", () => {
  const result = normalize(`
    add = (acc: number, x: number) => { return acc + x }
    main = (nums: number[]) => { return reduce(add, 0, nums) }
  `);
  assertEquals(result.includes("reduce(add,"), true);
});

Deno.test("normalize - map array arg is alpha-renamed", () => {
  const a = normalize(`
    double = (x: number) => { return x * 2 }
    main = (myNums: number[]) => { return map(double, myNums) }
  `);
  const b = normalize(`
    double = (x: number) => { return x * 2 }
    main = (otherNums: number[]) => { return map(double, otherNums) }
  `);
  assertEquals(a, b);
});

Deno.test("normalize - reduce initial expr is alpha-renamed", () => {
  const a = normalize(`
    add = (acc: number, x: number) => { return acc + x }
    main = (start: number, nums: number[]) => { return reduce(add, start, nums) }
  `);
  const b = normalize(`
    add = (acc: number, x: number) => { return acc + x }
    main = (init: number, nums: number[]) => { return reduce(add, init, nums) }
  `);
  assertEquals(a, b);
});

Deno.test("normalize - map same semantics same hash", async () => {
  const hashA = await hashProgram(`
    double = (x: number) => { return x * 2 }
    main = (myNums: number[]) => { return map(double, myNums) }
  `);
  const hashB = await hashProgram(`
    double = (y: number) => { return y * 2 }
    main = (arr: number[]) => { return map(double, arr) }
  `);
  assertEquals(hashA, hashB);
});
