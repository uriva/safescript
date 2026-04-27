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
  readonly unaryFields: ReadonlyMap<string, string>;
  readonly userFns: ReadonlyMap<string, readonly string[]>;
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
      const name = expectFieldName(s);
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

const comparisonOps: ReadonlySet<string> = new Set([
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
]);

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
  if (peek(s).kind === "!") {
    advance(s);
    const operand = parseUnary(s);
    return { kind: "unary_op", op: "!", operand };
  }
  return parsePostfix(s);
};

const expectFieldName = (s: ParserState): string => {
  const tok = advance(s);
  if (
    tok.kind === "ident" || tok.kind === "hash" || tok.kind === "return" ||
    tok.kind === "true" || tok.kind === "false" || tok.kind === "if" ||
    tok.kind === "else" || tok.kind === "import" || tok.kind === "from" ||
    tok.kind === "as" || tok.kind === "perms" || tok.kind === "map" ||
    tok.kind === "filter" || tok.kind === "reduce"
  ) {
    return tok.value;
  }
  throw new Error(
    `Expected field name but got '${tok.kind}' ("${tok.value}") at ${tok.line}:${tok.col}`,
  );
};

const parsePostfix = (s: ParserState): Value => {
  let base = parsePrimary(s);
  while (peek(s).kind === "." || peek(s).kind === "[") {
    if (peek(s).kind === ".") {
      advance(s);
      const field = expectFieldName(s);
      base = { kind: "dot_access", base, field };
    } else {
      advance(s);
      const index = parseExpr(s);
      expect(s, "]");
      base = { kind: "index_access", base, index };
    }
  }
  return base;
};

const parseObjectFields = (
  s: ParserState,
): ReadonlyArray<{ key: string; value: Value }> => {
  expect(s, "{");
  const fields: Array<{ key: string; value: Value }> = [];
  while (peek(s).kind !== "}") {
    if (fields.length > 0) expect(s, ",");
    const keyTok = peek(s);
    const key = keyTok.kind === "string"
      ? advance(s).value
      : expectFieldName(s);
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

const parseUserCallArgs = (
  s: ParserState,
  nameTok: Token,
  params: readonly string[],
): Value => {
  // Zero args.
  if (peek(s).kind === ")") {
    advance(s);
    if (params.length !== 0) {
      throw new Error(
        `Function '${nameTok.value}' expects ${params.length} argument(s), got 0 at ${nameTok.line}:${nameTok.col}`,
      );
    }
    return { kind: "user_call", fn: nameTok.value, args: [] };
  }
  // Named args: fn({ key: value, ... }).
  // Detect by looking at `{` followed by `ident :` or `string :` or `}`.
  if (peek(s).kind === "{") {
    const saved = s.pos;
    advance(s);
    const firstInner = peek(s);
    const secondInner = s.tokens[s.pos + 1];
    const looksLikeNamedArgs = firstInner.kind === "}" ||
      ((firstInner.kind === "ident" || firstInner.kind === "string") &&
        secondInner?.kind === ":");
    s.pos = saved;
    if (looksLikeNamedArgs) {
      const args = parseObjectFields(s);
      expect(s, ")");
      return { kind: "user_call", fn: nameTok.value, args };
    }
  }
  // Positional args: fn(a, b, c). Bind to params by position.
  const positional: Value[] = [parseExpr(s)];
  while (peek(s).kind === ",") {
    advance(s);
    positional.push(parseExpr(s));
  }
  expect(s, ")");
  if (positional.length !== params.length) {
    throw new Error(
      `Function '${nameTok.value}' expects ${params.length} argument(s), got ${positional.length} at ${nameTok.line}:${nameTok.col}`,
    );
  }
  return {
    kind: "user_call",
    fn: nameTok.value,
    args: positional.map((value, i) => ({ key: params[i], value })),
  };
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
  if (tok.kind === "map" || tok.kind === "filter") {
    advance(s);
    expect(s, "(");
    const fn = parseExpr(s);
    expect(s, ",");
    const array = parseExpr(s);
    expect(s, ")");
    return { kind: tok.kind, fn, array };
  }
  if (tok.kind === "reduce") {
    advance(s);
    expect(s, "(");
    const fn = parseExpr(s);
    expect(s, ",");
    const initial = parseExpr(s);
    expect(s, ",");
    const array = parseExpr(s);
    expect(s, ")");
    return { kind: "reduce", fn, initial, array };
  }
  if (tok.kind === "ident") {
    advance(s);
    // Function call: either a user-declared function or a builtin op.
    if (peek(s).kind === "(") {
      // override(target, { key: replName, ... }) — special form, parsed
      // before generic call dispatch so the second arg's `{...}` is treated
      // as a replacement map of identifiers (not arbitrary value exprs).
      if (tok.value === "override") {
        advance(s); // consume '('
        const targetTok = expect(s, "ident");
        if (!s.userFns.has(targetTok.value)) {
          throw new Error(
            `override target '${targetTok.value}' is not a user function at ${targetTok.line}:${targetTok.col}`,
          );
        }
        expect(s, ",");
        expect(s, "{");
        const replacements: Array<{ key: string; value: string }> = [];
        const seenKeys = new Set<string>();
        while (peek(s).kind !== "}") {
          if (replacements.length > 0) expect(s, ",");
          const keyTok = peek(s);
          const key = keyTok.kind === "string"
            ? advance(s).value
            : expectFieldName(s);
          if (seenKeys.has(key)) {
            throw new Error(
              `Duplicate replacement key '${key}' in override at ${keyTok.line}:${keyTok.col}`,
            );
          }
          seenKeys.add(key);
          expect(s, ":");
          const valTok = expect(s, "ident");
          if (!s.userFns.has(valTok.value)) {
            throw new Error(
              `override replacement '${valTok.value}' is not a user function at ${valTok.line}:${valTok.col}`,
            );
          }
          if (valTok.value === targetTok.value) {
            throw new Error(
              `override cannot self-reference target '${targetTok.value}' at ${valTok.line}:${valTok.col}`,
            );
          }
          replacements.push({ key, value: valTok.value });
        }
        expect(s, "}");
        expect(s, ")");
        if (replacements.length === 0) {
          throw new Error(
            `override requires at least one replacement at ${tok.line}:${tok.col}`,
          );
        }
        const overrideValue: Value = {
          kind: "override",
          target: targetTok.value,
          replacements,
        };
        // Direct invocation: override(...)(arg1: ..., arg2: ...). Reuse
        // user-call arg parsing against the target's params; the rewritten
        // Dag has the same param list as the original target.
        if (peek(s).kind === "(") {
          advance(s); // consume '('
          const targetParams = s.userFns.get(targetTok.value)!;
          const callValue = parseUserCallArgs(s, targetTok, targetParams);
          // parseUserCallArgs returned `user_call`; swap into dag_call.
          if (callValue.kind !== "user_call") {
            throw new Error("internal: parseUserCallArgs returned non user_call");
          }
          return { kind: "dag_call", fn: overrideValue, args: callValue.args };
        }
        return overrideValue;
      }
      advance(s);
      const userParams = s.userFns.get(tok.value);
      if (userParams) {
        return parseUserCallArgs(s, tok, userParams);
      }
      if (peek(s).kind === "{") {
        const args = parseObjectFields(s);
        expect(s, ")");
        return { kind: "call", op: tok.value, args };
      }
      if (peek(s).kind === ")") {
        advance(s);
        return { kind: "call", op: tok.value, args: [] };
      }
      // unary call sugar: op(expr) → op({ field: expr })
      const fieldName = s.unaryFields.get(tok.value);
      if (!fieldName) {
        throw new Error(
          `Op '${tok.value}' does not support unary call syntax at ${tok.line}:${tok.col}`,
        );
      }
      const value = parseExpr(s);
      expect(s, ")");
      return { kind: "call", op: tok.value, args: [{ key: fieldName, value }] };
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
    const elseBody = peek(s).kind === "else"
      ? (advance(s), parseBlock(s))
      : null;
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
  // Function-call statement (discarded result). Either user-function or op.
  if (peek(s).kind === "(") {
    advance(s);
    const userParams = s.userFns.get(name.value);
    if (userParams) {
      const callValue = parseUserCallArgs(s, name, userParams);
      if (callValue.kind !== "user_call") {
        throw new Error("Internal: expected user_call");
      }
      return {
        kind: "user_void_call",
        fn: callValue.fn,
        args: callValue.args,
      };
    }
    if (peek(s).kind === "{") {
      const args = parseObjectFields(s);
      expect(s, ")");
      return { kind: "void_call", call: { op: name.value, args } };
    }
    if (peek(s).kind === ")") {
      advance(s);
      return { kind: "void_call", call: { op: name.value, args: [] } };
    }
    // unary call sugar: op(expr) → op({ field: expr })
    const fieldName = s.unaryFields.get(name.value);
    if (!fieldName) {
      throw new Error(
        `Op '${name.value}' does not support unary call syntax at ${name.line}:${name.col}`,
      );
    }
    const value = parseExpr(s);
    expect(s, ")");
    return {
      kind: "void_call",
      call: { op: name.value, args: [{ key: fieldName, value }] },
    };
  }
  throw new Error(
    `Expected '=' or '(' after '${name.value}' at ${name.line}:${name.col}`,
  );
};

// --- Imports ---

const parseImportDecl = (s: ParserState): ImportDecl => {
  expect(s, "import");
  const name = expect(s, "ident").value;
  const alias = peek(s).kind === "as"
    ? (advance(s), expect(s, "ident").value)
    : null;
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

// --- Cycle detection ---

const collectFnRefs = (value: Value): ReadonlySet<string> => {
  const refs = new Set<string>();
  const walk = (v: Value): void => {
    switch (v.kind) {
      case "map":
      case "filter":
        walk(v.fn);
        walk(v.array);
        break;
      case "reduce":
        walk(v.fn);
        walk(v.initial);
        walk(v.array);
        break;
      case "array":
        v.elements.forEach(walk);
        break;
      case "object":
        v.fields.forEach((f) => walk(f.value));
        break;
      case "binary_op":
        walk(v.left);
        walk(v.right);
        break;
      case "unary_op":
        walk(v.operand);
        break;
      case "ternary":
        walk(v.condition);
        walk(v.then);
        walk(v.else);
        break;
      case "dot_access":
        walk(v.base);
        break;
      case "index_access":
        walk(v.base);
        walk(v.index);
        break;
      case "call":
        v.args.forEach((a) => walk(a.value));
        break;
      case "user_call":
        refs.add(v.fn);
        v.args.forEach((a) => walk(a.value));
        break;
      case "reference":
        // A bare reference may name a user fn (e.g. `map(myFn, xs)`). The
        // cycle checker treats it as a potential fn-ref; harmless if it's
        // actually a local var.
        refs.add(v.name);
        break;
      case "override":
        refs.add(v.target);
        for (const r of v.replacements) refs.add(r.value);
        break;
      case "dag_call":
        walk(v.fn);
        v.args.forEach((a) => walk(a.value));
        break;
    }
  };
  walk(value);
  return refs;
};

const collectFnRefsFromStmts = (
  stmts: readonly Statement[],
): ReadonlySet<string> => {
  const refs = new Set<string>();
  const addAll = (s: ReadonlySet<string>) => {
    for (const r of s) refs.add(r);
  };
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "assignment":
        addAll(collectFnRefs(stmt.value));
        break;
      case "void_call":
        stmt.call.args.forEach((a) => addAll(collectFnRefs(a.value)));
        break;
      case "user_void_call":
        refs.add(stmt.fn);
        stmt.args.forEach((a) => addAll(collectFnRefs(a.value)));
        break;
      case "if_else":
        addAll(collectFnRefs(stmt.condition));
        addAll(collectFnRefsFromStmts(stmt.then));
        if (stmt.else) addAll(collectFnRefsFromStmts(stmt.else));
        break;
    }
  }
  return refs;
};

const checkFnCallCycles = (functions: readonly FnDef[]): void => {
  const fnNames = new Set(functions.map((f) => f.name));
  const graph = new Map<string, ReadonlySet<string>>();
  for (const fn of functions) {
    const bodyRefs = collectFnRefsFromStmts(fn.body);
    const returnRefs = collectFnRefs(fn.returnValue);
    const allRefs = new Set<string>();
    for (const r of bodyRefs) if (fnNames.has(r)) allRefs.add(r);
    for (const r of returnRefs) if (fnNames.has(r)) allRefs.add(r);
    graph.set(fn.name, allRefs);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const dfs = (name: string, path: string[]): void => {
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new Error(
        `Recursive function call cycle detected: ${cycle.join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;
    visiting.add(name);
    path.push(name);
    for (const dep of graph.get(name) ?? []) {
      dfs(dep, path);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const fn of functions) {
    dfs(fn.name, []);
  }
};

// Scan tokens for function declarations (ident = (param: type, ...) => ...)
// without advancing the real parser. Returns map of fn name → param names in order.
const collectUserFunctions = (
  tokens: readonly Token[],
): ReadonlyMap<string, readonly string[]> => {
  const fns = new Map<string, readonly string[]>();
  let i = 0;
  // Skip imports
  while (i < tokens.length && tokens[i].kind === "import") {
    while (i < tokens.length && tokens[i].kind !== "hash") i++;
    if (i < tokens.length) i++; // hash keyword
    if (i < tokens.length && tokens[i].kind === "string") i++; // hash value
  }
  while (i < tokens.length && tokens[i].kind !== "eof") {
    if (tokens[i].kind !== "ident") {
      i++;
      continue;
    }
    const name = tokens[i].value;
    if (tokens[i + 1]?.kind !== "=" || tokens[i + 2]?.kind !== "(") {
      i++;
      continue;
    }
    // Collect param names at depth 1 of the param parens
    let j = i + 3;
    const params: string[] = [];
    let depth = 1;
    let expectName = true;
    while (j < tokens.length && depth > 0) {
      const tok = tokens[j];
      if (tok.kind === "(" || tok.kind === "{" || tok.kind === "[") depth++;
      else if (tok.kind === ")" || tok.kind === "}" || tok.kind === "]") {
        depth--;
      } else if (depth === 1 && tok.kind === "," && !expectName) {
        expectName = true;
      } else if (depth === 1 && expectName && tok.kind === "ident") {
        params.push(tok.value);
        expectName = false;
      }
      j++;
    }
    fns.set(name, params);
    i = j;
  }
  return fns;
};

export const parse = (
  tokens: readonly Token[],
  unaryFields: ReadonlyMap<string, string> = new Map(),
): Program => {
  const userFns = collectUserFunctions(tokens);
  const s: ParserState = { tokens, pos: 0, unaryFields, userFns };
  const imports: ImportDecl[] = [];
  while (peek(s).kind === "import") {
    imports.push(parseImportDecl(s));
  }
  const functions: FnDef[] = [];
  while (peek(s).kind !== "eof") {
    functions.push(parseFnDef(s));
  }
  checkFnCallCycles(functions);
  return { imports, functions };
};
