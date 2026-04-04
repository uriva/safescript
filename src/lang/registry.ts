import type { DagOp } from "../types.ts";
import type { z } from "zod/v4";
import * as pure from "../ops/pure.ts";
import * as crypto from "../ops/crypto.ts";
import * as io from "../ops/io.ts";
import * as source from "../ops/source.ts";

export type OpEntry = {
  readonly staticFields: ReadonlySet<string>;
  // deno-lint-ignore no-explicit-any
  readonly create: (staticParams: Record<string, unknown>) => DagOp<any, any>;
};

// deno-lint-ignore no-explicit-any
const direct = (dagOp: DagOp<any, any>): OpEntry => ({
  staticFields: new Set(),
  create: () => dagOp,
});

const factory = (
  staticFields: readonly string[],
  // deno-lint-ignore no-explicit-any
  fn: (params: Record<string, unknown>) => DagOp<any, any>,
): OpEntry => ({
  staticFields: new Set(staticFields),
  create: fn,
});

export const builtinRegistry: ReadonlyMap<string, OpEntry> = new Map<string, OpEntry>([
  // pure
  ["jsonParse", direct(pure.jsonParse)],
  ["jsonStringify", direct(pure.jsonStringify)],
  ["stringConcat", direct(pure.stringConcat)],
  ["base64urlEncode", direct(pure.base64urlEncode)],
  ["base64urlDecode", direct(pure.base64urlDecode)],
  ["pick", direct(pure.pick)],
  ["merge", direct(pure.merge)],
  ["sha256", direct(pure.sha256)],
  // crypto
  ["generateEd25519KeyPair", direct(crypto.generateEd25519KeyPair)],
  ["generateX25519KeyPair", direct(crypto.generateX25519KeyPair)],
  ["ed25519Sign", direct(crypto.ed25519Sign)],
  ["aesGenerateKey", direct(crypto.aesGenerateKey)],
  ["aesEncrypt", direct(crypto.aesEncrypt)],
  ["aesDecrypt", direct(crypto.aesDecrypt)],
  ["x25519DeriveKey", direct(crypto.x25519DeriveKey)],
  ["importIdentity", direct(crypto.importIdentity)],
  ["exportIdentity", direct(crypto.exportIdentity)],
  // io
  ["readSecret", factory(["name"], (p) => io.readSecret(p.name as string))],
  ["writeSecret", factory(["name"], (p) => io.writeSecret(p.name as string))],
  ["httpRequest", factory(["host"], (p) => io.httpRequest(p.host as string))],
  // source
  ["timestamp", direct(source.timestamp)],
  ["randomBytes", direct(source.randomBytes)],
]);
