import type { LabelShape, Manifest, OpTag } from "./types.ts";

const unionSets = <T>(...sets: ReadonlySet<T>[]): ReadonlySet<T> =>
  new Set(sets.flatMap((s) => [...s]));

export const mergeManifests = (
  from: Manifest,
  into: Manifest,
): Manifest => ({
  tags: unionSets(from.tags, into.tags),
  hosts: unionSets(from.hosts, into.hosts),
  ...(from.emits || into.emits
    ? { emits: unionSets(from.emits ?? new Set(), into.emits ?? new Set()) }
    : {}),
  ...(into.emitsShape ?? from.emitsShape
    ? { emitsShape: into.emitsShape ?? from.emitsShape }
    : {}),
  memoryBytes: from.memoryBytes + into.memoryBytes,
  runtimeMs: from.runtimeMs + into.runtimeMs,
  diskBytes: from.diskBytes + into.diskBytes,
});

export const makeManifest = (
  tags: readonly OpTag[],
  resources: { memoryBytes: number; runtimeMs: number; diskBytes: number },
  hosts?: readonly string[],
  emits?: readonly string[],
  emitsShape?: LabelShape,
): Manifest => {
  return {
    tags: new Set(tags),
    hosts: new Set(hosts ?? []),
    emits: new Set(emits ?? []),
    ...(emitsShape ? { emitsShape } : {}),
    memoryBytes: resources.memoryBytes,
    runtimeMs: resources.runtimeMs,
    diskBytes: resources.diskBytes,
  };
};
