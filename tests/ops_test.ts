import { assertEquals } from "jsr:@std/assert";
import {
  base64urlDecode,
  base64urlEncode,
  jsonParse,
  jsonStringify,
  merge,
  pick,
  sha256,
  stringConcat,
} from "../src/ops/pure.ts";
import {
  aesDecrypt,
  aesEncrypt,
  aesGenerateKey,
  ed25519Sign,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  x25519DeriveKey,
} from "../src/ops/crypto.ts";
import { httpRequest, readSecret, writeSecret } from "../src/ops/io.ts";
import { literal, randomBytes, timestamp } from "../src/ops/source.ts";
import { execute } from "../src/execute.ts";
import type { ExecutionContext } from "../src/types.ts";
import { z } from "zod/v4";

const secrets: Record<string, string> = {};
const mockCtx: ExecutionContext = {
  readSecret: async (name: string) => secrets[name] ?? "",
  writeSecret: async (name: string, value: string) => {
    secrets[name] = value;
  },
  fetch: globalThis.fetch,
};

// ─── pure ops ─────────────────────────────────────────────────────────────

Deno.test("jsonParse - parses valid JSON", async () => {
  const result = await jsonParse.run({ text: '{"a":1}' });
  assertEquals(result.value, { a: 1 });
});

Deno.test("jsonStringify - stringifies value", async () => {
  const result = await jsonStringify.run({ value: { a: 1 } });
  assertEquals(result.text, '{"a":1}');
});

Deno.test("jsonParse + jsonStringify roundtrip", async () => {
  const original = { x: [1, 2, 3], y: "hello" };
  const stringified = await jsonStringify.run({ value: original });
  const parsed = await jsonParse.run({ text: stringified.text });
  assertEquals(parsed.value, original);
});

Deno.test("stringConcat - joins parts", async () => {
  const result = await stringConcat.run({ parts: ["a", "b", "c"] });
  assertEquals(result.result, "abc");
});

Deno.test("stringConcat - empty array", async () => {
  const result = await stringConcat.run({ parts: [] });
  assertEquals(result.result, "");
});

Deno.test("base64url encode/decode roundtrip", async () => {
  const text = "Hello, World! Special chars: +/=";
  const encoded = await base64urlEncode.run({ text });
  // base64url should not contain +, /, or = padding
  assertEquals(encoded.encoded.includes("+"), false);
  assertEquals(encoded.encoded.includes("/"), false);
  assertEquals(encoded.encoded.includes("="), false);
  const decoded = await base64urlDecode.run({ encoded: encoded.encoded });
  assertEquals(decoded.text, text);
});

Deno.test("pick - selects specified keys", async () => {
  const result = await pick.run({
    obj: { a: 1, b: 2, c: 3 },
    keys: ["a", "c"],
  });
  assertEquals(result.result, { a: 1, c: 3 });
});

Deno.test("pick - missing keys ignored", async () => {
  const result = await pick.run({
    obj: { a: 1 },
    keys: ["a", "missing"],
  });
  assertEquals(result.result, { a: 1 });
});

Deno.test("merge - combines two objects", async () => {
  const result = await merge.run({
    a: { x: 1 },
    b: { y: 2 },
  });
  assertEquals(result.result, { x: 1, y: 2 });
});

Deno.test("merge - b overrides a on conflict", async () => {
  const result = await merge.run({
    a: { x: 1 },
    b: { x: 2 },
  });
  assertEquals(result.result, { x: 2 });
});

Deno.test("sha256 - produces consistent hash", async () => {
  const r1 = await sha256.run({ data: "hello" });
  const r2 = await sha256.run({ data: "hello" });
  assertEquals(r1.hash, r2.hash);
  assertEquals(typeof r1.hash, "string");
  assertEquals(r1.hash.length > 0, true);
});

Deno.test("sha256 - different inputs produce different hashes", async () => {
  const r1 = await sha256.run({ data: "hello" });
  const r2 = await sha256.run({ data: "world" });
  assertEquals(r1.hash !== r2.hash, true);
});

// ─── crypto ops ───────────────────────────────────────────────────────────

Deno.test("generateEd25519KeyPair - produces key pair", async () => {
  const result = await generateEd25519KeyPair.run({});
  assertEquals(typeof result.publicKey, "string");
  assertEquals(typeof result.privateKey, "string");
  assertEquals(result.publicKey.length > 0, true);
  assertEquals(result.privateKey.length > 0, true);
});

Deno.test("ed25519Sign - signs data", async () => {
  const keyPair = await generateEd25519KeyPair.run({});
  const result = await ed25519Sign.run({
    data: "hello world",
    privateKey: keyPair.privateKey,
  });
  assertEquals(typeof result.signature, "string");
  assertEquals(result.signature.length > 0, true);
});

Deno.test("ed25519Sign - different data produces different signatures", async () => {
  const keyPair = await generateEd25519KeyPair.run({});
  const sig1 = await ed25519Sign.run({
    data: "hello",
    privateKey: keyPair.privateKey,
  });
  const sig2 = await ed25519Sign.run({
    data: "world",
    privateKey: keyPair.privateKey,
  });
  assertEquals(sig1.signature !== sig2.signature, true);
});

Deno.test("generateX25519KeyPair - produces key pair", async () => {
  const result = await generateX25519KeyPair.run({});
  assertEquals(typeof result.publicKey, "string");
  assertEquals(typeof result.privateKey, "string");
});

Deno.test("aesGenerateKey - produces a key", async () => {
  const result = await aesGenerateKey.run({});
  assertEquals(typeof result.key, "string");
  assertEquals(result.key.length > 0, true);
});

Deno.test("aes encrypt/decrypt roundtrip", async () => {
  const { key } = await aesGenerateKey.run({});
  const plaintext = "secret message";
  const encrypted = await aesEncrypt.run({ plaintext, key });
  assertEquals(typeof encrypted.ciphertext, "string");
  assertEquals(typeof encrypted.iv, "string");
  const decrypted = await aesDecrypt.run({
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    key,
  });
  assertEquals(decrypted.plaintext, plaintext);
});

Deno.test("aes encrypt produces different ciphertext each time (random IV)", async () => {
  const { key } = await aesGenerateKey.run({});
  const e1 = await aesEncrypt.run({ plaintext: "same", key });
  const e2 = await aesEncrypt.run({ plaintext: "same", key });
  assertEquals(e1.ciphertext !== e2.ciphertext, true);
});

Deno.test("x25519DeriveKey - derives a shared key", async () => {
  const alice = await generateX25519KeyPair.run({});
  const bob = await generateX25519KeyPair.run({});
  const salt = "test-salt";
  const { encoded: saltB64 } = await base64urlEncode.run({ text: salt });
  const aliceKey = await x25519DeriveKey.run({
    myPrivateKey: alice.privateKey,
    theirPublicKey: bob.publicKey,
    salt: saltB64,
    info: "test-context",
  });
  const bobKey = await x25519DeriveKey.run({
    myPrivateKey: bob.privateKey,
    theirPublicKey: alice.publicKey,
    salt: saltB64,
    info: "test-context",
  });
  assertEquals(aliceKey.derivedKey, bobKey.derivedKey);
});

// ─── io ops ───────────────────────────────────────────────────────────────

Deno.test("readSecret - reads from context", async () => {
  secrets["test-key"] = "test-value";
  const reader = readSecret("test-key");
  assertEquals(reader.manifest.secretsRead.has("test-key"), true);
  assertEquals(reader.manifest.outputTainted, true);
  const result = await execute(reader, {}, mockCtx);
  assertEquals(result, { value: "test-value" });
});

Deno.test("writeSecret - writes to context", async () => {
  const writer = writeSecret("new-key");
  assertEquals(writer.manifest.secretsWritten.has("new-key"), true);
  await execute(writer, { value: "stored" }, mockCtx);
  assertEquals(secrets["new-key"], "stored");
});

Deno.test("httpRequest - manifest declares host", () => {
  const req = httpRequest("api.example.com");
  assertEquals(req.manifest.hosts.has("api.example.com"), true);
  assertEquals(req.manifest.tags.has("network"), true);
});

// ─── source ops ───────────────────────────────────────────────────────────

Deno.test("timestamp - returns current time", async () => {
  const before = Date.now();
  const result = await timestamp.run({});
  const after = Date.now();
  assertEquals(result.timestamp >= before, true);
  assertEquals(result.timestamp <= after, true);
  assertEquals(timestamp.manifest.tags.has("time"), true);
});

Deno.test("literal - returns fixed value", async () => {
  const lit = literal(z.object({ x: z.number() }), { x: 42 });
  const result = await lit.run({});
  assertEquals(result, { x: 42 });
  assertEquals(lit.manifest.tags.has("pure"), true);
});

Deno.test("randomBytes - produces base64url-encoded bytes", async () => {
  const result = await randomBytes.run({ length: 16 });
  assertEquals(typeof result.bytes, "string");
  assertEquals(result.bytes.length > 0, true);
  assertEquals(randomBytes.manifest.tags.has("random"), true);
});

Deno.test("randomBytes - different calls produce different values", async () => {
  const r1 = await randomBytes.run({ length: 32 });
  const r2 = await randomBytes.run({ length: 32 });
  assertEquals(r1.bytes !== r2.bytes, true);
});
