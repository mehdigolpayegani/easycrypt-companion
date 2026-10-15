// Reads the lemmas and axioms EasyCrypt prints in the response pane, as
// `search` and `print` show them. Independent of VS Code.

export interface Result {
  /** As the comment above it gives it, `RField.ofintS`, or just `size_cat`. */
  name: string;
  kind: "lemma" | "axiom";
  /** 0-based lines of the result, its comment included. */
  start: number;
  end: number;
  /** Where its short name is. */
  line: number;
  column: number;
  endColumn: number;
}

const NAME = "[A-Za-z_][A-Za-z0-9_']*";
// `local lemma nosmt [tags] name ['a]:`
const HEADER = new RegExp(`^(?:(?:local|declare|global)\\s+)*(lemma|axiom)\\s+(?:nosmt\\s+)?(?:\\[[^\\]]*\\]\\s*)?(${NAME})`);
// EasyCrypt's name for a result that its short name does not reach: `(* RField.ofintS *)`.
const FULL_NAME = new RegExp(`^\\(\\*\\s*((?:${NAME}\\.)+${NAME})\\s*\\*\\)\\s*$`);

export function results(text: string): Result[] {
  const lines = text.split("\n");
  const found: Result[] = [];
  for (let line = 0; line < lines.length; line++) {
    const m = HEADER.exec(lines[line]);
    if (!m) continue;
    const short = m[2];
    const full = line > 0 ? FULL_NAME.exec(lines[line - 1])?.[1] : undefined;
    const named = full !== undefined && full.endsWith(`.${short}`);
    // The statement goes on, indented.
    let end = line;
    while (end + 1 < lines.length && /^\s+\S/.test(lines[end + 1])) end++;
    const column = m[0].length - short.length;
    found.push({
      name: named ? full : short,
      kind: m[1] as Result["kind"],
      start: named ? line - 1 : line,
      end,
      line,
      column,
      endColumn: column + short.length,
    });
  }
  return found;
}

/** The result whose short name is at `column` of `line`, if any. */
export function resultAt(text: string, line: number, column: number): Result | undefined {
  return results(text).find((r) => r.line === line && r.column <= column && column <= r.endColumn);
}
