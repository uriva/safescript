// highlight.js language definition for safescript.
//
// safescript is a small DSL where every program is a flat list of fn defs.
// Highlight rules:
//   - Keywords: return, if, else, override, map, filter, reduce, import, from
//   - Type names after `:` and `):` (number, string, boolean, void, plus
//     identifiers and array suffixes like `string[]`)
//   - Builtin op names: httpRequest, jsonParse, jsonStringify, readSecret,
//     writeSecret, stringConcat, stringSplit, sha256, hmac, etc.
//   - String literals (double quotes, with escapes)
//   - Number literals
//   - Boolean literals: true, false
//   - Line comments (`//`)
//   - Function definition heads: `name = (args) =>`

import type { HLJSApi, Language } from "highlight.js";

const safescriptLanguage = (hljs: HLJSApi): Language => {
  const KEYWORDS = {
    keyword: "return if else override map filter reduce import from",
    literal: "true false null",
    built_in: [
      // I/O ops
      "httpRequest",
      "readSecret",
      "writeSecret",
      // Pure ops
      "jsonParse",
      "jsonStringify",
      "stringConcat",
      "stringSplit",
      "stringReplace",
      "stringLength",
      "stringSlice",
      "arrayLength",
      "arrayConcat",
      "arraySlice",
      "objectKeys",
      "objectValues",
      "objectMerge",
      "pick",
      "omit",
      // Crypto
      "sha256",
      "hmac",
      "randomBytes",
      "uuid",
      // Sources
      "now",
      "env",
    ].join(" "),
  };

  const STRING = {
    className: "string",
    variants: [
      {
        begin: '"',
        end: '"',
        contains: [
          { begin: "\\\\." }, // escape sequences
        ],
      },
    ],
  };

  const NUMBER = hljs.NUMBER_MODE;

  const COMMENT = hljs.COMMENT("//", "$");

  // Type annotation after `:` — captures simple ident, possibly with `[]`.
  const TYPE_ANNOTATION = {
    className: "type",
    begin: ":\\s*",
    end: "(?=[,)=>{])",
    excludeBegin: false,
    relevance: 0,
    contains: [
      {
        className: "type",
        begin: "\\b[A-Za-z_][A-Za-z0-9_]*(\\[\\])*\\b",
      },
    ],
  };

  // Function definition: `name = (...)` at start of statement.
  const FN_DEF = {
    className: "function",
    begin: "^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*\\(",
    returnBegin: true,
    contains: [
      {
        className: "title",
        begin: "[A-Za-z_][A-Za-z0-9_]*",
      },
    ],
  };

  return {
    name: "safescript",
    aliases: ["sscript", "ss"],
    keywords: KEYWORDS,
    contains: [
      COMMENT,
      STRING,
      NUMBER,
      FN_DEF,
      TYPE_ANNOTATION,
      // identifiers (so keywords/built-ins are matched correctly)
      {
        className: "title.function.invoke",
        begin: "\\b([a-z_][A-Za-z0-9_]*)\\s*\\(",
        returnBegin: true,
        contains: [
          {
            className: "title.function",
            begin: "[a-z_][A-Za-z0-9_]*",
          },
        ],
      },
    ],
  };
};

export default safescriptLanguage;
