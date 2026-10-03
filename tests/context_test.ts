import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { enableNodeContext } from "../src/contextNode.ts";
import { getContext, runWithContext } from "../src/context.ts";
import type { ExecutionContext } from "../src/types.ts";

const ctxWith = (id: string): ExecutionContext =>
  ({
    fetch: globalThis.fetch.bind(globalThis),
    ...(id ? ({ id } as Record<string, unknown>) : {}),
  }) as ExecutionContext;

const idOf = (ctx: ExecutionContext): unknown =>
  (ctx as unknown as { id?: string }).id;

// ─── stack propagation (the default, used in browsers) ──────────────────────

Deno.test("getContext throws outside of a run", () => {
  assertThrows(() => getContext(), Error, "No execution context");
});

Deno.test("context is visible synchronously and across awaits", async () => {
  const ctx = ctxWith("outer");
  const seen = await runWithContext(ctx, async () => {
    const before = idOf(getContext());
    await new Promise((r) => setTimeout(r, 1));
    return [before, idOf(getContext())];
  });
  assertEquals(seen, ["outer", "outer"]);
});

Deno.test("context does not leak after a run completes", async () => {
  await runWithContext(ctxWith("first"), async () => {});
  assertThrows(() => getContext(), Error, "No execution context");
});

Deno.test("context does not leak when a run rejects", async () => {
  await assertRejects(() =>
    runWithContext(ctxWith("boom"), () => Promise.reject(new Error("boom")))
  );
  assertThrows(() => getContext(), Error, "No execution context");
});

Deno.test("context is restored when a run throws synchronously", () => {
  const ctx = ctxWith("outer");
  assertThrows(
    () =>
      runWithContext(ctx, () => {
        assertEquals(idOf(getContext()), "outer");
        throw new Error("sync boom");
      }),
    Error,
    "sync boom",
  );
  assertThrows(() => getContext(), Error, "No execution context");
});

Deno.test("nested runs restore the enclosing context", async () => {
  const seen = await runWithContext(ctxWith("outer"), async () => {
    const before = idOf(getContext());
    await runWithContext(ctxWith("inner"), async () => {
      await new Promise((r) => setTimeout(r, 1));
      assertEquals(idOf(getContext()), "inner");
    });
    return [before, idOf(getContext())];
  });
  assertEquals(seen, ["outer", "outer"]);
});

// ─── AsyncLocalStorage propagation (Node/Deno concurrent hosts) ─────────────

Deno.test("enableNodeContext isolates concurrent runs", async () => {
  const restore = enableNodeContext();
  try {
    const observe = (id: string, delay: number, hold: number) =>
      runWithContext(ctxWith(id), async () => {
        await new Promise((r) => setTimeout(r, delay));
        const first = idOf(getContext());
        await new Promise((r) => setTimeout(r, hold));
        return [first, idOf(getContext())];
      });

    const [slow, fast] = await Promise.all([
      observe("slow", 12, 12),
      observe("fast", 1, 1),
    ]);
    assertEquals(slow, ["slow", "slow"]);
    assertEquals(fast, ["fast", "fast"]);
  } finally {
    restore();
  }
});

Deno.test("enableNodeContext still nests correctly", async () => {
  const restore = enableNodeContext();
  try {
    const seen = await runWithContext(ctxWith("outer"), async () => {
      const before = idOf(getContext());
      await Promise.all([
        runWithContext(ctxWith("a"), async () => {
          await new Promise((r) => setTimeout(r, 5));
        }),
        runWithContext(ctxWith("b"), async () => {
          await new Promise((r) => setTimeout(r, 1));
        }),
      ]);
      return [before, idOf(getContext())];
    });
    assertEquals(seen, ["outer", "outer"]);
  } finally {
    restore();
  }
});

Deno.test("enableNodeContext restore puts the previous runner back", async () => {
  const first = enableNodeContext();
  const restoreFirst = enableNodeContext();
  restoreFirst();
  let seen: unknown;
  await runWithContext(ctxWith("still-node"), () => {
    seen = idOf(getContext());
    return Promise.resolve();
  });
  assertEquals(seen, "still-node");
  first();
  seen = undefined;
  await runWithContext(ctxWith("back-to-stack"), () => {
    seen = idOf(getContext());
    return Promise.resolve();
  });
  assertEquals(seen, "back-to-stack");
});
