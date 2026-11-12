import { z } from "zod/v4";

export type OpTag =
  | "pure"
  | "crypto"
  | "network"
  | "time"
  | "random"
  | "loop"
  | "disk";

export type LabelShape =
  | { readonly kind: "record"; readonly prefix: string }
  | { readonly kind: "array"; readonly element: LabelShape }
  | {
    readonly kind: "object";
    readonly fields: Readonly<Record<string, LabelShape>>;
  };

export type Manifest = {
  readonly tags: ReadonlySet<OpTag>;
  readonly hosts: ReadonlySet<string>;
  // Labels this op's output carries regardless of its inputs, as opaque
  // `kind:id` strings (e.g. `viewer:alice`, `owner:bob`). The analyzer
  // unions these with input-derived labels at every call site; it never
  // interprets them. Optional so existing manifests keep working.
  readonly emits?: ReadonlySet<string>;
  // Optional structured label shape for field-sensitive taint projection
  // (e.g. `{ kind: "object", fields: { items: { kind: "array", element: { kind: "record", prefix: "db:customers" } } } }`).
  // Accessing `.company` on a `record` emits `<prefix>.company`, while passing
  // the unprojected record or indexing dynamically emits `<prefix>.*`.
  readonly emitsShape?: LabelShape;
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
  emits: new Set(),
  memoryBytes: 0,
  runtimeMs: 0,
  diskBytes: 0,
};
