// Follows `clone` declarations: a clone copies a theory, possibly renaming
// its members, so a name may be declared in the theory that was copied.

import { DeclarationKind, Rename } from "./declarations";
import { DeclarationIndex, IndexEntry, theoryOfFile } from "./index";

/** A theory: `path` inside `file`, empty for the file itself. */
export interface TheoryRef {
  file: string;
  path: string[];
}

const MAX_DEPTH = 12;
const PLAIN = /^[A-Za-z0-9_']+$/;

const RENAME_KINDS: Partial<Record<DeclarationKind, string>> = {
  lemma: "lemma",
  axiom: "lemma",
  op: "op",
  abbrev: "op",
  pred: "pred",
  type: "type",
  module: "module",
  "module type": "module type",
  theory: "theory",
  clone: "theory",
};

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function endsWith(path: string[], suffix: string[]): boolean {
  return suffix.length <= path.length && suffix.every((part, i) => part === path[path.length - suffix.length + i]);
}

/** `name` after the renames of a clone, as EasyCrypt applies them: in order, to every match. */
function renamed(renames: Rename[], kind: DeclarationKind, name: string): string {
  for (const r of renames) {
    if (r.kinds.length > 0 && !r.kinds.includes(RENAME_KINDS[kind] ?? "")) continue;
    try {
      name = name.replace(new RegExp(r.pattern, "g"), r.replacement.replace(/\$/g, "$$$$").replace(/\\(\d)/g, "$$$1"));
    } catch {
      // not a regular expression JavaScript understands
    }
  }
  return name;
}

/** The names that `renames` may have turned into `name`; only plain-text renames are undone. */
function originalNames(renames: Rename[], name: string): string[] {
  const names = new Set([name]);
  for (const r of [...renames].reverse()) {
    if (!PLAIN.test(r.pattern) || !r.replacement) continue;
    for (const n of [...names]) {
      if (n.includes(r.replacement)) names.add(n.split(r.replacement).join(r.pattern));
    }
  }
  return [...names];
}

type Denoted = { theory: TheoryRef } | { clone: IndexEntry };

/** What the theory name `names` may denote, seen from `from`: theories, or clones that copy one. */
function denoted(index: DeclarationIndex, from: TheoryRef, names: string[]): Denoted[] {
  // `Self` and `Top` are the current file.
  const absolute = names[0] === "Self" || names[0] === "Top";
  if (absolute) names = names.slice(1);
  if (names.length === 0) return [{ theory: { file: from.file, path: [] } }];
  const parents = names.slice(0, -1);
  const last = names[names.length - 1];

  let entries = index
    .named(last)
    .filter((e) => e.kind === "theory" || (e.clone !== undefined && !e.clone.include))
    .filter((e) =>
      absolute
        ? e.file === from.file && sameArray(e.path, parents)
        : endsWith([theoryOfFile(e.file), ...e.path], parents),
    );
  const local = entries.filter((e) => e.file === from.file);
  if (local.length > 0) entries = local;

  const found: Denoted[] = entries.map((e) =>
    e.clone ? { clone: e } : { theory: { file: e.file, path: [...e.path, e.name] } },
  );
  if (!absolute && parents.length === 0 && local.length === 0) {
    for (const file of index.filesOfTheory(last)) found.push({ theory: { file, path: [] } });
  }
  return found;
}

/** Members called `name` of the copy `clone` makes: those of its source, with the renames undone. */
function throughClone(index: DeclarationIndex, clone: IndexEntry, name: string, depth: number): IndexEntry[] {
  const { source, renames } = clone.clone!;
  const from = { file: clone.file, path: clone.path };
  const found: IndexEntry[] = [];
  for (const original of originalNames(renames, name)) {
    for (const entry of membersOf(index, from, source.split("."), original, depth + 1)) {
      if (renamed(renames, entry.kind, original) === name) found.push(entry);
    }
  }
  return found;
}

function membersOfTheory(index: DeclarationIndex, theory: TheoryRef, name: string, depth: number): IndexEntry[] {
  const inside = (e: IndexEntry) => e.file === theory.file && sameArray(e.path, theory.path);
  const found = index.named(name).filter((e) => inside(e) && !e.clone?.include);
  for (const clone of index.clonesOf(theory.file)) {
    if (clone.clone!.include && inside(clone)) found.push(...throughClone(index, clone, name, depth));
  }
  return found;
}

/**
 * Declarations called `name` in the theory `names`, seen from `from`,
 * including what the theory gets from clones.
 */
export function membersOf(
  index: DeclarationIndex,
  from: TheoryRef,
  names: string[],
  name: string,
  depth = 0,
): IndexEntry[] {
  if (depth > MAX_DEPTH) return [];
  const found = new Set<IndexEntry>();
  for (const d of denoted(index, from, names)) {
    const members = "clone" in d ? throughClone(index, d.clone, name, depth) : membersOfTheory(index, d.theory, name, depth);
    for (const entry of members) found.add(entry);
  }
  return [...found];
}

/**
 * Declarations called `name` that `file` can use without a qualifier thanks
 * to clones: its own `clone import` and `clone include`, and the top-level
 * `clone include` and `clone export` of the files it requires.
 */
export function openedByClones(
  index: DeclarationIndex,
  file: string,
  required: Iterable<string>,
  name: string,
): IndexEntry[] {
  const found = new Set<IndexEntry>();
  const follow = (clone: IndexEntry) => {
    for (const entry of throughClone(index, clone, name, 0)) found.add(entry);
  };
  for (const clone of index.clonesOf(file)) {
    const { include, import: imported, export: exported } = clone.clone!;
    if (include || imported || exported) follow(clone);
  }
  for (const other of required) {
    for (const clone of index.clonesOf(other)) {
      if (clone.path.length === 0 && (clone.clone!.include || clone.clone!.export)) follow(clone);
    }
  }
  return [...found];
}

/** A declaration as seen through clones: under the name the renames give it. */
export interface Member {
  name: string;
  entry: IndexEntry;
  /** The file holding the theory or clone it was reached through. */
  home: string;
}

/** All the members the copy `clone` makes, renamed. */
function allThroughClone(index: DeclarationIndex, clone: IndexEntry, depth: number): Member[] {
  const { source, renames } = clone.clone!;
  const from = { file: clone.file, path: clone.path };
  return allMembersOf(index, from, source.split("."), depth + 1).map((m) => ({
    name: renamed(renames, m.entry.kind, m.name),
    entry: m.entry,
    home: clone.file,
  }));
}

function allMembersOfTheory(index: DeclarationIndex, theory: TheoryRef, depth: number): Member[] {
  const inside = (e: IndexEntry) => sameArray(e.path, theory.path);
  const found: Member[] = [];
  for (const entry of index.declarationsOf(theory.file)) {
    if (inside(entry) && !entry.clone?.include) found.push({ name: entry.name, entry, home: theory.file });
  }
  for (const clone of index.clonesOf(theory.file)) {
    if (!clone.clone!.include || !inside(clone)) continue;
    for (const m of allThroughClone(index, clone, depth)) found.push({ ...m, home: theory.file });
  }
  return found;
}

/** All the members of the theory `names`, seen from `from`, including what clones bring. */
export function allMembersOf(index: DeclarationIndex, from: TheoryRef, names: string[], depth = 0): Member[] {
  if (depth > MAX_DEPTH) return [];
  return denoted(index, from, names).flatMap((d) =>
    "clone" in d ? allThroughClone(index, d.clone, depth) : allMembersOfTheory(index, d.theory, depth),
  );
}

/**
 * All the members that clones open without a qualifier, as in
 * `openedByClones`: those of `file`, and the top-level `clone include` and
 * `clone export` of the `others` files.
 */
export function allOpenedByClones(index: DeclarationIndex, file: string, others: Iterable<string>): Member[] {
  const found: Member[] = [];
  for (const clone of index.clonesOf(file)) {
    const { include, import: imported, export: exported } = clone.clone!;
    if (include || imported || exported) found.push(...allThroughClone(index, clone, 0));
  }
  for (const other of others) {
    if (other === file) continue;
    for (const clone of index.clonesOf(other)) {
      if (clone.path.length === 0 && (clone.clone!.include || clone.clone!.export)) {
        found.push(...allThroughClone(index, clone, 0));
      }
    }
  }
  return found;
}
