import type { DagOp } from "../types.ts";
import * as pure from "../ops/pure.ts";
import * as crypto from "../ops/crypto.ts";
import * as io from "../ops/io.ts";
import * as source from "../ops/source.ts";

export type OpEntry = {
  readonly staticFields: ReadonlySet<string>;
  readonly unaryField: string | null;
  readonly resolveStaticParams?: (
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
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
  resolveStaticParams?: (
    params: Record<string, unknown>,
  ) => Record<string, unknown>,
): OpEntry => ({
  staticFields: new Set(staticFields),
  unaryField,
  resolveStaticParams,
  create: fn,
});

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const resolveHttpStaticParams = (
  params: Record<string, unknown>,
): Record<string, unknown> => {
  if (params.host === "") {
    throw new Error("Invalid declared host ''");
  }
  const hasHost = params.host !== undefined;
  const hasUrl = typeof params.url === "string" && params.url.length > 0;

  if (hasHost && hasUrl) {
    const declaredHost = String(params.host);
    io.validateDeclaredHost(declaredHost);
    const rawUrl = String(params.url);
    if (SCHEME_RE.test(rawUrl)) {
      const parsed = (() => {
        try {
          return new URL(rawUrl);
        } catch {
          throw new Error(`Invalid HTTP URL '${rawUrl}'`);
        }
      })();
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Unsupported HTTP protocol '${parsed.protocol}'`);
      }
      if (parsed.username || parsed.password) {
        throw new Error("HTTP URL must not include credentials");
      }
      const colonIdx = declaredHost.indexOf(":");
      const expectedHostname = colonIdx >= 0
        ? declaredHost.slice(0, colonIdx)
        : declaredHost;
      const expectedPort = colonIdx >= 0
        ? declaredHost.slice(colonIdx + 1)
        : "";
      if (parsed.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
        throw new Error(
          `Static URL host '${parsed.hostname}' does not match declared host '${expectedHostname}'`,
        );
      }
      const defaultPort = parsed.protocol === "https:" ? "443" : "80";
      if (expectedPort) {
        if (
          parsed.port !== expectedPort &&
          !(expectedPort === defaultPort && parsed.port === "")
        ) {
          throw new Error(
            `Static URL port '${parsed.port}' does not match declared host '${declaredHost}'`,
          );
        }
      } else if (parsed.port !== "") {
        throw new Error(
          `Static URL port '${parsed.port}' does not match declared host '${declaredHost}'`,
        );
      }
    } else if (rawUrl.startsWith("//") || rawUrl.startsWith("/\\")) {
      throw new Error(
        `Invalid relative URL '${rawUrl}': must not start with '//' or '/\\'`,
      );
    }
    return params;
  }

  if (hasHost) {
    io.validateDeclaredHost(String(params.host));
    return params;
  }

  if (hasUrl) {
    const rawUrl = String(params.url);
    const urlObj = (() => {
      try {
        return new URL(rawUrl);
      } catch {
        throw new Error(`Invalid HTTP URL '${rawUrl}'`);
      }
    })();
    if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:") {
      throw new Error(`Unsupported HTTP protocol '${urlObj.protocol}'`);
    }
    if (urlObj.username || urlObj.password) {
      throw new Error("HTTP URL must not include credentials");
    }
    const derivedHost = urlObj.port
      ? `${urlObj.hostname}:${urlObj.port}`
      : urlObj.hostname;
    io.validateDeclaredHost(derivedHost);
    return { ...params, host: derivedHost };
  }

  return params;
};

export const builtinRegistry: ReadonlyMap<string, OpEntry> = new Map<
  string,
  OpEntry
>([
  // pure
  ["jsonParse", direct(pure.jsonParse, "text")],
  ["parseJson", direct(pure.jsonParse, "text")],
  ["jsonStringify", direct(pure.jsonStringify, "value")],
  ["stringStringify", direct(pure.stringStringify, "value")],
  ["len", direct(pure.len, "value")],
  ["objectKeys", direct(pure.objectKeys, "obj")],
  ["keys", direct(pure.objectKeys, "obj")],
  ["typeOf", direct(pure.typeOf, "value")],
  ["typeof", direct(pure.typeOf, "value")],
  ["buildMultipartBody", direct(pure.buildMultipartBody)],
  ["stringConcat", direct(pure.stringConcat, "parts")],
  ["stringIncludes", direct(pure.stringIncludes)],
  ["stringReplace", direct(pure.stringReplace)],
  ["stringRegex", direct(pure.stringRegex)],
  ["stringSplit", direct(pure.stringSplit)],
  ["split", direct(pure.stringSplit)],
  ["stringSlice", direct(pure.stringSlice)],
  ["slice", direct(pure.stringSlice)],
  ["stringLower", direct(pure.stringLower, "text")],
  ["stringUpper", direct(pure.stringUpper, "text")],
  ["stringTrim", direct(pure.stringTrim, "text")],
  ["trim", direct(pure.stringTrim, "text")],
  ["stringStartsWith", direct(pure.stringStartsWith)],
  ["stringEndsWith", direct(pure.stringEndsWith)],
  ["toString", direct(pure.toString, "value")],
  ["urlEncode", direct(pure.urlEncode, "text")],
  ["base64urlEncode", direct(pure.base64urlEncode, "text")],
  ["base64urlDecode", direct(pure.base64urlDecode, "encoded")],
  ["pick", direct(pure.pick)],
  ["arrayAppend", direct(pure.arrayAppend)],
  ["arrayConcat", direct(pure.arrayConcat, "parts")],
  ["arrayJoin", direct(pure.arrayJoin, "array")],
  ["join", direct(pure.arrayJoin, "array")],
  ["assert", direct(pure.assert, "condition")],
  ["doc", direct(pure.doc)],
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
  [
    "httpRequest",
    factory(
      ["host"],
      (p) => io.httpRequest(p.host as string),
      "url",
      resolveHttpStaticParams,
    ),
  ],
  // source
  ["timestamp", direct(source.timestamp)],
  ["randomBytes", direct(source.randomBytes, "length")],
]);

export const builtinUnaryFields: ReadonlyMap<string, string> = new Map(
  [...builtinRegistry.entries()]
    .filter(([, entry]) => entry.unaryField !== null)
    .map(([name, entry]) => [name, entry.unaryField!]),
);
