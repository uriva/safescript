import { z } from "zod/v4";

export type OpTag =
  | "pure"
  | "crypto"
  | "network"
  | "time"
  | "random"
  | "loop"
  | "disk";

export type Manifest = {
  readonly tags: ReadonlySet<OpTag>;
  readonly hosts: ReadonlySet<string>;
  readonly memoryBytes: number;
  readonly runtimeMs: number;
  readonly diskBytes: number;
};

export type DagOp<
  I extends z.ZodObject<z.ZodRawShape>,
  O extends z.ZodType,
> = {
  readonly _tag: "dag-op";
  readonly inputSchema: I;
  readonly outputSchema: O;
  readonly manifest: Manifest;
  readonly run: (input: z.infer<I>) => Promise<z.infer<O>>;
};

export type ExecutionContext = {
  readonly fetch: typeof globalThis.fetch;
};

export type ResourceBounds = {
  readonly memoryBytes: number;
  readonly runtimeMs: number;
  readonly diskBytes: number;
};

export const emptyManifest: Manifest = {
  tags: new Set(),
  hosts: new Set(),
  memoryBytes: 0,
  runtimeMs: 0,
  diskBytes: 0,
};
