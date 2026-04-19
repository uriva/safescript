import type { Manifest, OpTag } from "./types.ts";

const unionSets = <T>(...sets: ReadonlySet<T>[]): ReadonlySet<T> =>
  new Set(sets.flatMap((s) => [...s]));

export const mergeManifests = (
  from: Manifest,
  into: Manifest,
): Manifest => ({
  tags: unionSets(from.tags, into.tags),
  hosts: unionSets(from.hosts, into.hosts),
  memoryBytes: from.memoryBytes + into.memoryBytes,
  runtimeMs: from.runtimeMs + into.runtimeMs,
  diskBytes: from.diskBytes + into.diskBytes,
});

export const makeManifest = (
  tags: readonly OpTag[],
  resources: { memoryBytes: number; runtimeMs: number; diskBytes: number },
  hosts?: readonly string[],
): Manifest => {
  return {
    tags: new Set(tags),
    hosts: new Set(hosts ?? []),
    memoryBytes: resources.memoryBytes,
    runtimeMs: resources.runtimeMs,
    diskBytes: resources.diskBytes,
  };
};
