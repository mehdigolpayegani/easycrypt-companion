// Finds the declarations a name in a script may refer to, by name only:
// first in the same file, then in the files it requires, then anywhere.

import { DeclarationIndex, IndexEntry, theoryOfFile } from "./index";

const QUALIFIED = /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/g;
// EasyCrypt loads these before any script.
const PRELUDE = ["Pervasive", "Logic", "Tactics"];

export interface NameAt {
  /** The name up to the part under the cursor: `Ring` or `Ring.addrC` in `Ring.addrC`. */
  name: string;
  /** Columns of the part under the cursor. */
  start: number;
  end: number;
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
      if (column <= end) return { name: line.slice(m.index, end), start, end };
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
function requiredFiles(index: DeclarationIndex, file: string): Set<string> {
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

function endsWith(path: string[], suffix: string[]): boolean {
  return suffix.length <= path.length && suffix.every((part, i) => part === path[path.length - suffix.length + i]);
}

/**
 * What `name` (possibly qualified) may refer to when used in `file`. A
 * qualifier that matches nothing, such as the alias of a clone, is ignored.
 */
export function resolve(index: DeclarationIndex, file: string | undefined, name: string): Resolution {
  const qualifier = name.split(".");
  const base = qualifier.pop()!;
  let candidates = index.named(base);
  if (qualifier.length > 0) {
    const qualified = candidates.filter((e) => endsWith([theoryOfFile(e.file), ...e.path], qualifier));
    if (qualified.length > 0) candidates = qualified;
  } else {
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

  const required = file === undefined ? new Set<string>() : requiredFiles(index, file);
  const resolution: Resolution = { sameFile: [], required: [], elsewhere: [] };
  for (const entry of candidates) {
    if (entry.file === file) resolution.sameFile.push(entry);
    else if (required.has(entry.file)) resolution.required.push(entry);
    else resolution.elsewhere.push(entry);
  }
  return resolution;
}

/** The nearest declarations found: same file, else required files, else anywhere. */
export function nearest(r: Resolution): IndexEntry[] {
  if (r.sameFile.length > 0) return r.sameFile;
  return r.required.length > 0 ? r.required : r.elsewhere;
}
