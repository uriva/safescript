export type TokenKind =
  | "ident"
  | "string"
  | "tmpl_head"
  | "tmpl_mid"
  | "tmpl_tail"
  | "jsx_open"
  | "jsx_close_open"
  | "jsx_tag_end"
  | "jsx_self_close"
  | "jsx_frag_open"
  | "jsx_frag_close"
  | "jsx_ident"
  | "jsx_text"
  | "number"
  | "true"
  | "false"
  | "null"
  | "undefined"
  | "function"
  | "return"
  | "if"
  | "else"
  | "import"
  | "from"
  | "as"
  | "perms"
  | "hash"
  | "="
  | "=>"
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  | "&&"
  | "||"
  | "..."
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "!"
  | "?"
  | "("
  | ")"
  | "{"
  | "}"
  | "["
  | "]"
  | ":"
  | ","
  | "."
  | ";"
  | "map"
  | "filter"
  | "reduce"
  | "eof";

export type Token = {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly col: number;
};

const isWhitespace = (ch: string): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

const isIdentStart = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";

const isIdentChar = (ch: string): boolean => isIdentStart(ch) || isDigit(ch);

const isJsxIdentChar = (ch: string): boolean =>
  isIdentChar(ch) || ch === "-" || ch === ":" || ch === ".";

const keywords: ReadonlySet<string> = new Set([
  "return",
  "function",
  "true",
  "false",
  "null",
  "undefined",
  "if",
  "else",
  "import",
  "from",
  "as",
  "perms",
  "hash",
  "map",
  "filter",
  "reduce",
]);

const valueEndingKinds: ReadonlySet<TokenKind> = new Set([
  "ident",
  "number",
  "string",
  "tmpl_tail",
  "true",
  "false",
  "null",
  "undefined",
  ")",
  "]",
  "}",
  "jsx_tag_end",
  "jsx_self_close",
  "jsx_frag_close",
]);

const canStartPrimaryExpr = (prev: Token | undefined): boolean =>
  prev === undefined || !valueEndingKinds.has(prev.kind);

const htmlEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: "\u00a0",
  middot: "\u00b7",
  mdash: "\u2014",
  ndash: "\u2013",
  rarr: "\u2192",
  larr: "\u2190",
  nearr: "\u2197",
};

const decodeJsxText = (raw: string): string =>
  raw.replace(/&(#?[a-zA-Z0-9]+);/g, (full, name: string) =>
    Object.prototype.hasOwnProperty.call(htmlEntities, name)
      ? htmlEntities[name]
      : full
  );

const normalizeJsxText = (raw: string): string => {
  if (!raw.includes("\n") && !raw.includes("\r")) {
    return decodeJsxText(raw);
  }
  const lines = raw.split(/\r?\n/);
  const cleaned: string[] = [];
  lines.forEach((ln, idx) => {
    const trimmedStart = idx > 0 ? ln.replace(/^[ \t]+/, "") : ln;
    const trimmedBoth = idx < lines.length - 1
      ? trimmedStart.replace(/[ \t]+$/, "")
      : trimmedStart;
    if (trimmedBoth.length > 0) {
      cleaned.push(trimmedBoth);
    }
  });
  return decodeJsxText(cleaned.join(" "));
};

type LexMode =
  | { kind: "expr"; braceDepth: number; returnTo: "tmpl" | "jsx" }
  | { kind: "jsx_tag"; isClosing: boolean; pendingTagName: boolean }
  | { kind: "jsx_children" };

export const tokenize = (source: string): readonly Token[] => {
  const tokens: Token[] = [];
  const state = { pos: 0, line: 1, col: 1 };
  const modeStack: LexMode[] = [];

  const peek = (): string =>
    state.pos < source.length ? source[state.pos] : "";
  const peekAt = (offset: number): string =>
    state.pos + offset < source.length ? source[state.pos + offset] : "";
  const advance = (): string => {
    const ch = source[state.pos];
    state.pos++;
    if (ch === "\n") {
      state.line++;
      state.col = 1;
    } else {
      state.col++;
    }
    return ch;
  };

  const skipWhitespace = (): void => {
    while (state.pos < source.length && isWhitespace(source[state.pos])) {
      advance();
    }
  };

  const skipLineComment = (): void => {
    while (state.pos < source.length && source[state.pos] !== "\n") advance();
  };

  const skipBlockComment = (startLine: number, startCol: number): void => {
    advance(); // /
    advance(); // *
    while (state.pos < source.length) {
      if (source[state.pos] === "*" && peekAt(1) === "/") {
        advance();
        advance();
        return;
      }
      advance();
    }
    throw new Error(`Unterminated block comment at ${startLine}:${startCol}`);
  };

  const readString = (
    startLine: number,
    startCol: number,
    quoteChar = '"',
  ): Token => {
    advance(); // skip opening quote
    const chars: string[] = [];
    while (state.pos < source.length && source[state.pos] !== quoteChar) {
      if (source[state.pos] === "\\") {
        advance();
        const esc = advance();
        if (esc === "n") chars.push("\n");
        else if (esc === "t") chars.push("\t");
        else if (esc === "r") chars.push("\r");
        else if (esc === "\\") chars.push("\\");
        else if (esc === '"') chars.push('"');
        else if (esc === "'") chars.push("'");
        else {
          throw new Error(
            `Unknown escape sequence '\\${esc}' in string at ${startLine}:${startCol}. Supported escapes: \\n \\t \\r \\\\ \\" \\'`,
          );
        }
      } else {
        chars.push(advance());
      }
    }
    if (state.pos >= source.length) {
      throw new Error(`Unterminated string at ${startLine}:${startCol}`);
    }
    advance(); // skip closing quote
    return {
      kind: "string",
      value: chars.join(""),
      line: startLine,
      col: startCol,
    };
  };

  const readNumber = (startLine: number, startCol: number): Token => {
    const chars: string[] = [];
    while (state.pos < source.length && isDigit(source[state.pos])) {
      chars.push(advance());
    }
    if (state.pos < source.length && source[state.pos] === ".") {
      chars.push(advance());
      while (state.pos < source.length && isDigit(source[state.pos])) {
        chars.push(advance());
      }
    }
    return {
      kind: "number",
      value: chars.join(""),
      line: startLine,
      col: startCol,
    };
  };

  const readIdent = (startLine: number, startCol: number): Token => {
    const chars: string[] = [];
    while (state.pos < source.length && isIdentChar(source[state.pos])) {
      chars.push(advance());
    }
    const value = chars.join("");
    const kind: TokenKind = keywords.has(value) ? (value as TokenKind) : "ident";
    return { kind, value, line: startLine, col: startCol };
  };

  const readJsxIdent = (startLine: number, startCol: number): Token => {
    const chars: string[] = [];
    while (state.pos < source.length && isJsxIdentChar(source[state.pos])) {
      chars.push(advance());
    }
    return {
      kind: "jsx_ident",
      value: chars.join(""),
      line: startLine,
      col: startCol,
    };
  };

  const tok = (
    kind: TokenKind,
    value: string,
    startLine: number,
    startCol: number,
  ): Token => {
    for (let i = 0; i < value.length; i++) advance();
    return { kind, value, line: startLine, col: startCol };
  };

  const readTemplateChunk = (
    startLine: number,
    startCol: number,
    isStart: boolean,
  ): Token => {
    const chars: string[] = [];
    while (state.pos < source.length) {
      if (source[state.pos] === "`") {
        advance(); // skip closing backtick
        return {
          kind: isStart ? "string" : "tmpl_tail",
          value: chars.join(""),
          line: startLine,
          col: startCol,
        };
      }
      if (source[state.pos] === "$" && peekAt(1) === "{") {
        advance(); // $
        advance(); // {
        modeStack.push({ kind: "expr", braceDepth: 0, returnTo: "tmpl" });
        return {
          kind: isStart ? "tmpl_head" : "tmpl_mid",
          value: chars.join(""),
          line: startLine,
          col: startCol,
        };
      }
      if (source[state.pos] === "\\") {
        advance();
        const esc = advance();
        if (esc === "n") chars.push("\n");
        else if (esc === "t") chars.push("\t");
        else if (esc === "r") chars.push("\r");
        else if (esc === "\\") chars.push("\\");
        else if (esc === "`") chars.push("`");
        else if (esc === "$") chars.push("$");
        else if (esc === '"') chars.push('"');
        else if (esc === "'") chars.push("'");
        else {
          throw new Error(
            `Unknown escape sequence '\\${esc}' in template string at ${startLine}:${startCol}. Supported escapes: \\n \\t \\r \\\\ \\\` \\$ \\" \\'`,
          );
        }
      } else {
        chars.push(advance());
      }
    }
    throw new Error(`Unterminated template literal at ${startLine}:${startCol}`);
  };

  while (state.pos < source.length) {
    const top = modeStack[modeStack.length - 1];

    if (top?.kind === "jsx_children") {
      const startLine = state.line;
      const startCol = state.col;
      const ch = peek();

      if (ch === "<" && peekAt(1) === "/") {
        if (peekAt(2) === ">") {
          tokens.push(tok("jsx_frag_close", "</>", startLine, startCol));
          modeStack.pop();
        } else {
          tokens.push(tok("jsx_close_open", "</", startLine, startCol));
          modeStack.push({
            kind: "jsx_tag",
            isClosing: true,
            pendingTagName: true,
          });
        }
        continue;
      }

      if (ch === "<" && peekAt(1) === ">") {
        tokens.push(tok("jsx_frag_open", "<>", startLine, startCol));
        modeStack.push({ kind: "jsx_children" });
        continue;
      }

      if (ch === "<" && isIdentStart(peekAt(1))) {
        tokens.push(tok("jsx_open", "<", startLine, startCol));
        modeStack.push({
          kind: "jsx_tag",
          isClosing: false,
          pendingTagName: true,
        });
        continue;
      }

      if (ch === "{") {
        if (peekAt(1) === "/" && peekAt(2) === "*") {
          advance(); // {
          skipBlockComment(startLine, startCol);
          if (peek() !== "}") {
            throw new Error(
              `Expected '}' after JSX comment at ${state.line}:${state.col}`,
            );
          }
          advance(); // }
          continue;
        }
        tokens.push(tok("{", "{", startLine, startCol));
        modeStack.push({ kind: "expr", braceDepth: 0, returnTo: "jsx" });
        continue;
      }

      const textChars: string[] = [];
      while (state.pos < source.length) {
        const c = peek();
        if (c === "{") break;
        if (
          c === "<" &&
          (peekAt(1) === "/" || peekAt(1) === ">" || isIdentStart(peekAt(1)))
        ) {
          break;
        }
        textChars.push(advance());
      }
      const normalized = normalizeJsxText(textChars.join(""));
      if (normalized.length > 0) {
        tokens.push({
          kind: "jsx_text",
          value: normalized,
          line: startLine,
          col: startCol,
        });
      }
      continue;
    }

    if (top?.kind === "jsx_tag") {
      skipWhitespace();
      if (state.pos >= source.length) {
        throw new Error(
          `Unterminated JSX tag at ${state.line}:${state.col}`,
        );
      }
      const startLine = state.line;
      const startCol = state.col;
      const ch = peek();

      if (ch === "/" && peekAt(1) === "*") {
        skipBlockComment(startLine, startCol);
        continue;
      }

      if (top.pendingTagName) {
        if (!isIdentStart(ch)) {
          throw new Error(
            `Expected JSX tag name at ${startLine}:${startCol}, got '${ch}'`,
          );
        }
        tokens.push(readJsxIdent(startLine, startCol));
        top.pendingTagName = false;
        continue;
      }

      if (!top.isClosing && ch === "/" && peekAt(1) === ">") {
        tokens.push(tok("jsx_self_close", "/>", startLine, startCol));
        modeStack.pop();
        continue;
      }

      if (ch === ">") {
        tokens.push(tok("jsx_tag_end", ">", startLine, startCol));
        modeStack.pop();
        if (top.isClosing) {
          if (modeStack[modeStack.length - 1]?.kind === "jsx_children") {
            modeStack.pop();
          }
        } else {
          modeStack.push({ kind: "jsx_children" });
        }
        continue;
      }

      if (ch === "=") {
        tokens.push(tok("=", "=", startLine, startCol));
        continue;
      }

      if (ch === '"' || ch === "'") {
        tokens.push(readString(startLine, startCol, ch));
        continue;
      }

      if (ch === "{") {
        tokens.push(tok("{", "{", startLine, startCol));
        modeStack.push({ kind: "expr", braceDepth: 0, returnTo: "jsx" });
        continue;
      }

      if (isIdentStart(ch)) {
        tokens.push(readJsxIdent(startLine, startCol));
        continue;
      }

      throw new Error(
        `Unexpected character '${ch}' inside JSX tag at ${startLine}:${startCol}`,
      );
    }

    skipWhitespace();
    if (state.pos >= source.length) break;

    const startLine = state.line;
    const startCol = state.col;
    const ch = peek();

    if (ch === "/" && peekAt(1) === "/") {
      skipLineComment();
      continue;
    }

    if (ch === "/" && peekAt(1) === "*") {
      skipBlockComment(startLine, startCol);
      continue;
    }

    if (ch === '"' || ch === "'") {
      tokens.push(readString(startLine, startCol, ch));
    } else if (ch === "`") {
      advance(); // skip opening backtick
      tokens.push(readTemplateChunk(startLine, startCol, true));
    } else if (
      ch === "}" &&
      top?.kind === "expr" &&
      top.braceDepth === 0
    ) {
      modeStack.pop();
      if (top.returnTo === "tmpl") {
        advance(); // consume closing '}' of ${...}
        tokens.push(readTemplateChunk(startLine, startCol, false));
      } else {
        tokens.push(tok("}", "}", startLine, startCol));
      }
    } else if (ch === "{" && top?.kind === "expr") {
      top.braceDepth++;
      tokens.push(tok("{", "{", startLine, startCol));
    } else if (ch === "}" && top?.kind === "expr") {
      top.braceDepth--;
      tokens.push(tok("}", "}", startLine, startCol));
    } else if (
      ch === "<" &&
      canStartPrimaryExpr(tokens[tokens.length - 1]) &&
      peekAt(1) === ">"
    ) {
      tokens.push(tok("jsx_frag_open", "<>", startLine, startCol));
      modeStack.push({ kind: "jsx_children" });
    } else if (
      ch === "<" &&
      canStartPrimaryExpr(tokens[tokens.length - 1]) &&
      isIdentStart(peekAt(1))
    ) {
      tokens.push(tok("jsx_open", "<", startLine, startCol));
      modeStack.push({
        kind: "jsx_tag",
        isClosing: false,
        pendingTagName: true,
      });
    } else if (isDigit(ch)) {
      tokens.push(readNumber(startLine, startCol));
    } else if (isIdentStart(ch)) {
      tokens.push(readIdent(startLine, startCol));
    } else if (ch === "." && peekAt(1) === "." && peekAt(2) === ".") {
      tokens.push(tok("...", "...", startLine, startCol));
    } else if (ch === "&" && peekAt(1) === "&") {
      tokens.push(tok("&&", "&&", startLine, startCol));
    } else if (ch === "|" && peekAt(1) === "|") {
      tokens.push(tok("||", "||", startLine, startCol));
    } else if (ch === "=" && peekAt(1) === ">") {
      tokens.push(tok("=>", "=>", startLine, startCol));
    } else if (ch === "=" && peekAt(1) === "=") {
      tokens.push(tok("==", "==", startLine, startCol));
    } else if (ch === "!" && peekAt(1) === "=") {
      tokens.push(tok("!=", "!=", startLine, startCol));
    } else if (ch === "<" && peekAt(1) === "=") {
      tokens.push(tok("<=", "<=", startLine, startCol));
    } else if (ch === ">" && peekAt(1) === "=") {
      tokens.push(tok(">=", ">=", startLine, startCol));
    } else if (ch === "=") {
      tokens.push(tok("=", "=", startLine, startCol));
    } else if (ch === "<") {
      tokens.push(tok("<", "<", startLine, startCol));
    } else if (ch === ">") {
      tokens.push(tok(">", ">", startLine, startCol));
    } else if (
      ch === "(" || ch === ")" || ch === "{" || ch === "}" ||
      ch === "[" || ch === "]" || ch === ":" || ch === "," ||
      ch === "." || ch === ";" || ch === "+" || ch === "-" || ch === "*" ||
      ch === "/" || ch === "%" || ch === "?" || ch === "!"
    ) {
      tokens.push(tok(ch as TokenKind, ch, startLine, startCol));
    } else {
      throw new Error(
        `Unexpected character '${ch}' at ${startLine}:${startCol}`,
      );
    }
  }

  if (modeStack.length > 0) {
    throw new Error(`Unterminated JSX or template expression at ${state.line}:${state.col}`);
  }

  tokens.push({ kind: "eof", value: "", line: state.line, col: state.col });
  return tokens;
};
