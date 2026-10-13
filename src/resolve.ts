// Finds the declarations a name in a script may refer to, by name only:
// first in the same file, then in the files it requires, then anywhere.

import { endsWith, membersOf, openedByClones } from "./clones";
import { DeclarationIndex, IndexEntry, theoryOfFile } from "./index";

const QUALIFIED = /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/g;
// EasyCrypt loads these before any script.
const PRELUDE = ["Pervasive", "Logic", "Tactics"];
// A module name at the end of a text.
const MODULE_BEFORE = /[A-Za-z_][A-Za-z0-9_'.]*$/;

export interface NameAt {
  /**
   * The name up to the part under the cursor: `Ring` or `Ring.addrC` in
   * `Ring.addrC`. Module arguments are left out: `G.main` in `G(A).main`.
   */
  name: string;
  /** Columns of the part under the cursor. */
  start: number;
  end: number;
}

/** `G.` if the name at `start` follows the applied module `G(A, B).`, else nothing. */
export function appliedModule(line: string, start: number): string {
  let prefix = "";
  while (line[start - 1] === "." && line[start - 2] === ")") {
    let open = start - 2;
    for (let depth = 0; open >= 0; open--) {
      if (line[open] === ")") depth++;
      else if (line[open] === "(" && --depth === 0) break;
    }
    const applied = MODULE_BEFORE.exec(line.slice(0, Math.max(open, 0)));
    if (!applied) break;
    prefix = `${applied[0]}.${prefix}`;
    start = applied.index;
  }
  return prefix;
}

/** The name at `column` of `line`, if any. Type variables (`'a`) and memories (`&m`) are not names. */
export function nameAt(line: string, column: number): NameAt | undefined {
  QUALIFIED.lastIndex = 0;
  for (let m = QUALIFIED.exec(line); m && m.index <= column; m = QUALIFIED.exec(line)) {
    if (column > m.index + m[0].length) continue;
    const before = line[m.index - 1];
    if (before === "&" || (before === "'" && !/[A-Za-z0-9_']/.test(line[m.index - 2] ?? " "))) return undefined;
    let start = m.index;
    for (const part of m[0].split(".")) {
      const end = start + part.length;
      if (column <= end) return { name: appliedModule(line, m.index) + line.slice(m.index, end), start, end };
      start = end + 1;
    }
  }
  return undefined;
}

export interface Resolution {
  sameFile: IndexEntry[];
  /** In files reached through `require`, directly or not. */
  required: IndexEntry[];
  elsewhere: IndexEntry[];
}

/** The files `file` loads: the prelude and what it requires, directly or through other files. */
export function requiredFiles(index: DeclarationIndex, file: string): Set<string> {
  const files = new Set<string>();
  const theories = new Set<string>();
  const queue = [...PRELUDE, ...index.requiresOf(file)];
  for (let theory = queue.pop(); theory !== undefined; theory = queue.pop()) {
    if (theories.has(theory)) continue;
    theories.add(theory);
    for (const required of index.filesOfTheory(theory)) {
      if (files.has(required)) continue;
      files.add(required);
      queue.push(...index.requiresOf(required));
    }
  }
  return files;
}

/** Whether `e` can be named without a qualifier at `line` of `file`: a `var` or `proc` only inside its module. */
export function inScope(e: IndexEntry, file: string | undefined, line: number | undefined): boolean {
  return !e.scope || (e.file === file && line !== undefined && e.scope.start <= line && line <= e.scope.end);
}

/**
 * What `name` (possibly qualified) may refer to when used in `file`, at
 * `line` if known. Clones are followed to the theory they copy. A qualifier
 * that still matches nothing is ignored.
 */
export function resolve(index: DeclarationIndex, file: string | undefined, name: string, line?: number): Resolution {
  const qualifier = name.split(".");
  const base = qualifier.pop()!;
  const required = file === undefined ? new Set<string>() : requiredFiles(index, file);
  let candidates = index.named(base);
  if (qualifier.length > 0) {
    const within = (q: string[]) => candidates.filter((e) => endsWith([theoryOfFile(e.file), ...e.path], q));
    let qualified = within(qualifier);
    if (qualified.length === 0) qualified = membersOf(index, { file: file ?? "", path: [] }, qualifier, base);
    // The first names may be those of a clone: `RO.Lazy.m` for `Lazy.m`.
    for (let q = qualifier.slice(1); q.length > 0 && qualified.length === 0; q = q.slice(1)) qualified = within(q);
    if (qualified.length > 0) candidates = qualified;
  } else {
    candidates = candidates.filter((e) => inScope(e, file, line));
    // A file is a theory too: `List` is List.ec.
    const files = index.filesOfTheory(base).map((path): IndexEntry => ({
      file: path,
      kind: "theory",
      name: base,
      path: [],
      line: 0,
      column: 0,
      endColumn: 0,
      signature: "",
    }));
    candidates = [...candidates, ...files];
  }

  const resolution: Resolution = { sameFile: [], required: [], elsewhere: [] };
  for (const entry of candidates) {
    if (entry.file === file) resolution.sameFile.push(entry);
    else if (required.has(entry.file)) resolution.required.push(entry);
    else resolution.elsewhere.push(entry);
  }
  // Nothing nearby under that name: it may come from a clone, perhaps renamed.
  if (file !== undefined && qualifier.length === 0 && resolution.sameFile.length + resolution.required.length === 0) {
    const opened = new Set(openedByClones(index, file, required, base));
    resolution.required = [...opened];
    resolution.elsewhere = resolution.elsewhere.filter((e) => !opened.has(e));
  }
  return resolution;
}

/** The nearest declarations found: same file, else required files, else anywhere. */
export function nearest(r: Resolution): IndexEntry[] {
  if (r.sameFile.length > 0) return r.sameFile;
  return r.required.length > 0 ? r.required : r.elsewhere;
}
