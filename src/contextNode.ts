import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "./types.ts";
import { type ContextRunner, setContextRunner } from "./context.ts";

const storage = new AsyncLocalStorage<ExecutionContext>();

const asyncLocalRunner: ContextRunner = {
  get: () => storage.getStore(),
  run: <T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> =>
    storage.run(ctx, fn),
};

// Switch context propagation to AsyncLocalStorage, which survives interleaved
// awaits — required on Node/Deno whenever programs can run concurrently in one
// realm (a server handling requests, for example). Returns a function that
// restores the previous runner. Deliberately not re-exported from mod.ts, so
// that bundling for the browser cannot pull `node:async_hooks` in.
export const enableNodeContext = (): () => void =>
  setContextRunner(asyncLocalRunner);
