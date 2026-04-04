import { z } from "zod/v4";

export type OpTag =
  | "pure"
  | "crypto"
  | "network"
  | "secret:read"
  | "secret:write"
  | "time"
  | "random"
  | "loop"
  | "disk";

export type Manifest = {
  readonly tags: ReadonlySet<OpTag>;
  readonly secretsRead: ReadonlySet<string>;
  readonly secretsWritten: ReadonlySet<string>;
  readonly hosts: ReadonlySet<string>;
  readonly taintedHosts: ReadonlyMap<string, ReadonlySet<string>>;
  readonly outputTainted: boolean;
  readonly taintSources: ReadonlySet<string>;
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
  readonly readSecret: (name: string) => Promise<string>;
  readonly writeSecret: (name: string, value: string) => Promise<void>;
  readonly fetch: typeof globalThis.fetch;
};

export type ResourceBounds = {
  readonly memoryBytes: number;
  readonly runtimeMs: number;
  readonly diskBytes: number;
};

export const emptyManifest: Manifest = {
  tags: new Set(),
  secretsRead: new Set(),
  secretsWritten: new Set(),
  hosts: new Set(),
  taintedHosts: new Map(),
  outputTainted: false,
  taintSources: new Set(),
  memoryBytes: 0,
  runtimeMs: 0,
  diskBytes: 0,
};
