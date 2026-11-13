import type { BinaryOp, FnDef, Program, Statement, Value } from "./ast.ts";
import { fnExprName } from "./ast.ts";
import { validateProgramSemantics } from "./parser.ts";
import { validateSafeRegex } from "../ops/pure.ts";

type FnMap = ReadonlyMap<string, FnDef>;

export type ToTypescriptOptions = {
  readonly functionName?: string;
  readonly stripTypes?: boolean;
  readonly treeShakeOps?: boolean;
  readonly ioOps?: readonly string[];
};

const B64_NEEDED_OPS = new Set([
  "base64urlEncode",
  "base64urlDecode",
  "sha256",
  "generateEd25519KeyPair",
  "generateX25519KeyPair",
  "ed25519PublicFromPrivate",
  "ed25519PublicFromPrivate",
  "x25519PublicFromPrivate",
  "ed25519Sign",
  "aesGenerateKey",
  "aesEncrypt",
  "aesDecrypt",
  "x25519DeriveKey",
  "randomBytes",
]);

const UNSAFE_LITERAL_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

const buildOpEntries = (strip: boolean): Record<string, string> => ({
  jsonParse: strip
    ? `jsonParse: async (args) =>\n    _JSON.parse(args.text),`
    : `jsonParse: async (args: { text: string }) =>\n    _JSON.parse(args.text),`,
  parseJson: strip
    ? `parseJson: async (args) =>\n    _JSON.parse(args.text),`
    : `parseJson: async (args: { text: string }) =>\n    _JSON.parse(args.text),`,
  jsonStringify: strip
    ? `jsonStringify: async (args) =>\n    _JSON.stringify(args.value),`
    : `jsonStringify: async (args: { value: unknown }) =>\n    _JSON.stringify(args.value),`,
  stringStringify: strip
    ? `stringStringify: async (args) =>\n    ({ text: _JSON.stringify(args.value) }),`
    : `stringStringify: async (args: { value: unknown }) =>\n    ({ text: _JSON.stringify(args.value) }),`,
  len: strip
    ? `len: async (args) =>\n    Array.isArray(args.value) || typeof args.value === "string"\n      ? args.value.length\n      : 0,`
    : `len: async (args: { value: unknown }) =>\n    Array.isArray(args.value) || typeof args.value === "string"\n      ? args.value.length\n      : 0,`,
  objectKeys: strip
    ? `objectKeys: async (args) => {\n    const target = args.obj ?? args.value;\n    return target && typeof target === "object" && !Array.isArray(target)\n      ? _Object.keys(target).filter((k) => !_FORBIDDEN_KEYS.has(k))\n      : [];\n  },`
    : `objectKeys: async (args: { obj?: unknown; value?: unknown }) => {\n    const target = args.obj ?? args.value;\n    return target && typeof target === "object" && !Array.isArray(target)\n      ? _Object.keys(target as Record<string, unknown>).filter((k) => !_FORBIDDEN_KEYS.has(k))\n      : [];\n  },`,
  keys: strip
    ? `keys: async (args) => {\n    const target = args.obj ?? args.value;\n    return target && typeof target === "object" && !Array.isArray(target)\n      ? _Object.keys(target).filter((k) => !_FORBIDDEN_KEYS.has(k))\n      : [];\n  },`
    : `keys: async (args: { obj?: unknown; value?: unknown }) => {\n    const target = args.obj ?? args.value;\n    return target && typeof target === "object" && !Array.isArray(target)\n      ? _Object.keys(target as Record<string, unknown>).filter((k) => !_FORBIDDEN_KEYS.has(k))\n      : [];\n  },`,
  typeOf: strip
    ? `typeOf: async (args) =>\n    args.value === null ? "null" : Array.isArray(args.value) ? "array" : typeof args.value,`
    : `typeOf: async (args: { value: unknown }) =>\n    args.value === null ? "null" : Array.isArray(args.value) ? "array" : typeof args.value,`,
  typeof: strip
    ? `typeof: async (args) =>\n    args.value === null ? "null" : Array.isArray(args.value) ? "array" : typeof args.value,`
    : `typeof: async (args: { value: unknown }) =>\n    args.value === null ? "null" : Array.isArray(args.value) ? "array" : typeof args.value,`,
  toString: strip
    ? `toString: async (args) => {\n    const v = args.value;\n    if (typeof v === "string") return v;\n    if (typeof v === "number" || typeof v === "boolean") return String(v);\n    if (v === null || v === undefined) return "";\n    throw new TypeError(\`toString expects a primitive value, got \${Array.isArray(v) ? "array" : typeof v}\`);\n  },`
    : `toString: async (args: { value: unknown }) => {\n    const v = args.value;\n    if (typeof v === "string") return v;\n    if (typeof v === "number" || typeof v === "boolean") return String(v);\n    if (v === null || v === undefined) return "";\n    throw new TypeError(\`toString expects a primitive value, got \${Array.isArray(v) ? "array" : typeof v}\`);\n  },`,
  stringConcat: strip
    ? `stringConcat: async (args) => {\n    const parts = args.parts;\n    let total = 0;\n    for (let i = 0; i < parts.length; i++) {\n      if (typeof parts[i] !== "string") {\n        throw new TypeError(\n          \`stringConcat expects string parts, got \${typeof parts[i]} at index \${i}\`,\n        );\n      }\n      total += parts[i].length;\n      if (total > 8388608) throw new Error("stringConcat exceeds maximum length");\n    }\n    return { result: parts.join("") };\n  },`
    : `stringConcat: async (args: { parts: string[] }) => {\n    const parts = args.parts;\n    let total = 0;\n    for (let i = 0; i < parts.length; i++) {\n      if (typeof parts[i] !== "string") {\n        throw new TypeError(\n          \`stringConcat expects string parts, got \${typeof parts[i]} at index \${i}\`,\n        );\n      }\n      total += parts[i].length;\n      if (total > 8388608) throw new Error("stringConcat exceeds maximum length");\n    }\n    return { result: parts.join("") };\n  },`,
  stringIncludes: strip
    ? `stringIncludes: async (args) =>\n    ({ result: (args.haystack ?? args.text ?? args.value ?? args.s ?? "").includes(args.needle ?? args.search ?? args.substring ?? "") }),`
    : `stringIncludes: async (args: { haystack?: string; text?: string; value?: string; s?: string; needle?: string; search?: string; substring?: string }) =>\n    ({ result: (args.haystack ?? args.text ?? args.value ?? args.s ?? "").includes(args.needle ?? args.search ?? args.substring ?? "") }),`,
  stringReplace: strip
    ? `stringReplace: async (args) => {\n    if (args.needle === "") throw new Error("needle must not be empty");\n    const count = args.haystack.split(args.needle).length - 1;\n    const all = args.all ?? true;\n    const applied = all ? count : Math.min(count, 1);\n    if (args.haystack.length + applied * (args.replacement.length - args.needle.length) > 8388608) throw new Error("stringReplace exceeds maximum length");\n    return {\n      result: all\n        ? args.haystack.replaceAll(args.needle, args.replacement)\n        : args.haystack.replace(args.needle, args.replacement),\n      count,\n    };\n  },`
    : `stringReplace: async (args: { haystack: string; needle: string; replacement: string; all?: boolean }) => {\n    if (args.needle === "") throw new Error("needle must not be empty");\n    const count = args.haystack.split(args.needle).length - 1;\n    const all = args.all ?? true;\n    const applied = all ? count : Math.min(count, 1);\n    if (args.haystack.length + applied * (args.replacement.length - args.needle.length) > 8388608) throw new Error("stringReplace exceeds maximum length");\n    return {\n      result: all\n        ? args.haystack.replaceAll(args.needle, args.replacement)\n        : args.haystack.replace(args.needle, args.replacement),\n      count,\n    };\n  },`,
  stringRegex: strip
    ? `stringRegex: async (args) => {\n    _validateRegex(args.pattern, args.text);\n    const match = new _RegExp(args.pattern).exec(args.text);\n    return match ? { match: true, groups: [...match].slice(1).map((g) => g ?? "") } : { match: false, groups: [] };\n  },`
    : `stringRegex: async (args: { text: string; pattern: string }) => {\n    _validateRegex(args.pattern, args.text);\n    const match = new _RegExp(args.pattern).exec(args.text);\n    return match ? { match: true, groups: [...match].slice(1).map((g) => g ?? "") } : { match: false, groups: [] as string[] };\n  },`,
  stringSplit: strip
    ? `stringSplit: async (args) =>\n    ({ parts: (args.text ?? args.haystack ?? "").split(args.delimiter) }),`
    : `stringSplit: async (args: { text?: string; haystack?: string; delimiter: string }) =>\n    ({ parts: (args.text ?? args.haystack ?? "").split(args.delimiter) }),`,
  split: strip
    ? `split: async (args) =>\n    ({ parts: (args.text ?? args.haystack ?? "").split(args.delimiter) }),`
    : `split: async (args: { text?: string; haystack?: string; delimiter: string }) =>\n    ({ parts: (args.text ?? args.haystack ?? "").split(args.delimiter) }),`,
  stringSlice: strip
    ? `stringSlice: async (args) => {\n    const target = args.array ?? args.text ?? args.haystack ?? args.value ?? "";\n    if (Array.isArray(target)) {\n      return args.end !== undefined ? target.slice(args.start, args.end) : target.slice(args.start);\n    }\n    const s = String(target);\n    return args.end !== undefined ? s.slice(args.start, args.end) : s.slice(args.start);\n  },`
    : `stringSlice: async (args: { text?: unknown; haystack?: string; array?: unknown[]; value?: unknown; start: number; end?: number }) => {\n    const target = args.array ?? args.text ?? args.haystack ?? args.value ?? "";\n    if (Array.isArray(target)) {\n      return args.end !== undefined ? target.slice(args.start, args.end) : target.slice(args.start);\n    }\n    const s = String(target);\n    return args.end !== undefined ? s.slice(args.start, args.end) : s.slice(args.start);\n  },`,
  slice: strip
    ? `slice: async (args) => {\n    const target = args.array ?? args.text ?? args.haystack ?? args.value ?? "";\n    if (Array.isArray(target)) {\n      return args.end !== undefined ? target.slice(args.start, args.end) : target.slice(args.start);\n    }\n    const s = String(target);\n    return args.end !== undefined ? s.slice(args.start, args.end) : s.slice(args.start);\n  },`
    : `slice: async (args: { text?: unknown; haystack?: string; array?: unknown[]; value?: unknown; start: number; end?: number }) => {\n    const target = args.array ?? args.text ?? args.haystack ?? args.value ?? "";\n    if (Array.isArray(target)) {\n      return args.end !== undefined ? target.slice(args.start, args.end) : target.slice(args.start);\n    }\n    const s = String(target);\n    return args.end !== undefined ? s.slice(args.start, args.end) : s.slice(args.start);\n  },`,
  stringLower: strip
    ? `stringLower: async (args) =>\n    ({ result: args.text.toLowerCase() }),`
    : `stringLower: async (args: { text: string }) =>\n    ({ result: args.text.toLowerCase() }),`,
  stringUpper: strip
    ? `stringUpper: async (args) =>\n    args.text.toUpperCase(),`
    : `stringUpper: async (args: { text: string }) =>\n    args.text.toUpperCase(),`,
  stringTrim: strip
    ? `stringTrim: async (args) =>\n    args.text.trim(),`
    : `stringTrim: async (args: { text: string }) =>\n    args.text.trim(),`,
  trim: strip
    ? `trim: async (args) =>\n    args.text.trim(),`
    : `trim: async (args: { text: string }) =>\n    args.text.trim(),`,
  stringStartsWith: strip
    ? `stringStartsWith: async (args) =>\n    args.text.startsWith(args.prefix),`
    : `stringStartsWith: async (args: { text: string; prefix: string }) =>\n    args.text.startsWith(args.prefix),`,
  stringEndsWith: strip
    ? `stringEndsWith: async (args) =>\n    args.text.endsWith(args.suffix),`
    : `stringEndsWith: async (args: { text: string; suffix: string }) =>\n    args.text.endsWith(args.suffix),`,
  urlEncode: strip
    ? `urlEncode: async (args) =>\n    ({ encoded: encodeURIComponent(args.text) }),`
    : `urlEncode: async (args: { text: string }) =>\n    ({ encoded: encodeURIComponent(args.text) }),`,
  base64urlEncode: strip
    ? `base64urlEncode: async (args) =>\n    ({ encoded: _b64url(new TextEncoder().encode(args.text)) }),`
    : `base64urlEncode: async (args: { text: string }) =>\n    ({ encoded: _b64url(new TextEncoder().encode(args.text)) }),`,
  base64urlDecode: strip
    ? `base64urlDecode: async (args) =>\n    ({ text: new TextDecoder().decode(_b64urlDecode(args.encoded)) }),`
    : `base64urlDecode: async (args: { encoded: string }) =>\n    ({ text: new TextDecoder().decode(_b64urlDecode(args.encoded)) }),`,
  pick: strip
    ? `pick: async (args) => {\n    const picked = {};\n    for (const k of args.keys) {\n      if (_FORBIDDEN_KEYS.has(k)) throw new Error(\`Forbidden property access: '\${k}'\`);\n      if (_hasOwn(args.obj, k)) _defineSafeProp(picked, k, args.obj[k]);\n    }\n    return { obj: picked, result: picked };\n  },`
    : `pick: async (args: { obj: Record<string, unknown>; keys: string[] }) => {\n    const picked: Record<string, unknown> = {};\n    for (const k of args.keys) {\n      if (_FORBIDDEN_KEYS.has(k)) throw new Error(\`Forbidden property access: '\${k}'\`);\n      if (_hasOwn(args.obj, k)) _defineSafeProp(picked, k, args.obj[k]);\n    }\n    return { obj: picked, result: picked };\n  },`,
  merge: strip
    ? `merge: async (args) => {\n    const merged = {};\n    for (const [k, v] of _Object.entries(args.a)) if (!_FORBIDDEN_KEYS.has(k)) _defineSafeProp(merged, k, v);\n    for (const [k, v] of _Object.entries(args.b)) if (!_FORBIDDEN_KEYS.has(k)) _defineSafeProp(merged, k, v);\n    return { result: merged };\n  },`
    : `merge: async (args: { a: Record<string, unknown>; b: Record<string, unknown> }) => {\n    const merged: Record<string, unknown> = {};\n    for (const [k, v] of _Object.entries(args.a)) if (!_FORBIDDEN_KEYS.has(k)) _defineSafeProp(merged, k, v);\n    for (const [k, v] of _Object.entries(args.b)) if (!_FORBIDDEN_KEYS.has(k)) _defineSafeProp(merged, k, v);\n    return { result: merged };\n  },`,
  arrayAppend: strip
    ? `arrayAppend: async (args) =>\n    ({ array: [...args.array, args.element] }),`
    : `arrayAppend: async (args: { array: unknown[]; element: unknown }) =>\n    ({ array: [...args.array, args.element] }),`,
  arrayConcat: strip
    ? `arrayConcat: async (args) => {\n    const out = [];\n    for (let i = 0; i < args.parts.length; i++) {\n      if (!Array.isArray(args.parts[i])) throw new TypeError(\`arrayConcat expects array segments, got \${typeof args.parts[i]} at index \${i}\`);\n      if (out.length + args.parts[i].length > 100000) throw new Error("arrayConcat exceeds maximum array length");\n      for (let j = 0; j < args.parts[i].length; j++) out.push(args.parts[i][j]);\n    }\n    return out;\n  },`
    : `arrayConcat: async (args: { parts: unknown[][] }) => {\n    const out: unknown[] = [];\n    for (let i = 0; i < args.parts.length; i++) {\n      if (!Array.isArray(args.parts[i])) throw new TypeError(\`arrayConcat expects array segments, got \${typeof args.parts[i]} at index \${i}\`);\n      if (out.length + args.parts[i].length > 100000) throw new Error("arrayConcat exceeds maximum array length");\n      for (let j = 0; j < args.parts[i].length; j++) out.push(args.parts[i][j]);\n    }\n    return out;\n  },`,
  arrayJoin: strip
    ? `arrayJoin: async (args) =>\n    args.array.map((el) => el === null || el === undefined ? "" : String(el)).join(args.delimiter ?? ","),`
    : `arrayJoin: async (args: { array: unknown[]; delimiter?: string }) =>\n    args.array.map((el) => el === null || el === undefined ? "" : String(el)).join(args.delimiter ?? ","),`,
  join: strip
    ? `join: async (args) =>\n    args.array.map((el) => el === null || el === undefined ? "" : String(el)).join(args.delimiter ?? ","),`
    : `join: async (args: { array: unknown[]; delimiter?: string }) =>\n    args.array.map((el) => el === null || el === undefined ? "" : String(el)).join(args.delimiter ?? ","),`,
  assert: strip
    ? `assert: async (args) => {\n    if (!args.condition) throw new Error(args.message ?? "Assertion failed");\n    return { ok: true };\n  },`
    : `assert: async (args: { condition: boolean; message?: string }) => {\n    if (!args.condition) throw new Error(args.message ?? "Assertion failed");\n    return { ok: true };\n  },`,
  doc: `doc: async () => ({}),`,
  sha256: strip
    ? `sha256: async (args) => {\n    const bytes = new TextEncoder().encode(args.data);\n    const hash = new Uint8Array(await _crypto.subtle.digest("SHA-256", bytes));\n    return { hash: _b64url(hash) };\n  },`
    : `sha256: async (args: { data: string }) => {\n    const bytes = new TextEncoder().encode(args.data);\n    const hash = new Uint8Array(await _crypto.subtle.digest("SHA-256", bytes));\n    return { hash: _b64url(hash) };\n  },`,
  generateEd25519KeyPair: strip
    ? `generateEd25519KeyPair: async () => {\n    const kp = await _crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);\n    return {\n      publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", kp.publicKey))),\n      privateKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("pkcs8", kp.privateKey))),\n    };\n  },`
    : `generateEd25519KeyPair: async () => {\n    const kp = await _crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;\n    return {\n      publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", kp.publicKey))),\n      privateKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("pkcs8", kp.privateKey))),\n    };\n  },`,
  generateX25519KeyPair: strip
    ? `generateX25519KeyPair: async () => {\n    const kp = await _crypto.subtle.generateKey("X25519", true, ["deriveKey", "deriveBits"]);\n    return {\n      publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", kp.publicKey))),\n      privateKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("pkcs8", kp.privateKey))),\n    };\n  },`
    : `generateX25519KeyPair: async () => {\n    const kp = await _crypto.subtle.generateKey("X25519", true, ["deriveKey", "deriveBits"]) as CryptoKeyPair;\n    return {\n      publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", kp.publicKey))),\n      privateKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("pkcs8", kp.privateKey))),\n    };\n  },`,
  ed25519PublicFromPrivate: strip
    ? `ed25519PublicFromPrivate: async (args) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", true, ["sign"]);\n    const jwk = await _crypto.subtle.exportKey("jwk", priv);\n    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] };\n    const pub = await _crypto.subtle.importKey("jwk", pubJwk, "Ed25519", true, ["verify"]);\n    return { publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", pub))) };\n  },`
    : `ed25519PublicFromPrivate: async (args: { privateKey: string }) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", true, ["sign"]);\n    const jwk = await _crypto.subtle.exportKey("jwk", priv);\n    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] };\n    const pub = await _crypto.subtle.importKey("jwk", pubJwk, "Ed25519", true, ["verify"]);\n    return { publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", pub))) };\n  },`,
  x25519PublicFromPrivate: strip
    ? `x25519PublicFromPrivate: async (args) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "X25519", true, ["deriveBits"]);\n    const jwk = await _crypto.subtle.exportKey("jwk", priv);\n    const pubJwk = { ...jwk, d: undefined, key_ops: [] };\n    const pub = await _crypto.subtle.importKey("jwk", pubJwk, "X25519", true, []);\n    return { publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", pub))) };\n  },`
    : `x25519PublicFromPrivate: async (args: { privateKey: string }) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "X25519", true, ["deriveBits"]);\n    const jwk = await _crypto.subtle.exportKey("jwk", priv);\n    const pubJwk = { ...jwk, d: undefined, key_ops: [] };\n    const pub = await _crypto.subtle.importKey("jwk", pubJwk, "X25519", true, []);\n    return { publicKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", pub))) };\n  },`,
  ed25519Sign: strip
    ? `ed25519Sign: async (args) => {\n    const key = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", false, ["sign"]);\n    const sig = new Uint8Array(await _crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(args.data)));\n    return { signature: _b64url(sig) };\n  },`
    : `ed25519Sign: async (args: { data: string; privateKey: string }) => {\n    const key = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", false, ["sign"]);\n    const sig = new Uint8Array(await _crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(args.data)));\n    return { signature: _b64url(sig) };\n  },`,
  aesGenerateKey: strip
    ? `aesGenerateKey: async () => {\n    const key = await _crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);\n    return { key: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", key))) };\n  },`
    : `aesGenerateKey: async () => {\n    const key = await _crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as CryptoKey;\n    return { key: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", key))) };\n  },`,
  aesEncrypt: strip
    ? `aesEncrypt: async (args) => {\n    const ck = await _crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);\n    const iv = _crypto.getRandomValues(new Uint8Array(12));\n    const ct = new Uint8Array(await _crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(args.plaintext)));\n    return { ciphertext: _b64url(ct), iv: _b64url(iv) };\n  },`
    : `aesEncrypt: async (args: { plaintext: string; key: string }) => {\n    const ck = await _crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);\n    const iv = _crypto.getRandomValues(new Uint8Array(12));\n    const ct = new Uint8Array(await _crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(args.plaintext)));\n    return { ciphertext: _b64url(ct), iv: _b64url(iv) };\n  },`,
  aesDecrypt: strip
    ? `aesDecrypt: async (args) => {\n    const ck = await _crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);\n    const pt = await _crypto.subtle.decrypt({ name: "AES-GCM", iv: _b64urlDecode(args.iv) }, ck, _b64urlDecode(args.ciphertext));\n    return { plaintext: new TextDecoder().decode(pt) };\n  },`
    : `aesDecrypt: async (args: { ciphertext: string; iv: string; key: string }) => {\n    const ck = await _crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);\n    const pt = await _crypto.subtle.decrypt({ name: "AES-GCM", iv: _b64urlDecode(args.iv) }, ck, _b64urlDecode(args.ciphertext));\n    return { plaintext: new TextDecoder().decode(pt) };\n  },`,
  x25519DeriveKey: strip
    ? `x25519DeriveKey: async (args) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.myPrivateKey), "X25519", false, ["deriveBits"]);\n    const pub = await _crypto.subtle.importKey("raw", _b64urlDecode(args.theirPublicKey), "X25519", false, []);\n    const bits = await _crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);\n    const hkdf = await _crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);\n    const dk = await _crypto.subtle.deriveKey(\n      { name: "HKDF", hash: "SHA-256", salt: _b64urlDecode(args.salt), info: new TextEncoder().encode(args.info) },\n      hkdf, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],\n    );\n    return { derivedKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", dk))) };\n  },`
    : `x25519DeriveKey: async (args: { myPrivateKey: string; theirPublicKey: string; salt: string; info: string }) => {\n    const priv = await _crypto.subtle.importKey("pkcs8", _b64urlDecode(args.myPrivateKey), "X25519", false, ["deriveBits"]);\n    const pub = await _crypto.subtle.importKey("raw", _b64urlDecode(args.theirPublicKey), "X25519", false, []);\n    const bits = await _crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);\n    const hkdf = await _crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);\n    const dk = await _crypto.subtle.deriveKey(\n      { name: "HKDF", hash: "SHA-256", salt: _b64urlDecode(args.salt), info: new TextEncoder().encode(args.info) },\n      hkdf, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],\n    );\n    return { derivedKey: _b64url(new Uint8Array(await _crypto.subtle.exportKey("raw", dk))) };\n  },`,
  timestamp: `timestamp: async () => ({ timestamp: Date.now() }),`,
  buildMultipartBody: strip
    ? `buildMultipartBody: async (args) => {\n    const bBytes = _crypto.getRandomValues(new Uint8Array(16));\n    const boundary = "----SafescriptMultipartBoundary" + Array.from(bBytes, (b) => b.toString(16).padStart(2, "0")).join("");\n    const clean = (s) => String(s).replace(/[\\r\\n"]/g, "");\n    const parts = [];\n    if (args.fields) {\n      for (const [name, value] of _Object.entries(args.fields)) {\n        parts.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${clean(name)}"\\r\\n\\r\\n\${value}\\r\\n\`);\n      }\n    }\n    if (args.files) {\n      for (const file of args.files) {\n        parts.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${clean(file.name)}"; filename="\${clean(file.filename)}"\\r\\nContent-Type: \${clean(file.contentType)}\\r\\n\\r\\n\${file.content}\\r\\n\`);\n      }\n    }\n    parts.push(\`--\${boundary}--\\r\\n\`);\n    return { body: parts.join(""), boundary };\n  },`
    : `buildMultipartBody: async (args: { fields?: Record<string, string>; files?: Array<{ name: string; filename: string; content: string; contentType: string }> }) => {\n    const bBytes = _crypto.getRandomValues(new Uint8Array(16));\n    const boundary = "----SafescriptMultipartBoundary" + Array.from(bBytes, (b) => b.toString(16).padStart(2, "0")).join("");\n    const clean = (s: string) => String(s).replace(/[\\r\\n"]/g, "");\n    const parts: string[] = [];\n    if (args.fields) {\n      for (const [name, value] of _Object.entries(args.fields)) {\n        parts.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${clean(name)}"\\r\\n\\r\\n\${value}\\r\\n\`);\n      }\n    }\n    if (args.files) {\n      for (const file of args.files) {\n        parts.push(\`--\${boundary}\\r\\nContent-Disposition: form-data; name="\${clean(file.name)}"; filename="\${clean(file.filename)}"\\r\\nContent-Type: \${clean(file.contentType)}\\r\\n\\r\\n\${file.content}\\r\\n\`);\n      }\n    }\n    parts.push(\`--\${boundary}--\\r\\n\`);\n    return { body: parts.join(""), boundary };\n  },`,
  randomBytes: strip
    ? `randomBytes: async (args) => {\n    if (!Number.isInteger(args.length) || args.length < 0 || args.length > 65536) throw new RangeError("randomBytes length must be an integer between 0 and 65536");\n    return { bytes: _b64url(_crypto.getRandomValues(new Uint8Array(args.length))) };\n  },`
    : `randomBytes: async (args: { length: number }) => {\n    if (!Number.isInteger(args.length) || args.length < 0 || args.length > 65536) throw new RangeError("randomBytes length must be an integer between 0 and 65536");\n    return { bytes: _b64url(_crypto.getRandomValues(new Uint8Array(args.length))) };\n  },`,
  httpRequest: strip
    ? `httpRequest: async (args, ctx) => {\n    const url = _buildSafeHttpUrl(args);\n    const response = await ctx.fetch(url, { method: args.method ?? "GET", headers: args.headers, body: args.body, signal: AbortSignal.timeout(args.timeout ?? 60000) });\n    return { status: response.status, body: await response.text() };\n  },`
    : `httpRequest: async (args: { host?: string; method?: string; path?: string; url?: string; headers?: Record<string, string>; body?: string; timeout?: number; subdomain?: string }, ctx: ExecutionContext) => {\n    const url = _buildSafeHttpUrl(args);\n    const response = await ctx.fetch(url, { method: args.method ?? "GET", headers: args.headers, body: args.body, signal: AbortSignal.timeout(args.timeout ?? 60000) });\n    return { status: response.status, body: await response.text() };\n  },`,
});

const buildPreamble = (
  strip: boolean,
  usedOps: ReadonlySet<string> | null,
): string => {
  const opEntries = buildOpEntries(strip);
  const selectedKeys = usedOps
    ? Object.keys(opEntries).filter((k) => usedOps.has(k))
    : Object.keys(opEntries);
  const needsB64 = !usedOps ||
    selectedKeys.some((k) => B64_NEEDED_OPS.has(k));
  const needsHttp = !usedOps || selectedKeys.includes("httpRequest");
  const needsRegex = !usedOps || selectedKeys.includes("stringRegex");

  const lines: string[] = [
    "// safescript runtime — auto-generated, do not edit",
  ];
  if (!strip) {
    lines.push(
      `type ExecutionContext = {\n  fetch: typeof globalThis.fetch;\n};`,
    );
  }

  lines.push(
    strip
      ? `const _Object = Object;\nconst _JSON = JSON;\nconst _RegExp = RegExp;\nconst _URL = URL;\nconst _crypto = crypto;\nconst _hasOwn = (obj, key) => _Object.prototype.hasOwnProperty.call(obj, key);\nconst _FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);\nconst _defineSafeProp = (target, key, value) => {\n  if (key === "then" && typeof value === "function") throw new Error("Function-valued 'then' property is forbidden");\n  _Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });\n};\nconst _safeObj = (entries) => {\n  const out = {};\n  for (const [k, v] of entries) _defineSafeProp(out, k, v);\n  return out;\n};`
      : `const _Object = Object;\nconst _JSON = JSON;\nconst _RegExp = RegExp;\nconst _URL = URL;\nconst _crypto = crypto;\nconst _hasOwn = (obj: object, key: PropertyKey): boolean => _Object.prototype.hasOwnProperty.call(obj, key);\nconst _FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);\nconst _defineSafeProp = (target: Record<string, unknown>, key: string, value: unknown): void => {\n  if (key === "then" && typeof value === "function") throw new Error("Function-valued 'then' property is forbidden");\n  _Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });\n};\nconst _safeObj = (entries: Array<[string, unknown]>): Record<string, unknown> => {\n  const out: Record<string, unknown> = {};\n  for (const [k, v] of entries) _defineSafeProp(out, k, v);\n  return out;\n};`,
  );

  if (needsB64) {
    lines.push(
      strip
        ? `const _b64url = (bytes) => {\n  const chunks = [];\n  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));\n  return btoa(chunks.join("")).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");\n};\n\nconst _b64urlDecode = (str) => {\n  const padded = str.replace(/-/g, "+").replace(/_/g, "/");\n  const binary = atob(padded);\n  const bytes = new Uint8Array(binary.length);\n  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n  return bytes;\n};`
        : `const _b64url = (bytes: Uint8Array): string => {\n  const chunks: string[] = [];\n  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));\n  return btoa(chunks.join("")).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");\n};\n\nconst _b64urlDecode = (str: string): Uint8Array => {\n  const padded = str.replace(/-/g, "+").replace(/_/g, "/");\n  const binary = atob(padded);\n  const bytes = new Uint8Array(binary.length);\n  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n  return bytes;\n};`,
    );
  }

  if (needsHttp) {
    lines.push(
      strip
        ? `const _HOST_RE = /^[a-z0-9-]+(\\.[a-z0-9-]+)*(:\\d+)?$/i;\nconst _SUBDOMAIN_RE = /^[a-z0-9-]+(\\.[a-z0-9-]+)*$/i;\nconst _SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;\nconst _buildSafeHttpUrl = (args) => {\n  const declaredHost = args.host !== undefined && args.host !== "" ? String(args.host) : (() => {\n    if (!args.url || args.host === "") throw new Error("Invalid declared host");\n    const u = new _URL(String(args.url));\n    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Unsupported HTTP protocol");\n    if (u.username || u.password) throw new Error("HTTP URL must not include credentials");\n    return u.port ? \`\${u.hostname}:\${u.port}\` : u.hostname;\n  })();\n  if (!_HOST_RE.test(declaredHost)) throw new Error(\`Invalid declared host '\${declaredHost}'\`);\n  if (args.subdomain !== undefined && args.subdomain !== "" && !_SUBDOMAIN_RE.test(args.subdomain)) throw new Error(\`Invalid subdomain '\${args.subdomain}'\`);\n  if (args.path !== undefined && args.path !== "" && (!args.path.startsWith("/") || args.path.startsWith("//") || args.path.startsWith("/\\\\"))) throw new Error(\`Invalid HTTP path '\${args.path}'\`);\n  const expectedHost = args.subdomain ? \`\${args.subdomain}.\${declaredHost}\` : declaredHost;\n  const targetUrl = args.url !== undefined && args.url !== ""\n    ? (_SCHEME_RE.test(args.url) ? args.url : (() => {\n      if (args.url.startsWith("//") || args.url.startsWith("/\\\\")) throw new Error("Invalid relative URL");\n      return \`https://\${expectedHost}\${args.url.startsWith("/") ? "" : "/"}\${args.url}\`;\n    })())\n    : \`https://\${expectedHost}\${args.path ?? ""}\`;\n  const parsed = new _URL(targetUrl);\n  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(\`Unsupported HTTP protocol '\${parsed.protocol}'\`);\n  if (parsed.username || parsed.password) throw new Error("HTTP URL must not include credentials");\n  const colonIdx = expectedHost.indexOf(":");\n  const expHostname = colonIdx >= 0 ? expectedHost.slice(0, colonIdx) : expectedHost;\n  const expPort = colonIdx >= 0 ? expectedHost.slice(colonIdx + 1) : "";\n  if (parsed.hostname.toLowerCase() !== expHostname.toLowerCase()) throw new Error(\`URL host '\${parsed.hostname}' does not match declared host '\${expHostname}'\`);\n  const defPort = parsed.protocol === "https:" ? "443" : "80";\n  if (expPort ? (parsed.port !== expPort && !(expPort === defPort && parsed.port === "")) : parsed.port !== "") throw new Error(\`URL port '\${parsed.port}' does not match declared host '\${expectedHost}'\`);\n  return targetUrl;\n};`
        : `const _HOST_RE = /^[a-z0-9-]+(\\.[a-z0-9-]+)*(:\\d+)?$/i;\nconst _SUBDOMAIN_RE = /^[a-z0-9-]+(\\.[a-z0-9-]+)*$/i;\nconst _SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;\nconst _buildSafeHttpUrl = (args: { host?: string; subdomain?: string; path?: string; url?: string }): string => {\n  const declaredHost = args.host !== undefined && args.host !== "" ? String(args.host) : (() => {\n    if (!args.url || args.host === "") throw new Error("Invalid declared host");\n    const u = new _URL(String(args.url));\n    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Unsupported HTTP protocol");\n    if (u.username || u.password) throw new Error("HTTP URL must not include credentials");\n    return u.port ? \`\${u.hostname}:\${u.port}\` : u.hostname;\n  })();\n  if (!_HOST_RE.test(declaredHost)) throw new Error(\`Invalid declared host '\${declaredHost}'\`);\n  if (args.subdomain !== undefined && args.subdomain !== "" && !_SUBDOMAIN_RE.test(args.subdomain)) throw new Error(\`Invalid subdomain '\${args.subdomain}'\`);\n  if (args.path !== undefined && args.path !== "" && (!args.path.startsWith("/") || args.path.startsWith("//") || args.path.startsWith("/\\\\"))) throw new Error(\`Invalid HTTP path '\${args.path}'\`);\n  const expectedHost = args.subdomain ? \`\${args.subdomain}.\${declaredHost}\` : declaredHost;\n  const targetUrl = args.url !== undefined && args.url !== ""\n    ? (_SCHEME_RE.test(args.url) ? args.url : (() => {\n      if (args.url.startsWith("//") || args.url.startsWith("/\\\\")) throw new Error("Invalid relative URL");\n      return \`https://\${expectedHost}\${args.url.startsWith("/") ? "" : "/"}\${args.url}\`;\n    })())\n    : \`https://\${expectedHost}\${args.path ?? ""}\`;\n  const parsed = new _URL(targetUrl);\n  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(\`Unsupported HTTP protocol '\${parsed.protocol}'\`);\n  if (parsed.username || parsed.password) throw new Error("HTTP URL must not include credentials");\n  const colonIdx = expectedHost.indexOf(":");\n  const expHostname = colonIdx >= 0 ? expectedHost.slice(0, colonIdx) : expectedHost;\n  const expPort = colonIdx >= 0 ? expectedHost.slice(colonIdx + 1) : "";\n  if (parsed.hostname.toLowerCase() !== expHostname.toLowerCase()) throw new Error(\`URL host '\${parsed.hostname}' does not match declared host '\${expHostname}'\`);\n  const defPort = parsed.protocol === "https:" ? "443" : "80";\n  if (expPort ? (parsed.port !== expPort && !(expPort === defPort && parsed.port === "")) : parsed.port !== "") throw new Error(\`URL port '\${parsed.port}' does not match declared host '\${expectedHost}'\`);\n  return targetUrl;\n};`,
    );
  }

  if (needsRegex) {
    lines.push(
      strip
        ? `const _validateRegex = (pattern, text) => {\n  if (pattern.length > 1000) throw new Error("Regex pattern exceeds maximum length");\n  if (text.length > 1000000) throw new Error("Regex text exceeds maximum length");\n  const stack = [];\n  let inClass = false;\n  let lastGroup = null;\n  for (let i = 0; i < pattern.length; i++) {\n    const ch = pattern[i];\n    if (inClass) { if (ch === "\\\\") i++; else if (ch === "]") inClass = false; continue; }\n    if (ch === "\\\\") {\n      const n = pattern[i + 1];\n      if ((n >= "1" && n <= "9") || n === "k") throw new Error("Unsafe regex: backreferences are not permitted");\n      i++; lastGroup = null; continue;\n    }\n    if (ch === "[") { inClass = true; lastGroup = null; continue; }\n    if (ch === "(") { stack.push({ q: false }); lastGroup = null; continue; }\n    if (ch === ")") {\n      const g = stack.pop();\n      if (!g) throw new Error("Unbalanced ')'");\n      if (g.q && stack.length > 0) stack[stack.length - 1].q = true;\n      lastGroup = g;\n      continue;\n    }\n    const bm = ch === "{" ? /^\\{(\\d+)(,(\\d*))?\\}/.exec(pattern.slice(i)) : null;\n    if (ch === "*" || ch === "+" || ch === "?" || bm) {\n      if (bm) i += bm[0].length - 1;\n      if (pattern[i + 1] === "?") i++;\n      if (lastGroup && lastGroup.q) throw new Error("Unsafe regex: nested quantifiers");\n      for (const f of stack) f.q = true;\n      lastGroup = null;\n      continue;\n    }\n    lastGroup = null;\n  }\n};`
        : `const _validateRegex = (pattern: string, text: string): void => {\n  if (pattern.length > 1000) throw new Error("Regex pattern exceeds maximum length");\n  if (text.length > 1000000) throw new Error("Regex text exceeds maximum length");\n  const stack: Array<{ q: boolean }> = [];\n  let inClass = false;\n  let lastGroup: { q: boolean } | null = null;\n  for (let i = 0; i < pattern.length; i++) {\n    const ch = pattern[i];\n    if (inClass) { if (ch === "\\\\") i++; else if (ch === "]") inClass = false; continue; }\n    if (ch === "\\\\") {\n      const n = pattern[i + 1];\n      if ((n >= "1" && n <= "9") || n === "k") throw new Error("Unsafe regex: backreferences are not permitted");\n      i++; lastGroup = null; continue;\n    }\n    if (ch === "[") { inClass = true; lastGroup = null; continue; }\n    if (ch === "(") { stack.push({ q: false }); lastGroup = null; continue; }\n    if (ch === ")") {\n      const g = stack.pop();\n      if (!g) throw new Error("Unbalanced ')'");\n      if (g.q && stack.length > 0) stack[stack.length - 1].q = true;\n      lastGroup = g;\n      continue;\n    }\n    const bm = ch === "{" ? /^\\{(\\d+)(,(\\d*))?\\}/.exec(pattern.slice(i)) : null;\n    if (ch === "*" || ch === "+" || ch === "?" || bm) {\n      if (bm) i += bm[0].length - 1;\n      if (pattern[i + 1] === "?") i++;\n      if (lastGroup && lastGroup.q) throw new Error("Unsafe regex: nested quantifiers");\n      for (const f of stack) f.q = true;\n      lastGroup = null;\n      continue;\n    }\n    lastGroup = null;\n  }\n};`,
    );
  }

  const opsBody = selectedKeys.map((k) => `  ${opEntries[k]}`).join("\n");
  lines.push(opsBody ? `const _ops = {\n${opsBody}\n};` : `const _ops = {};`);

  lines.push(
    strip
      ? `const _getField = (base, field) => {\n  if (_FORBIDDEN_KEYS.has(field)) throw new Error(\`Forbidden property access: '\${field}'\`);\n  if (base === null || base === undefined) return undefined;\n  if (Array.isArray(base)) {\n    if (field === "length") return base.length;\n    if (field === "value" || field === "result" || field === "array" || field === "parts") return base;\n    return undefined;\n  }\n  if (typeof base === "string") {\n    if (field === "length") return base.length;\n    if (field === "text" || field === "result" || field === "value" || field === "encoded" || field === "hash" || field === "bytes") return base;\n    return undefined;\n  }\n  if (typeof base === "number") {\n    if (field === "value" || field === "result" || field === "timestamp" || field === "length") return base;\n    return undefined;\n  }\n  if (typeof base === "boolean") {\n    if (field === "value" || field === "result" || field === "ok") return base;\n    return undefined;\n  }\n  if (typeof base !== "object") return undefined;\n  if ((field === "value" || field === "result" || field === "obj") && !_hasOwn(base, field)) return base;\n  return _hasOwn(base, field) ? base[field] : undefined;\n};\n\nconst _getIndex = (base, idx) => {\n  if (typeof idx === "string" && _FORBIDDEN_KEYS.has(idx)) throw new Error(\`Forbidden property access: '\${idx}'\`);\n  if (Array.isArray(base)) {\n    if (typeof idx !== "number" || !Number.isInteger(idx)) throw new Error(\`Array index must be an integer, got \${typeof idx}\`);\n    return idx >= 0 && idx < base.length && _hasOwn(base, idx) ? base[idx] : undefined;\n  }\n  if (base !== null && typeof base === "object" && typeof idx === "string") {\n    return _hasOwn(base, idx) ? base[idx] : undefined;\n  }\n  throw new Error("Cannot index non-array value");\n};`
      : `const _getField = (base: unknown, field: string): unknown => {\n  if (_FORBIDDEN_KEYS.has(field)) throw new Error(\`Forbidden property access: '\${field}'\`);\n  if (base === null || base === undefined) return undefined;\n  if (Array.isArray(base)) {\n    if (field === "length") return base.length;\n    if (field === "value" || field === "result" || field === "array" || field === "parts") return base;\n    return undefined;\n  }\n  if (typeof base === "string") {\n    if (field === "length") return base.length;\n    if (field === "text" || field === "result" || field === "value" || field === "encoded" || field === "hash" || field === "bytes") return base;\n    return undefined;\n  }\n  if (typeof base === "number") {\n    if (field === "value" || field === "result" || field === "timestamp" || field === "length") return base;\n    return undefined;\n  }\n  if (typeof base === "boolean") {\n    if (field === "value" || field === "result" || field === "ok") return base;\n    return undefined;\n  }\n  if (typeof base !== "object") return undefined;\n  const obj = base as Record<string, unknown>;\n  if ((field === "value" || field === "result" || field === "obj") && !_hasOwn(obj, field)) return obj;\n  return _hasOwn(obj, field) ? obj[field] : undefined;\n};\n\nconst _getIndex = (base: unknown, idx: unknown): unknown => {\n  if (typeof idx === "string" && _FORBIDDEN_KEYS.has(idx)) throw new Error(\`Forbidden property access: '\${idx}'\`);\n  if (Array.isArray(base)) {\n    if (typeof idx !== "number" || !Number.isInteger(idx)) throw new Error(\`Array index must be an integer, got \${typeof idx}\`);\n    return idx >= 0 && idx < base.length && _hasOwn(base, idx) ? base[idx] : undefined;\n  }\n  if (base !== null && typeof base === "object" && typeof idx === "string") {\n    const obj = base as Record<string, unknown>;\n    return _hasOwn(obj, idx) ? obj[idx] : undefined;\n  }\n  throw new Error("Cannot index non-array value");\n};`,
  );

  lines.push(
    strip
      ? `const _mapAsync = async (arr, fn) =>\n  Promise.all(arr.map(fn));\n\nconst _filterAsync = async (arr, fn) => {\n  const results = await Promise.all(arr.map(async (el) => ({ el, keep: await fn(el) })));\n  return results.filter((r) => r.keep).map((r) => r.el);\n};\n\nconst _reduceAsync = async (arr, fn, init) => {\n  let acc = init;\n  for (const el of arr) acc = await fn(acc, el);\n  return acc;\n};`
      : `const _mapAsync = async <T, U>(arr: T[], fn: (el: T) => Promise<U>): Promise<U[]> =>\n  Promise.all(arr.map(fn));\n\nconst _filterAsync = async <T>(arr: T[], fn: (el: T) => Promise<boolean>): Promise<T[]> => {\n  const results = await Promise.all(arr.map(async (el) => ({ el, keep: await fn(el) })));\n  return results.filter((r) => r.keep).map((r) => r.el);\n};\n\nconst _reduceAsync = async <T, U>(arr: T[], fn: (acc: U, el: T) => Promise<U>, init: U): Promise<U> => {\n  let acc = init;\n  for (const el of arr) acc = await fn(acc, el);\n  return acc;\n};`,
  );

  return lines.join("\n\n") + "\n";
};

// --- Code generation ---

const escapeStr = (s: string): string => JSON.stringify(s);

const emitValue = (
  v: Value,
  fns: FnMap,
  ioOps: ReadonlySet<string>,
): string => {
  switch (v.kind) {
    case "string":
      return escapeStr(v.value);
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "reference":
      if (fns.has(v.name)) {
        throw new Error(
          `Function '${v.name}' cannot be used as a standalone value in TypeScript transpilation`,
        );
      }
      return v.name;
    case "dot_access":
      return `_getField(${emitValue(v.base, fns, ioOps)}, ${
        escapeStr(v.field)
      })`;
    case "index_access":
      return `_getIndex(${emitValue(v.base, fns, ioOps)}, ${
        emitValue(v.index, fns, ioOps)
      })`;
    case "array":
      return `[${v.elements.map((e) => emitValue(e, fns, ioOps)).join(", ")}]`;
    case "object": {
      const hasUnsafeKey = v.fields.some((f) => UNSAFE_LITERAL_KEYS.has(f.key));
      if (hasUnsafeKey) {
        return `_safeObj([${
          v.fields.map((f) =>
            `[${escapeStr(f.key)}, ${emitValue(f.value, fns, ioOps)}]`
          ).join(", ")
        }])`;
      }
      return `{ ${
        v.fields.map((f) =>
          `${escapeStr(f.key)}: ${emitValue(f.value, fns, ioOps)}`
        )
          .join(", ")
      } }`;
    }
    case "call": {
      if (v.op === "stringRegex") {
        const pat = v.args.find((a) => a.key === "pattern");
        if (pat?.value.kind === "string") {
          validateSafeRegex(pat.value.value, "");
        }
      }
      return emitCall(v.op, v.args, fns, ioOps);
    }
    case "user_call":
      return emitUserCall(v.fn, v.args, fns, ioOps);
    case "binary_op":
      return `(${emitValue(v.left, fns, ioOps)} ${emitBinOp(v.op)} ${
        emitValue(v.right, fns, ioOps)
      })`;
    case "unary_op":
      return `(${v.op}${emitValue(v.operand, fns, ioOps)})`;
    case "ternary":
      return `(${emitValue(v.condition, fns, ioOps)} ? ${
        emitValue(v.then, fns, ioOps)
      } : ${emitValue(v.else, fns, ioOps)})`;
    case "map": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to TypeScript",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const param = fn.params[0].name;
      const capProps = (v.captures ?? [])
        .map((c) => `${escapeStr(c.key)}: ${emitValue(c.value, fns, ioOps)}`)
        .join(", ");
      const callArg = capProps ? `{ ${param}, ${capProps} }` : `{ ${param} }`;
      return `await _mapAsync(${
        emitValue(v.array, fns, ioOps)
      }, async (${param}) => await ${fnName}(${callArg}, _ctx))`;
    }
    case "filter": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to TypeScript",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const param = fn.params[0].name;
      const capProps = (v.captures ?? [])
        .map((c) => `${escapeStr(c.key)}: ${emitValue(c.value, fns, ioOps)}`)
        .join(", ");
      const callArg = capProps ? `{ ${param}, ${capProps} }` : `{ ${param} }`;
      return `await _filterAsync(${
        emitValue(v.array, fns, ioOps)
      }, async (${param}) => await ${fnName}(${callArg}, _ctx))`;
    }
    case "reduce": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to TypeScript",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const p0 = fn.params[0].name;
      const p1 = fn.params[1].name;
      const capProps = (v.captures ?? [])
        .map((c) => `${escapeStr(c.key)}: ${emitValue(c.value, fns, ioOps)}`)
        .join(", ");
      const callArg = capProps
        ? `{ ${p0}, ${p1}, ${capProps} }`
        : `{ ${p0}, ${p1} }`;
      return `await _reduceAsync(${
        emitValue(v.array, fns, ioOps)
      }, async (${p0}, ${p1}) => await ${fnName}(${callArg}, _ctx), ${
        emitValue(v.initial, fns, ioOps)
      })`;
    }
    case "override":
      throw new Error(
        "override(...) is a test-time construct and cannot be transpiled to TypeScript",
      );
    case "dag_call":
      throw new Error(
        "dag_call (override(...)(args)) is a test-time construct and cannot be transpiled to TypeScript",
      );
  }
};

const emitBinOp = (op: BinaryOp): string =>
  op === "==" ? "===" : op === "!=" ? "!==" : op;

const emitUserCall = (
  fnName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
  ioOps: ReadonlySet<string>,
): string => {
  const hasUnsafeKey = args.some((a) => UNSAFE_LITERAL_KEYS.has(a.key));
  const argObj = args.length === 0
    ? "{}"
    : hasUnsafeKey
    ? `_safeObj([${
      args.map((a) =>
        `[${escapeStr(a.key)}, ${emitValue(a.value, fns, ioOps)}]`
      ).join(", ")
    }])`
    : `{ ${
      args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns, ioOps)}`)
        .join(", ")
    } }`;
  return `await ${fnName}(${argObj}, _ctx)`;
};

const emitCall = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
  ioOps: ReadonlySet<string>,
): string => {
  const hasUnsafeKey = args.some((a) => UNSAFE_LITERAL_KEYS.has(a.key));
  const argObj = args.length === 0
    ? "{}"
    : hasUnsafeKey
    ? `_safeObj([${
      args.map((a) =>
        `[${escapeStr(a.key)}, ${emitValue(a.value, fns, ioOps)}]`
      ).join(", ")
    }])`
    : `{ ${
      args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns, ioOps)}`)
        .join(", ")
    } }`;
  if (ioOps.has(opName)) {
    return `await _ops[${escapeStr(opName)}](${argObj}, _ctx)`;
  }
  return `await _ops[${escapeStr(opName)}](${argObj})`;
};

const collectHoistedVars = (fn: FnDef): Set<string> => {
  const branchVars = new Set<string>();
  const counts = new Map<string, number>();

  const scan = (stmts: readonly Statement[], inBranch: boolean) => {
    for (const s of stmts) {
      if (s.kind === "assignment") {
        counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
        if (inBranch) branchVars.add(s.name);
      } else if (s.kind === "if_else") {
        scan(s.then, true);
        if (s.else) scan(s.else, true);
      }
    }
  };

  scan(fn.body, false);

  const hoisted = new Set<string>();
  if (fn.returnValue.kind === "reference" && fn.returnValue.name === "__ret") {
    hoisted.add("__ret");
  }
  for (const [name, count] of counts.entries()) {
    if (name === "__ret" || branchVars.has(name) || count > 1) {
      hoisted.add(name);
    }
  }
  return hoisted;
};

const emitStatement = (
  stmt: Statement,
  depth: number,
  fns: FnMap,
  hoistedVars: ReadonlySet<string>,
  ioOps: ReadonlySet<string>,
): string => {
  switch (stmt.kind) {
    case "assignment":
      if (stmt.name === "__ret") {
        return `${"  ".repeat(depth)}return ${
          emitValue(stmt.value, fns, ioOps)
        };`;
      }
      if (hoistedVars.has(stmt.name)) {
        return `${"  ".repeat(depth)}${stmt.name} = ${
          emitValue(stmt.value, fns, ioOps)
        };`;
      }
      return `${"  ".repeat(depth)}const ${stmt.name} = ${
        emitValue(stmt.value, fns, ioOps)
      };`;
    case "return":
      return "";
    case "void_call":
      return `${"  ".repeat(depth)}${
        emitCall(stmt.call.op, stmt.call.args, fns, ioOps)
      };`;
    case "user_void_call":
      return `${"  ".repeat(depth)}${
        emitUserCall(stmt.fn, stmt.args, fns, ioOps)
      };`;
    case "if_else": {
      const cond = emitValue(stmt.condition, fns, ioOps);
      const thenBlock = stmt.then
        .map((s) => emitStatement(s, depth + 1, fns, hoistedVars, ioOps))
        .filter((s) => s.length > 0)
        .join("\n");
      if (stmt.else) {
        const elseBlock = stmt.else
          .map((s) => emitStatement(s, depth + 1, fns, hoistedVars, ioOps))
          .filter((s) => s.length > 0)
          .join("\n");
        return `${"  ".repeat(depth)}if (${cond}) {\n${thenBlock}\n${
          "  ".repeat(depth)
        }} else {\n${elseBlock}\n${"  ".repeat(depth)}}`;
      }
      return `${"  ".repeat(depth)}if (${cond}) {\n${thenBlock}\n${
        "  ".repeat(depth)
      }}`;
    }
  }
};

const collectFnLocalNames = (fn: FnDef): ReadonlySet<string> => {
  const out = new Set<string>(fn.params.map((p) => p.name));
  const walk = (stmts: readonly Statement[]) => {
    for (const s of stmts) {
      if (s.kind === "assignment") out.add(s.name);
      else if (s.kind === "if_else") {
        walk(s.then);
        if (s.else) walk(s.else);
      }
    }
  };
  walk(fn.body);
  return out;
};

const emitFn = (
  fn: FnDef,
  fns: FnMap,
  strip: boolean,
  ioOps: ReadonlySet<string>,
): string => {
  const localNames = collectFnLocalNames(fn);
  const bodyFns: FnMap = new Map(
    [...fns].filter(([k]) => !localNames.has(k)),
  );
  const params = fn.params.map((p) => {
    const d = p.defaultValue !== undefined
      ? ` = ${JSON.stringify(p.defaultValue.value)}`
      : "";
    return `${p.name}${d}`;
  }).join(", ");
  const hoistedVars = collectHoistedVars(fn);
  const hoistedDecls = Array.from(hoistedVars)
    .map((v) =>
      strip ? `  let ${v} = undefined;` : `  let ${v}: any = undefined;`
    )
    .join("\n");
  const bodyStmts = fn.body
    .map((s) => emitStatement(s, 1, bodyFns, hoistedVars, ioOps))
    .filter((s) => s.length > 0)
    .join("\n");
  const body = hoistedDecls
    ? (bodyStmts ? `${hoistedDecls}\n${bodyStmts}` : hoistedDecls)
    : bodyStmts;
  const ret = `  return ${emitValue(fn.returnValue, bodyFns, ioOps)};`;
  const sig = strip
    ? `const ${fn.name} = async ({ ${params} }, _ctx) =>`
    : `const ${fn.name} = async ({ ${params} }: Record<string, any>, _ctx: ExecutionContext) =>`;
  return `${sig} {\n${body}\n${ret}\n};`;
};

const collectValueFnRefs = (
  v: Value,
  fnRefs: Set<string>,
  opRefs: Set<string>,
): void => {
  switch (v.kind) {
    case "dot_access":
      collectValueFnRefs(v.base, fnRefs, opRefs);
      return;
    case "index_access":
      collectValueFnRefs(v.base, fnRefs, opRefs);
      collectValueFnRefs(v.index, fnRefs, opRefs);
      return;
    case "array":
      v.elements.forEach((e) => collectValueFnRefs(e, fnRefs, opRefs));
      return;
    case "object":
      v.fields.forEach((f) => collectValueFnRefs(f.value, fnRefs, opRefs));
      return;
    case "binary_op":
      collectValueFnRefs(v.left, fnRefs, opRefs);
      collectValueFnRefs(v.right, fnRefs, opRefs);
      return;
    case "unary_op":
      collectValueFnRefs(v.operand, fnRefs, opRefs);
      return;
    case "ternary":
      collectValueFnRefs(v.condition, fnRefs, opRefs);
      collectValueFnRefs(v.then, fnRefs, opRefs);
      collectValueFnRefs(v.else, fnRefs, opRefs);
      return;
    case "call":
      opRefs.add(v.op);
      v.args.forEach((a) => collectValueFnRefs(a.value, fnRefs, opRefs));
      return;
    case "user_call":
      fnRefs.add(v.fn);
      v.args.forEach((a) => collectValueFnRefs(a.value, fnRefs, opRefs));
      return;
    case "map":
    case "filter":
      fnRefs.add(fnExprName(v.fn));
      collectValueFnRefs(v.fn, fnRefs, opRefs);
      collectValueFnRefs(v.array, fnRefs, opRefs);
      v.captures?.forEach((c) => collectValueFnRefs(c.value, fnRefs, opRefs));
      return;
    case "reduce":
      fnRefs.add(fnExprName(v.fn));
      collectValueFnRefs(v.fn, fnRefs, opRefs);
      collectValueFnRefs(v.initial, fnRefs, opRefs);
      collectValueFnRefs(v.array, fnRefs, opRefs);
      v.captures?.forEach((c) => collectValueFnRefs(c.value, fnRefs, opRefs));
      return;
  }
};

const collectStmtFnRefs = (
  stmt: Statement,
  fnRefs: Set<string>,
  opRefs: Set<string>,
): void => {
  switch (stmt.kind) {
    case "assignment":
      collectValueFnRefs(stmt.value, fnRefs, opRefs);
      return;
    case "return":
      return;
    case "void_call":
      opRefs.add(stmt.call.op);
      stmt.call.args.forEach((a) =>
        collectValueFnRefs(a.value, fnRefs, opRefs)
      );
      return;
    case "user_void_call":
      fnRefs.add(stmt.fn);
      stmt.args.forEach((a) => collectValueFnRefs(a.value, fnRefs, opRefs));
      return;
    case "if_else":
      collectValueFnRefs(stmt.condition, fnRefs, opRefs);
      stmt.then.forEach((s) => collectStmtFnRefs(s, fnRefs, opRefs));
      if (stmt.else) {
        stmt.else.forEach((s) => collectStmtFnRefs(s, fnRefs, opRefs));
      }
      return;
  }
};

const collectTransitiveDeps = (
  start: readonly FnDef[],
  fns: FnMap,
): {
  readonly order: readonly FnDef[];
  readonly usedOps: ReadonlySet<string>;
} => {
  const visited = new Set<string>();
  const order: FnDef[] = [];
  const usedOps = new Set<string>();
  const visit = (fn: FnDef): void => {
    if (visited.has(fn.name)) return;
    visited.add(fn.name);
    const refs = new Set<string>();
    fn.body.forEach((s) => collectStmtFnRefs(s, refs, usedOps));
    collectValueFnRefs(fn.returnValue, refs, usedOps);
    for (const dep of refs) {
      const depFn = fns.get(dep);
      if (depFn) visit(depFn);
    }
    order.push(fn);
  };
  start.forEach(visit);
  return { order, usedOps };
};

export const toTypescript = (
  program: Program,
  fnOrOptions?: string | ToTypescriptOptions,
): string => {
  const opts: ToTypescriptOptions = typeof fnOrOptions === "string"
    ? { functionName: fnOrOptions }
    : (fnOrOptions ?? {});
  const functionName = opts.functionName;
  const strip = Boolean(opts.stripTypes);
  const ioOps = new Set(["httpRequest", ...(opts.ioOps ?? [])]);

  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  if (functionName && !fns.has(functionName)) {
    throw new Error(`Function '${functionName}' not found`);
  }
  const roots = functionName
    ? [fns.get(functionName)!]
    : [...program.functions];
  validateProgramSemantics(program, roots);
  const { order: targetFns, usedOps } = collectTransitiveDeps(roots, fns);
  const preamble = buildPreamble(strip, opts.treeShakeOps ? usedOps : null);
  const fnCode = targetFns.map((f) => emitFn(f, fns, strip, ioOps)).join(
    "\n\n",
  );
  return `${preamble}\n${fnCode}\n`;
};
