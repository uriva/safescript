import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenize } from "../src/lang/lexer.ts";
import { parse } from "../src/lang/parser.ts";
import { interpret } from "../src/lang/interpreter.ts";
import { computeSignature } from "../src/lang/signature.ts";
import { builtinRegistry, builtinUnaryFields } from "../src/lang/registry.ts";
import type { ExecutionContext } from "../src/types.ts";
import type { Program } from "../src/lang/ast.ts";

const parseSource = (source: string): Program =>
  parse(tokenize(source), builtinUnaryFields);

const makeMockCtx = (
  expectedUrl?: string,
  responseBody = '{"ok":true}',
  status = 200,
): {
  ctx: ExecutionContext;
  getCalls: () => { url: string; init?: RequestInit }[];
} => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const ctx: ExecutionContext = {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      calls.push({ url, init });
      if (expectedUrl && url !== expectedUrl) {
        throw new Error(`Expected URL ${expectedUrl}, got ${url}`);
      }
      return Promise.resolve(new Response(responseBody, { status }));
    },
  };
  return { ctx, getCalls: () => calls };
};

Deno.test("reproduction: httpRequest unary call with URL syntax", async () => {
  const source = `
    main = () => {
      res = httpRequest("https://api.github.com/user/repos")
      return res
    }
  `;
  const prog = parseSource(source);
  const sig = computeSignature(prog, "main", builtinRegistry);
  assertEquals(sig.hosts.has("api.github.com"), true);

  const { ctx, getCalls } = makeMockCtx("https://api.github.com/user/repos");
  const result = await interpret(prog, "main", {}, ctx, builtinRegistry) as {
    status: number;
    body: string;
  };
  assertEquals(result.status, 200);
  assertEquals(result.body, '{"ok":true}');
  assertEquals(getCalls().length, 1);
  assertEquals(getCalls()[0].init?.method, "GET");
});

Deno.test("reproduction: httpRequest with object containing url (no host, no path, no method)", async () => {
  const source = `
    main = (token: string) => {
      res = httpRequest({
        url: "https://api.github.com/repos/uriva/justlikeyou/actions/runs",
        headers: { "Authorization": "Bearer " + token }
      })
      return res
    }
  `;
  const prog = parseSource(source);
  const sig = computeSignature(prog, "main", builtinRegistry);
  assertEquals(sig.hosts.has("api.github.com"), true);

  const { ctx, getCalls } = makeMockCtx(
    "https://api.github.com/repos/uriva/justlikeyou/actions/runs",
  );
  const result = await interpret(
    prog,
    "main",
    { token: "test_tok" },
    ctx,
    builtinRegistry,
  ) as { status: number; body: string };
  assertEquals(result.status, 200);
  assertEquals(getCalls().length, 1);
  assertEquals(getCalls()[0].init?.method, "GET");
  assertEquals(
    (getCalls()[0].init?.headers as Record<string, string>)?.Authorization,
    "Bearer test_tok",
  );
});

Deno.test("reproduction: httpRequest with host and url does not produce host+undefined", async () => {
  const source = `
    main = () => {
      res = httpRequest({
        host: "api.github.com",
        method: "GET",
        url: "https://api.github.com/repos/uriva/justlikeyou/actions/runs?per_page=5"
      })
      return res
    }
  `;
  const prog = parseSource(source);
  const sig = computeSignature(prog, "main", builtinRegistry);
  assertEquals(sig.hosts.has("api.github.com"), true);

  const { ctx, getCalls } = makeMockCtx(
    "https://api.github.com/repos/uriva/justlikeyou/actions/runs?per_page=5",
  );
  const result = await interpret(prog, "main", {}, ctx, builtinRegistry) as {
    status: number;
    body: string;
  };
  assertEquals(result.status, 200);
  assertEquals(getCalls()[0].url.includes("undefined"), false);
});

Deno.test("reproduction: parseJson alias works with unary text", async () => {
  const source = `
    main = (raw: string) => {
      data = parseJson(raw)
      return data.value
    }
  `;
  const prog = parseSource(source);
  const result = await interpret(
    prog,
    "main",
    { raw: '{"count":42}' },
    { fetch: globalThis.fetch },
    builtinRegistry,
  );
  assertEquals(result, { count: 42 });
});

Deno.test("reproduction: split alias works with stringSplit", async () => {
  const source = `
    main = (raw: string) => {
      res = split({ text: raw, delimiter: "," })
      return res.parts
    }
  `;
  const prog = parseSource(source);
  const result = await interpret(
    prog,
    "main",
    { raw: "a,b,c" },
    { fetch: globalThis.fetch },
    builtinRegistry,
  );
  assertEquals(result, ["a", "b", "c"]);
});

Deno.test("reproduction: helpful parser error for fetch call", () => {
  const source = `
    main = () => {
      res = fetch("https://api.github.com/user")
      return res
    }
  `;
  const err = assertThrows(() => parseSource(source)) as Error;
  assertEquals(
    err.message.includes("Safescript does not support 'fetch'"),
    true,
    `Error should mention fetch is not supported, got: ${err.message}`,
  );
  assertEquals(
    err.message.includes("httpRequest"),
    true,
    `Error should guide to httpRequest, got: ${err.message}`,
  );
});

Deno.test("reproduction: helpful parser error for loops", () => {
  const sourceForIn = `
    main = (arr: string[]) => {
      for line in arr {
      }
      return 1
    }
  `;
  const err1 = assertThrows(() => parseSource(sourceForIn)) as Error;
  assertEquals(
    err1.message.includes("does not support 'for' loops") ||
      err1.message.includes("Safescript has no loops"),
    true,
    `Error should explain no loops, got: ${err1.message}`,
  );

  const sourceForParens = `
    main = (arr: string[]) => {
      for (x in arr) {
      }
      return 1
    }
  `;
  const err2 = assertThrows(() => parseSource(sourceForParens)) as Error;
  assertEquals(
    err2.message.includes("does not support 'for' loops") ||
      err2.message.includes("Safescript has no loops"),
    true,
    `Error should explain no loops, got: ${err2.message}`,
  );
});
