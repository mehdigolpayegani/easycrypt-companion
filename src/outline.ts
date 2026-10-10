// Turns the declarations of a script into an outline tree and into the line
// ranges that can be folded. Independent of VS Code.

import { Declaration } from "./declarations";
import { commentsAndBraces } from "./sentences";

export interface OutlineNode {
  declaration: Declaration;
  children: OutlineNode[];
}

/** Nests declarations inside the theories and sections that contain them. */
export function outlineTree(declarations: Declaration[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const open: OutlineNode[] = [];
  for (const declaration of declarations) {
    while (open.length > 0 && declaration.start >= open[open.length - 1].declaration.end) open.pop();
    const node = { declaration, children: [] };
    (open.length > 0 ? open[open.length - 1].children : roots).push(node);
    if (declaration.kind === "theory" || declaration.kind === "section") open.push(node);
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
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
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
    } else if (d.end > d.signatureEnd) {
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
