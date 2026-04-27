// Top-level interpreter — lowers the entry fn into a Graph IR Dag, then runs
// it under the supplied ExecutionContext. User-fn dispatch (compose nodes)
// resolves through a per-call lookup that lazily builds Dags for callees,
// reusing the same build cache so each (fn, replacements) pair lowers once.

import type { FnDef, Program } from "./ast.ts";
import type { OpEntry } from "./registry.ts";
import type { ExecutionContext } from "../types.ts";
import { runWithContext } from "../context.ts";
import { builtinRegistry } from "./registry.ts";
import { buildDag, type Dag, type FnMap } from "./graph.ts";
import { executeDag, withComposeRegistry } from "./graphExec.ts";

export const interpret = async (
  program: Program,
  functionName: string,
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  registry: ReadonlyMap<string, OpEntry> = builtinRegistry,
): Promise<unknown> => {
  const entry = program.functions.find((f) => f.name === functionName);
  if (!entry) throw new Error(`Function '${functionName}' not found`);
  const fns: FnMap = new Map(program.functions.map((f) => [f.name, f]));
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
