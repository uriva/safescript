import type { BinaryOp, FnDef, Program, Statement, Value } from "./ast.ts";
import { fnExprName } from "./ast.ts";
import { validateProgramSemantics } from "./parser.ts";
import { validateSafeRegex } from "../ops/pure.ts";

type FnMap = ReadonlyMap<string, FnDef>;

// --- Python runtime preamble ---

const preamble = `# safescript runtime — auto-generated, do not edit
import builtins as _builtins
import json
import hashlib as _hashlib
import os as _os
import time as _time
import base64 as _base64
import urllib.parse as _urllib_parse
import re as _re
import asyncio as _asyncio
import secrets as _secrets
from typing import Any, Optional
from dataclasses import dataclass

_json = json

try:
    import aiohttp as _aiohttp
except ImportError:
    _aiohttp = None  # type: ignore


@dataclass
class ExecutionContext:
    fetch: Optional[Any] = None  # aiohttp.ClientSession or similar


_FORBIDDEN_KEYS = {"__proto__", "prototype", "constructor"}
_HOST_RE = _re.compile(r"^[a-z0-9-]+(\\.[a-z0-9-]+)*(:\\d+)?$", _re.IGNORECASE)
_SUBDOMAIN_RE = _re.compile(r"^[a-z0-9-]+(\\.[a-z0-9-]+)*$", _re.IGNORECASE)
_SCHEME_RE = _re.compile(r"^[a-z][a-z0-9+.-]*:", _re.IGNORECASE)


def _is_forbidden_key(k: Any) -> bool:
    return k in _FORBIDDEN_KEYS or (
        _builtins.isinstance(k, _builtins.str)
        and k.startswith("__")
        and k.endswith("__")
    )


def _get_field(base: Any, field: str) -> Any:
    if _is_forbidden_key(field):
        raise PermissionError(f"Forbidden property access: '{field}'")
    if base is None:
        return None
    if _builtins.isinstance(base, _builtins.list):
        if field == "length":
            return _builtins.len(base)
        if field in ("value", "result", "array", "parts"):
            return base
        return None
    if _builtins.isinstance(base, _builtins.str):
        if field == "length":
            return _builtins.len(base)
        if field in ("text", "result", "value", "encoded", "hash", "bytes"):
            return base
        return None
    if _builtins.isinstance(base, _builtins.bool):
        if field in ("value", "result", "ok"):
            return base
        return None
    if _builtins.isinstance(base, (_builtins.int, _builtins.float)):
        if field in ("value", "result", "timestamp", "length"):
            return base
        return None
    if _builtins.isinstance(base, _builtins.dict):
        if field in ("value", "result", "obj") and field not in base:
            return base
        return base.get(field, None)
    raise TypeError(f"Cannot access field '{field}' on non-dict value")


def _get_index(base: Any, idx: Any) -> Any:
    if _builtins.isinstance(idx, _builtins.str) and _is_forbidden_key(idx):
        raise PermissionError(f"Forbidden property access: '{idx}'")
    if _builtins.isinstance(base, _builtins.list):
        if not _builtins.isinstance(idx, _builtins.int) or _builtins.isinstance(idx, _builtins.bool):
            raise TypeError(f"Array index must be an integer, got {_builtins.type(idx).__name__}")
        return base[idx] if 0 <= idx < _builtins.len(base) else None
    if _builtins.isinstance(base, _builtins.dict) and _builtins.isinstance(idx, _builtins.str):
        return base.get(idx, None)
    raise TypeError("Cannot index non-array value")


def _validate_regex(pattern: str, text: str) -> None:
    if _builtins.len(pattern) > 1000:
        raise ValueError("Regex pattern exceeds maximum length")
    if _builtins.len(text) > 1000000:
        raise ValueError("Regex input text exceeds maximum length")
    stack = []
    in_class = False
    last_group = None
    i = 0
    while i < _builtins.len(pattern):
        ch = pattern[i]
        if in_class:
            if ch == "\\\\":
                i += 2
                continue
            if ch == "]":
                in_class = False
            i += 1
            continue
        if ch == "\\\\":
            nxt = pattern[i + 1] if i + 1 < _builtins.len(pattern) else ""
            if nxt in "123456789" or nxt == "k":
                raise ValueError("Unsafe regex: backreferences are not permitted")
            last_group = None
            i += 2
            continue
        if ch == "[":
            in_class = True
            last_group = None
            i += 1
            continue
        if ch == "(":
            stack.append({"q": False})
            last_group = None
            i += 1
            continue
        if ch == ")":
            if not stack:
                raise ValueError("Unbalanced ')' in regex pattern")
            g = stack.pop()
            if g["q"] and stack:
                stack[-1]["q"] = True
            last_group = g
            i += 1
            continue
        bm = _re.match(r"^\\{(\\d+)(,(\\d*))?\\}", pattern[i:]) if ch == "{" else None
        if ch in "*+?" or bm is not None:
            if bm is not None:
                i += _builtins.len(bm.group(0)) - 1
            if i + 1 < _builtins.len(pattern) and pattern[i + 1] == "?":
                i += 1
            if last_group is not None and last_group["q"]:
                raise ValueError("Unsafe regex: nested quantifiers")
            for f in stack:
                f["q"] = True
            last_group = None
            i += 1
            continue
        last_group = None
        i += 1


def _build_safe_http_url(args: dict) -> str:
    raw_host = args.get("host")
    raw_url = args.get("url")
    if raw_host is not None and raw_host != "":
        declared_host = _builtins.str(raw_host)
    else:
        if raw_host == "" or not raw_url:
            raise ValueError("Invalid declared host")
        u = _urllib_parse.urlsplit(_builtins.str(raw_url))
        if u.scheme not in ("http", "https"):
            raise ValueError(f"Unsupported HTTP protocol '{u.scheme}:'")
        if u.username or u.password:
            raise ValueError("HTTP URL must not include credentials")
        declared_host = f"{u.hostname}:{u.port}" if u.port else (u.hostname or "")
    if not declared_host or not _HOST_RE.match(declared_host):
        raise ValueError(f"Invalid declared host '{declared_host}'")
    subdomain = args.get("subdomain")
    if subdomain is not None and subdomain != "":
        if not _SUBDOMAIN_RE.match(_builtins.str(subdomain)):
            raise ValueError(f"Invalid subdomain '{subdomain}'")
    path = args.get("path")
    if path is not None and path != "":
        if not path.startswith("/") or path.startswith("//") or path.startswith("/\\\\"):
            raise ValueError(f"Invalid HTTP path '{path}'")
    expected_host = f"{subdomain}.{declared_host}" if subdomain else declared_host
    if raw_url is not None and raw_url != "":
        if _SCHEME_RE.match(raw_url):
            target_url = raw_url
        else:
            if raw_url.startswith("//") or raw_url.startswith("/\\\\"):
                raise ValueError("Invalid relative URL")
            target_url = f"https://{expected_host}{'' if raw_url.startswith('/') else '/'}{raw_url}"
    else:
        target_url = f"https://{expected_host}{path or ''}"
    parsed = _urllib_parse.urlsplit(target_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported HTTP protocol '{parsed.scheme}:'")
    if parsed.username or parsed.password:
        raise ValueError("HTTP URL must not include credentials")
    exp_hostname, _, exp_port = expected_host.partition(":")
    if (parsed.hostname or "").lower() != exp_hostname.lower():
        raise ValueError(f"URL host '{parsed.hostname}' does not match declared host '{exp_hostname}'")
    def_port = 443 if parsed.scheme == "https" else 80
    actual_port = parsed.port
    if exp_port:
        if actual_port is not None and _builtins.str(actual_port) != exp_port:
            raise ValueError(f"URL port '{actual_port}' does not match declared host '{expected_host}'")
        if actual_port is None and _builtins.int(exp_port) != def_port:
            raise ValueError(f"URL port does not match declared host '{expected_host}'")
    elif actual_port is not None and actual_port != def_port:
        raise ValueError(f"URL port '{actual_port}' does not match declared host '{expected_host}'")
    return target_url


def _b64url_encode(data: bytes) -> str:
    return _base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (4 - _builtins.len(s) % 4)
    return _base64.urlsafe_b64decode(padded)


async def _op_json_parse(args: dict) -> Any:
    return _json.loads(args["text"])


async def _op_json_stringify(args: dict) -> str:
    return _json.dumps(args["value"])


async def _op_string_stringify(args: dict) -> dict:
    return {"text": _json.dumps(args["value"])}


async def _op_len(args: dict) -> int:
    val = args.get("value")
    return _builtins.len(val) if _builtins.isinstance(val, (_builtins.list, _builtins.str)) else 0


async def _op_object_keys(args: dict) -> list:
    target = args.get("obj") if args.get("obj") is not None else args.get("value")
    return [k for k in target.keys() if not _is_forbidden_key(k)] if _builtins.isinstance(target, _builtins.dict) else []


async def _op_type_of(args: dict) -> str:
    val = args.get("value")
    if val is None:
        return "null"
    if _builtins.isinstance(val, _builtins.bool):
        return "boolean"
    if _builtins.isinstance(val, (_builtins.int, _builtins.float)):
        return "number"
    if _builtins.isinstance(val, _builtins.str):
        return "string"
    if _builtins.isinstance(val, _builtins.list):
        return "array"
    if _builtins.isinstance(val, _builtins.dict):
        return "object"
    return _builtins.type(val).__name__


async def _op_string_concat(args: dict) -> dict:
    parts = args["parts"]
    total = 0
    for i, p in _builtins.enumerate(parts):
        if not _builtins.isinstance(p, _builtins.str):
            raise TypeError(f"stringConcat expects string parts, got {_builtins.type(p).__name__} at index {i}")
        total += _builtins.len(p)
        if total > 8388608:
            raise ValueError("stringConcat exceeds maximum length")
    return {"result": "".join(parts)}


async def _op_string_includes(args: dict) -> dict:
    haystack = args.get("haystack") or args.get("text") or args.get("value") or args.get("s") or ""
    needle = args.get("needle") or args.get("search") or args.get("substring") or ""
    return {"result": needle in haystack}


async def _op_string_replace(args: dict) -> dict:
    haystack = args["haystack"]
    needle = args["needle"]
    replacement = args["replacement"]
    if needle == "":
        raise ValueError("needle must not be empty")
    count = _builtins.len(haystack.split(needle)) - 1
    replace_all = args.get("all", True)
    applied = count if replace_all else _builtins.min(count, 1)
    if _builtins.len(haystack) + applied * (_builtins.len(replacement) - _builtins.len(needle)) > 8388608:
        raise ValueError("stringReplace exceeds maximum length")
    result = haystack.replace(needle, replacement) if replace_all else haystack.replace(needle, replacement, 1)
    return {"result": result, "count": count}


async def _op_string_regex(args: dict) -> dict:
    _validate_regex(args["pattern"], args["text"])
    m = _re.search(args["pattern"], args["text"])
    if m:
        return {"match": True, "groups": [g if g is not None else "" for g in m.groups()]}
    return {"match": False, "groups": []}


async def _op_string_split(args: dict) -> dict:
    text = args.get("text") if args.get("text") is not None else args.get("haystack", "")
    return {"parts": text.split(args["delimiter"])}


async def _op_string_slice(args: dict) -> Any:
    target = args.get("array")
    if target is None:
        target = args.get("text")
    if target is None:
        target = args.get("haystack")
    if target is None:
        target = args.get("value", "")
    start = _builtins.int(args.get("start", 0))
    end = args.get("end")
    if _builtins.isinstance(target, _builtins.list):
        return target[start:_builtins.int(end)] if end is not None else target[start:]
    s = _builtins.str(target)
    return s[start:_builtins.int(end)] if end is not None else s[start:]


async def _op_string_lower(args: dict) -> dict:
    return {"result": args["text"].lower()}


async def _op_string_upper(args: dict) -> str:
    return args["text"].upper()


async def _op_string_trim(args: dict) -> str:
    return args["text"].strip()


async def _op_string_starts_with(args: dict) -> bool:
    return args["text"].startswith(args["prefix"])


async def _op_string_ends_with(args: dict) -> bool:
    return args["text"].endswith(args["suffix"])


async def _op_to_string(args: dict) -> str:
    v = args.get("value")
    if _builtins.isinstance(v, _builtins.str):
        return v
    if _builtins.isinstance(v, _builtins.bool):
        return "true" if v else "false"
    if _builtins.isinstance(v, (_builtins.int, _builtins.float)):
        return _builtins.str(v)
    if v is None:
        return ""
    raise TypeError(f"toString expects a primitive value, got {_builtins.type(v).__name__}")


async def _op_url_encode(args: dict) -> dict:
    return {"encoded": _urllib_parse.quote(args["text"], safe="")}


async def _op_base64url_encode(args: dict) -> dict:
    return {"encoded": _b64url_encode(args["text"].encode())}


async def _op_base64url_decode(args: dict) -> dict:
    return {"text": _b64url_decode(args["encoded"]).decode()}


async def _op_pick(args: dict) -> dict:
    obj = args["obj"]
    picked = {}
    for k in args["keys"]:
        if _is_forbidden_key(k):
            raise PermissionError(f"Forbidden property access: '{k}'")
        if k in obj:
            picked[k] = obj[k]
    return {"obj": picked, "result": picked}


async def _op_merge(args: dict) -> dict:
    merged = {}
    for k, v in args["a"].items():
        if not _is_forbidden_key(k):
            merged[k] = v
    for k, v in args["b"].items():
        if not _is_forbidden_key(k):
            merged[k] = v
    return {"result": merged}


async def _op_array_append(args: dict) -> dict:
    return {"array": [*args["array"], args["element"]]}


async def _op_array_concat(args: dict) -> list:
    out = []
    for i, seg in _builtins.enumerate(args["parts"]):
        if not _builtins.isinstance(seg, _builtins.list):
            raise TypeError(f"arrayConcat expects array segments, got {_builtins.type(seg).__name__} at index {i}")
        if _builtins.len(out) + _builtins.len(seg) > 100000:
            raise ValueError("arrayConcat exceeds maximum array length")
        out.extend(seg)
    return out


async def _op_array_join(args: dict) -> str:
    delim = args.get("delimiter") if args.get("delimiter") is not None else ","
    parts = []
    for el in args["array"]:
        if el is None:
            parts.append("")
        elif _builtins.isinstance(el, _builtins.bool):
            parts.append("true" if el else "false")
        else:
            parts.append(_builtins.str(el))
    return delim.join(parts)


async def _op_assert(args: dict) -> dict:
    if not args.get("condition"):
        raise AssertionError(args.get("message") or "Assertion failed")
    return {"ok": True}


async def _op_doc(args: dict) -> dict:
    return {}


async def _op_sha256(args: dict) -> dict:
    h = _hashlib.sha256(args["data"].encode()).digest()
    return {"hash": _b64url_encode(h)}


async def _op_build_multipart_body(args: dict) -> dict:
    boundary = "----SafescriptMultipartBoundary" + _secrets.token_hex(16)
    clean = lambda s: _re.sub(r'[\\r\\n"]', "", _builtins.str(s))
    parts = []
    if args.get("fields"):
        for name, value in args["fields"].items():
            parts.append(
                f"--{boundary}\\r\\nContent-Disposition: form-data; name=\\"{clean(name)}\\"\\r\\n\\r\\n{value}\\r\\n"
            )
    if args.get("files"):
        for file in args["files"]:
            name = clean(file["name"])
            filename = clean(file["filename"])
            content = file["content"]
            content_type = clean(file["contentType"])
            parts.append(
                f"--{boundary}\\r\\nContent-Disposition: form-data; name=\\"{name}\\"; filename=\\"{filename}\\"\\r\\nContent-Type: {content_type}\\r\\n\\r\\n{content}\\r\\n"
            )
    parts.append(f"--{boundary}--\\r\\n")
    return {"body": "".join(parts), "boundary": boundary}


async def _op_timestamp(args: dict) -> dict:
    return {"timestamp": _builtins.int(_time.time() * 1000)}


async def _op_random_bytes(args: dict) -> dict:
    length = args["length"]
    if not _builtins.isinstance(length, _builtins.int) or _builtins.isinstance(length, _builtins.bool) or length < 0 or length > 65536:
        raise ValueError("randomBytes length must be an integer between 0 and 65536")
    return {"bytes": _b64url_encode(_os.urandom(length))}


async def _op_http_request(args: dict, ctx: ExecutionContext) -> dict:
    url = _build_safe_http_url(args)
    if _aiohttp is None:
        raise RuntimeError("aiohttp is required for httpRequest. Install with: pip install aiohttp")
    session = ctx.fetch or _aiohttp.ClientSession()
    timeout = _aiohttp.ClientTimeout(total=(args.get("timeout") or 60000) / 1000)
    try:
        async with session.request(
            args.get("method", "GET"),
            url,
            headers=args.get("headers"),
            data=args.get("body"),
            timeout=timeout,
        ) as resp:
            body = await resp.text()
            return {"status": resp.status, "body": body}
    except _asyncio.TimeoutError:
        return {"status": 0, "body": f"REQUEST_TIMEOUT: The request timed out after {args.get('timeout') or 60000}ms."}
    finally:
        if not ctx.fetch:
            await session.close()


# Crypto ops — require the cryptography package
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as _Ed25519PrivateKey
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey as _X25519PrivateKey, X25519PublicKey as _X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _AESGCM
    from cryptography.hazmat.primitives import serialization as _serialization, hashes as _hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF as _HKDF
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False


def _require_crypto(op_name: str):
    if not _HAS_CRYPTO:
        raise RuntimeError(f"{op_name} requires the cryptography package. Install with: pip install cryptography")


async def _op_generate_ed25519_key_pair(args: dict) -> dict:
    _require_crypto("generateEd25519KeyPair")
    private_key = _Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_raw = public_key.public_bytes(_serialization.Encoding.Raw, _serialization.PublicFormat.Raw)
    priv_pkcs8 = private_key.private_bytes(_serialization.Encoding.DER, _serialization.PrivateFormat.PKCS8, _serialization.NoEncryption())
    return {"publicKey": _b64url_encode(pub_raw), "privateKey": _b64url_encode(priv_pkcs8)}


async def _op_ed25519_sign(args: dict) -> dict:
    _require_crypto("ed25519Sign")
    priv = _serialization.load_der_private_key(_b64url_decode(args["privateKey"]), password=None)
    sig = priv.sign(args["data"].encode())
    return {"signature": _b64url_encode(sig)}


async def _op_ed25519_public_from_private(args: dict) -> dict:
    _require_crypto("ed25519PublicFromPrivate")
    priv = _serialization.load_der_private_key(_b64url_decode(args["privateKey"]), password=None)
    pub_raw = priv.public_key().public_bytes(_serialization.Encoding.Raw, _serialization.PublicFormat.Raw)
    return {"publicKey": _b64url_encode(pub_raw)}


async def _op_x25519_public_from_private(args: dict) -> dict:
    _require_crypto("x25519PublicFromPrivate")
    priv = _serialization.load_der_private_key(_b64url_decode(args["privateKey"]), password=None)
    pub_raw = priv.public_key().public_bytes(_serialization.Encoding.Raw, _serialization.PublicFormat.Raw)
    return {"publicKey": _b64url_encode(pub_raw)}


async def _op_generate_x25519_key_pair(args: dict) -> dict:
    _require_crypto("generateX25519KeyPair")
    private_key = _X25519PrivateKey.generate()
    public_key = private_key.public_key()
    pub_raw = public_key.public_bytes(_serialization.Encoding.Raw, _serialization.PublicFormat.Raw)
    priv_pkcs8 = private_key.private_bytes(_serialization.Encoding.DER, _serialization.PrivateFormat.PKCS8, _serialization.NoEncryption())
    return {"publicKey": _b64url_encode(pub_raw), "privateKey": _b64url_encode(priv_pkcs8)}


async def _op_x25519_derive_key(args: dict) -> dict:
    _require_crypto("x25519DeriveKey")
    priv = _serialization.load_der_private_key(_b64url_decode(args["myPrivateKey"]), password=None)
    pub = _X25519PublicKey.from_public_bytes(_b64url_decode(args["theirPublicKey"]))
    shared = priv.exchange(pub)
    salt = _b64url_decode(args["salt"])
    derived = _HKDF(algorithm=_hashes.SHA256(), length=32, salt=salt, info=args["info"].encode()).derive(shared)
    return {"derivedKey": _b64url_encode(derived)}


async def _op_aes_generate_key(args: dict) -> dict:
    return {"key": _b64url_encode(_os.urandom(32))}


async def _op_aes_encrypt(args: dict) -> dict:
    _require_crypto("aesEncrypt")
    key = _b64url_decode(args["key"])
    iv = _os.urandom(12)
    aesgcm = _AESGCM(key)
    ct = aesgcm.encrypt(iv, args["plaintext"].encode(), None)
    return {"ciphertext": _b64url_encode(ct), "iv": _b64url_encode(iv)}


async def _op_aes_decrypt(args: dict) -> dict:
    _require_crypto("aesDecrypt")
    key = _b64url_decode(args["key"])
    iv = _b64url_decode(args["iv"])
    ct = _b64url_decode(args["ciphertext"])
    aesgcm = _AESGCM(key)
    pt = aesgcm.decrypt(iv, ct, None)
    return {"plaintext": pt.decode()}


_OPS = {
    "jsonParse": _op_json_parse,
    "parseJson": _op_json_parse,
    "jsonStringify": _op_json_stringify,
    "stringStringify": _op_string_stringify,
    "len": _op_len,
    "objectKeys": _op_object_keys,
    "keys": _op_object_keys,
    "typeOf": _op_type_of,
    "typeof": _op_type_of,
    "buildMultipartBody": _op_build_multipart_body,
    "stringConcat": _op_string_concat,
    "stringIncludes": _op_string_includes,
    "stringReplace": _op_string_replace,
    "stringRegex": _op_string_regex,
    "stringSplit": _op_string_split,
    "split": _op_string_split,
    "stringSlice": _op_string_slice,
    "slice": _op_string_slice,
    "stringLower": _op_string_lower,
    "stringUpper": _op_string_upper,
    "stringTrim": _op_string_trim,
    "trim": _op_string_trim,
    "stringStartsWith": _op_string_starts_with,
    "stringEndsWith": _op_string_ends_with,
    "toString": _op_to_string,
    "urlEncode": _op_url_encode,
    "base64urlEncode": _op_base64url_encode,
    "base64urlDecode": _op_base64url_decode,
    "pick": _op_pick,
    "merge": _op_merge,
    "arrayAppend": _op_array_append,
    "arrayConcat": _op_array_concat,
    "arrayJoin": _op_array_join,
    "join": _op_array_join,
    "assert": _op_assert,
    "doc": _op_doc,
    "sha256": _op_sha256,
    "timestamp": _op_timestamp,
    "randomBytes": _op_random_bytes,
    "httpRequest": _op_http_request,
    "generateEd25519KeyPair": _op_generate_ed25519_key_pair,
    "generateX25519KeyPair": _op_generate_x25519_key_pair,
    "ed25519PublicFromPrivate": _op_ed25519_public_from_private,
    "x25519PublicFromPrivate": _op_x25519_public_from_private,
    "ed25519Sign": _op_ed25519_sign,
    "aesGenerateKey": _op_aes_generate_key,
    "aesEncrypt": _op_aes_encrypt,
    "aesDecrypt": _op_aes_decrypt,
    "x25519DeriveKey": _op_x25519_derive_key,
}

_IO_OPS = {"httpRequest"}


async def _map_async(arr, fn):
    return _builtins.list(await _asyncio.gather(*(fn(el) for el in arr)))


async def _filter_async(arr, fn):
    results = await _asyncio.gather(*(fn(el) for el in arr))
    return [el for el, keep in _builtins.zip(arr, results) if keep]


async def _reduce_async(arr, fn, init):
    acc = init
    for el in arr:
        acc = await fn(acc, el)
    return acc
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
      return v.value ? "True" : "False";
    case "null":
    case "undefined":
      return "None";
    case "reference":
      if (fns.has(v.name)) {
        throw new Error(
          `Function '${v.name}' cannot be used as a standalone value in Python transpilation`,
        );
      }
      return v.name;
    case "dot_access":
      return `_get_field(${emitValue(v.base, fns)}, ${escapeStr(v.field)})`;
    case "index_access":
      return `_get_index(${emitValue(v.base, fns)}, ${
        emitValue(v.index, fns)
      })`;
    case "array":
      return `[${v.elements.map((e) => emitValue(e, fns)).join(", ")}]`;
    case "object": {
      for (const f of v.fields) {
        if (
          f.key === "__proto__" ||
          f.key === "prototype" ||
          f.key === "constructor"
        ) {
          throw new Error(`Forbidden object key '${f.key}'`);
        }
      }
      return `{${
        v.fields.map((f) => `${escapeStr(f.key)}: ${emitValue(f.value, fns)}`)
          .join(", ")
      }}`;
    }
    case "call": {
      if (v.op === "stringRegex") {
        const pat = v.args.find((a) => a.key === "pattern");
        if (pat?.value.kind === "string") {
          validateSafeRegex(pat.value.value, "");
        }
      }
      return emitCall(v.op, v.args, fns);
    }
    case "user_call":
      return emitUserCall(v.fn, v.args, fns);
    case "binary_op":
      return `(${emitValue(v.left, fns)} ${emitBinOp(v.op)} ${
        emitValue(v.right, fns)
      })`;
    case "unary_op":
      return v.op === "!"
        ? `(not ${emitValue(v.operand, fns)})`
        : `(-${emitValue(v.operand, fns)})`;
    case "ternary":
      return `(${emitValue(v.then, fns)} if ${
        emitValue(v.condition, fns)
      } else ${emitValue(v.else, fns)})`;
    case "map": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to Python",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const param = fn.params[0].name;
      const capKwargs = (v.captures ?? [])
        .map((c) => `${c.key}=${emitValue(c.value, fns)}`)
        .join(", ");
      const kwargs = capKwargs
        ? `${param}=${param}, ${capKwargs}, _ctx=_ctx`
        : `${param}=${param}, _ctx=_ctx`;
      return `await _map_async(${
        emitValue(v.array, fns)
      }, lambda ${param}: ${fnName}(${kwargs}))`;
    }
    case "filter": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to Python",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const param = fn.params[0].name;
      const capKwargs = (v.captures ?? [])
        .map((c) => `${c.key}=${emitValue(c.value, fns)}`)
        .join(", ");
      const kwargs = capKwargs
        ? `${param}=${param}, ${capKwargs}, _ctx=_ctx`
        : `${param}=${param}, _ctx=_ctx`;
      return `await _filter_async(${
        emitValue(v.array, fns)
      }, lambda ${param}: ${fnName}(${kwargs}))`;
    }
    case "reduce": {
      if (v.fn.kind === "override") {
        throw new Error(
          "override(...) is a test-time construct and cannot be transpiled to Python",
        );
      }
      const fnName = fnExprName(v.fn);
      const fn = fns.get(fnName);
      if (!fn) throw new Error(`Unknown function: '${fnName}'`);
      const p0 = fn.params[0].name;
      const p1 = fn.params[1].name;
      const capKwargs = (v.captures ?? [])
        .map((c) => `${c.key}=${emitValue(c.value, fns)}`)
        .join(", ");
      const kwargs = capKwargs
        ? `${p0}=${p0}, ${p1}=${p1}, ${capKwargs}, _ctx=_ctx`
        : `${p0}=${p0}, ${p1}=${p1}, _ctx=_ctx`;
      return `await _reduce_async(${
        emitValue(v.array, fns)
      }, lambda ${p0}, ${p1}: ${fnName}(${kwargs}), ${
        emitValue(v.initial, fns)
      })`;
    }
    case "override":
      throw new Error(
        "override(...) is a test-time construct and cannot be transpiled to Python",
      );
    case "dag_call":
      throw new Error(
        "dag_call (override(...)(args)) is a test-time construct and cannot be transpiled to Python",
      );
  }
};

const emitBinOp = (op: BinaryOp): string => {
  switch (op) {
    case "==":
      return "==";
    case "!=":
      return "!=";
    case "+":
      return "+";
    case "-":
      return "-";
    case "*":
      return "*";
    case "/":
      return "/";
    case "%":
      return "%";
    case "<":
      return "<";
    case ">":
      return ">";
    case "<=":
      return "<=";
    case ">=":
      return ">=";
    case "&&":
      return "and";
    case "||":
      return "or";
  }
};

const emitUserCall = (
  fnName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
): string => {
  const argList = args.map((a) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(a.key) || a.key.startsWith("_")) {
      throw new Error(`Invalid keyword argument '${a.key}'`);
    }
    return `${a.key}=${emitValue(a.value, fns)}`;
  }).join(", ");
  return argList.length === 0
    ? `await ${fnName}(_ctx=_ctx)`
    : `await ${fnName}(${argList}, _ctx=_ctx)`;
};

const emitCall = (
  opName: string,
  args: ReadonlyArray<{ readonly key: string; readonly value: Value }>,
  fns: FnMap,
): string => {
  const ioOps = new Set(["httpRequest"]);
  const argObj = args.length === 0
    ? "{}"
    : `{${
      args.map((a) => `${escapeStr(a.key)}: ${emitValue(a.value, fns)}`).join(
        ", ",
      )
    }}`;
  if (ioOps.has(opName)) {
    return `await _OPS[${escapeStr(opName)}](${argObj}, _ctx)`;
  }
  return `await _OPS[${escapeStr(opName)}](${argObj})`;
};

const emitStatement = (stmt: Statement, depth: number, fns: FnMap): string => {
  const pad = "    ".repeat(depth);
  switch (stmt.kind) {
    case "assignment":
      if (stmt.name === "__ret") {
        return `${pad}return ${emitValue(stmt.value, fns)}`;
      }
      return `${pad}${stmt.name} = ${emitValue(stmt.value, fns)}`;
    case "return":
      return "";
    case "void_call":
      return `${pad}${emitCall(stmt.call.op, stmt.call.args, fns)}`;
    case "user_void_call":
      return `${pad}${emitUserCall(stmt.fn, stmt.args, fns)}`;
    case "if_else": {
      const cond = emitValue(stmt.condition, fns);
      const thenBlock = stmt.then
        .map((s) => emitStatement(s, depth + 1, fns))
        .filter((s) => s.length > 0)
        .join("\n");
      if (stmt.else) {
        const elseBlock = stmt.else
          .map((s) => emitStatement(s, depth + 1, fns))
          .filter((s) => s.length > 0)
          .join("\n");
        return `${pad}if ${cond}:\n${thenBlock}\n${pad}else:\n${elseBlock}`;
      }
      return `${pad}if ${cond}:\n${thenBlock}`;
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

const emitFn = (fn: FnDef, fns: FnMap): string => {
  const localNames = collectFnLocalNames(fn);
  const bodyFns: FnMap = new Map(
    [...fns].filter(([k]) => !localNames.has(k)),
  );
  const params = fn.params.map((p) => {
    const d = p.defaultValue !== undefined
      ? `=${
        p.defaultValue.kind === "boolean"
          ? (p.defaultValue.value ? "True" : "False")
          : p.defaultValue.kind === "null" ||
              p.defaultValue.kind === "undefined"
          ? "None"
          : JSON.stringify(p.defaultValue.value)
      }`
      : "";
    return `${p.name}${d}`;
  }).join(", ");
  const body = fn.body
    .map((s) => emitStatement(s, 1, bodyFns))
    .filter((s) => s.length > 0)
    .join("\n");
  const isRetVar = fn.returnValue.kind === "reference" &&
    fn.returnValue.name === "__ret";
  const ret = isRetVar
    ? "    return None"
    : `    return ${emitValue(fn.returnValue, bodyFns)}`;
  const bodyStr = body ? `${body}\n${ret}` : ret;
  return `async def ${fn.name}(${
    params ? `*, ${params}, ` : ""
  }_ctx: ExecutionContext):\n${bodyStr}`;
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
      out.add(fnExprName(v.fn));
      collectValueFnRefs(v.fn, out);
      collectValueFnRefs(v.array, out);
      v.captures?.forEach((c) => collectValueFnRefs(c.value, out));
      return;
    case "reduce":
      out.add(fnExprName(v.fn));
      collectValueFnRefs(v.fn, out);
      collectValueFnRefs(v.initial, out);
      collectValueFnRefs(v.array, out);
      v.captures?.forEach((c) => collectValueFnRefs(c.value, out));
      return;
  }
};

const collectStmtFnRefs = (stmt: Statement, out: Set<string>): void => {
  switch (stmt.kind) {
    case "assignment":
      collectValueFnRefs(stmt.value, out);
      return;
    case "return":
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

export const toPython = (program: Program, functionName?: string): string => {
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  if (functionName && !fns.has(functionName)) {
    throw new Error(`Function '${functionName}' not found`);
  }
  const roots = functionName
    ? [fns.get(functionName)!]
    : [...program.functions];
  validateProgramSemantics(program, roots);
  const targetFns = collectTransitiveDeps(roots, fns);
  const fnCode = targetFns.map((f) => emitFn(f, fns)).join("\n\n\n");
  return `${preamble}\n\n${fnCode}\n`;
};
