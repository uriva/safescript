import { z } from "zod/v4";
import type { DagOp, OpTag } from "./types.ts";
import { makeManifest } from "./manifest.ts";

export const op = <
  I extends z.ZodObject<z.ZodRawShape>,
  O extends z.ZodType,
>({
  input,
  output,
  tags,
  resources,
  run,
  secretsRead,
  secretsWritten,
  hosts,
}: {
  input: I;
  output: O;
  tags: readonly OpTag[];
  resources: { memoryBytes: number; runtimeMs: number; diskBytes: number };
  run: (input: z.infer<I>) => Promise<z.infer<O>>;
  secretsRead?: readonly string[];
  secretsWritten?: readonly string[];
  hosts?: readonly string[];
}): DagOp<I, O> => ({
  _tag: "dag-op",
  inputSchema: input,
  outputSchema: output,
  manifest: makeManifest(tags, resources, secretsRead, secretsWritten, hosts),
  run,
});
