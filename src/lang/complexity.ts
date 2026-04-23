export type ComplexityTerm = {
  readonly coeff: number;
  readonly vars: readonly string[];
};

export type ComplexityExpr = {
  readonly terms: readonly ComplexityTerm[];
};

const canonicalTerm = (t: ComplexityTerm): ComplexityTerm => ({
  coeff: t.coeff,
  vars: [...t.vars].sort(),
});

const termKey = (vars: readonly string[]): string => vars.join("*");

export const normalize = (expr: ComplexityExpr): ComplexityExpr => {
  const merged = new Map<string, number>();
  for (const t of expr.terms) {
    const c = canonicalTerm(t);
    if (c.coeff === 0) continue;
    const k = termKey(c.vars);
    merged.set(k, (merged.get(k) ?? 0) + c.coeff);
  }
  const terms: ComplexityTerm[] = [];
  for (const [k, coeff] of merged) {
    if (coeff === 0) continue;
    terms.push({ coeff, vars: k === "" ? [] : k.split("*") });
  }
  terms.sort((a, b) => termKey(a.vars).localeCompare(termKey(b.vars)));
  return { terms };
};

export const constant = (n: number): ComplexityExpr =>
  normalize({ terms: [{ coeff: n, vars: [] }] });

export const zero = constant(0);
export const one = constant(1);

export const variable = (name: string): ComplexityExpr =>
  normalize({ terms: [{ coeff: 1, vars: [name] }] });

export const add = (...exprs: ComplexityExpr[]): ComplexityExpr =>
  normalize({ terms: exprs.flatMap((e) => [...e.terms]) });

export const scale = (expr: ComplexityExpr, n: number): ComplexityExpr =>
  normalize({
    terms: expr.terms.map((t) => ({ ...t, coeff: t.coeff * n })),
  });

const multiplyTerms = (a: ComplexityTerm, b: ComplexityTerm): ComplexityTerm => ({
  coeff: a.coeff * b.coeff,
  vars: [...a.vars, ...b.vars].sort(),
});

export const multiply = (a: ComplexityExpr, b: ComplexityExpr): ComplexityExpr => {
  const terms: ComplexityTerm[] = [];
  for (const ta of a.terms) {
    for (const tb of b.terms) {
      terms.push(multiplyTerms(ta, tb));
    }
  }
  return normalize({ terms });
};

export const maxExpr = (a: ComplexityExpr, b: ComplexityExpr): ComplexityExpr =>
  add(a, b);

export const complexityToString = (expr: ComplexityExpr): string => {
  if (expr.terms.length === 0) return "0";
  const parts: string[] = [];
  for (const t of expr.terms) {
    if (t.coeff === 0) continue;
    const varsStr = t.vars.join(" * ");
    let part = "";
    if (t.vars.length === 0) {
      part = String(t.coeff);
    } else if (t.coeff === 1) {
      part = varsStr;
    } else if (t.coeff === -1) {
      part = "-" + varsStr;
    } else {
      part = `${t.coeff} * ${varsStr}`;
    }
    parts.push(part);
  }
  if (parts.length === 0) return "0";
  return parts.join(" + ");
};

export const complexityEquals = (a: ComplexityExpr, b: ComplexityExpr): boolean =>
  complexityToString(a) === complexityToString(b);
