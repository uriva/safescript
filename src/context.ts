import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "./types.ts";

const contextStorage = new AsyncLocalStorage<ExecutionContext>();

export const getContext = (): ExecutionContext => {
  const ctx = contextStorage.getStore();
  if (!ctx) throw new Error("No execution context — call execute() first.");
  return ctx;
};

export const runWithContext = <T>(
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> => contextStorage.run(ctx, fn);
