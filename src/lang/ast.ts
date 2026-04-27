export type TypeExpr =
  | {
    readonly kind: "primitive";
    readonly name: "string" | "number" | "boolean";
  }
  | { readonly kind: "array"; readonly element: TypeExpr }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyArray<
      { readonly name: string; readonly type: TypeExpr }
    >;
  };

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">=";

export type Value =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "reference"; readonly name: string }
  | {
    readonly kind: "dot_access";
    readonly base: Value;
    readonly field: string;
  }
  | {
    readonly kind: "index_access";
    readonly base: Value;
    readonly index: Value;
  }
  | { readonly kind: "array"; readonly elements: readonly Value[] }
  | {
    readonly kind: "object";
    readonly fields: ReadonlyArray<
      { readonly key: string; readonly value: Value }
    >;
  }
  | {
    readonly kind: "call";
    readonly op: string;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: Value }
    >;
  }
  | {
    readonly kind: "user_call";
    readonly fn: string;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: Value }
    >;
  }
  | {
    readonly kind: "binary_op";
    readonly op: BinaryOp;
    readonly left: Value;
    readonly right: Value;
  }
  | { readonly kind: "unary_op"; readonly op: "-" | "!"; readonly operand: Value }
  | {
    readonly kind: "ternary";
    readonly condition: Value;
    readonly then: Value;
    readonly else: Value;
  }
  | { readonly kind: "map"; readonly fn: string; readonly array: Value }
  | { readonly kind: "filter"; readonly fn: string; readonly array: Value }
  | {
    readonly kind: "reduce";
    readonly fn: string;
    readonly initial: Value;
    readonly array: Value;
  }
  // override(target, { key: replName, ... }) — produces a callable DAG value:
  // the target user-fn rewritten so that references to `key` (a builtin op
  // label or user-fn name) become references to `replName` (a user-fn name),
  // transitively into callees. Cannot self-reference. No user-facing dag
  // literal syntax; this is the only way to create a first-class fn value.
  | {
    readonly kind: "override";
    readonly target: string;
    readonly replacements: ReadonlyArray<
      { readonly key: string; readonly value: string }
    >;
  };

export type Statement =
  | {
    readonly kind: "assignment";
    readonly name: string;
    readonly value: Value;
  }
  | { readonly kind: "void_call"; readonly call: OpCall }
  | {
    readonly kind: "user_void_call";
    readonly fn: string;
    readonly args: ReadonlyArray<
      { readonly key: string; readonly value: Value }
    >;
  }
  | {
    readonly kind: "if_else";
    readonly condition: Value;
    readonly then: readonly Statement[];
    readonly else: readonly Statement[] | null;
  };

export type OpCall = {
  readonly op: string;
  readonly args: ReadonlyArray<{ readonly key: string; readonly value: Value }>;
};

export type Param = {
  readonly name: string;
  readonly type: TypeExpr;
};

export type FnDef = {
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: readonly Statement[];
  readonly returnValue: Value;
  readonly returnType: TypeExpr | null;
};

export type ImportDecl = {
  readonly name: string;
  readonly alias: string | null;
  readonly source: string;
  readonly perms: Value;
  readonly hash: string;
};

export type Program = {
  readonly imports: readonly ImportDecl[];
  readonly functions: readonly FnDef[];
};
