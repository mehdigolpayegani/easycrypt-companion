// Chooses the names to suggest while typing: the declarations of the index
// and the words of the open scripts. Independent of VS Code.

import { endsWith } from "./clones";
import { DeclarationIndex, IndexEntry, theoryOfFile } from "./index";
import { appliedModule, inScope, requiredFiles } from "./resolve";

const NAME = "[A-Za-z_][A-Za-z0-9_']*";
// What is being typed: `Ring.add`, `Ring.` or `add`.
const TYPED = new RegExp(`((?:${NAME}\\.)*)(${NAME})?$`);
const WORD = new RegExp(NAME, "g");
// A single letter is too often a local name.
const MIN_LENGTH = 2;
// The names of other files are many: they wait for a third letter.
const MIN_LENGTH_OTHER_FILES = 3;
const MAX_DECLARATIONS = 200;
const MAX_WORDS = 50;

export interface Typed {
  /** The theories or modules before the word: `Ring` in `Ring.add`. */
  qualifier: string[];
  /** The part of the name typed so far, possibly empty after a dot. */
  word: string;
  /** Column where `word` starts. */
  start: number;
}

/** The name being typed just before `column` of `line`, if any. */
export function typedName(line: string, column: number): Typed | undefined {
  const before = line.slice(0, column);
  const m = TYPED.exec(before)!;
  const [, dotted, word = ""] = m;
  // Not a memory (`&m`) or a type variable (`'a`).
  if (before[m.index - 1] === "&" || before[m.index - 1] === "'") return undefined;
  // `G(A).ma`: the module comes before its arguments.
  const qualifier = (appliedModule(before, m.index) + dotted).split(".").slice(0, -1);
  if (qualifier.length === 0 && !word) return undefined;
  return { qualifier, word, start: column - word.length };
}

/** How far a suggestion comes from; nearer ones are listed first. */
export enum Near {
  File,
  Word,
  Required,
  Elsewhere,
}

export interface Suggestion {
  name: string;
  near: Near;
  /** The declaration; none for a plain word of a script. */
  entry?: IndexEntry;
  /** The theory to `require` before the name can be used. */
  needs?: string;
}

export interface Suggestions {
  items: Suggestion[];
  /** False if there were too many: typing more gives other ones. */
  complete: boolean;
}

interface Ranked extends Suggestion {
  /** Where the name has what was typed: 0 at its start, 1 at the start of a later part. */
  rank: number;
}

/** Undefined unless `typed` starts `name` or one of its parts; VS Code shows nothing else. */
function rankOf(typed: string, name: string): number | undefined {
  const lower = name.toLowerCase();
  for (let at = lower.indexOf(typed); at >= 0; at = lower.indexOf(typed, at + 1)) {
    if (at === 0) return 0;
    // `cat` in `size_cat`, `C` in `addrC`
    if (name[at - 1] === "_" || name[at] !== lower[at]) return 1;
  }
  return undefined;
}

/** Best first: by rank, then nearness, then length. */
function best(items: Ranked[], limit: number): Ranked[] {
  items.sort(
    (a, b) => a.rank - b.rank || a.near - b.near || a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return items.slice(0, limit);
}

/** The declarations matching `typed`, inside `qualifier` if there is one; the nearest of each name. */
function declarations(
  index: DeclarationIndex,
  file: string | undefined,
  line: number,
  qualifier: string[],
  typed: string,
): Ranked[] {
  // Without knowing what the script requires, nothing is marked.
  const known = file !== undefined && index.has(file);
  const required = known ? requiredFiles(index, file) : new Set<string>();
  const byName = new Map<string, Ranked>();
  const add = (found: Ranked) => {
    const previous = byName.get(found.name);
    if (!previous || found.near < previous.near) byName.set(found.name, found);
  };

  for (const other of index.files()) {
    const near = other === file ? Near.File : required.has(other) ? Near.Required : Near.Elsewhere;
    const theory = theoryOfFile(other);
    for (const entry of index.declarationsOf(other)) {
      // Sections and operators such as `(+)` are not typed as names.
      if (entry.kind === "section" || !/^[A-Za-z_]/.test(entry.name)) continue;
      const rank = rankOf(typed, entry.name);
      if (rank === undefined) continue;
      const fits =
        qualifier.length > 0
          ? endsWith([theory, ...entry.path], qualifier)
          : inScope(entry, file, line) && (near === Near.File || typed.length >= MIN_LENGTH_OTHER_FILES);
      if (!fits) continue;
      const found: Ranked = { name: entry.name, near, entry, rank };
      if (known && near === Near.Elsewhere) found.needs = theory;
      add(found);
    }
    // A file is a theory too.
    const named = qualifier.length === 0 && other !== file && typed.length >= MIN_LENGTH_OTHER_FILES;
    const rank = named ? rankOf(typed, theory) : undefined;
    if (rank !== undefined) {
      const position = { line: 0, column: 0, endColumn: 0 };
      const entry: IndexEntry = { file: other, kind: "theory", name: theory, path: [], ...position, signature: "" };
      add({ name: theory, near, entry, rank });
    }
  }
  return [...byName.values()];
}

/** The words of `texts` matching `typed`, other than those to `skip`. */
function words(texts: string[], typed: string, skip: (word: string) => boolean): Ranked[] {
  const seen = new Set<string>();
  const found: Ranked[] = [];
  for (const text of texts) {
    for (const [word] of text.matchAll(WORD)) {
      if (seen.has(word)) continue;
      seen.add(word);
      const rank = word.length < MIN_LENGTH || skip(word) ? undefined : rankOf(typed, word);
      if (rank !== undefined) found.push({ name: word, near: Near.Word, rank });
    }
  }
  return found;
}

/**
 * What to suggest for `typed` at `line` of `file`. `texts` are the open
 * scripts: their words are suggested too.
 */
export function suggest(
  index: DeclarationIndex,
  file: string | undefined,
  line: number,
  typed: Typed,
  texts: string[] = [],
): Suggestions {
  const lower = typed.word.toLowerCase();
  let { qualifier } = typed;
  if (qualifier.length === 0 && lower.length < MIN_LENGTH) return { items: [], complete: true };

  let declared = declarations(index, file, line, qualifier, lower);
  // The first names may be those of a clone: `RO.Lazy.` for `Lazy.`.
  while (declared.length === 0 && qualifier.length > 1) {
    qualifier = qualifier.slice(1);
    declared = declarations(index, file, line, qualifier, lower);
  }
  if (qualifier.length > 0) {
    // A nearer theory or module of that name hides the others.
    const nearest = Math.min(...declared.map((d) => d.near));
    declared = declared.filter((d) => d.near === nearest);
  }
  const names = new Set(declared.map((d) => d.name));
  const plain =
    typed.qualifier.length > 0 ? [] : words(texts, lower, (word) => word === typed.word || names.has(word));

  const items = [...best(declared, MAX_DECLARATIONS), ...best(plain, MAX_WORDS)];
  const complete = declared.length <= MAX_DECLARATIONS && plain.length <= MAX_WORDS;
  return { items: items.map(({ rank: _, ...suggestion }) => suggestion), complete };
}
