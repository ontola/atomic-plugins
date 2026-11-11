import type { InventoryFile } from './file-inventory-sources.js';
import type { FileInventorySource } from './config.js';

export interface FileLocation {
  collection: string;
  provider: FileInventorySource['provider'];
  file: InventoryFile;
}

interface DuplicateCandidate {
  name: string;
  size: string;
  groups: FileLocation[][];
}
export function findFileDuplicates(locations: FileLocation[]): {
  confirmed: FileLocation[][];
  candidates: DuplicateCandidate[];
} {
  const roots = locations.map((_, i) => i);
  const rank = locations.map(() => 0);
  const root = (index: number): number => {
    while (index !== roots[index]) {
      roots[index] = roots[roots[index]];
      index = roots[index];
    }
    return index;
  };
  const join = (a: number, b: number): void => {
    a = root(a);
    b = root(b);
    if (a === b) return;
    if (rank[a] < rank[b]) roots[a] = b;
    else {
      roots[b] = a;
      if (rank[a] === rank[b]) rank[a]++;
    }
  };
  const hashes = new Map<string, number>();
  const names = new Map<string, number[]>();
  for (const [index, { file }] of locations.entries()) {
    for (const [algorithm, hash] of Object.entries(file.hashes)) {
      const key = algorithm + ':' + hash;
      const seen = hashes.get(key);
      if (seen === undefined) hashes.set(key, index);
      else join(index, seen);
    }
    if (file.size !== undefined) {
      const key = JSON.stringify([file.name, file.size]);
      const group = names.get(key);
      if (group) group.push(index);
      else names.set(key, [index]);
    }
  }

  const groupByContent = (indices: Iterable<number>): FileLocation[][] => {
    const groups = new Map<number, FileLocation[]>();
    for (const index of indices) {
      const key = root(index);
      const group = groups.get(key);
      if (group) group.push(locations[index]);
      else groups.set(key, [locations[index]]);
    }
    return [...groups.values()];
  };
  const confirmed = groupByContent(locations.keys()).filter(
    (group) => group.length > 1,
  );
  const candidates: DuplicateCandidate[] = [];
  for (const indices of names.values()) {
    if (
      indices.length < 2 ||
      new Set(indices.map((i) => locations[i].provider)).size < 2
    )
      continue;
    const groups = groupByContent(indices);
    if (groups.length < 2) continue;
    const { name, size } = locations[indices[0]].file;
    candidates.push({ name, size: size!, groups });
  }
  return { confirmed, candidates };
}
