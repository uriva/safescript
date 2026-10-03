import type { ExecutionContext } from "./types.ts";

// How a context is made visible to `getContext()` for the duration of a run.
// `get` returns undefined outside any run.
export type ContextRunner = {
  readonly run: <T>(
    ctx: ExecutionContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
  readonly get: () => ExecutionContext | undefined;
};

// Save/restore propagation. Correct for sequential and nested execution — an
// inner run sees its own context and the enclosing one is restored afterwards.
// Not correct for two programs running *concurrently* in one JS realm: an
// interleaved `await` lets whichever resumed last clobber the other's context.
// This is the default because it has no dependencies, so the library bundles
// for the browser. Node/Deno hosts that can run programs concurrently must opt
// into AsyncLocalStorage with `enableNodeContext` from ./contextNode.ts.
const stackRunner: ContextRunner = (() => {
  let current: ExecutionContext | undefined;
  return {
    get: () => current,
    run: <T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> => {
      const previous = current;
      current = ctx;
      const restore = () => {
        current = previous;
      };
      let started: Promise<T>;
      try {
        started = fn();
      } catch (error) {
        restore();
        throw error;
      }
      return started.finally(restore);
    },
  };
})();

let runner: ContextRunner = stackRunner;

// Installs a propagation strategy and returns a function that restores the
// previous one.
export const setContextRunner = (next: ContextRunner): () => void => {
  const previous = runner;
  runner = next;
  return () => {
    runner = previous;
  };
};

export const getContext = (): ExecutionContext => {
  const ctx = runner.get();
  if (!ctx) throw new Error("No execution context — call execute() first.");
  return ctx;
};

export const runWithContext = <T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> => runner.run(ctx, fn);
