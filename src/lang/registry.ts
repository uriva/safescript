import type { DagOp } from "../types.ts";
import type { z } from "zod/v4";
import * as pure from "../ops/pure.ts";
import * as crypto from "../ops/crypto.ts";
import * as io from "../ops/io.ts";
import * as source from "../ops/source.ts";

export type OpEntry = {
  readonly staticFields: ReadonlySet<string>;
  readonly unaryField: string | null;
  // deno-lint-ignore no-explicit-any
  readonly create: (staticParams: Record<string, unknown>) => DagOp<any, any>;
};

// deno-lint-ignore no-explicit-any
const direct = (
  dagOp: DagOp<any, any>,
  unaryField: string | null = null,
): OpEntry => ({
  staticFields: new Set(),
  unaryField,
  create: () => dagOp,
});

const factory = (
  staticFields: readonly string[],
  // deno-lint-ignore no-explicit-any
  fn: (params: Record<string, unknown>) => DagOp<any, any>,
  unaryField: string | null = null,
): OpEntry => ({
  staticFields: new Set(staticFields),
  unaryField,
  create: fn,
});

export const builtinRegistry: ReadonlyMap<string, OpEntry> = new Map<
  string,
  OpEntry
>([
  // pure
  ["jsonParse", direct(pure.jsonParse, "text")],
  ["jsonStringify", direct(pure.jsonStringify, "value")],
  ["stringConcat", direct(pure.stringConcat, "parts")],
  ["stringIncludes", direct(pure.stringIncludes)],
  ["stringLower", direct(pure.stringLower, "text")],
  ["urlEncode", direct(pure.urlEncode, "text")],
  ["base64urlEncode", direct(pure.base64urlEncode, "text")],
  ["base64urlDecode", direct(pure.base64urlDecode, "encoded")],
  ["pick", direct(pure.pick)],
  ["merge", direct(pure.merge)],
  ["sha256", direct(pure.sha256, "data")],
  // crypto
  ["generateEd25519KeyPair", direct(crypto.generateEd25519KeyPair)],
  ["generateX25519KeyPair", direct(crypto.generateX25519KeyPair)],
  [
    "ed25519PublicFromPrivate",
    direct(crypto.ed25519PublicFromPrivate, "privateKey"),
  ],
  [
    "x25519PublicFromPrivate",
    direct(crypto.x25519PublicFromPrivate, "privateKey"),
  ],
  ["ed25519Sign", direct(crypto.ed25519Sign)],
  ["aesGenerateKey", direct(crypto.aesGenerateKey)],
  ["aesEncrypt", direct(crypto.aesEncrypt)],
  ["aesDecrypt", direct(crypto.aesDecrypt)],
  ["x25519DeriveKey", direct(crypto.x25519DeriveKey)],
  // io
  ["httpRequest", factory(["host"], (p) => io.httpRequest(p.host as string))],
  // source
  ["timestamp", direct(source.timestamp)],
  ["randomBytes", direct(source.randomBytes, "length")],
]);

export const builtinUnaryFields: ReadonlyMap<string, string> = new Map(
  [...builtinRegistry.entries()]
    .filter(([, entry]) => entry.unaryField !== null)
    .map(([name, entry]) => [name, entry.unaryField!]),
);
