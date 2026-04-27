// Top-level interpreter — lowers the entry fn into a Graph IR Dag, then runs
// it under the supplied ExecutionContext. User-fn dispatch (compose nodes)
// resolves through a per-call lookup that lazily builds Dags for callees,
// reusing the same build cache so each (fn, replacements) pair lowers once.

import type { FnDef, ImportDecl, Program } from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import type { ExecutionContext } from "../types.ts";
import { runWithContext } from "../context.ts";
import { builtinRegistry, builtinUnaryFields } from "./registry.ts";
import { buildDag, type Dag, type FnMap } from "./graph.ts";
import { executeDag, withComposeRegistry } from "./graphExec.ts";
import { parse } from "./parser.ts";
import { tokenize } from "./lexer.ts";

const resolveImports = async (
  imports: readonly ImportDecl[],
  functions: readonly FnDef[],
  importerPath: string,
): Promise<readonly FnDef[]> => {
  const resolved = [...functions] as FnDef[];
  for (const imp of imports) {
    const source = imp.source;
    if (!source.startsWith(".")) continue;
    const resolvedPath = source.startsWith("/")
      ? source
      : new URL(source, `file://${importerPath}`).pathname;
    const text = await Deno.readTextFile(resolvedPath);
    const depProgram = parse(tokenize(text), builtinUnaryFields);
    for (const name of imp.names) {
      const fn = depProgram.functions.find((f) => f.name === name);
      if (!fn) throw new Error(`Import '${name}' not found in ${source}`);
      // Import all transitive deps: include all functions from the file.
      for (const depFn of depProgram.functions) {
        if (!resolved.some((f) => f.name === depFn.name)) {
          resolved.push(depFn);
        }
      }
      break; // only need to process once per file
    }
  }
  return resolved;
};

export const interpret = async (
  program: Program,
  functionName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  registry: ReadonlyMap<string, OpEntry> = builtinRegistry,
  sourcePath = "",
): Promise<unknown> => {
  const functions = await resolveImports(program.imports, program.functions, sourcePath);
  const entry = functions.find((f) => f.name === functionName);
  if (!entry) throw new Error(`Function '${functionName}' not found`);
  const fns: FnMap = new Map(functions.map((f) => [f.name, f]));
  const buildCache = new Map<string, Dag>();
  const noReps = new Map<string, string>();
  const entryDag = buildDag(entry, fns, noReps, buildCache);
  // Compose lookup: resolve a fn name to its Dag, building if not yet built.
  // We lower with no replacements at the top level; overrides are introduced
  // inside expressions, not at compose-call sites.
  const lookup = (name: string): Dag | undefined => {
    const fn = fns.get(name);
    if (!fn) return undefined;
    return buildDag(fn, fns, noReps, buildCache);
  };
  return runWithContext(
    ctx,
    () => withComposeRegistry(lookup, () => executeDag(entryDag, args, registry)),
  );
};
