import type {
  FnDef,
  ImportDecl,
  Program,
  Statement,
  TypeExpr,
  Value,
} from "./ast.ts";
import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { builtinUnaryFields } from "./registry.ts";

// Alpha-renaming state: tracks canonical name assignments per function scope.
type RenameState = {
  readonly map: Map<string, string>;
  paramCounter: number;
  varCounter: number;
};

const freshState = (): RenameState => ({
  map: new Map(),
  paramCounter: 0,
  varCounter: 0,
});

const renameParam = (state: RenameState, name: string): string => {
  const canonical = `_p${state.paramCounter++}`;
  state.map.set(name, canonical);
  return canonical;
};

const renameVar = (state: RenameState, name: string): string => {
  const existing = state.map.get(name);
  if (existing !== undefined) return existing;
  const canonical = `_v${state.varCounter++}`;
  state.map.set(name, canonical);
  return canonical;
};

const resolve = (state: RenameState, name: string): string =>
  state.map.get(name) ?? name;

const quote = (s: string): string => JSON.stringify(s);

// --- Serialization helpers ---

const serializeType = (t: TypeExpr): string => {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "array":
      return `${serializeType(t.element)}[]`;
    case "object":
      return `{${
        t.fields.map((f) => `${quote(f.name)}:${serializeType(f.type)}`).join(
          ",",
        )
      }}`;
  }
};

const serializeValue = (v: Value, state: RenameState): string => {
  switch (v.kind) {
    case "string":
      return quote(v.value);
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "reference":
      return resolve(state, v.name);
    case "dot_access":
      return `${serializeValue(v.base, state)}.${quote(v.field)}`;
    case "index_access":
      return `${serializeValue(v.base, state)}[${
        serializeValue(v.index, state)
      }]`;
    case "array":
      return `[${v.elements.map((e) => serializeValue(e, state)).join(",")}]`;
    case "object":
      return `{${
        v.fields.map((f) => `${quote(f.key)}:${serializeValue(f.value, state)}`)
          .join(",")
      }}`;
    case "call":
      return v.args.length === 0
        ? `${v.op}()`
        : `${v.op}({${
          v.args.map((a) => `${quote(a.key)}:${serializeValue(a.value, state)}`)
            .join(",")
        }})`;
    case "user_call":
      return v.args.length === 0
        ? `${v.fn}()`
        : `${v.fn}({${
          v.args.map((a) => `${quote(a.key)}:${serializeValue(a.value, state)}`)
            .join(",")
        }})`;
    case "binary_op":
      return `(${serializeValue(v.left, state)}${v.op}${
        serializeValue(v.right, state)
      })`;
    case "unary_op":
      return `(${v.op}${serializeValue(v.operand, state)})`;
    case "ternary":
      return `(${serializeValue(v.condition, state)}?${
        serializeValue(v.then, state)
      }:${serializeValue(v.else, state)})`;
    case "map": {
      const caps = v.captures?.length
        ? `,{${
          v.captures.map((c) =>
            `${quote(c.key)}:${serializeValue(c.value, state)}`
          ).join(",")
        }}`
        : "";
      return `map(${serializeValue(v.fn, state)},${
        serializeValue(v.array, state)
      }${caps})`;
    }
    case "filter": {
      const caps = v.captures?.length
        ? `,{${
          v.captures.map((c) =>
            `${quote(c.key)}:${serializeValue(c.value, state)}`
          ).join(",")
        }}`
        : "";
      return `filter(${serializeValue(v.fn, state)},${
        serializeValue(v.array, state)
      }${caps})`;
    }
    case "reduce": {
      const caps = v.captures?.length
        ? `,{${
          v.captures.map((c) =>
            `${quote(c.key)}:${serializeValue(c.value, state)}`
          ).join(",")
        }}`
        : "";
      return `reduce(${serializeValue(v.fn, state)},${
        serializeValue(v.initial, state)
      },${serializeValue(v.array, state)}${caps})`;
    }
    case "override":
      return `override(${quote(v.target)},{${
        v.replacements.map((r) => `${quote(r.key)}:${quote(r.value)}`).join(
          ",",
        )
      }})`;
    case "dag_call":
      return `${serializeValue(v.fn, state)}({${
        v.args.map((a) => `${quote(a.key)}:${serializeValue(a.value, state)}`)
          .join(",")
      }})`;
  }
};

const serializeStatements = (
  stmts: readonly Statement[],
  state: RenameState,
): string =>
  stmts.map((stmt) => {
    switch (stmt.kind) {
      case "assignment": {
        const rhs = serializeValue(stmt.value, state);
        const canonical = renameVar(state, stmt.name);
        return `${canonical}=${rhs}`;
      }
      case "return": {
        return `return ${serializeValue(stmt.value, state)}`;
      }
      case "void_call":
        return stmt.call.args.length === 0
          ? `${stmt.call.op}()`
          : `${stmt.call.op}({${
            stmt.call.args.map((a) =>
              `${quote(a.key)}:${serializeValue(a.value, state)}`
            ).join(",")
          }})`;
      case "user_void_call":
        return stmt.args.length === 0
          ? `${stmt.fn}()`
          : `${stmt.fn}({${
            stmt.args.map((a) =>
              `${quote(a.key)}:${serializeValue(a.value, state)}`
            ).join(",")
          }})`;
      case "if_else": {
        const cond = serializeValue(stmt.condition, state);
        const then = serializeStatements(stmt.then, state);
        const elseStr = stmt.else
          ? ` else{${serializeStatements(stmt.else, state)}}`
          : "";
        return `if ${cond}{${then}}${elseStr}`;
      }
    }
  }).join(";");

const serializeFn = (fn: FnDef, state: RenameState): string => {
  const params = fn.params.map((p) => {
    const canonical = renameParam(state, p.name);
    const typeStr = serializeType(p.type);
    const defaultStr = p.defaultValue
      ? `=${
        p.defaultValue.kind === "string"
          ? quote(p.defaultValue.value)
          : String(p.defaultValue.value)
      }`
      : "";
    return `${canonical}:${typeStr}${defaultStr}`;
  }).join(",");
  const retType = fn.returnType ? `:${serializeType(fn.returnType)}` : "";
  const body = serializeStatements(fn.body, state);
  const ret = serializeValue(fn.returnValue, state);
  return `${fn.name}=(${params})${retType}=>{$${
    body ? `${body};` : ""
  }return ${ret}}`;
};

const serializeImport = (imp: ImportDecl): string => {
  const namesStr = imp.names.length === 1
    ? imp.names[0]
    : `{ ${imp.names.join(", ")} }`;
  const permsStr = imp.perms
    ? ` perms ${serializeValue(imp.perms, freshState())}`
    : "";
  const hashStr = imp.hash ? ` hash ${quote(imp.hash)}` : "";
  return `import ${namesStr} from ${quote(imp.source)}${permsStr}${hashStr}`;
};

export const normalize = (source: string): string => {
  const program = parse(tokenize(source), builtinUnaryFields);
  const imports = program.imports.map(serializeImport);
  const fns = program.functions.map((fn) => serializeFn(fn, freshState()));
  return [...imports, ...fns].join("\n");
};

export const hashProgram = async (source: string): Promise<string> => {
  const normalized = normalize(source);
  const encoded = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
};
