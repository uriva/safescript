import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { z } from "zod/v4";
import { compose, emptyManifest, execute, op } from "../mod.ts";
import { makeManifest, mergeManifests } from "../src/manifest.ts";
import type { ExecutionContext, Manifest } from "../src/types.ts";

const mockCtx: ExecutionContext = {
  fetch: globalThis.fetch,
};

// ─── op() ─────────────────────────────────────────────────────────────────

Deno.test("op - creates a valid DagOp with correct manifest", () => {
  const add = op({
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.object({ sum: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 100, runtimeMs: 1, diskBytes: 0 },
    run: async ({ a, b }) => ({ sum: a + b }),
  });
  assertEquals(add._tag, "dag-op");
  assertEquals(add.manifest.tags.has("pure"), true);
  assertEquals(add.manifest.memoryBytes, 100);
  assertEquals(add.manifest.runtimeMs, 1);
});

Deno.test("op - run function produces correct output", async () => {
  const double = op({
    input: z.object({ n: z.number() }),
    output: z.object({ result: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ n }) => ({ result: n * 2 }),
  });
  const result = await double.run({ n: 5 });
  assertEquals(result, { result: 10 });
});

Deno.test("op - hosts are recorded in manifest", () => {
  const netOp = op({
    input: z.object({ url: z.string() }),
    output: z.object({ status: z.number() }),
    tags: ["network"],
    resources: { memoryBytes: 1024, runtimeMs: 5000, diskBytes: 0 },
    hosts: ["api.example.com"],
    run: async () => ({ status: 200 }),
  });
  assertEquals(netOp.manifest.hosts.has("api.example.com"), true);
});

// ─── compose() single-wire ────────────────────────────────────────────────

Deno.test("compose - single wire chains from → into", async () => {
  const toStr = op({
    input: z.object({ n: z.number() }),
    output: z.object({ text: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ n }) => ({ text: String(n) }),
  });
  const upper = op({
    input: z.object({ data: z.object({ text: z.string() }) }),
    output: z.object({ result: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ data }) => ({ result: data.text.toUpperCase() }),
  });
  const composed = compose({ into: upper, from: toStr, key: "data" });
  const result = await composed.run({ n: 42 });
  assertEquals(result, { result: "42" });
});

Deno.test("compose - removes wired key from input schema", () => {
  const from = op({
    input: z.object({ x: z.number() }),
    output: z.object({ y: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ x }) => ({ y: String(x) }),
  });
  const into = op({
    input: z.object({ y: z.string(), extra: z.number() }),
    output: z.object({ out: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ y, extra }) => ({ out: `${y}-${extra}` }),
  });
  const composed = compose({ into, from, key: "y" });
  assertEquals("x" in composed.inputSchema.shape, true);
  assertEquals("extra" in composed.inputSchema.shape, true);
  assertEquals("y" in composed.inputSchema.shape, false);
});

Deno.test("compose - merges resource bounds", () => {
  const a = op({
    input: z.object({ x: z.number() }),
    output: z.object({ y: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 100, runtimeMs: 10, diskBytes: 5 },
    run: async ({ x }) => ({ y: x }),
  });
  const b = op({
    input: z.object({ y: z.number() }),
    output: z.object({ z: z.number() }),
    tags: ["crypto"],
    resources: { memoryBytes: 200, runtimeMs: 20, diskBytes: 3 },
    run: async ({ y }) => ({ z: y }),
  });
  const composed = compose({ into: b, from: a, key: "y" });
  assertEquals(composed.manifest.memoryBytes, 300);
  assertEquals(composed.manifest.runtimeMs, 30);
  assertEquals(composed.manifest.diskBytes, 8);
  assertEquals(composed.manifest.tags.has("pure"), true);
  assertEquals(composed.manifest.tags.has("crypto"), true);
});

Deno.test("compose - throws on incompatible overlapping keys", () => {
  const from = op({
    input: z.object({ shared: z.string() }),
    output: z.object({ y: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ shared }) => ({ y: shared }),
  });
  const into = op({
    input: z.object({ y: z.string(), shared: z.number() }),
    output: z.object({ out: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ y }) => ({ out: y }),
  });
  assertThrows(
    () => compose({ into, from, key: "y" }),
    Error,
    "incompatible types",
  );
});

// ─── compose() multi-wire ─────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
Deno.test("compose - multi-wire wires multiple keys", async () => {
  const srcA = op({
    input: z.object({ seed: z.number() }),
    output: z.object({ val: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ seed }) => ({ val: seed * 2 }),
  });
  const srcB = op({
    input: z.object({}),
    output: z.object({ val: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async () => ({ val: "hello" }),
  });
  const combine = op({
    input: z.object({
      a: z.object({ val: z.number() }),
      b: z.object({ val: z.string() }),
    }),
    output: z.object({ result: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ a, b }) => ({ result: `${b.val}-${a.val}` }),
  });
  // Multi-wire: from is a Record, no key
  const composed = (compose as any)({
    into: combine,
    from: { a: srcA, b: srcB },
  });
  const result = await composed.run({ seed: 5 });
  assertEquals(result, { result: "hello-10" });
});

// ─── manifest helpers ─────────────────────────────────────────────────────

Deno.test("makeManifest - basic manifest creation", () => {
  const m = makeManifest(
    ["network"],
    { memoryBytes: 1024, runtimeMs: 100, diskBytes: 0 },
    ["api.example.com"],
  );
  assertEquals(m.tags.has("network"), true);
  assertEquals(m.hosts.has("api.example.com"), true);
});

Deno.test("makeManifest - pure op is empty on hosts", () => {
  const m = makeManifest(
    ["pure"],
    { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
  );
  assertEquals(m.hosts.size, 0);
});

Deno.test("mergeManifests - unions tags", () => {
  const a: Manifest = {
    ...emptyManifest,
    tags: new Set(["pure"]),
  };
  const b: Manifest = {
    ...emptyManifest,
    tags: new Set(["crypto"]),
  };
  const merged = mergeManifests(a, b);
  assertEquals(merged.tags.has("pure"), true);
  assertEquals(merged.tags.has("crypto"), true);
});

Deno.test("mergeManifests - sums resource bounds", () => {
  const a: Manifest = {
    ...emptyManifest,
    memoryBytes: 100,
    runtimeMs: 10,
    diskBytes: 5,
  };
  const b: Manifest = {
    ...emptyManifest,
    memoryBytes: 200,
    runtimeMs: 20,
    diskBytes: 3,
  };
  const merged = mergeManifests(a, b);
  assertEquals(merged.memoryBytes, 300);
  assertEquals(merged.runtimeMs, 30);
  assertEquals(merged.diskBytes, 8);
});

// ─── execute() ────────────────────────────────────────────────────────────

Deno.test("execute - validates input, runs, validates output", async () => {
  const add = op({
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.object({ sum: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ a, b }) => ({ sum: a + b }),
  });
  const result = await execute(add, { a: 3, b: 4 }, mockCtx);
  assertEquals(result, { sum: 7 });
});

Deno.test("execute - rejects invalid input", async () => {
  const add = op({
    input: z.object({ a: z.number() }),
    output: z.object({ result: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ a }) => ({ result: a }),
  });
  await assertRejects(
    () =>
      execute(add, { a: "not a number" } as unknown as { a: number }, mockCtx),
  );
});

Deno.test("execute - rejects bad output from run function", async () => {
  const badOp = op({
    input: z.object({}),
    output: z.object({ n: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async () => ({ n: "not a number" }) as unknown as { n: number },
  });
  await assertRejects(() => execute(badOp, {}, mockCtx));
});

Deno.test("execute - composed program runs end-to-end", async () => {
  const double = op({
    input: z.object({ n: z.number() }),
    output: z.object({ value: z.number() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ n }) => ({ value: n * 2 }),
  });
  const addStr = op({
    input: z.object({
      data: z.object({ value: z.number() }),
      prefix: z.string(),
    }),
    output: z.object({ result: z.string() }),
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
    run: async ({ data, prefix }) => ({ result: `${prefix}${data.value}` }),
  });
  const program = compose({ into: addStr, from: double, key: "data" });
  const result = await execute(program, { n: 5, prefix: "val:" }, mockCtx);
  assertEquals(result, { result: "val:10" });
});
