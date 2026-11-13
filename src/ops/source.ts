import { z } from "zod/v4";
import { op } from "../op.ts";

export const MAX_RANDOM_BYTES = 65_536;

const bytesToBase64Url = (bytes: Uint8Array): string => {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

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
  input: z.object({ length: z.number().int().min(0).max(MAX_RANDOM_BYTES) }),
  output: z.object({ bytes: z.string() }),
  tags: ["random"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ length }) => {
    if (!Number.isInteger(length) || length < 0 || length > MAX_RANDOM_BYTES) {
      throw new RangeError(
        `randomBytes length must be an integer between 0 and ${MAX_RANDOM_BYTES}, got ${length}`,
      );
    }
    const buf = crypto.getRandomValues(new Uint8Array(length));
    return { bytes: bytesToBase64Url(buf) };
  },
});
