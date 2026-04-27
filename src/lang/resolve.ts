import { z } from "zod/v4";
import type { ImportDecl, Program, Value } from "./ast.ts";
import type { Signature } from "./signature.ts";
import type { OpEntry } from "./registry.ts";
import type { DagOp, ExecutionContext, Manifest } from "../types.ts";
import { getContext } from "../context.ts";
import { builtinRegistry } from "./registry.ts";
import { computeSignature } from "./signature.ts";
import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { interpret } from "./interpreter.ts";
import { hashProgram } from "./normalize.ts";
import { builtinUnaryFields } from "./registry.ts";

export type FetchSource = (source: string) => Promise<string>;

// Extract a static string array from a Value AST node.
const extractStringArray = (v: Value): readonly string[] => {
  if (v.kind !== "array") {
    throw new Error(`Expected array in perms, got '${v.kind}'`);
  }
  return v.elements.map((el) => {
    if (el.kind !== "string") {
      throw new Error(
        `Expected string literal in perms array, got '${el.kind}'`,
      );
    }
    return el.value;
  });
};

// Extract a map of string → Set<string> from a Value AST node (object of arrays).
const extractDataFlowMap = (
  v: Value,
): ReadonlyMap<string, ReadonlySet<string>> => {
  if (v.kind !== "object") {
    throw new Error(`Expected object in perms dataFlow, got '${v.kind}'`);
  }
  const result = new Map<string, ReadonlySet<string>>();
  for (const field of v.fields) {
    result.set(field.key, new Set(extractStringArray(field.value)));
  }
  return result;
};

// Extract a perms assertion from the parsed Value (object literal).
// Returns a comparable structure matching Signature fields.
type PermsAssertion = {
  readonly hosts: ReadonlySet<string>;
  readonly envReads: ReadonlySet<string>;
  readonly dataFlow: ReadonlyMap<string, ReadonlySet<string>> | null;
};

const extractPerms = (perms: Value): PermsAssertion => {
  if (perms.kind !== "object") {
    throw new Error(`Perms must be an object literal, got '${perms.kind}'`);
  }
  const result: {
    hosts: ReadonlySet<string>;
    envReads: ReadonlySet<string>;
    dataFlow: ReadonlyMap<string, ReadonlySet<string>> | null;
  } = {
    hosts: new Set(),
    envReads: new Set(),
    dataFlow: null,
  };
  for (const field of perms.fields) {
    switch (field.key) {
      case "hosts":
        result.hosts = new Set(extractStringArray(field.value));
        break;
      case "envReads":
        result.envReads = new Set(extractStringArray(field.value));
        break;
      case "dataFlow":
        result.dataFlow = extractDataFlowMap(field.value);
        break;
      default:
        throw new Error(`Unknown perms field: '${field.key}'`);
    }
  }
  return result;
};

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((v) => b.has(v));

const formatSet = (s: ReadonlySet<string>): string =>
  s.size === 0 ? "(none)" : `[${[...s].sort().join(", ")}]`;

const dataFlowMapsEqual = (
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, aSet] of a) {
    const bSet = b.get(key);
    if (!bSet || !setsEqual(aSet, bSet)) return false;
  }
  return true;
};

const formatDataFlow = (m: ReadonlyMap<string, ReadonlySet<string>>): string =>
  m.size === 0
    ? "(none)"
    : `{ ${
      [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) =>
        `${k}: ${formatSet(v)}`
      ).join(", ")
    } }`;

const assertPerms = (
  sig: Signature,
  perms: PermsAssertion,
  importName: string,
  source: string,
): void => {
  const mismatches: string[] = [];
  if (!setsEqual(sig.hosts, perms.hosts)) {
    mismatches.push(
      `hosts: declared ${formatSet(perms.hosts)}, actual ${
        formatSet(sig.hosts)
      }`,
    );
  }
  if (!setsEqual(sig.envReads, perms.envReads)) {
    mismatches.push(
      `envReads: declared ${formatSet(perms.envReads)}, actual ${
        formatSet(sig.envReads)
      }`,
    );
  }
  if (
    perms.dataFlow !== null && !dataFlowMapsEqual(sig.dataFlow, perms.dataFlow)
  ) {
    mismatches.push(
      `dataFlow: declared ${formatDataFlow(perms.dataFlow)}, actual ${
        formatDataFlow(sig.dataFlow)
      }`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Perms assertion failed for import '${importName}' from "${source}":\n  ${
        mismatches.join("\n  ")
      }`,
    );
  }
};

// Build a manifest from a Signature (for synthetic OpEntry).
const manifestFromSignature = (sig: Signature): Manifest => {
  const tags = new Set<import("../types.ts").OpTag>();
  if (sig.hosts.size > 0) tags.add("network");
  if (sig.envReads.has("timestamp")) tags.add("time");
  if (sig.envReads.has("randomBytes")) tags.add("random");
  if (tags.size === 0) tags.add("pure");
  return {
    tags,
    hosts: sig.hosts,
    memoryBytes: sig.memoryBytes,
    runtimeMs: sig.runtimeMs,
    diskBytes: sig.diskBytes,
  };
};

// Create a synthetic OpEntry for an imported function.
const syntheticOp = (
  depProgram: Program,
  fnName: string,
  sig: Signature,
  depRegistry: ReadonlyMap<string, OpEntry>,
): OpEntry => ({
  staticFields: new Set(),
  unaryField: null,
  create: (): DagOp<z.ZodObject<z.ZodRawShape>, z.ZodType> => ({
    _tag: "dag-op",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    manifest: manifestFromSignature(sig),
    run: (inputs: Record<string, unknown>) =>
      interpret(depProgram, fnName, inputs, getContext(), depRegistry),
  }),
});

// Resolve all imports for a program, returning an extended registry.
// Uses a cache keyed by hash to avoid re-resolving diamond deps.
export const resolveImports = async (
  program: Program,
  fetchSource: FetchSource,
  baseRegistry: ReadonlyMap<string, OpEntry> = builtinRegistry,
  cache: Map<
    string,
    { program: Program; registry: ReadonlyMap<string, OpEntry> }
  > = new Map(),
): Promise<ReadonlyMap<string, OpEntry>> => {
  if (program.imports.length === 0) return baseRegistry;

  const extended = new Map(baseRegistry);

  for (const imp of program.imports) {
    if (!imp.hash) continue; // skip hashless imports, handled by interpreter
    const localNames = imp.names;

    for (const name of localNames) {
      if (baseRegistry.has(name)) {
        throw new Error(`Import '${name}' conflicts with builtin op '${name}'`);
      }
    }

    // Fetch and verify hash
    const source = await fetchSource(imp.source);
    const actualHash = await hashProgram(source);
    if (actualHash !== imp.hash) {
      throw new Error(
        `Hash mismatch for import '${imp.names.join(", ")}' from "${imp.source}":\n  declared: ${imp.hash}\n  actual:   ${actualHash}`,
      );
    }

    // Check cache (diamond dep optimization)
    const cached = cache.get(imp.hash);
    const depProgram = cached?.program ??
      parse(tokenize(source), builtinUnaryFields);

    // Recursively resolve the dep's own imports
    const depRegistry = cached?.registry ??
      await resolveImports(depProgram, fetchSource, baseRegistry, cache);

    if (!cached) {
      cache.set(imp.hash, { program: depProgram, registry: depRegistry });
    }

    // Find each named function in the dep
    for (const name of imp.names) {
      const fn = depProgram.functions.find((f) => f.name === name);
      if (!fn) {
        throw new Error(
          `Function '${name}' not found in dep from "${imp.source}"`,
        );
      }

      // Compute signature with the dep's resolved registry (transitive)
      const sig = computeSignature(depProgram, name, depRegistry);

      // Assert perms
      const perms = imp.perms ? extractPerms(imp.perms) : null;
      if (perms) assertPerms(sig, perms, name, imp.source);

      // Register synthetic op
      extended.set(
        name,
        syntheticOp(depProgram, name, sig, depRegistry),
      );
    }
  }

  return extended;
};
