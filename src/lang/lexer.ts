export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "true"
  | "false"
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

const keywords: ReadonlySet<string> = new Set([
  "return",
  "true",
  "false",
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

export const tokenize = (source: string): readonly Token[] => {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const peek = (): string => (pos < source.length ? source[pos] : "");
  const peekAt = (
    offset: number,
  ): string => (pos + offset < source.length ? source[pos + offset] : "");
  const advance = (): string => {
    const ch = source[pos];
    pos++;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  const skipWhitespace = (): void => {
    while (pos < source.length && isWhitespace(source[pos])) advance();
  };

  const skipLineComment = (): void => {
    while (pos < source.length && source[pos] !== "\n") advance();
  };

  const readString = (startLine: number, startCol: number): Token => {
    advance(); // skip opening quote
    let value = "";
    while (pos < source.length && source[pos] !== '"') {
      if (source[pos] === "\\") {
        advance();
        const esc = advance();
        if (esc === "n") value += "\n";
        else if (esc === "t") value += "\t";
        else if (esc === "\\") value += "\\";
        else if (esc === '"') value += '"';
        else value += esc;
      } else {
        value += advance();
      }
    }
    if (pos >= source.length) {
      throw new Error(`Unterminated string at ${startLine}:${startCol}`);
    }
    advance(); // skip closing quote
    return { kind: "string", value, line: startLine, col: startCol };
  };

  const readNumber = (startLine: number, startCol: number): Token => {
    let value = "";
    while (pos < source.length && isDigit(source[pos])) value += advance();
    if (pos < source.length && source[pos] === ".") {
      value += advance();
      while (pos < source.length && isDigit(source[pos])) value += advance();
    }
    return { kind: "number", value, line: startLine, col: startCol };
  };

  const readIdent = (startLine: number, startCol: number): Token => {
    let value = "";
    while (pos < source.length && isIdentChar(source[pos])) value += advance();
    const kind: TokenKind = keywords.has(value) ? value as TokenKind : "ident";
    return { kind, value, line: startLine, col: startCol };
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

  while (pos < source.length) {
    skipWhitespace();
    if (pos >= source.length) break;

    const startLine = line;
    const startCol = col;
    const ch = peek();

    if (ch === "/" && peekAt(1) === "/") {
      skipLineComment();
      continue;
    }

    if (ch === '"') {
      tokens.push(readString(startLine, startCol));
    } else if (isDigit(ch)) {
      tokens.push(readNumber(startLine, startCol));
    } else if (isIdentStart(ch)) {
      tokens.push(readIdent(startLine, startCol));
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
      ch === "." || ch === "+" || ch === "-" || ch === "*" ||
      ch === "/" || ch === "%" || ch === "?"
    ) {
      tokens.push(tok(ch as TokenKind, ch, startLine, startCol));
    } else {
      throw new Error(
        `Unexpected character '${ch}' at ${startLine}:${startCol}`,
      );
    }
  }

  tokens.push({ kind: "eof", value: "", line, col });
  return tokens;
};
