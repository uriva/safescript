import { z } from "zod/v4";
import { op } from "../op.ts";

export const MAX_STRING_LENGTH = 8 * 1024 * 1024;
export const MAX_ARRAY_LENGTH = 100_000;
export const MAX_REGEX_PATTERN_LENGTH = 1_000;
export const MAX_REGEX_TEXT_LENGTH = 1_000_000;

const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const defineSafeProp = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (key === "then" && typeof value === "function") {
    throw new Error("Function-valued 'then' property (thenable) is forbidden");
  }
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const base64UrlToBytes = (encoded: string): Uint8Array => {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const sanitizeMultipartParam = (value: string): string =>
  value.replace(/[\r\n"]/g, "");

const randomBoundary = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `----SafescriptMultipartBoundary${hex}`;
};

type RegexAtom =
  | { readonly kind: "atom" }
  | { readonly kind: "quantifier" }
  | {
    readonly kind: "group";
    readonly hasQuantifier: boolean;
    readonly hasAlternation: boolean;
    readonly overlappingBranches: boolean;
  };

type GroupFrame = {
  hasQuantifier: boolean;
  hasAlternation: boolean;
  isLookaround: boolean;
  branchFirstChars: string[];
  currentBranchFirst: string | null;
};

export const validateSafeRegex = (pattern: string, text: string): void => {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern length ${pattern.length} exceeds maximum ${MAX_REGEX_PATTERN_LENGTH}`,
    );
  }
  if (text.length > MAX_REGEX_TEXT_LENGTH) {
    throw new Error(
      `Regex input text length ${text.length} exceeds maximum ${MAX_REGEX_TEXT_LENGTH}`,
    );
  }

  const stack: GroupFrame[] = [];
  const state: {
    inCharClass: boolean;
    lastAtom: RegexAtom | null;
    repeatQuantifiers: number;
  } = {
    inCharClass: false,
    lastAtom: null,
    repeatQuantifiers: 0,
  };

  const recordBranchStart = (token: string): void => {
    const top = stack[stack.length - 1];
    if (top && top.currentBranchFirst === null) {
      top.currentBranchFirst = token;
    }
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (state.inCharClass) {
      if (ch === "\\") {
        i++;
      } else if (ch === "]") {
        state.inCharClass = false;
      }
      continue;
    }

    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!next) {
        throw new Error("Invalid trailing escape in regex pattern");
      }
      if ((next >= "1" && next <= "9") || next === "k") {
        throw new Error("Unsafe regex: backreferences are not permitted");
      }
      const isWildcardEscape = "dDwWsSbB".includes(next);
      recordBranchStart(isWildcardEscape ? "*" : `lit:${next}`);
      state.lastAtom = { kind: "atom" };
      i++;
      continue;
    }

    if (ch === "[") {
      recordBranchStart("*");
      state.inCharClass = true;
      state.lastAtom = { kind: "atom" };
      continue;
    }

    if (ch === "(") {
      recordBranchStart("*");
      const rest = pattern.slice(i + 1);
      const isLookaround = rest.startsWith("?=") ||
        rest.startsWith("?!") ||
        rest.startsWith("?<=") ||
        rest.startsWith("?<!");
      if (rest.startsWith("?<=") || rest.startsWith("?<!")) {
        i += 3;
      } else if (
        rest.startsWith("?:") ||
        rest.startsWith("?=") ||
        rest.startsWith("?!")
      ) {
        i += 2;
      }
      stack.push({
        hasQuantifier: false,
        hasAlternation: false,
        isLookaround,
        branchFirstChars: [],
        currentBranchFirst: null,
      });
      state.lastAtom = null;
      continue;
    }

    if (ch === "|") {
      const top = stack[stack.length - 1];
      if (top) {
        top.hasAlternation = true;
        top.branchFirstChars.push(top.currentBranchFirst ?? "*");
        top.currentBranchFirst = null;
      }
      state.lastAtom = null;
      continue;
    }

    if (ch === ")") {
      const group = stack.pop();
      if (!group) {
        throw new Error("Unbalanced ')' in regex pattern");
      }
      if (group.hasAlternation) {
        group.branchFirstChars.push(group.currentBranchFirst ?? "*");
      }
      if (group.isLookaround && group.hasQuantifier) {
        throw new Error(
          "Unsafe regex: quantifiers inside lookaround assertions are not permitted",
        );
      }
      if (group.hasQuantifier && stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }
      const overlappingBranches = group.hasAlternation &&
        (group.branchFirstChars.includes("*") ||
          new Set(group.branchFirstChars).size !==
            group.branchFirstChars.length);
      state.lastAtom = {
        kind: "group",
        hasQuantifier: group.hasQuantifier,
        hasAlternation: group.hasAlternation,
        overlappingBranches,
      };
      continue;
    }

    const braceMatch = ch === "{"
      ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i))
      : null;

    if (ch === "*" || ch === "+" || ch === "?" || braceMatch !== null) {
      if (!state.lastAtom || state.lastAtom.kind === "quantifier") {
        throw new Error("Unsafe regex: invalid or stacked quantifier");
      }
      const isRepeated = braceMatch
        ? (() => {
          const min = Number(braceMatch[1]);
          const hasComma = braceMatch[2] !== undefined;
          const maxStr = braceMatch[3];
          const max = maxStr ? Number(maxStr) : (hasComma ? Infinity : min);
          if (min > 1000 || (Number.isFinite(max) && max > 1000)) {
            throw new Error(
              "Unsafe regex: repetition quantifier bound exceeds 1000",
            );
          }
          i += braceMatch[0].length - 1;
          return max > 1;
        })()
        : ch === "*" || ch === "+";

      if (pattern[i + 1] === "?") {
        i++;
      }

      if (state.lastAtom.kind === "group") {
        if (state.lastAtom.hasQuantifier) {
          throw new Error(
            "Unsafe regex: nested quantifiers risk catastrophic backtracking",
          );
        }
        if (isRepeated && state.lastAtom.overlappingBranches) {
          throw new Error(
            "Unsafe regex: quantified overlapping alternation risks catastrophic backtracking",
          );
        }
      }

      for (const frame of stack) {
        frame.hasQuantifier = true;
      }
      if (isRepeated) {
        state.repeatQuantifiers++;
        if (state.repeatQuantifiers > 10) {
          throw new Error("Unsafe regex: too many repetition quantifiers");
        }
      }
      state.lastAtom = { kind: "quantifier" };
      continue;
    }

    if (ch === "." || ch === "^" || ch === "$") {
      if (ch === ".") recordBranchStart("*");
      state.lastAtom = { kind: "atom" };
      continue;
    }

    recordBranchStart(`lit:${ch}`);
    state.lastAtom = { kind: "atom" };
  }
};

const isValidJsonEscape = (seq: string) =>
  seq === '\\"' ||
  seq === "\\\\" ||
  seq === "\\/" ||
  seq === "\\b" ||
  seq === "\\f" ||
  seq === "\\n" ||
  seq === "\\r" ||
  seq === "\\t" ||
  /^\\u[\da-fA-F]{4}$/.test(seq);

const repairJson = (text: string): string =>
  text.replace(
    /\\(?:u[\da-fA-F]{4}|.|$)/gs,
    (match) => isValidJsonEscape(match) ? match : "\\" + match,
  );

const safeJsonParse = (text: string): unknown => {
  if (text.length > MAX_STRING_LENGTH) {
    throw new Error(
      `jsonParse input exceeds maximum string length (${MAX_STRING_LENGTH})`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(repairJson(text));
  }
};

export const jsonParse = op({
  input: z.object({ text: z.string() }),
  output: z.unknown(),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => safeJsonParse(text),
});

export const jsonStringify = op({
  input: z.object({ value: z.unknown() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ value }) => {
    const out = JSON.stringify(value);
    if (out.length > MAX_STRING_LENGTH) {
      throw new Error(
        `jsonStringify result exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    return out;
  },
});

export const stringStringify = op({
  input: z.object({ value: z.unknown() }),
  output: z.object({ text: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ value }) => {
    const text = JSON.stringify(value);
    if (text.length > MAX_STRING_LENGTH) {
      throw new Error(
        `stringStringify result exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    return { text };
  },
});

export const stringConcat = op({
  input: z.object({ parts: z.array(z.string()) }),
  output: z.object({ result: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ parts }) => {
    const state = { total: 0 };
    for (let i = 0; i < parts.length; i++) {
      if (typeof parts[i] !== "string") {
        throw new TypeError(
          `stringConcat expects string parts, got ${typeof parts[
            i
          ]} at index ${i}`,
        );
      }
      state.total += parts[i].length;
      if (state.total > MAX_STRING_LENGTH) {
        throw new Error(
          `stringConcat result exceeds maximum string length (${MAX_STRING_LENGTH})`,
        );
      }
    }
    return { result: parts.join("") };
  },
});

export const stringIncludes = op({
  input: z.object({
    haystack: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    s: z.string().optional(),
    needle: z.string().optional(),
    search: z.string().optional(),
    substring: z.string().optional(),
  }),
  output: z.object({ result: z.boolean() }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ haystack, text, value, s, needle, search, substring }) => ({
    result: (haystack ?? text ?? value ?? s ?? "").includes(
      needle ?? search ?? substring ?? "",
    ),
  }),
});

export const stringReplace = op({
  input: z.object({
    haystack: z.string(),
    needle: z.string(),
    replacement: z.string(),
    all: z.boolean().optional(),
  }),
  output: z.object({ result: z.string(), count: z.number() }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ haystack, needle, replacement, all }) => {
    if (needle === "") throw new Error("needle must not be empty");
    const count = haystack.split(needle).length - 1;
    const replaceAll = all ?? true;
    const applied = replaceAll ? count : Math.min(count, 1);
    const expectedLen = haystack.length +
      applied * (replacement.length - needle.length);
    if (expectedLen > MAX_STRING_LENGTH) {
      throw new Error(
        `stringReplace result exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    return {
      result: replaceAll
        ? haystack.replaceAll(needle, replacement)
        : haystack.replace(needle, replacement),
      count,
    };
  },
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
  run: async ({ text }) => {
    const encoded = encodeURIComponent(text);
    if (encoded.length > MAX_STRING_LENGTH) {
      throw new Error(
        `urlEncode result exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    return { encoded };
  },
});

export const base64urlEncode = op({
  input: z.object({ text: z.string() }),
  output: z.object({ encoded: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => {
    if (text.length > MAX_STRING_LENGTH) {
      throw new Error(
        `base64urlEncode input exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    const bytes = new TextEncoder().encode(text);
    return { encoded: bytesToBase64Url(bytes) };
  },
});

export const base64urlDecode = op({
  input: z.object({ encoded: z.string() }),
  output: z.object({ text: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ encoded }) => {
    if (encoded.length > MAX_STRING_LENGTH) {
      throw new Error(
        `base64urlDecode input exceeds maximum string length (${MAX_STRING_LENGTH})`,
      );
    }
    const bytes = base64UrlToBytes(encoded);
    return { text: new TextDecoder().decode(bytes) };
  },
});

export const pick = op({
  input: z.object({ obj: z.record(z.unknown()), keys: z.array(z.string()) }),
  output: z.object({
    obj: z.record(z.unknown()),
    result: z.record(z.unknown()),
  }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ obj, keys }) => {
    const picked: Record<string, unknown> = {};
    for (const k of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(k)) {
        throw new Error(`Forbidden property access: '${k}'`);
      }
      if (Object.hasOwn(obj, k)) {
        defineSafeProp(picked, k, obj[k]);
      }
    }
    return { obj: picked, result: picked };
  },
});

export const arrayAppend = op({
  input: z.object({ array: z.array(z.unknown()), element: z.unknown() }),
  output: z.object({ array: z.array(z.unknown()) }),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ array, element }) => {
    if (array.length + 1 > MAX_ARRAY_LENGTH) {
      throw new Error(
        `Array length exceeds maximum allowed (${MAX_ARRAY_LENGTH})`,
      );
    }
    return { array: [...array, element] };
  },
});

export const merge = op({
  input: z.object({
    a: z.record(z.unknown()),
    b: z.record(z.unknown()),
  }),
  output: z.object({ result: z.record(z.unknown()) }),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ a, b }) => {
    const merged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (!FORBIDDEN_OBJECT_KEYS.has(k)) defineSafeProp(merged, k, v);
    }
    for (const [k, v] of Object.entries(b)) {
      if (!FORBIDDEN_OBJECT_KEYS.has(k)) defineSafeProp(merged, k, v);
    }
    return { result: merged };
  },
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
    return { hash: bytesToBase64Url(hashBytes) };
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

export const stringRegex = op({
  input: z.object({ text: z.string(), pattern: z.string() }),
  output: z.object({ match: z.boolean(), groups: z.array(z.string()) }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text, pattern }) => {
    validateSafeRegex(pattern, text);
    const match = new RegExp(pattern).exec(text);
    return match
      ? { match: true, groups: [...match].slice(1).map((g) => g ?? "") }
      : { match: false, groups: [] };
  },
});

export const stringSplit = op({
  input: z.object({
    text: z.string().optional(),
    haystack: z.string().optional(),
    delimiter: z.string(),
  }),
  output: z.object({ parts: z.array(z.string()) }),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text, haystack, delimiter }) => {
    const src = text ?? haystack ?? "";
    if (delimiter === "" && src.length > MAX_ARRAY_LENGTH) {
      throw new Error(
        `stringSplit result exceeds maximum array length (${MAX_ARRAY_LENGTH})`,
      );
    }
    const parts = src.split(delimiter);
    if (parts.length > MAX_ARRAY_LENGTH) {
      throw new Error(
        `stringSplit result exceeds maximum array length (${MAX_ARRAY_LENGTH})`,
      );
    }
    return { parts };
  },
});

export const stringSlice = op({
  input: z.object({
    text: z.unknown().optional(),
    haystack: z.string().optional(),
    array: z.array(z.unknown()).optional(),
    value: z.unknown().optional(),
    start: z.number(),
    end: z.number().optional(),
  }),
  output: z.unknown(),
  tags: ["pure"],
  resources: { memoryBytes: 4096, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text, haystack, array, value, start, end }) => {
    const target = array ?? text ?? haystack ?? value ?? "";
    if (Array.isArray(target)) {
      return end !== undefined ? target.slice(start, end) : target.slice(start);
    }
    const s = String(target);
    return end !== undefined ? s.slice(start, end) : s.slice(start);
  },
});

export const objectKeys = op({
  input: z.object({
    obj: z.unknown().optional(),
    value: z.unknown().optional(),
  }),
  output: z.array(z.string()),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ obj, value }) => {
    const target = obj ?? value;
    return target && typeof target === "object" && !Array.isArray(target)
      ? Object.keys(target as Record<string, unknown>).filter((k) =>
        !FORBIDDEN_OBJECT_KEYS.has(k)
      )
      : [];
  },
});

export const typeOf = op({
  input: z.object({ value: z.unknown() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
  run: async ({ value }) =>
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
});

export const doc = op({
  input: z.object({
    target: z.unknown().optional(),
    text: z.string(),
  }),
  output: z.object({}),
  tags: ["pure"],
  resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
  run: async () => ({}),
});

export const buildMultipartBody = op({
  input: z.object({
    fields: z.record(z.string()).optional(),
    files: z.array(
      z.object({
        name: z.string(),
        filename: z.string(),
        content: z.string(),
        contentType: z.string(),
      }),
    ).optional(),
  }),
  output: z.object({ body: z.string(), boundary: z.string() }),
  tags: ["pure"],
  resources: { memoryBytes: 65536, runtimeMs: 5, diskBytes: 0 },
  run: async ({ fields, files }) => {
    const boundary = randomBoundary();
    const parts: string[] = [];
    const lenState = { total: 0 };
    const pushPart = (part: string): void => {
      lenState.total += part.length;
      if (lenState.total > MAX_STRING_LENGTH) {
        throw new Error(
          `buildMultipartBody exceeds maximum string length (${MAX_STRING_LENGTH})`,
        );
      }
      parts.push(part);
    };
    if (fields) {
      for (const [name, value] of Object.entries(fields)) {
        const safeName = sanitizeMultipartParam(name);
        pushPart(
          `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${value}\r\n`,
        );
      }
    }
    if (files) {
      for (const file of files) {
        const safeName = sanitizeMultipartParam(file.name);
        const safeFilename = sanitizeMultipartParam(file.filename);
        const safeContentType = sanitizeMultipartParam(file.contentType);
        pushPart(
          `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\nContent-Type: ${safeContentType}\r\n\r\n${file.content}\r\n`,
        );
      }
    }
    pushPart(`--${boundary}--\r\n`);
    return { body: parts.join(""), boundary };
  },
});

export const len = op({
  input: z.object({ value: z.unknown() }),
  output: z.object({ length: z.number() }),
  tags: ["pure"],
  resources: { memoryBytes: 0, runtimeMs: 0, diskBytes: 0 },
  run: async ({ value }) => ({
    length: Array.isArray(value) || typeof value === "string"
      ? value.length
      : 0,
  }),
});

export const toString = op({
  input: z.object({ value: z.unknown() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 256, runtimeMs: 0, diskBytes: 0 },
  run: async ({ value }) => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (value === null || value === undefined) return "";
    throw new TypeError(
      `toString expects a primitive value (string, number, boolean, null, undefined), got ${
        Array.isArray(value) ? "array" : typeof value
      }. Use jsonStringify(...) to serialize objects or arrays.`,
    );
  },
});

export const stringUpper = op({
  input: z.object({ text: z.string() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => text.toUpperCase(),
});

export const stringTrim = op({
  input: z.object({ text: z.string() }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 1024, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text }) => text.trim(),
});

export const stringStartsWith = op({
  input: z.object({ text: z.string(), prefix: z.string() }),
  output: z.boolean(),
  tags: ["pure"],
  resources: { memoryBytes: 256, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text, prefix }) => text.startsWith(prefix),
});

export const stringEndsWith = op({
  input: z.object({ text: z.string(), suffix: z.string() }),
  output: z.boolean(),
  tags: ["pure"],
  resources: { memoryBytes: 256, runtimeMs: 1, diskBytes: 0 },
  run: async ({ text, suffix }) => text.endsWith(suffix),
});

export const arrayJoin = op({
  input: z.object({
    array: z.array(z.unknown()),
    delimiter: z.string().optional(),
  }),
  output: z.string(),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ array, delimiter }) => {
    if (array.length > MAX_ARRAY_LENGTH) {
      throw new Error(
        `arrayJoin input exceeds maximum array length (${MAX_ARRAY_LENGTH})`,
      );
    }
    const delim = delimiter ?? ",";
    const lenState = { total: 0 };
    const strs = array.map((el, idx) => {
      const s = (() => {
        if (typeof el === "string") return el;
        if (typeof el === "number" || typeof el === "boolean") {
          return String(el);
        }
        if (el === null || el === undefined) return "";
        throw new TypeError(
          `arrayJoin expects primitive elements, got ${typeof el}`,
        );
      })();
      lenState.total += s.length + (idx > 0 ? delim.length : 0);
      if (lenState.total > MAX_STRING_LENGTH) {
        throw new Error(
          `arrayJoin result exceeds maximum string length (${MAX_STRING_LENGTH})`,
        );
      }
      return s;
    });
    return strs.join(delim);
  },
});

export const arrayConcat = op({
  input: z.object({ parts: z.array(z.array(z.unknown())) }),
  output: z.array(z.unknown()),
  tags: ["pure"],
  resources: { memoryBytes: 2048, runtimeMs: 1, diskBytes: 0 },
  run: async ({ parts }) => {
    const out: unknown[] = [];
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      if (!Array.isArray(segment)) {
        throw new TypeError(
          `arrayConcat expects array segments, got ${typeof segment} at index ${i}`,
        );
      }
      if (out.length + segment.length > MAX_ARRAY_LENGTH) {
        throw new Error(
          `arrayConcat result exceeds maximum array length (${MAX_ARRAY_LENGTH})`,
        );
      }
      for (let j = 0; j < segment.length; j++) {
        out.push(segment[j]);
      }
    }
    return out;
  },
});
