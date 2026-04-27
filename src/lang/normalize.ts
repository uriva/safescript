import type {
  BinaryOp,
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
  const canonical = `_v${state.varCounter++}`;
  state.map.set(name, canonical);
  return canonical;
};

const resolve = (state: RenameState, name: string): string =>
  state.map.get(name) ?? name;

// --- Serialization helpers ---

const serializeType = (t: TypeExpr): string => {
  switch (t.kind) {
    case "primitive":
      return t.name;
    case "array":
      return `${serializeType(t.element)}[]`;
    case "object":
      return `{${
        t.fields.map((f) => `${f.name}:${serializeType(f.type)}`).join(",")
      }}`;
  }
};

const serializeValue = (v: Value, state: RenameState): string => {
  switch (v.kind) {
    case "string":
      return `"${
        v.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(
          /\n/g,
          "\\n",
        ).replace(/\t/g, "\\t")
      }"`;
    case "number":
      return String(v.value);
    case "boolean":
      return String(v.value);
    case "reference":
      return resolve(state, v.name);
    case "dot_access":
      return `${serializeValue(v.base, state)}.${v.field}`;
    case "index_access":
      return `${serializeValue(v.base, state)}[${
        serializeValue(v.index, state)
      }]`;
    case "array":
      return `[${v.elements.map((e) => serializeValue(e, state)).join(",")}]`;
    case "object":
      return `{${
        v.fields.map((f) => `${f.key}:${serializeValue(f.value, state)}`).join(
          ",",
        )
      }}`;
    case "call":
      return v.args.length === 0
        ? `${v.op}()`
        : `${v.op}({${
          v.args.map((a) => `${a.key}:${serializeValue(a.value, state)}`).join(
            ",",
          )
        }})`;
    case "user_call":
      return v.args.length === 0
        ? `${v.fn}()`
        : `${v.fn}({${
          v.args.map((a) => `${a.key}:${serializeValue(a.value, state)}`).join(
            ",",
          )
        }})`;
    case "binary_op":
      return `(${serializeValue(v.left, state)}${v.op}${
        serializeValue(v.right, state)
      })`;
    case "unary_op":
      return `(-${serializeValue(v.operand, state)})`;
    case "ternary":
      return `(${serializeValue(v.condition, state)}?${
        serializeValue(v.then, state)
      }:${serializeValue(v.else, state)})`;
    case "map":
      return `map(${serializeValue(v.fn, state)},${serializeValue(v.array, state)})`;
    case "filter":
      return `filter(${serializeValue(v.fn, state)},${serializeValue(v.array, state)})`;
    case "reduce":
      return `reduce(${serializeValue(v.fn, state)},${serializeValue(v.initial, state)},${
        serializeValue(v.array, state)
      })`;
    case "override":
      return `override(${v.target},{${
        v.replacements.map((r) => `${r.key}:${r.value}`).join(",")
      }})`;
    case "dag_call":
      return `${serializeValue(v.fn, state)}({${
        v.args.map((a) => `${a.key}:${serializeValue(a.value, state)}`).join(",")
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
        const canonical = renameVar(state, stmt.name);
        return `${canonical}=${serializeValue(stmt.value, state)}`;
      }
      case "void_call":
        return stmt.call.args.length === 0
          ? `${stmt.call.op}()`
          : `${stmt.call.op}({${
            stmt.call.args.map((a) =>
              `${a.key}:${serializeValue(a.value, state)}`
            ).join(",")
          }})`;
      case "user_void_call":
        return stmt.args.length === 0
          ? `${stmt.fn}()`
          : `${stmt.fn}({${
            stmt.args.map((a) =>
              `${a.key}:${serializeValue(a.value, state)}`
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
    return `${canonical}:${serializeType(p.type)}`;
  }).join(",");
  const retType = fn.returnType ? `:${serializeType(fn.returnType)}` : "";
  const body = serializeStatements(fn.body, state);
  const ret = serializeValue(fn.returnValue, state);
  return `${fn.name}=(${params})${retType}=>{${
    body ? `${body};` : ""
  }return ${ret}}`;
};

const serializeImport = (imp: ImportDecl): string => {
  const aliasStr = imp.alias ? ` as ${imp.alias}` : "";
  // Perms are serialized without renaming (external names kept)
  const permsStr = serializeValue(imp.perms, freshState());
  return `import ${imp.name}${aliasStr} from "${imp.source}" perms ${permsStr} hash "${imp.hash}"`;
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
