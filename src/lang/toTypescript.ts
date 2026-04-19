import type { BinaryOp, FnDef, Program, Statement, Value } from "./ast.ts";

type FnMap = ReadonlyMap<string, FnDef>;

// --- Runtime preamble: self-contained implementations of all built-in ops ---

const preamble = `// safescript runtime — auto-generated, do not edit
type ExecutionContext = {
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
  stringIncludes: async (args: { haystack: string; needle: string }) =>
    ({ result: args.haystack.includes(args.needle) }),
  stringLower: async (args: { text: string }) =>
    ({ result: args.text.toLowerCase() }),
  urlEncode: async (args: { text: string }) =>
    ({ encoded: encodeURIComponent(args.text) }),
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
  ed25519PublicFromPrivate: async (args: { privateKey: string }) => {
    const priv = await crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "Ed25519", true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const pubJwk = { ...jwk, d: undefined, key_ops: ["verify"] };
    const pub = await crypto.subtle.importKey("jwk", pubJwk, "Ed25519", true, ["verify"]);
    return { publicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pub))) };
  },
  x25519PublicFromPrivate: async (args: { privateKey: string }) => {
    const priv = await crypto.subtle.importKey("pkcs8", _b64urlDecode(args.privateKey), "X25519", true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const pubJwk = { ...jwk, d: undefined, key_ops: [] };
    const pub = await crypto.subtle.importKey("jwk", pubJwk, "X25519", true, []);
    return { publicKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pub))) };
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
  x25519DeriveKey: async (args: { myPrivateKey: string; theirPublicKey: string; salt: string; info: string }) => {
    const priv = await crypto.subtle.importKey("pkcs8", _b64urlDecode(args.myPrivateKey), "X25519", false, ["deriveBits"]);
    const pub = await crypto.subtle.importKey("raw", _b64urlDecode(args.theirPublicKey), "X25519", false, []);
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
    const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const dk = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: _b64urlDecode(args.salt), info: new TextEncoder().encode(args.info) },
      hkdf, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
    );
    return { derivedKey: _b64url(new Uint8Array(await crypto.subtle.exportKey("raw", dk))) };
  },
  timestamp: async () => ({ timestamp: Date.now() }),
  randomBytes: async (args: { length: number }) =>
    ({ bytes: _b64url(crypto.getRandomValues(new Uint8Array(args.length))) }),
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

const escapeStr = (s: string): string => JSON.stringify(s);

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
    case "index_access":
      return `${emitValue(v.base, fns)}[${emitValue(v.index, fns)}]`;
    case "array":
      return `[${v.elements.map((e) => emitValue(e, fns)).join(", ")}]`;
    case "object":
      return `{ ${
        v.fields.map((f) => `${escapeStr(f.key)}: ${emitValue(f.value, fns)}`)
          .join(", ")
      } }`;
    case "call":
      return emitCall(v.op, v.args, fns);
    case "user_call":
      return emitUserCall(v.fn, v.args, fns);
    case "binary_op":
      return `(${emitValue(v.left, fns)} ${emitBinOp(v.op)} ${
        emitValue(v.right, fns)
      })`;
    case "unary_op":
      return `(-${emitValue(v.operand, fns)})`;
    case "ternary":
      return `(${emitValue(v.condition, fns)} ? ${emitValue(v.then, fns)} : ${
        emitValue(v.else, fns)
      })`;
    case "map": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _mapAsync(${
        emitValue(v.array, fns)
      }, async (${param}) => await ${v.fn}({ ${param} }, _ctx))`;
    }
    case "filter": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _filterAsync(${
        emitValue(v.array, fns)
      }, async (${param}) => await ${v.fn}({ ${param} }, _ctx))`;
    }
    case "reduce": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const p0 = fn.params[0].name;
      const p1 = fn.params[1].name;
      return `await _reduceAsync(${
        emitValue(v.array, fns)
      }, async (${p0}, ${p1}) => await ${v.fn}({ ${p0}, ${p1} }, _ctx), ${
        emitValue(v.initial, fns)
      })`;
    }
  }
};

const emitBinOp = (op: BinaryOp): string =>
  op === "==" ? "===" : op === "!=" ? "!==" : op;

const emitUserCall = (
  fnName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
): string => {
  const argObj = args.length === 0
    ? "{}"
    : `{ ${
      args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns)}`).join(
        ", ",
      )
    } }`;
  return `await ${fnName}(${argObj}, _ctx)`;
};

const emitCall = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
): string => {
  // IO ops need the static field merged into the args object + ctx
  const ioOps = new Set(["httpRequest"]);
  const argObj = args.length === 0
    ? "{}"
    : `{ ${
      args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns)}`).join(
        ", ",
      )
    } }`;
  if (ioOps.has(opName)) {
    return `await _ops[${escapeStr(opName)}](${argObj}, _ctx)`;
  }
  return `await _ops[${escapeStr(opName)}](${argObj})`;
};

const emitStatement = (stmt: Statement, depth: number, fns: FnMap): string => {
  switch (stmt.kind) {
    case "assignment":
      return `${"  ".repeat(depth)}const ${stmt.name} = ${
        emitValue(stmt.value, fns)
      };`;
    case "void_call":
      return `${"  ".repeat(depth)}${
        emitCall(stmt.call.op, stmt.call.args, fns)
      };`;
    case "user_void_call":
      return `${"  ".repeat(depth)}${
        emitUserCall(stmt.fn, stmt.args, fns)
      };`;
    case "if_else": {
      const cond = emitValue(stmt.condition, fns);
      const thenBlock = stmt.then.map((s) => emitStatement(s, depth + 1, fns))
        .join("\n");
      if (stmt.else) {
        const elseBlock = stmt.else.map((s) => emitStatement(s, depth + 1, fns))
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

const emitFn = (fn: FnDef, fns: FnMap): string => {
  const params = fn.params.map((p) => p.name).join(", ");
  const body = fn.body.map((s) => emitStatement(s, 1, fns)).join("\n");
  const ret = `  return ${emitValue(fn.returnValue, fns)};`;
  return `const ${fn.name} = async ({ ${params} }: Record<string, any>, _ctx: ExecutionContext) => {\n${body}\n${ret}\n};`;
};

const collectValueFnRefs = (v: Value, out: Set<string>): void => {
  switch (v.kind) {
    case "dot_access":
      collectValueFnRefs(v.base, out);
      return;
    case "index_access":
      collectValueFnRefs(v.base, out);
      collectValueFnRefs(v.index, out);
      return;
    case "array":
      v.elements.forEach((e) => collectValueFnRefs(e, out));
      return;
    case "object":
      v.fields.forEach((f) => collectValueFnRefs(f.value, out));
      return;
    case "binary_op":
      collectValueFnRefs(v.left, out);
      collectValueFnRefs(v.right, out);
      return;
    case "unary_op":
      collectValueFnRefs(v.operand, out);
      return;
    case "ternary":
      collectValueFnRefs(v.condition, out);
      collectValueFnRefs(v.then, out);
      collectValueFnRefs(v.else, out);
      return;
    case "call":
      v.args.forEach((a) => collectValueFnRefs(a.value, out));
      return;
    case "user_call":
      out.add(v.fn);
      v.args.forEach((a) => collectValueFnRefs(a.value, out));
      return;
    case "map":
    case "filter":
      out.add(v.fn);
      collectValueFnRefs(v.array, out);
      return;
    case "reduce":
      out.add(v.fn);
      collectValueFnRefs(v.initial, out);
      collectValueFnRefs(v.array, out);
      return;
  }
};

const collectStmtFnRefs = (stmt: Statement, out: Set<string>): void => {
  switch (stmt.kind) {
    case "assignment":
      collectValueFnRefs(stmt.value, out);
      return;
    case "void_call":
      stmt.call.args.forEach((a) => collectValueFnRefs(a.value, out));
      return;
    case "user_void_call":
      out.add(stmt.fn);
      stmt.args.forEach((a) => collectValueFnRefs(a.value, out));
      return;
    case "if_else":
      collectValueFnRefs(stmt.condition, out);
      stmt.then.forEach((s) => collectStmtFnRefs(s, out));
      if (stmt.else) stmt.else.forEach((s) => collectStmtFnRefs(s, out));
      return;
  }
};

const collectTransitiveDeps = (
  start: readonly FnDef[],
  fns: FnMap,
): readonly FnDef[] => {
  const visited = new Set<string>();
  const order: FnDef[] = [];
  const visit = (fn: FnDef): void => {
    if (visited.has(fn.name)) return;
    visited.add(fn.name);
    const refs = new Set<string>();
    fn.body.forEach((s) => collectStmtFnRefs(s, refs));
    collectValueFnRefs(fn.returnValue, refs);
    for (const dep of refs) {
      const depFn = fns.get(dep);
      if (depFn) visit(depFn);
    }
    order.push(fn);
  };
  start.forEach(visit);
  return order;
};

export const toTypescript = (
  program: Program,
  functionName?: string,
): string => {
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  if (functionName && !fns.has(functionName)) {
    throw new Error(`Function '${functionName}' not found`);
  }
  const roots = functionName
    ? [fns.get(functionName)!]
    : [...program.functions];
  const targetFns = collectTransitiveDeps(roots, fns);
  const fnCode = targetFns.map((f) => emitFn(f, fns)).join("\n\n");
  return `${preamble}\n${fnCode}\n`;
};
