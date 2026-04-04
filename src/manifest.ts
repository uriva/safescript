import type { Manifest, OpTag } from "./types.ts";

const unionSets = <T>(...sets: ReadonlySet<T>[]): ReadonlySet<T> =>
  new Set(sets.flatMap((s) => [...s]));

const mergeTaintedHosts = (
  a: ReadonlyMap<string, ReadonlySet<string>>,
  b: ReadonlyMap<string, ReadonlySet<string>>,
  intoHosts: ReadonlySet<string>,
  fromTaint: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const result = new Map<string, Set<string>>();
  const addEntries = (map: ReadonlyMap<string, ReadonlySet<string>>) =>
    map.forEach((secrets, host) => {
      const existing = result.get(host) ?? new Set();
      secrets.forEach((s) => existing.add(s));
      result.set(host, existing);
    });
  addEntries(a);
  addEntries(b);
  if (fromTaint.size > 0) {
    intoHosts.forEach((host) => {
      const existing = result.get(host) ?? new Set();
      fromTaint.forEach((s) => existing.add(s));
      result.set(host, existing);
    });
  }
  return result;
};

export const mergeManifests = (
  from: Manifest,
  into: Manifest,
  fromTaint: ReadonlySet<string>,
): Manifest => ({
  tags: unionSets(from.tags, into.tags),
  secretsRead: unionSets(from.secretsRead, into.secretsRead),
  secretsWritten: unionSets(from.secretsWritten, into.secretsWritten),
  hosts: unionSets(from.hosts, into.hosts),
  taintedHosts: mergeTaintedHosts(
    from.taintedHosts,
    into.taintedHosts,
    into.hosts,
    fromTaint,
  ),
  outputTainted: into.outputTainted || fromTaint.size > 0,
  taintSources: unionSets(into.taintSources, fromTaint),
  memoryBytes: from.memoryBytes + into.memoryBytes,
  runtimeMs: from.runtimeMs + into.runtimeMs,
  diskBytes: from.diskBytes + into.diskBytes,
});

export const makeManifest = (
  tags: readonly OpTag[],
  resources: { memoryBytes: number; runtimeMs: number; diskBytes: number },
  secretsRead?: readonly string[],
  secretsWritten?: readonly string[],
  hosts?: readonly string[],
): Manifest => {
  const tagSet = new Set(tags);
  const readSet = new Set(secretsRead ?? []);
  return {
    tags: tagSet,
    secretsRead: readSet,
    secretsWritten: new Set(secretsWritten ?? []),
    hosts: new Set(hosts ?? []),
    taintedHosts: new Map(),
    outputTainted: tagSet.has("secret:read"),
    taintSources: tagSet.has("secret:read") ? readSet : new Set(),
    memoryBytes: resources.memoryBytes,
    runtimeMs: resources.runtimeMs,
    diskBytes: resources.diskBytes,
  };
};
