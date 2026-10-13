// The declarations of many files, searchable by name. Independent of VS Code.

import { basename } from "node:path";
import { Declaration, DeclarationKind, parseDeclarations, Rename, requiredTheories } from "./declarations";
import { lineAt, lineStartsOf } from "./sentences";

export interface IndexEntry {
  file: string;
  kind: DeclarationKind;
  name: string;
  /** Enclosing theories, then modules for a `var` or `proc`, outermost first. */
  path: string[];
  /** Position of the name, 0-based. */
  line: number;
  column: number;
  endColumn: number;
  /** The declaring sentence, cut short if long. */
  signature: string;
  clone?: CloneInfo;
  /** For a `var` or `proc`: the lines of its module, where its bare name can be used. */
  scope?: { start: number; end: number };
}

export interface CloneInfo {
  /** The theory copied, as written: `Ring.ComRing`. */
  source: string;
  /** `clone include`: the copy becomes part of the enclosing theory. */
  include: boolean;
  import: boolean;
  export: boolean;
  renames: Rename[];
}

interface FileEntries {
  entries: IndexEntry[];
  clones: IndexEntry[];
  requires: string[];
}

const MAX_SIGNATURE_LINES = 12;
const MAX_SIGNATURE_LENGTH = 1200;

/** `List` for `/lib/List.ec`: a file is a theory named after it. */
export function theoryOfFile(file: string): string {
  return basename(file).replace(/\.eca?$/, "");
}

/** `text` without the indentation of its first line, cut to a few lines. */
function signatureOf(text: string, indent: number): string {
  const indentation = new RegExp(`^[ \\t]{0,${indent}}`);
  const lines = text.split("\n").map((line, i) => (i === 0 ? line : line.replace(indentation, "")));
  const kept = lines.slice(0, MAX_SIGNATURE_LINES).join("\n");
  if (lines.length <= MAX_SIGNATURE_LINES && kept.length <= MAX_SIGNATURE_LENGTH) return kept;
  return `${kept.slice(0, MAX_SIGNATURE_LENGTH)}\n\u2026`;
}

/**
 * How well `name` matches `query`, lower being better: equal, prefix,
 * substring, then letters in order. Undefined if it does not match.
 */
function matchRank(query: string, name: string): number | undefined {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  let i = 0;
  for (const c of name) if (c === query[i]) i++;
  return i === query.length ? 3 : undefined;
}

export class DeclarationIndex {
  private readonly byFile = new Map<string, FileEntries>();
  /** Lookup tables, rebuilt on demand after a change. */
  private byName?: Map<string, IndexEntry[]>;
  private byTheory?: Map<string, string[]>;

  /** Replaces what is known about `file` with the declarations of `text`. */
  update(file: string, text: string): void {
    const lineStarts = lineStartsOf(text);
    const entries: IndexEntry[] = [];
    /** The modules around the declaration being read, outermost first. */
    const modules: Declaration[] = [];
    for (const d of parseDeclarations(text)) {
      if (!d.name) continue; // an unnamed section
      while (modules.length > 0 && d.start >= modules[modules.length - 1].end) modules.pop();
      const line = lineAt(lineStarts, d.nameStart);
      const column = d.nameStart - lineStarts[line];
      const indent = d.start - (text.lastIndexOf("\n", d.start - 1) + 1);
      const entry: IndexEntry = {
        file,
        kind: d.kind,
        name: d.name,
        path: d.path,
        line,
        column,
        endColumn: column + (d.nameEnd - d.nameStart),
        signature: signatureOf(text.slice(d.start, d.signatureEnd), indent),
      };
      if (d.kind === "clone" && d.source !== undefined) {
        const flags = d.keyword.split(" ");
        entry.clone = {
          source: d.source,
          include: flags.includes("include"),
          import: flags.includes("import"),
          export: flags.includes("export"),
          renames: d.renames ?? [],
        };
      }
      const owner = modules[modules.length - 1];
      if (owner && (d.kind === "var" || d.kind === "proc")) {
        entry.scope = { start: lineAt(lineStarts, owner.start), end: lineAt(lineStarts, owner.end - 1) };
      }
      if (d.kind === "module" || d.kind === "module type") modules.push(d);
      entries.push(entry);
    }
    const clones = entries.filter((e) => e.clone !== undefined);
    this.byFile.set(file, { entries, clones, requires: requiredTheories(text) });
    this.byName = this.byTheory = undefined;
  }

  remove(file: string): void {
    this.byFile.delete(file);
    this.byName = this.byTheory = undefined;
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }

  /** Number of declarations. */
  get size(): number {
    let n = 0;
    for (const { entries } of this.byFile.values()) n += entries.length;
    return n;
  }

  /** Declarations called exactly `name`. */
  named(name: string): IndexEntry[] {
    if (!this.byName) {
      this.byName = new Map();
      for (const { entries } of this.byFile.values()) {
        for (const entry of entries) {
          const same = this.byName.get(entry.name);
          if (same) same.push(entry);
          else this.byName.set(entry.name, [entry]);
        }
      }
    }
    return this.byName.get(name) ?? [];
  }

  /** The files that are the theory `name`, e.g. `List.ec` for `List`. */
  filesOfTheory(name: string): string[] {
    if (!this.byTheory) {
      this.byTheory = new Map();
      for (const file of this.byFile.keys()) {
        const theory = theoryOfFile(file);
        const same = this.byTheory.get(theory);
        if (same) same.push(file);
        else this.byTheory.set(theory, [file]);
      }
    }
    return this.byTheory.get(name) ?? [];
  }

  /** The indexed files. */
  files(): Iterable<string> {
    return this.byFile.keys();
  }

  /** The declarations of `file`, in source order. */
  declarationsOf(file: string): IndexEntry[] {
    return this.byFile.get(file)?.entries ?? [];
  }

  /** The clones declared in `file`. */
  clonesOf(file: string): IndexEntry[] {
    return this.byFile.get(file)?.clones ?? [];
  }

  /** The theories `file` loads with `require`. */
  requiresOf(file: string): string[] {
    return this.byFile.get(file)?.requires ?? [];
  }

  /** Declarations whose name matches `query`, best matches first. Case is ignored. */
  search(query: string, limit = 500): IndexEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const found: Array<{ entry: IndexEntry; rank: number }> = [];
    for (const { entries } of this.byFile.values()) {
      for (const entry of entries) {
        const rank = matchRank(q, entry.name.toLowerCase());
        if (rank !== undefined) found.push({ entry, rank });
      }
    }
    found.sort(
      (a, b) =>
        a.rank - b.rank || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name),
    );
    return found.slice(0, limit).map((f) => f.entry);
  }
}
