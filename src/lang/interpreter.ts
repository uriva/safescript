// Top-level interpreter — lowers the entry fn into a Graph IR Dag, then runs
// it under the supplied ExecutionContext. User-fn dispatch (compose nodes)
// resolves through a per-call lookup threaded explicitly through executeDag
// (concurrency-safe across interleaved awaits).
//
// External imports MUST be pre-resolved by the host via resolveImports() using
// an explicit FetchSource; interpret() never performs implicit filesystem I/O.

import type { Program } from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import type { ExecutionContext } from "../types.ts";
import { runWithContext } from "../context.ts";
import { builtinRegistry } from "./registry.ts";
import { buildDag, type Dag, type FnMap } from "./graph.ts";
import { executeDag } from "./graphExec.ts";
import { validateProgramSemantics } from "./parser.ts";

export const interpret = (
  program: Program,
  functionName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  registry: ReadonlyMap<string, OpEntry> = builtinRegistry,
  _sourcePath = "",
): Promise<unknown> => {
  const entry = program.functions.find((f) => f.name === functionName);
  if (!entry) throw new Error(`Function '${functionName}' not found`);
  validateProgramSemantics(program, [entry]);

  for (const imp of program.imports) {
    for (const name of imp.names) {
      const inFunctions = program.functions.some((f) => f.name === name);
      if (!inFunctions && !registry.has(name)) {
        throw new Error(
          `Unresolved import '${name}' from "${imp.source}" — resolve imports explicitly via resolveImports() before calling interpret()`,
        );
      }
    }
  }

  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
  const buildCache = new Map<string, Dag>();
  const noReps = new Map<string, string>();
  const entryDag = buildDag(entry, fns, noReps, buildCache);

  const lookup = (name: string): Dag | undefined => {
    const fn = fns.get(name);
    if (!fn) return undefined;
    return buildDag(fn, fns, noReps, buildCache);
  };

  return runWithContext(ctx, () =>
    executeDag(entryDag, args, registry, {
      ctx,
      composeLookup: lookup,
    }));
};
