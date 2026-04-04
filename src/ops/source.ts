import { z } from "zod/v4";
import { op } from "../op.ts";

export const timestamp = op({
  input: z.object({}),
  output: z.object({ timestamp: z.number() }),
  tags: ["time"],
  resources: { memoryBytes: 64, runtimeMs: 1, diskBytes: 0 },
  run: async () => ({ timestamp: Date.now() }),
});

export const literal = <T extends z.ZodType>(schema: T, value: z.infer<T>) =>
  op({
    input: z.object({}),
    output: schema,
    tags: ["pure"],
    resources: { memoryBytes: 64, runtimeMs: 0, diskBytes: 0 },
    run: async () => value,
  });

export const randomBytes = op({
  input: z.object({ length: z.number() }),
  output: z.object({ bytes: z.string() }),
  tags: ["random"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ length }) => {
    const buf = crypto.getRandomValues(new Uint8Array(length));
    const binary = String.fromCharCode(...buf);
    return {
      bytes: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
        /=+$/,
        "",
      ),
    };
  },
});
