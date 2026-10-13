// Turns the declarations of a script into an outline tree and into the line
// ranges that can be folded. Independent of VS Code.

import { Declaration, DeclarationKind } from "./declarations";
import { commentsAndBraces, lineAt, lineStartsOf } from "./sentences";

export interface OutlineNode {
  declaration: Declaration;
  children: OutlineNode[];
}

const CONTAINERS = new Set<DeclarationKind>(["theory", "section", "module", "module type"]);

/** Nests declarations inside the theories, sections and modules that contain them. */
export function outlineTree(declarations: Declaration[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  for (const declaration of declarations) {
    while (open.length > 0 && declaration.start >= open[open.length - 1].declaration.end) open.pop();
    const node = { declaration, children: [] };
    (open.length > 0 ? open[open.length - 1].children : roots).push(node);
    if (CONTAINERS.has(declaration.kind)) open.push(node);
  }
  return roots;
}

/** Lines `start + 1` to `end` (0-based) are hidden when the range is folded. */
export interface FoldingRange {
  start: number;
  end: number;
  comment?: true;
}

/** What can be folded: proofs, theories, sections, `{ }` blocks, long declarations and comments. */
export function foldingRanges(text: string, declarations: Declaration[]): FoldingRange[] {
  const lineStarts = lineStartsOf(text);
  const lineOf = (offset: number) => lineAt(lineStarts, offset);
  const lineStartsWith = (line: number, prefix: string) => {
    let i = lineStarts[line];
    while (text[i] === " " || text[i] === "\t") i++;
    return text.startsWith(prefix, i);
  };

  /** The widest range starting on each line; VS Code allows one per line. */
  const byStart = new Map<number, FoldingRange>();
  const add = (start: number, end: number, comment?: true) => {
    if (end <= start || (byStart.get(start)?.end ?? -1) >= end) return;
    byStart.set(start, comment ? { start, end, comment } : { start, end });
  };

  for (const d of declarations) {
    const first = lineOf(d.start);
    const last = lineOf(d.end - 1);
    if (d.kind === "theory" || d.kind === "section") {
      // Keep the closing `end T.` visible.
      add(first, lineStartsWith(last, "end") ? last - 1 : last);
    } else if (d.kind === "lemma" && d.end > d.signatureEnd) {
      // A proof: the statement stays visible.
      add(lineOf(d.signatureEnd - 1), last);
    } else {
      add(first, lineStartsWith(last, "}") ? last - 1 : last);
    }
  }

  const { comments, braces } = commentsAndBraces(text);
  for (const c of comments) add(lineOf(c.start), lineOf(c.end - 1), true);
  // Keep the closing brace visible.
  for (const b of braces) add(lineOf(b.start), lineOf(b.end - 1) - 1);

  return [...byStart.values()].sort((a, b) => a.start - b.start);
}
