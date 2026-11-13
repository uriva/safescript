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

type AsyncLocalStorageLike<T> = {
  readonly getStore: () => T | undefined;
  readonly run: <R>(store: T, callback: () => R) => R;
};

// Save/restore propagation fallback for browser runtimes without AsyncLocalStorage.
const stackRunner: ContextRunner = (() => {
  const box: { current: ExecutionContext | undefined } = { current: undefined };
  return {
    get: () => box.current,
    run: <T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> => {
      const previous = box.current;
      box.current = ctx;
      const restore = () => {
        box.current = previous;
      };
      try {
        return fn().finally(restore);
      } catch (error) {
        restore();
        throw error;
      }
    },
  };
})();

// On Deno 2+, Node 22+, and Workers with nodejs_compat, access AsyncLocalStorage
// via pure globalThis property lookup so concurrent runs never clobber each
// other across awaits, while browser bundlers see zero Node builtin imports.
const tryCreateAsyncLocalRunner = (): ContextRunner | null => {
  const proc = (globalThis as unknown as {
    process?: {
      getBuiltinModule?: (id: string) =>
        | { AsyncLocalStorage?: new <T>() => AsyncLocalStorageLike<T> }
        | undefined;
    };
  }).process;
  const mod = proc?.getBuiltinModule?.("node:async_hooks");
  const Als = mod?.AsyncLocalStorage;
  if (typeof Als !== "function") return null;
  const storage = new Als<ExecutionContext>();
  return {
    get: () => storage.getStore(),
    run: <T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> =>
      storage.run(ctx, fn),
  };
};

const defaultRunner: ContextRunner = tryCreateAsyncLocalRunner() ?? stackRunner;
const runnerBox: { current: ContextRunner } = { current: defaultRunner };

// Installs a propagation strategy and returns a function that restores the
// previous one.
export const setContextRunner = (next: ContextRunner): () => void => {
  const previous = runnerBox.current;
  runnerBox.current = next;
  return () => {
    runnerBox.current = previous;
  };
};

export const getContext = (): ExecutionContext => {
  const ctx = runnerBox.current.get();
  if (!ctx) throw new Error("No execution context — call execute() first.");
  return ctx;
};

export const runWithContext = <T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> => runnerBox.current.run(ctx, fn);
