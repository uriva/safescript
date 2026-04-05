import type { BinaryOp, FnDef, Program, Statement, Value } from "./ast.ts";

type FnMap = ReadonlyMap<string, FnDef>;

// --- Runtime preamble: self-contained implementations of all built-in ops ---

const preamble = `// safescript runtime — auto-generated, do not edit
type ExecutionContext = {
  readSecret: (name: string) => Promise<string>;
  writeSecret: (name: string, value: string) => Promise<void>;
  fetch: typeof globalThis.fetch;
};

const _b64url = (bytes: Uint8Array): string => {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
};

const _b64urlDecode = (str: string): Uint8Array => {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const _ops = {
  jsonParse: async (args: { text: string }) =>
    ({ value: JSON.parse(args.text) }),
  jsonStringify: async (args: { value: unknown }) =>
    ({ text: JSON.stringify(args.value) }),
  stringConcat: async (args: { parts: string[] }) =>
    ({ result: args.parts.join("") }),
  base64urlEncode: async (args: { text: string }) =>
    ({ encoded: _b64url(new TextEncoder().encode(args.text)) }),
  base64urlDecode: async (args: { encoded: string }) =>
    ({ text: new TextDecoder().decode(_b64urlDecode(args.encoded)) }),
  pick: async (args: { obj: Record<string, unknown>; keys: string[] }) =>
    ({ result: Object.fromEntries(args.keys.filter((k) => k in args.obj).map((k) => [k, args.obj[k]])) }),
  merge: async (args: { a: Record<string, unknown>; b: Record<string, unknown> }) =>
    ({ result: { ...args.a, ...args.b } }),
  sha256: async (args: { data: string }) => {
    const bytes = new TextEncoder().encode(args.data);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { hash: _b64url(hash) };
  },
  generateEd25519KeyPair: async () => {
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    return {
      publicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))),
      privateKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))),
    };
  },
  generateX25519KeyPair: async () => {
    const kp = await crypto.subtle.generateKey("X25519", true, ["deriveKey", "deriveBits"]) as CryptoKeyPair;
    return {
      publicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))),
      privateKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))),
    };
  },
  ed25519Sign: async (args: { data: string; privateKey: string }) => {
    const key = await crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(args.data)));
    return { signature: _b64url(sig) };
  },
  aesGenerateKey: async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as CryptoKey;
    return { key: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", key))) };
  },
  aesEncrypt: async (args: { plaintext: string; key: string }) => {
    const ck = await crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(args.plaintext)));
    return { ciphertext: _b64url(ct), iv: _b64url(iv) };
  },
  aesDecrypt: async (args: { ciphertext: string; iv: string; key: string }) => {
    const ck = await crypto.subtle.importKey("raw", _b64urlDecode(args.key), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _b64urlDecode(args.iv) }, ck, _b64urlDecode(args.ciphertext));
    return { plaintext: new TextDecoder().decode(pt) };
  },
  x25519DeriveKey: async (args: { myPrivateKey: string; theirPublicKey: string; salt: string }) => {
    const priv = await crypto.subtle.importKey("pkcs8", _b64urlDecode(args.myPrivateKey), "X25519", false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("raw", _b64urlDecode(args.theirPublicKey), "X25519", false, []);
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
    const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const dk = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: _b64urlDecode(args.salt), info: new TextEncoder().encode("agentdocs-access-grant") },
      hkdf, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
    );
    return { derivedKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", dk))) };
  },
  importIdentity: async (args: { exportedIdentity: string }) => {
    const json = new TextDecoder().decode(_b64urlDecode(args.exportedIdentity));
    const exp = JSON.parse(json);
    const sk = await crypto.subtle.importKey("pkcs8", _b64urlDecode(exp.signing.privateKey), "Ed25519", true, ["sign"]);
    const sjwk = await crypto.subtle.exportKey("jwk", sk);
    const spk = await crypto.subtle.importKey("jwk", { ...sjwk, d: undefined, key_ops: ["verify"] }, "Ed25519", true, ["verify"]);
    const ek = await crypto.subtle.importKey("pkcs8", _b64urlDecode(exp.encryption.privateKey), "X25519", true, ["deriveBits"]);
    const ejwk = await crypto.subtle.exportKey("jwk", ek);
    const epk = await crypto.subtle.importKey("jwk", { ...ejwk, d: undefined, key_ops: [] }, "X25519", true, []);
    return {
      signingPublicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", spk))),
      signingPrivateKey: exp.signing.privateKey,
      encryptionPublicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", epk))),
      encryptionPrivateKey: exp.encryption.privateKey,
    };
  },
  exportIdentity: async (args: { signingPrivateKey: string; encryptionPrivateKey: string }) => {
    const exp = {
      signing: { privateKey: args.signingPrivateKey },
      encryption: { privateKey: args.encryptionPrivateKey },
      algorithm: { signing: "Ed25519", keyExchange: "X25519", symmetric: "AES-GCM-256" },
    };
    return { exportedIdentity: _b64url(new TextEncoder().encode(JSON.stringify(exp))) };
  },
  timestamp: async () => ({ timestamp: Date.now() }),
  randomBytes: async (args: { length: number }) =>
    ({ bytes: _b64url(crypto.getRandomValues(new Uint8Array(args.length))) }),
  readSecret: async (args: { name: string }, ctx: ExecutionContext) =>
    ({ value: await ctx.readSecret(args.name) }),
  writeSecret: async (args: { name: string; value: string }, ctx: ExecutionContext) => {
    await ctx.writeSecret(args.name, args.value);
    return {};
  },
  httpRequest: async (args: { host: string; method: string; path: string; headers?: Record<string, string>; body?: string }, ctx: ExecutionContext) => {
    const url = \`https://\${args.host}\${args.path}\`;
    const response = await ctx.fetch(url, { method: args.method, headers: args.headers, body: args.body });
    return { status: response.status, body: await response.text() };
  },
};

const _mapAsync = async <T, U>(arr: T[], fn: (el: T) => Promise<U>): Promise<U[]> =>
  Promise.all(arr.map(fn));

const _filterAsync = async <T>(arr: T[], fn: (el: T) => Promise<boolean>): Promise<T[]> => {
  const results = await Promise.all(arr.map(async (el) => ({ el, keep: await fn(el) })));
  return results.filter((r) => r.keep).map((r) => r.el);
};

const _reduceAsync = async <T, U>(arr: T[], fn: (acc: U, el: T) => Promise<U>, init: U): Promise<U> => {
  let acc = init;
  for (const el of arr) acc = await fn(acc, el);
  return acc;
};
`;

// --- Code generation ---

const escapeStr = (s: string): string =>
  JSON.stringify(s);

const emitValue = (v: Value, fns: FnMap): string => {
  switch (v.kind) {
    case "string":
      return escapeStr(v.value);
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "reference":
      return v.name;
    case "dot_access":
      return `${emitValue(v.base, fns)}[${escapeStr(v.field)}]`;
    case "array":
      return `[${v.elements.map((e) => emitValue(e, fns)).join(", ")}]`;
    case "object":
      return `{ ${v.fields.map((f) => `${escapeStr(f.key)}: ${emitValue(f.value, fns)}`).join(", ")} }`;
    case "call":
      return emitCall(v.op, v.args, fns);
    case "binary_op":
      return `(${emitValue(v.left, fns)} ${emitBinOp(v.op)} ${emitValue(v.right, fns)})`;
    case "unary_op":
      return `(-${emitValue(v.operand, fns)})`;
    case "ternary":
      return `(${emitValue(v.condition, fns)} ? ${emitValue(v.then, fns)} : ${emitValue(v.else, fns)})`;
    case "map": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _mapAsync(${emitValue(v.array, fns)}, async (${param}) => await ${v.fn}({ ${param} }, _ctx))`;
    }
    case "filter": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _filterAsync(${emitValue(v.array, fns)}, async (${param}) => await ${v.fn}({ ${param} }, _ctx))`;
    }
    case "reduce": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const p0 = fn.params[0].name;
      const p1 = fn.params[1].name;
      return `await _reduceAsync(${emitValue(v.array, fns)}, async (${p0}, ${p1}) => await ${v.fn}({ ${p0}, ${p1} }, _ctx), ${emitValue(v.initial, fns)})`;
    }
  }
};

const emitBinOp = (op: BinaryOp): string =>
  op === "==" ? "===" : op === "!=" ? "!==" : op;

const emitCall = (opName: string, args: ReadonlyArray<{ readonly key: string; readonly value: Value }>, fns: FnMap): string => {
  // IO ops need the static field merged into the args object + ctx
  const ioOps = new Set(["readSecret", "writeSecret", "httpRequest"]);
  const argObj = args.length === 0
    ? "{}"
    : `{ ${args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns)}`).join(", ")} }`;
  if (ioOps.has(opName)) {
    return `await _ops[${escapeStr(opName)}](${argObj}, _ctx)`;
  }
  return `await _ops[${escapeStr(opName)}](${argObj})`;
};

const emitStatement = (stmt: Statement, depth: number, fns: FnMap): string => {
  switch (stmt.kind) {
    case "assignment":
      return `${"  ".repeat(depth)}const ${stmt.name} = ${emitValue(stmt.value, fns)};`;
    case "void_call":
      return `${"  ".repeat(depth)}${emitCall(stmt.call.op, stmt.call.args, fns)};`;
    case "if_else": {
      const cond = emitValue(stmt.condition, fns);
      const thenBlock = stmt.then.map((s) => emitStatement(s, depth + 1, fns)).join("\n");
      if (stmt.else) {
        const elseBlock = stmt.else.map((s) => emitStatement(s, depth + 1, fns)).join("\n");
        return `${"  ".repeat(depth)}if (${cond}) {\n${thenBlock}\n${"  ".repeat(depth)}} else {\n${elseBlock}\n${"  ".repeat(depth)}}`;
      }
      return `${"  ".repeat(depth)}if (${cond}) {\n${thenBlock}\n${"  ".repeat(depth)}}`;
    }
  }
};

const emitFn = (fn: FnDef, fns: FnMap): string => {
  const params = fn.params.map((p) => p.name).join(", ");
  const body = fn.body.map((s) => emitStatement(s, 1, fns)).join("\n");
  const ret = `  return ${emitValue(fn.returnValue, fns)};`;
  return `const ${fn.name} = async ({ ${params} }: Record<string, any>, _ctx: ExecutionContext) => {\n${body}\n${ret}\n};`;
};

export const toTypescript = (program: Program, functionName?: string): string => {
  const targetFns = functionName
    ? program.functions.filter((f) => f.name === functionName)
    : program.functions;
  if (targetFns.length === 0 && functionName) {
    throw new Error(`Function '${functionName}' not found`);
  }
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  const fnCode = targetFns.map((f) => emitFn(f, fns)).join("\n\n");
  return `${preamble}\n${fnCode}\n`;
};
