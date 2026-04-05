import type { BinaryOp, FnDef, Program, Statement, Value } from "./ast.ts";

type FnMap = ReadonlyMap<string, FnDef>;

// --- Python runtime preamble ---

const preamble = `# safescript runtime — auto-generated, do not edit
import json
import hashlib
import os
import time
import base64
import asyncio
from typing import Any, Callable, Awaitable, Optional
from dataclasses import dataclass

try:
    import aiohttp
except ImportError:
    aiohttp = None  # type: ignore


@dataclass
class ExecutionContext:
    read_secret: Callable[[str], Awaitable[str]]
    write_secret: Callable[[str, str], Awaitable[None]]
    fetch: Optional[Any] = None  # aiohttp.ClientSession or similar


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(padded)


async def _op_json_parse(args: dict) -> dict:
    return {"value": json.loads(args["text"])}


async def _op_json_stringify(args: dict) -> dict:
    return {"text": json.dumps(args["value"])}


async def _op_string_concat(args: dict) -> dict:
    return {"result": "".join(args["parts"])}


async def _op_base64url_encode(args: dict) -> dict:
    return {"encoded": _b64url_encode(args["text"].encode())}


async def _op_base64url_decode(args: dict) -> dict:
    return {"text": _b64url_decode(args["encoded"]).decode()}


async def _op_pick(args: dict) -> dict:
    obj = args["obj"]
    return {"result": {k: obj[k] for k in args["keys"] if k in obj}}


async def _op_merge(args: dict) -> dict:
    return {"result": {**args["a"], **args["b"]}}


async def _op_sha256(args: dict) -> dict:
    h = hashlib.sha256(args["data"].encode()).digest()
    return {"hash": _b64url_encode(h)}


async def _op_timestamp(args: dict) -> dict:
    return {"timestamp": int(time.time() * 1000)}


async def _op_random_bytes(args: dict) -> dict:
    return {"bytes": _b64url_encode(os.urandom(args["length"]))}


async def _op_read_secret(args: dict, ctx: ExecutionContext) -> dict:
    return {"value": await ctx.read_secret(args["name"])}


async def _op_write_secret(args: dict, ctx: ExecutionContext) -> dict:
    await ctx.write_secret(args["name"], args["value"])
    return {}


async def _op_http_request(args: dict, ctx: ExecutionContext) -> dict:
    url = f"https://{args['host']}{args['path']}"
    if aiohttp is None:
        raise RuntimeError("aiohttp is required for httpRequest. Install with: pip install aiohttp")
    session = ctx.fetch or aiohttp.ClientSession()
    try:
        async with session.request(
            args["method"],
            url,
            headers=args.get("headers"),
            data=args.get("body"),
        ) as resp:
            body = await resp.text()
            return {"status": resp.status, "body": body}
    finally:
        if not ctx.fetch:
            await session.close()


# Crypto ops — require the cryptography package
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False


def _require_crypto(op_name: str):
    if not _HAS_CRYPTO:
        raise RuntimeError(f"{op_name} requires the cryptography package. Install with: pip install cryptography")


async def _op_generate_ed25519_key_pair(args: dict) -> dict:
    _require_crypto("generateEd25519KeyPair")
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_raw = public_key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    priv_pkcs8 = private_key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return {"publicKey": _b64url_encode(pub_raw), "privateKey": _b64url_encode(priv_pkcs8)}


async def _op_ed25519_sign(args: dict) -> dict:
    _require_crypto("ed25519Sign")
    priv = serialization.load_der_private_key(_b64url_decode(args["privateKey"]), password=None)
    sig = priv.sign(args["data"].encode())
    return {"signature": _b64url_encode(sig)}


async def _op_generate_x25519_key_pair(args: dict) -> dict:
    _require_crypto("generateX25519KeyPair")
    private_key = X25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_raw = public_key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    priv_pkcs8 = private_key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return {"publicKey": _b64url_encode(pub_raw), "privateKey": _b64url_encode(priv_pkcs8)}


async def _op_x25519_derive_key(args: dict) -> dict:
    _require_crypto("x25519DeriveKey")
    priv = serialization.load_der_private_key(_b64url_decode(args["myPrivateKey"]), password=None)
    pub = X25519PublicKey.from_public_bytes(_b64url_decode(args["theirPublicKey"]))
    shared = priv.exchange(pub)
    salt = _b64url_decode(args["salt"])
    derived = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=b"agentdocs-access-grant").derive(shared)
    return {"derivedKey": _b64url_encode(derived)}


async def _op_aes_generate_key(args: dict) -> dict:
    return {"key": _b64url_encode(os.urandom(32))}


async def _op_aes_encrypt(args: dict) -> dict:
    _require_crypto("aesEncrypt")
    key = _b64url_decode(args["key"])
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(iv, args["plaintext"].encode(), None)
    return {"ciphertext": _b64url_encode(ct), "iv": _b64url_encode(iv)}


async def _op_aes_decrypt(args: dict) -> dict:
    _require_crypto("aesDecrypt")
    key = _b64url_decode(args["key"])
    iv = _b64url_decode(args["iv"])
    ct = _b64url_decode(args["ciphertext"])
    aesgcm = AESGCM(key)
    pt = aesgcm.decrypt(iv, ct, None)
    return {"plaintext": pt.decode()}


async def _op_export_identity(args: dict) -> dict:
    exp = {
        "signing": {"privateKey": args["signingPrivateKey"]},
        "encryption": {"privateKey": args["encryptionPrivateKey"]},
        "algorithm": {"signing": "Ed25519", "keyExchange": "X25519", "symmetric": "AES-GCM-256"},
    }
    return {"exportedIdentity": _b64url_encode(json.dumps(exp).encode())}


async def _op_import_identity(args: dict) -> dict:
    _require_crypto("importIdentity")
    raw = _b64url_decode(args["exportedIdentity"])
    exp = json.loads(raw.decode())
    # Signing
    priv_signing = serialization.load_der_private_key(_b64url_decode(exp["signing"]["privateKey"]), password=None)
    pub_signing = priv_signing.public_key()
    pub_signing_raw = pub_signing.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    # Encryption
    priv_enc = serialization.load_der_private_key(_b64url_decode(exp["encryption"]["privateKey"]), password=None)
    pub_enc = priv_enc.public_key()
    pub_enc_raw = pub_enc.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {
        "signingPublicKey": _b64url_encode(pub_signing_raw),
        "signingPrivateKey": exp["signing"]["privateKey"],
        "encryptionPublicKey": _b64url_encode(pub_enc_raw),
        "encryptionPrivateKey": exp["encryption"]["privateKey"],
    }


_OPS = {
    "jsonParse": _op_json_parse,
    "jsonStringify": _op_json_stringify,
    "stringConcat": _op_string_concat,
    "base64urlEncode": _op_base64url_encode,
    "base64urlDecode": _op_base64url_decode,
    "pick": _op_pick,
    "merge": _op_merge,
    "sha256": _op_sha256,
    "timestamp": _op_timestamp,
    "randomBytes": _op_random_bytes,
    "readSecret": _op_read_secret,
    "writeSecret": _op_write_secret,
    "httpRequest": _op_http_request,
    "generateEd25519KeyPair": _op_generate_ed25519_key_pair,
    "generateX25519KeyPair": _op_generate_x25519_key_pair,
    "ed25519Sign": _op_ed25519_sign,
    "aesGenerateKey": _op_aes_generate_key,
    "aesEncrypt": _op_aes_encrypt,
    "aesDecrypt": _op_aes_decrypt,
    "x25519DeriveKey": _op_x25519_derive_key,
    "importIdentity": _op_import_identity,
    "exportIdentity": _op_export_identity,
}

_IO_OPS = {"readSecret", "writeSecret", "httpRequest"}


async def _map_async(arr, fn):
    return list(await asyncio.gather(*(fn(el) for el in arr)))


async def _filter_async(arr, fn):
    results = await asyncio.gather(*(fn(el) for el in arr))
    return [el for el, keep in zip(arr, results) if keep]


async def _reduce_async(arr, fn, init):
    acc = init
    for el in arr:
        acc = await fn(acc, el)
    return acc
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
      return v.value ? "True" : "False";
    case "reference":
      return v.name;
    case "dot_access":
      return `${emitValue(v.base, fns)}[${escapeStr(v.field)}]`;
    case "array":
      return `[${v.elements.map((e) => emitValue(e, fns)).join(", ")}]`;
    case "object":
      return `{${v.fields.map((f) => `${escapeStr(f.key)}: ${emitValue(f.value, fns)}`).join(", ")}}`;
    case "call":
      return emitCall(v.op, v.args, fns);
    case "binary_op":
      return `(${emitValue(v.left, fns)} ${emitBinOp(v.op)} ${emitValue(v.right, fns)})`;
    case "unary_op":
      return `(-${emitValue(v.operand, fns)})`;
    case "ternary":
      return `(${emitValue(v.then, fns)} if ${emitValue(v.condition, fns)} else ${emitValue(v.else, fns)})`;
    case "map": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _map_async(${emitValue(v.array, fns)}, lambda ${param}: ${v.fn}(${param}=${param}, _ctx=_ctx))`;
    }
    case "filter": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const param = fn.params[0].name;
      return `await _filter_async(${emitValue(v.array, fns)}, lambda ${param}: ${v.fn}(${param}=${param}, _ctx=_ctx))`;
    }
    case "reduce": {
      const fn = fns.get(v.fn);
      if (!fn) throw new Error(`Unknown function: '${v.fn}'`);
      const p0 = fn.params[0].name;
      const p1 = fn.params[1].name;
      return `await _reduce_async(${emitValue(v.array, fns)}, lambda ${p0}, ${p1}: ${v.fn}(${p0}=${p0}, ${p1}=${p1}, _ctx=_ctx), ${emitValue(v.initial, fns)})`;
    }
  }
};

const emitBinOp = (op: BinaryOp): string => {
  switch (op) {
    case "==": return "==";
    case "!=": return "!=";
    case "+": return "+";
    case "-": return "-";
    case "*": return "*";
    case "/": return "/";
    case "%": return "%";
    case "<": return "<";
    case ">": return ">";
    case "<=": return "<=";
    case ">=": return ">=";
  }
};

const emitCall = (opName: string, args: ReadonlyArray<{ readonly key: string; readonly value: Value }>, fns: FnMap): string => {
  const ioOps = new Set(["readSecret", "writeSecret", "httpRequest"]);
  const argObj = args.length === 0
    ? "{}"
    : `{${args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns)}`).join(", ")}}`;
  if (ioOps.has(opName)) {
    return `await _OPS[${escapeStr(opName)}](${argObj}, _ctx)`;
  }
  return `await _OPS[${escapeStr(opName)}](${argObj})`;
};

const emitStatement = (stmt: Statement, depth: number, fns: FnMap): string => {
  const pad = "    ".repeat(depth);
  switch (stmt.kind) {
    case "assignment":
      return `${pad}${stmt.name} = ${emitValue(stmt.value, fns)}`;
    case "void_call":
      return `${pad}${emitCall(stmt.call.op, stmt.call.args, fns)}`;
    case "if_else": {
      const cond = emitValue(stmt.condition, fns);
      const thenBlock = stmt.then.map((s) => emitStatement(s, depth + 1, fns)).join("\n");
      if (stmt.else) {
        const elseBlock = stmt.else.map((s) => emitStatement(s, depth + 1, fns)).join("\n");
        return `${pad}if ${cond}:\n${thenBlock}\n${pad}else:\n${elseBlock}`;
      }
      return `${pad}if ${cond}:\n${thenBlock}`;
    }
  }
};

const emitFn = (fn: FnDef, fns: FnMap): string => {
  const params = fn.params.map((p) => p.name).join(", ");
  const body = fn.body.map((s) => emitStatement(s, 1, fns)).join("\n");
  const ret = `    return ${emitValue(fn.returnValue, fns)}`;
  const bodyStr = body ? `${body}\n${ret}` : ret;
  return `async def ${fn.name}(${params ? `*, ${params}` : ""}, _ctx: ExecutionContext):\n${bodyStr}`;
};

export const toPython = (program: Program, functionName?: string): string => {
  const targetFns = functionName
    ? program.functions.filter((f) => f.name === functionName)
    : program.functions;
  if (targetFns.length === 0 && functionName) {
    throw new Error(`Function '${functionName}' not found`);
  }
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  const fnCode = targetFns.map((f) => emitFn(f, fns)).join("\n\n\n");
  return `${preamble}\n\n${fnCode}\n`;
};
