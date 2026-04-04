import type { Token, TokenKind } from "./lexer.ts";
import type {
  BinaryOp,
  FnDef,
  ImportDecl,
  Param,
  Program,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";

type ParserState = {
  readonly tokens: readonly Token[];
  pos: number;
};

const peek = (s: ParserState): Token => s.tokens[s.pos];

const advance = (s: ParserState): Token => {
  const tok = s.tokens[s.pos];
  s.pos++;
  return tok;
};

const expect = (s: ParserState, kind: TokenKind): Token => {
  const tok = advance(s);
  if (tok.kind !== kind) {
    throw new Error(
      `Expected '${kind}' but got '${tok.kind}' ("${tok.value}") at ${tok.line}:${tok.col}`,
    );
  }
  return tok;
};

// --- Types ---

const parseType = (s: ParserState): TypeExpr => {
  const tok = peek(s);
  let base: TypeExpr;
  if (tok.kind === "{") {
    advance(s);
    const fields: Array<{ name: string; type: TypeExpr }> = [];
    while (peek(s).kind !== "}") {
      if (fields.length > 0) expect(s, ",");
      const name = expect(s, "ident").value;
      expect(s, ":");
      const type = parseType(s);
      fields.push({ name, type });
    }
    expect(s, "}");
    base = { kind: "object", fields };
  } else if (
    tok.kind === "ident" &&
    (tok.value === "string" || tok.value === "number" ||
      tok.value === "boolean")
  ) {
    advance(s);
    base = { kind: "primitive", name: tok.value };
  } else {
    throw new Error(
      `Expected type at ${tok.line}:${tok.col}, got '${tok.kind}' ("${tok.value}")`,
    );
  }
  while (peek(s).kind === "[") {
    advance(s);
    expect(s, "]");
    base = { kind: "array", element: base };
  }
  return base;
};

const parseParams = (s: ParserState): readonly Param[] => {
  expect(s, "(");
  const params: Param[] = [];
  while (peek(s).kind !== ")") {
    if (params.length > 0) expect(s, ",");
    const name = expect(s, "ident").value;
    expect(s, ":");
    const type = parseType(s);
    params.push({ name, type });
  }
  expect(s, ")");
  return params;
};

// --- Expressions (precedence climbing) ---
// Precedence (low to high):
//   ternary: cond ? then : else
//   comparison: == != < > <= >=
//   additive: + -
//   multiplicative: * / %
//   unary: -
//   postfix: .field, (call)
//   primary: literals, references, arrays, objects

const parseExpr = (s: ParserState): Value => parseTernary(s);

const parseTernary = (s: ParserState): Value => {
  const condition = parseComparison(s);
  if (peek(s).kind !== "?") return condition;
  advance(s);
  const then = parseExpr(s);
  expect(s, ":");
  const elseVal = parseExpr(s);
  return { kind: "ternary", condition, then, else: elseVal };
};

const comparisonOps: ReadonlySet<string> = new Set(["==", "!=", "<", ">", "<=", ">="]);

const parseComparison = (s: ParserState): Value => {
  let left = parseAdditive(s);
  while (comparisonOps.has(peek(s).kind)) {
    const op = advance(s).kind as BinaryOp;
    const right = parseAdditive(s);
    left = { kind: "binary_op", op, left, right };
  }
  return left;
};

const parseAdditive = (s: ParserState): Value => {
  let left = parseMultiplicative(s);
  while (peek(s).kind === "+" || peek(s).kind === "-") {
    const op = advance(s).kind as BinaryOp;
    const right = parseMultiplicative(s);
    left = { kind: "binary_op", op, left, right };
  }
  return left;
};

const parseMultiplicative = (s: ParserState): Value => {
  let left = parseUnary(s);
  while (peek(s).kind === "*" || peek(s).kind === "/" || peek(s).kind === "%") {
    const op = advance(s).kind as BinaryOp;
    const right = parseUnary(s);
    left = { kind: "binary_op", op, left, right };
  }
  return left;
};

const parseUnary = (s: ParserState): Value => {
  if (peek(s).kind === "-") {
    advance(s);
    const operand = parseUnary(s);
    return { kind: "unary_op", op: "-", operand };
  }
  return parsePostfix(s);
};

const parsePostfix = (s: ParserState): Value => {
  let base = parsePrimary(s);
  while (peek(s).kind === ".") {
    advance(s);
    const field = expect(s, "ident").value;
    base = { kind: "dot_access", base, field };
  }
  return base;
};

const parseObjectFields = (s: ParserState): ReadonlyArray<{ key: string; value: Value }> => {
  expect(s, "{");
  const fields: Array<{ key: string; value: Value }> = [];
  while (peek(s).kind !== "}") {
    if (fields.length > 0) expect(s, ",");
    const keyTok = peek(s);
    const key = keyTok.kind === "string"
      ? advance(s).value
      : expect(s, "ident").value;
    if (peek(s).kind === ":") {
      advance(s);
      fields.push({ key, value: parseExpr(s) });
    } else {
      fields.push({ key, value: { kind: "reference", name: key } });
    }
  }
  expect(s, "}");
  return fields;
};

const parsePrimary = (s: ParserState): Value => {
  const tok = peek(s);
  if (tok.kind === "string") {
    advance(s);
    return { kind: "string", value: tok.value };
  }
  if (tok.kind === "number") {
    advance(s);
    return { kind: "number", value: Number(tok.value) };
  }
  if (tok.kind === "true") {
    advance(s);
    return { kind: "boolean", value: true };
  }
  if (tok.kind === "false") {
    advance(s);
    return { kind: "boolean", value: false };
  }
  if (tok.kind === "[") {
    advance(s);
    const elements: Value[] = [];
    while (peek(s).kind !== "]") {
      if (elements.length > 0) expect(s, ",");
      elements.push(parseExpr(s));
    }
    expect(s, "]");
    return { kind: "array", elements };
  }
  if (tok.kind === "{") {
    const fields = parseObjectFields(s);
    return { kind: "object", fields };
  }
  if (tok.kind === "(") {
    advance(s);
    const inner = parseExpr(s);
    expect(s, ")");
    return inner;
  }
  if (tok.kind === "ident") {
    advance(s);
    // op call: ident({ ... }) or ident()
    if (peek(s).kind === "(") {
      advance(s);
      if (peek(s).kind === "{") {
        const args = parseObjectFields(s);
        expect(s, ")");
        return { kind: "call", op: tok.value, args };
      }
      expect(s, ")");
      return { kind: "call", op: tok.value, args: [] };
    }
    return { kind: "reference", name: tok.value };
  }
  throw new Error(
    `Unexpected token '${tok.kind}' ("${tok.value}") at ${tok.line}:${tok.col}`,
  );
};

// --- Statements ---

const parseBlock = (s: ParserState): readonly Statement[] => {
  expect(s, "{");
  const stmts: Statement[] = [];
  while (peek(s).kind !== "}") {
    const stmt = parseStatement(s);
    if (stmt === null) break;
    stmts.push(stmt);
  }
  expect(s, "}");
  return stmts;
};

const parseStatement = (s: ParserState): Statement | null => {
  const tok = peek(s);
  if (tok.kind === "return" || tok.kind === "}" || tok.kind === "eof") {
    return null;
  }
  if (tok.kind === "if") {
    advance(s);
    const condition = parseExpr(s);
    const then = parseBlock(s);
    const elseBody = peek(s).kind === "else" ? (advance(s), parseBlock(s)) : null;
    return { kind: "if_else", condition, then, else: elseBody };
  }
  if (tok.kind !== "ident") {
    throw new Error(
      `Expected identifier or 'return' at ${tok.line}:${tok.col}, got '${tok.kind}'`,
    );
  }
  const name = advance(s);
  // assignment: name = expr
  if (peek(s).kind === "=") {
    advance(s);
    const value = parseExpr(s);
    return { kind: "assignment", name: name.value, value };
  }
  // void call: opCall({ ... }) or opCall()
  if (peek(s).kind === "(") {
    advance(s);
    if (peek(s).kind === "{") {
      const args = parseObjectFields(s);
      expect(s, ")");
      return { kind: "void_call", call: { op: name.value, args } };
    }
    expect(s, ")");
    return { kind: "void_call", call: { op: name.value, args: [] } };
  }
  throw new Error(
    `Expected '=' or '(' after '${name.value}' at ${name.line}:${name.col}`,
  );
};

// --- Imports ---

const parseImportDecl = (s: ParserState): ImportDecl => {
  expect(s, "import");
  const name = expect(s, "ident").value;
  const alias = peek(s).kind === "as" ? (advance(s), expect(s, "ident").value) : null;
  expect(s, "from");
  const source = expect(s, "string").value;
  expect(s, "perms");
  const perms = parseExpr(s);
  expect(s, "hash");
  const hash = expect(s, "string").value;
  return { name, alias, source, perms, hash };
};

// --- Functions & Program ---

const parseFnBody = (
  s: ParserState,
): { body: readonly Statement[]; returnValue: Value } => {
  expect(s, "{");
  const body: Statement[] = [];
  while (true) {
    const stmt = parseStatement(s);
    if (stmt === null) break;
    body.push(stmt);
  }
  expect(s, "return");
  const returnValue = parseExpr(s);
  expect(s, "}");
  return { body, returnValue };
};

const parseFnDef = (s: ParserState): FnDef => {
  const name = expect(s, "ident").value;
  expect(s, "=");
  const params = parseParams(s);
  const returnType = peek(s).kind === ":" ? (advance(s), parseType(s)) : null;
  expect(s, "=>");
  const { body, returnValue } = parseFnBody(s);
  return { name, params, body, returnValue, returnType };
};

export const parse = (tokens: readonly Token[]): Program => {
  const s: ParserState = { tokens, pos: 0 };
  const imports: ImportDecl[] = [];
  while (peek(s).kind === "import") {
    imports.push(parseImportDecl(s));
  }
  const functions: FnDef[] = [];
  while (peek(s).kind !== "eof") {
    functions.push(parseFnDef(s));
  }
  return { imports, functions };
};
