import type { Token, TokenKind } from "./lexer.ts";
import type {
  BinaryOp,
  DefaultValue,
  FnDef,
  ImportDecl,
  Param,
  Program,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";

type UserFnMeta = {
  readonly names: readonly string[];
  readonly hasDefaults: boolean;
};

type ParserState = {
  readonly tokens: readonly Token[];
  readonly unaryFields: ReadonlyMap<string, string>;
  readonly userFns: ReadonlyMap<string, UserFnMeta>;
  // Names that refer to runtime values inside the current fn body — params
  // and assignments. Tracked so `localName(args)` can be parsed as a Dag
  // application (`dag_call` with a reference fn) instead of a builtin op.
  // Populated and reset per FnDef.
  locals: Set<string>;
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

const parseLiteralValue = (s: ParserState): DefaultValue => {
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
  throw new Error(
    `Expected literal default value at ${tok.line}:${tok.col}, got '${tok.kind}'`,
  );
};

const parseParams = (s: ParserState): readonly Param[] => {
  expect(s, "(");
  const params: Param[] = [];
  while (peek(s).kind !== ")") {
    if (params.length > 0) expect(s, ",");
    const name = expect(s, "ident").value;
    const type = peek(s).kind === ":"
      ? (advance(s), parseType(s))
      : { kind: "primitive" as const, name: "inferred" as const };
    const defaultValue = peek(s).kind === "="
      ? (advance(s), parseLiteralValue(s))
      : undefined;
    params.push({ name, type, defaultValue });
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
  meta: UserFnMeta,
): Value => {
  const params = meta.names;
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
        (secondInner?.kind === ":" || secondInner?.kind === "}" ||
          secondInner?.kind === ","));
    s.pos = saved;
    if (looksLikeNamedArgs) {
      const args = parseObjectFields(s);
      expect(s, ")");
      return { kind: "user_call", fn: nameTok.value, args };
    }
  }
  // Positional args: fn(a, b, c). Bind to params by position.
  if (meta.hasDefaults) {
    throw new Error(
      `Function '${nameTok.value}' has default parameters and must be called with named arguments at ${nameTok.line}:${nameTok.col}`,
    );
  }
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

const parseNormalCallArgs = (
  s: ParserState,
): Array<{ key: string; value: Value }> => {
  const args: Array<{ key: string; value: Value }> = [];
  if (peek(s).kind !== ")") {
    const v = parseExpr(s);
    args.push({ key: "__arg0", value: v });
    let i = 1;
    while (peek(s).kind === ",") {
      advance(s);
      const nextV = parseExpr(s);
      args.push({ key: `__arg${i}`, value: nextV });
      i++;
    }
  }
  expect(s, ")");
  return args;
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
          const targetParams = s.userFns.get(targetTok.value);
          if (targetParams) {
            const callValue = parseUserCallArgs(s, targetTok, targetParams);
            if (callValue.kind !== "user_call") {
              throw new Error(
                "internal: parseUserCallArgs returned non user_call",
              );
            }
            return {
              kind: "dag_call",
              fn: overrideValue,
              args: callValue.args,
            };
          }
          const callArgs = parseNormalCallArgs(s);
          return { kind: "dag_call", fn: overrideValue, args: callArgs };
        }
        return overrideValue;
      }
      advance(s);
      const userMeta = s.userFns.get(tok.value);
      if (userMeta) {
        return parseUserCallArgs(s, tok, userMeta);
      }
      // Local-bound Dag invocation: `localName({k: v})` or `localName()`.
      // Lower to dag_call with a `reference` fn so the graph builder emits
      // an `apply` node that resolves the Dag at runtime.
      if (s.locals.has(tok.value)) {
        const args = peek(s).kind === ")"
          ? (advance(s), [])
          : peek(s).kind === "{"
          ? (() => {
            const a = parseObjectFields(s);
            expect(s, ")");
            return a;
          })()
          : (() => {
            throw new Error(
              `Local '${tok.value}' invocation requires named-args form '{k: v}' at ${tok.line}:${tok.col}`,
            );
          })();
        return {
          kind: "dag_call",
          fn: { kind: "reference", name: tok.value },
          args,
        };
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
    while (peek(s).kind === ";") advance(s);
    if (peek(s).kind === "}") break;
    const stmt = parseStatement(s);
    if (stmt === null) break;
    stmts.push(stmt);
    while (peek(s).kind === ";") advance(s);
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
    s.locals.add(name.value);
    return { kind: "assignment", name: name.value, value };
  }
  // Function-call statement (discarded result). Either user-function or op.
  if (peek(s).kind === "(") {
    advance(s);
    const userMeta = s.userFns.get(name.value);
    if (userMeta) {
      const callValue = parseUserCallArgs(s, name, userMeta);
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
  const names: string[] = [];
  if (peek(s).kind === "{") {
    advance(s);
    names.push(expect(s, "ident").value);
    while (peek(s).kind === ",") {
      advance(s);
      names.push(expect(s, "ident").value);
    }
    expect(s, "}");
  } else {
    const name = expect(s, "ident").value;
    if (peek(s).kind === "as") {
      advance(s);
      names.push(expect(s, "ident").value);
    } else {
      names.push(name);
    }
  }
  expect(s, "from");
  const source = expect(s, "string").value;
  const perms = peek(s).kind === "perms"
    ? (advance(s), parseExpr(s))
    : undefined;
  const hash = peek(s).kind === "hash"
    ? (advance(s), expect(s, "string").value)
    : undefined;
  return { names, source, perms, hash };
};

// --- Functions & Program ---

const parseFnBody = (
  s: ParserState,
): { body: readonly Statement[]; returnValue: Value } => {
  expect(s, "{");
  const stmts: Statement[] = [];
  let returnValue: Value | null = null;
  while (peek(s).kind !== "}" && peek(s).kind !== "eof") {
    while (peek(s).kind === ";") advance(s);
    if (peek(s).kind === "}") break;
    if (peek(s).kind === "return") {
      advance(s);
      returnValue = parseExpr(s);
      stmts.push({ kind: "return", value: returnValue });
    } else {
      const stmt = parseStatement(s);
      if (stmt === null) break;
      stmts.push(stmt);
    }
    while (peek(s).kind === ";") advance(s);
  }
  expect(s, "}");
  if (!returnValue) {
    throw new Error("Function body must include a return statement");
  }
  return { body: stmts, returnValue };
};

const parseFnDef = (s: ParserState): FnDef => {
  const name = expect(s, "ident").value;
  expect(s, "=");
  const params = parseParams(s);
  const returnType = peek(s).kind === ":" ? (advance(s), parseType(s)) : null;
  expect(s, "=>");
  // Reset locals for this fn; seed with params so they're not mistaken for
  // builtin ops on `paramName(args)` invocation.
  s.locals = new Set(params.map((p) => p.name));
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
        if (v.op === "doc") break;
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
        if (stmt.call.op === "doc") break;
        stmt.call.args.forEach((a) => addAll(collectFnRefs(a.value)));
        break;
      case "user_void_call":
        refs.add(stmt.fn);
        stmt.args.forEach((a) => addAll(collectFnRefs(a.value)));
        break;
      case "return":
        addAll(collectFnRefs(stmt.value));
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

const collectImportedFunctions = (
  imports: readonly ImportDecl[],
): ReadonlyMap<string, UserFnMeta> =>
  new Map(
    imports.map(({ names }) => [names[0]!, { names: [], hasDefaults: false }]),
  );

// Scan tokens for function declarations (ident = (param: type, ...) => ...)
// without advancing the real parser. Returns map of fn name → param metadata.
const collectUserFunctions = (
  tokens: readonly Token[],
  imports: readonly ImportDecl[],
): ReadonlyMap<string, UserFnMeta> => {
  const fns = new Map<string, UserFnMeta>(
    collectImportedFunctions(imports),
  );
  let i = 0;
  // Skip imports
  while (i < tokens.length && tokens[i].kind === "import") {
    i++;
    while (i < tokens.length && tokens[i].kind !== "string") i++;
    if (i < tokens.length) i++; // source string
    // optional perms
    if (i < tokens.length && tokens[i].kind === "perms") {
      i++;
      while (
        i < tokens.length && tokens[i].kind !== "hash" &&
        tokens[i].kind !== "ident" && tokens[i].kind !== "="
      ) i++;
    }
    // optional hash
    if (i < tokens.length && tokens[i].kind === "hash") {
      i++;
      if (i < tokens.length && tokens[i].kind === "string") i++;
    }
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
    // Collect param names and detect defaults at depth 1 of the param parens
    let j = i + 3;
    const params: string[] = [];
    let depth = 1;
    let expectName = true;
    let hasDefaults = false;
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
      } else if (depth === 1 && tok.kind === "=" && !expectName) {
        hasDefaults = true;
      }
      j++;
    }
    fns.set(name, { names: params, hasDefaults });
    i = j;
  }
  return fns;
};

const valueToTargetString = (v: Value): string | undefined => {
  if (v.kind === "reference") return v.name;
  if (v.kind === "dot_access") {
    const baseStr = valueToTargetString(v.base);
    return baseStr ? `${baseStr}.${v.field}` : undefined;
  }
  return undefined;
};

export const parse = (
  tokens: readonly Token[],
  unaryFields: ReadonlyMap<string, string> = new Map(),
): Program => {
  const importParserState: ParserState = {
    tokens,
    pos: 0,
    unaryFields,
    userFns: new Map(),
    locals: new Set(),
  };
  const importDecls: ImportDecl[] = [];
  while (peek(importParserState).kind === "import") {
    importDecls.push(parseImportDecl(importParserState));
    while (peek(importParserState).kind === ";") advance(importParserState);
  }
  const userFns = collectUserFunctions(tokens, importDecls);
  const s: ParserState = {
    tokens,
    pos: 0,
    unaryFields,
    userFns,
    locals: new Set(),
  };
  const imports: ImportDecl[] = [];
  while (peek(s).kind === "import") {
    imports.push(parseImportDecl(s));
    while (peek(s).kind === ";") advance(s);
  }
  const docs: { target?: string; text: string }[] = [];
  const functions: FnDef[] = [];
  while (peek(s).kind !== "eof") {
    while (peek(s).kind === ";") advance(s);
    if (peek(s).kind === "eof") break;
    if (peek(s).kind === "ident") {
      const start = s.pos;
      const name = advance(s);
      if (name.value === "doc" && peek(s).kind === "(") {
        advance(s);
        const args = parseObjectFields(s);
        expect(s, ")");
        const targetArg = args.find((a) => a.key === "target");
        const textArg = args.find((a) => a.key === "text");
        const target = targetArg ? valueToTargetString(targetArg.value) : undefined;
        if (textArg && textArg.value.kind === "string") {
          docs.push({ target, text: textArg.value.value });
        }
        continue;
      }
      s.pos = start;
    }
    functions.push(parseFnDef(s));
  }
  checkFnCallCycles(functions);
  const program = { imports, functions, docs };
  inferTypes(program);
  return program;
};

const tStr: TypeExpr = { kind: "primitive", name: "string" };
const tNum: TypeExpr = { kind: "primitive", name: "number" };
const tBool: TypeExpr = { kind: "primitive", name: "boolean" };
const tInf = (): TypeExpr => ({ kind: "primitive", name: "inferred" });
const tArr = (el: TypeExpr): TypeExpr => ({ kind: "array", element: el });
const tObj = (fields: Array<{ name: string; type: TypeExpr }>): TypeExpr => ({ kind: "object", fields });

const BUILTIN_SIGNATURES: Record<string, { params: Record<string, TypeExpr>; returnType: TypeExpr }> = {
  jsonParse: { params: { text: tStr }, returnType: tInf() },
  jsonStringify: { params: { value: tInf() }, returnType: tStr },
  buildMultipartBody: { params: { fields: tInf(), files: tInf() }, returnType: tInf() },
  stringConcat: { params: { parts: tArr(tStr) }, returnType: tStr },
  stringIncludes: { params: { haystack: tStr, needle: tStr }, returnType: tBool },
  stringReplace: { params: { haystack: tStr, needle: tStr, replacement: tStr, all: tBool }, returnType: tObj([{ name: "result", type: tStr }, { name: "count", type: tNum }]) },
  stringRegex: { params: { haystack: tStr, regex: tStr }, returnType: tObj([{ name: "match", type: tBool }, { name: "groups", type: tArr(tStr) }]) },
  stringSplit: { params: { haystack: tStr, delimiter: tStr }, returnType: tArr(tStr) },
  stringLower: { params: { text: tStr }, returnType: tStr },
  urlEncode: { params: { text: tStr }, returnType: tStr },
  base64urlEncode: { params: { text: tStr }, returnType: tStr },
  base64urlDecode: { params: { encoded: tStr }, returnType: tStr },
  pick: { params: { obj: tInf(), keys: tArr(tStr) }, returnType: tInf() },
  arrayAppend: { params: { array: tArr(tInf()), element: tInf() }, returnType: tArr(tInf()) },
  assert: { params: { condition: tBool, message: tStr }, returnType: tBool },
  doc: { params: { value: tInf() }, returnType: tInf() },
  merge: { params: { a: tObj([]), b: tObj([]) }, returnType: tInf() },
  sha256: { params: { data: tStr }, returnType: tStr },
  generateEd25519KeyPair: { params: {}, returnType: tObj([{ name: "publicKey", type: tStr }, { name: "privateKey", type: tStr }]) },
  generateX25519KeyPair: { params: {}, returnType: tObj([{ name: "publicKey", type: tStr }, { name: "privateKey", type: tStr }]) },
  ed25519PublicFromPrivate: { params: { privateKey: tStr }, returnType: tStr },
  x25519PublicFromPrivate: { params: { privateKey: tStr }, returnType: tStr },
  ed25519Sign: { params: { data: tStr, privateKey: tStr }, returnType: tStr },
  aesGenerateKey: { params: {}, returnType: tStr },
  aesEncrypt: { params: { plaintext: tStr, key: tStr }, returnType: tObj([{ name: "ciphertext", type: tStr }, { name: "iv", type: tStr }]) },
  aesDecrypt: { params: { ciphertext: tStr, iv: tStr, key: tStr }, returnType: tStr },
  x25519DeriveKey: { params: { myPrivateKey: tStr, theirPublicKey: tStr, salt: tStr, info: tStr }, returnType: tStr },
  httpRequest: { params: { host: tStr, method: tStr, path: tStr, headers: tObj([]), body: tStr, timeout: tNum, subdomain: tStr }, returnType: tObj([{ name: "status", type: tNum }, { name: "body", type: tStr }]) },
  timestamp: { params: {}, returnType: tNum },
  randomBytes: { params: { length: tNum }, returnType: tStr },
};

const inferTypes = (program: Program): void => {
  const resolvedTypes = new Map<TypeExpr, TypeExpr>();
  const nodeDescriptions = new Map<TypeExpr, string>();

  const resolve = (t: TypeExpr): TypeExpr => {
    const next = resolvedTypes.get(t);
    if (next) {
      const res = resolve(next);
      if (res !== next) resolvedTypes.set(t, res);
      return res;
    }
    return t;
  };

  const unify = (t1: TypeExpr, t2: TypeExpr): void => {
    const r1 = resolve(t1);
    const r2 = resolve(t2);
    if (r1 === r2) return;

    if (r1.kind === "primitive" && r1.name === "inferred") {
      resolvedTypes.set(r1, r2);
      return;
    }
    if (r2.kind === "primitive" && r2.name === "inferred") {
      resolvedTypes.set(r2, r1);
      return;
    }

    if (r1.kind === "primitive" && r2.kind === "primitive") {
      return;
    }

    if (r1.kind === "array" && r2.kind === "array") {
      unify(r1.element, r2.element);
      return;
    }

    if (r1.kind === "object" && r2.kind === "object") {
      const fields2 = new Map(r2.fields.map(f => [f.name, f.type]));
      for (const f1 of r1.fields) {
        const f2Type = fields2.get(f1.name);
        if (f2Type) {
          unify(f1.type, f2Type);
        }
      }
      return;
    }
  };

  const resolveDeep = (t: TypeExpr): TypeExpr => {
    const r = resolve(t);
    if (r.kind === "primitive") {
      if (r.name === "inferred") {
        return { kind: "primitive", name: "string" };
      }
      return r;
    }
    if (r.kind === "array") {
      return { kind: "array", element: resolveDeep(r.element) };
    }
    if (r.kind === "object") {
      return {
        kind: "object",
        fields: r.fields.map(f => ({ name: f.name, type: resolveDeep(f.type) }))
      };
    }
    return r;
  };

  const fnsMap = new Map(program.functions.map(f => [f.name, f]));

  const findFn = (v: Value): FnDef | undefined => {
    if (v.kind === "reference") return fnsMap.get(v.name);
    if (v.kind === "override") return fnsMap.get(v.target);
    return undefined;
  };

  const constrain = (expr: Value, expectedType: TypeExpr, locals: Map<string, TypeExpr>): void => {
    switch (expr.kind) {
      case "string":
        unify(expectedType, { kind: "primitive", name: "string" });
        break;
      case "number":
        unify(expectedType, { kind: "primitive", name: "number" });
        break;
      case "boolean":
        unify(expectedType, { kind: "primitive", name: "boolean" });
        break;
      case "reference": {
        const localType = locals.get(expr.name);
        if (localType) {
          unify(expectedType, localType);
        }
        break;
      }
      case "dot_access": {
        const fieldType = { kind: "primitive" as const, name: "inferred" as const };
        unify(expectedType, fieldType);
        const objType = {
          kind: "object" as const,
          fields: [{ name: expr.field, type: fieldType }]
        };
        constrain(expr.base, objType, locals);
        break;
      }
      case "index_access":
        constrain(expr.index, { kind: "primitive", name: "number" }, locals);
        constrain(expr.base, { kind: "array", element: expectedType }, locals);
        break;
      case "unary_op":
        if (expr.op === "-") {
          unify(expectedType, { kind: "primitive", name: "number" });
          constrain(expr.operand, { kind: "primitive", name: "number" }, locals);
        } else if (expr.op === "!") {
          unify(expectedType, { kind: "primitive", name: "boolean" });
          constrain(expr.operand, { kind: "primitive", name: "boolean" }, locals);
        }
        break;
      case "binary_op":
        if (expr.op === "+") {
          constrain(expr.left, expectedType, locals);
          constrain(expr.right, expectedType, locals);
        } else if (["-", "*", "/", "%"].includes(expr.op)) {
          unify(expectedType, { kind: "primitive", name: "number" });
          constrain(expr.left, { kind: "primitive", name: "number" }, locals);
          constrain(expr.right, { kind: "primitive", name: "number" }, locals);
        } else if (["<", ">", "<=", ">="].includes(expr.op)) {
          unify(expectedType, { kind: "primitive", name: "boolean" });
          constrain(expr.left, { kind: "primitive", name: "number" }, locals);
          constrain(expr.right, { kind: "primitive", name: "number" }, locals);
        } else if (["==", "!="].includes(expr.op)) {
          unify(expectedType, { kind: "primitive", name: "boolean" });
          const opType = { kind: "primitive" as const, name: "inferred" as const };
          constrain(expr.left, opType, locals);
          constrain(expr.right, opType, locals);
        }
        break;
      case "ternary":
        constrain(expr.condition, { kind: "primitive", name: "boolean" }, locals);
        constrain(expr.then, expectedType, locals);
        constrain(expr.else, expectedType, locals);
        break;
      case "array": {
        const elementType = { kind: "primitive" as const, name: "inferred" as const };
        unify(expectedType, { kind: "array", element: elementType });
        for (const e of expr.elements) {
          constrain(e, elementType, locals);
        }
        break;
      }
      case "object": {
        const fields: Array<{ name: string; type: TypeExpr }> = [];
        for (const f of expr.fields) {
          const fType = { kind: "primitive" as const, name: "inferred" as const };
          constrain(f.value, fType, locals);
          fields.push({ name: f.key, type: fType });
        }
        unify(expectedType, { kind: "object", fields });
        break;
      }
      case "call": {
        const sig = BUILTIN_SIGNATURES[expr.op];
        if (sig) {
          unify(expectedType, sig.returnType);
          for (const arg of expr.args) {
            const expectedArgType = sig.params[arg.key];
            if (expectedArgType) {
              constrain(arg.value, expectedArgType, locals);
            }
          }
        }
        break;
      }
      case "user_call": {
        const fn = fnsMap.get(expr.fn);
        if (fn) {
          unify(expectedType, fn.returnType ?? { kind: "primitive", name: "inferred" });
          for (const arg of expr.args) {
            const param = fn.params.find(p => p.name === arg.key);
            if (param) {
              constrain(arg.value, param.type, locals);
            }
          }
        }
        break;
      }
      case "dag_call": {
        const fn = findFn(expr.fn);
        if (fn) {
          unify(expectedType, fn.returnType ?? { kind: "primitive", name: "inferred" });
          for (const arg of expr.args) {
            const param = fn.params.find(p => p.name === arg.key);
            if (param) {
              constrain(arg.value, param.type, locals);
            }
          }
        }
        break;
      }
      case "override": {
        const targetFn = fnsMap.get(expr.target);
        if (targetFn) {
          for (const r of expr.replacements) {
            const replFn = fnsMap.get(r.value);
            if (replFn) {
              for (const rp of replFn.params) {
                const tp = targetFn.params.find(p => p.name === rp.name);
                if (tp) {
                  unify(rp.type, tp.type);
                }
              }
              if (replFn.returnType && targetFn.returnType) {
                unify(replFn.returnType, targetFn.returnType);
              }
            }
          }
        } else {
          const sig = BUILTIN_SIGNATURES[expr.target];
          if (sig) {
            for (const r of expr.replacements) {
              const replFn = fnsMap.get(r.value);
              if (replFn) {
                for (const rp of replFn.params) {
                  const tpType = sig.params[rp.name];
                  if (tpType) {
                    unify(rp.type, tpType);
                  }
                }
                if (replFn.returnType) {
                  unify(replFn.returnType, sig.returnType);
                }
              }
            }
          }
        }
        break;
      }
      case "map": {
        const elementType = { kind: "primitive" as const, name: "inferred" as const };
        constrain(expr.array, { kind: "array", element: elementType }, locals);
        const fnDef = findFn(expr.fn);
        if (fnDef && fnDef.params.length > 0) {
          unify(fnDef.params[0].type, elementType);
          const retType = { kind: "primitive" as const, name: "inferred" as const };
          unify(fnDef.returnType ?? { kind: "primitive", name: "inferred" }, retType);
          unify(expectedType, { kind: "array", element: retType });
        }
        break;
      }
      case "filter": {
        const elementType = { kind: "primitive" as const, name: "inferred" as const };
        constrain(expr.array, { kind: "array", element: elementType }, locals);
        const fnDef = findFn(expr.fn);
        if (fnDef && fnDef.params.length > 0) {
          unify(fnDef.params[0].type, elementType);
          unify(fnDef.returnType ?? { kind: "primitive", name: "inferred" }, { kind: "primitive", name: "boolean" });
        }
        unify(expectedType, { kind: "array", element: elementType });
        break;
      }
      case "reduce": {
        const elementType = { kind: "primitive" as const, name: "inferred" as const };
        constrain(expr.array, { kind: "array", element: elementType }, locals);
        constrain(expr.initial, expectedType, locals);
        const fnDef = findFn(expr.fn);
        if (fnDef && fnDef.params.length >= 2) {
          unify(fnDef.params[0].type, expectedType);
          unify(fnDef.params[1].type, elementType);
          unify(fnDef.returnType ?? { kind: "primitive", name: "inferred" }, expectedType);
        }
        break;
      }
    }
  };

  const constrainStatement = (stmt: Statement, locals: Map<string, TypeExpr>): void => {
    switch (stmt.kind) {
      case "assignment": {
        let t = locals.get(stmt.name);
        if (!t) {
          t = { kind: "primitive", name: "inferred" };
          nodeDescriptions.set(t, `variable '${stmt.name}'`);
          locals.set(stmt.name, t);
        }
        constrain(stmt.value, t, locals);
        break;
      }
      case "void_call": {
        const fakeExpr: Value = { kind: "call", op: stmt.call.op, args: stmt.call.args };
        constrain(fakeExpr, { kind: "primitive", name: "inferred" }, locals);
        break;
      }
      case "user_void_call": {
        const fakeExpr: Value = { kind: "user_call", fn: stmt.fn, args: stmt.args };
        constrain(fakeExpr, { kind: "primitive", name: "inferred" }, locals);
        break;
      }
      case "if_else":
        constrain(stmt.condition, { kind: "primitive", name: "boolean" }, locals);
        for (const s of stmt.then) constrainStatement(s, locals);
        if (stmt.else) {
          for (const s of stmt.else) constrainStatement(s, locals);
        }
        break;
      case "return":
        constrain(stmt.value, { kind: "primitive", name: "inferred" }, locals);
        break;
    }
  };

  for (const fn of program.functions) {
    for (const p of fn.params) {
      if (p.type.kind === "primitive" && p.type.name === "inferred") {
        nodeDescriptions.set(p.type, `parameter '${p.name}' in function '${fn.name}'`);
      }
    }
  }

  for (const fn of program.functions) {
    const locals = new Map<string, TypeExpr>();
    for (const p of fn.params) {
      locals.set(p.name, p.type);
    }
    for (const s of fn.body) {
      constrainStatement(s, locals);
    }
    const retType = fn.returnType ?? { kind: "primitive", name: "inferred" };
    constrain(fn.returnValue, retType, locals);
    if (!fn.returnType) {
      (fn as any).returnType = retType;
    }
  }

  for (const fn of program.functions) {
    for (const p of fn.params) {
      (p as any).type = resolveDeep(p.type);
    }
    if (fn.returnType) {
      (fn as any).returnType = resolveDeep(fn.returnType);
    }
  }
};
