// The declarations of many files, searchable by name. Independent of VS Code.

import { DeclarationKind, parseDeclarations } from "./declarations";

export interface IndexEntry {
  file: string;
  kind: DeclarationKind;
  name: string;
  /** Enclosing theories, outermost first. */
  path: string[];
  /** Position of the name, 0-based. */
  line: number;
  column: number;
  endColumn: number;
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
  private readonly byFile = new Map<string, IndexEntry[]>();

  /** Replaces what is known about `file` with the declarations of `text`. */
  update(file: string, text: string): void {
    const lineStarts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    let line = 0;
    const entries: IndexEntry[] = [];
    // Names come in source order, so the line only moves forward.
    for (const d of parseDeclarations(text)) {
      if (!d.name) continue; // an unnamed section
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= d.nameStart) line++;
      const column = d.nameStart - lineStarts[line];
      entries.push({
        file,
        kind: d.kind,
        name: d.name,
        path: d.path,
        line,
        column,
        endColumn: column + (d.nameEnd - d.nameStart),
      });
    }
    this.byFile.set(file, entries);
  }

  remove(file: string): void {
    this.byFile.delete(file);
  }

  has(file: string): boolean {
    return this.byFile.has(file);
  }

  /** Number of declarations. */
  get size(): number {
    let n = 0;
    for (const entries of this.byFile.values()) n += entries.length;
    return n;
  }

  /** Declarations whose name matches `query`, best matches first. Case is ignored. */
  search(query: string, limit = 500): IndexEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const found: Array<{ entry: IndexEntry; rank: number }> = [];
    for (const entries of this.byFile.values()) {
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
