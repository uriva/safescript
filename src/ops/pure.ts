import { z } from "zod/v4";
import { op } from "../op.ts";

export const jsonParse = op({
  input: z.object({ text: z.string() }),
  output: z.object({ value: z.unknown() }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => ({ value: JSON.parse(text) }),
});

export const jsonStringify = op({
  input: z.object({ value: z.unknown() }),
  output: z.object({ text: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ value }) => ({ text: JSON.stringify(value) }),
});

export const stringConcat = op({
  input: z.object({ parts: z.array(z.string()) }),
  output: z.object({ result: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ parts }) => ({ result: parts.join("") }),
});

export const stringIncludes = op({
  input: z.object({ haystack: z.string(), needle: z.string() }),
  output: z.object({ result: z.boolean() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ haystack, needle }) => ({ result: haystack.includes(needle) }),
});

export const stringLower = op({
  input: z.object({ text: z.string() }),
  output: z.object({ result: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => ({ result: text.toLowerCase() }),
});

export const urlEncode = op({
  input: z.object({ text: z.string() }),
  output: z.object({ encoded: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => ({ encoded: encodeURIComponent(text) }),
});

export const base64urlEncode = op({
  input: z.object({ text: z.string() }),
  output: z.object({ encoded: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => {
    const bytes = new TextEncoder().encode(text);
    const binary = String.fromCharCode(...bytes);
    return {
      encoded: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
        /=+$/,
        "",
      ),
    };
  },
});

export const base64urlDecode = op({
  input: z.object({ encoded: z.string() }),
  output: z.object({ text: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ encoded }) => {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    binary.split("").forEach((ch, i) => {
      bytes[i] = ch.charCodeAt(0);
    });
    return { text: new TextDecoder().decode(bytes) };
  },
});

export const pick = op({
  input: z.object({ obj: z.record(z.unknown()), keys: z.array(z.string()) }),
  output: z.object({ obj: z.record(z.unknown()) }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ obj, keys }) => ({
    obj: Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k))),
  }),
});

export const arrayAppend = op({
  input: z.object({ array: z.array(z.unknown()), element: z.unknown() }),
  output: z.object({ array: z.array(z.unknown()) }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ array, element }) => ({ array: [...array, element] }),
});

export const merge = op({
  input: z.object({
    a: z.record(z.unknown()),
    b: z.record(z.unknown()),
  }),
  output: z.object({ result: z.record(z.unknown()) }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ a, b }) => ({ result: { ...a, ...b } }),
});

export const sha256 = op({
  input: z.object({ data: z.string() }),
  output: z.object({ hash: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 5, diskBytes: 0 },
  run: async ({ data }) => {
    const bytes = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      bytes.buffer as ArrayBuffer,
    );
    const hashBytes = new Uint8Array(hashBuffer);
    const binary = String.fromCharCode(...hashBytes);
    return {
      hash: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
        /=+$/,
        "",
      ),
    };
  },
});

export const assert = op({
  input: z.object({ condition: z.boolean(), message: z.string().optional() }),
  output: z.object({ ok: z.literal(true) }),
  tags: ["pure"],
  resources: { memoryBytes: 256, runtimeMs: 1, diskBytes: 0 },
  run: async ({ condition, message }) => {
    if (!condition) throw new Error(message ?? "assertion failed");
    return { ok: true as const };
  },
});
