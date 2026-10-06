// Splits a script into sentences like EasyCrypt's lexer (src/ecLexer.mll):
// a sentence ends at a `.` before whitespace, outside comments and strings.

export interface Sentence {
  /** Where scanning started: the end of the previous sentence. */
  start: number;
  /** First character that is not whitespace or a comment. */
  contentStart: number;
  /** Just after the final `.`. */
  end: number;
}

// The lexer's `binop`.
const BINOP = "(?:[=<>+\\-*/\\\\%&^|:#$]+|`[=<>+\\-*/\\\\%&^|:#$]+`|\\\\[A-Za-z0-9_']+)";
// A parenthesised operator: `(*)`, `( + )`.
const PAREN_OP_RE = new RegExp(`\\([ \\t\\r]*${BINOP}[ \\t\\r]*\\)`, "y");
// `(*op*)`, e.g. `(*-----*)`: skipped by the lexer like a comment.
const STAR_OP_RE = new RegExp(`\\(\\*${BINOP}\\*\\)`, "y");

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

function matchAt(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0].length : 0;
}

/** Classifies the `(` at `i` like ocamllex: longest match, then first rule. */
function classifyParen(text: string, i: number): { kind: "skip" | "operator"; next: number } | undefined {
  const skip = matchAt(STAR_OP_RE, text, i);
  const op = matchAt(PAREN_OP_RE, text, i);
  if (skip > 0 && skip >= op) return { kind: "skip", next: i + skip };
  if (op > 0) return { kind: "operator", next: i + op };
  return undefined;
}

/** Offset after the parenthesised operator at `i`, if any. */
function skipOperatorParen(text: string, i: number): number | undefined {
  const c = classifyParen(text, i);
  return c?.kind === "operator" ? c.next : undefined;
}

/** Offset after the comment opened at `i`; undefined if unterminated. */
function skipComment(text: string, i: number): number | undefined {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    if (text[j] === "(" && text[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (text[j] === "*" && text[j + 1] === ")") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return undefined;
}

/** Offset after the string opened at `i`; undefined if unterminated. */
function skipString(text: string, i: number): number | undefined {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j++;
  }
  return undefined;
}

/** Offset after the comment at `i`: null if unterminated, undefined if none. */
function commentAt(text: string, i: number): number | null | undefined {
  if (text[i] !== "(" || text[i + 1] !== "*") return undefined;
  const paren = classifyParen(text, i);
  if (paren?.kind === "skip") return paren.next;
  if (paren?.kind === "operator") return undefined;
  return skipComment(text, i) ?? null;
}

/** First offset from `from` that is not whitespace or a comment, if any. */
export function skipBlanksAndComments(text: string, from: number): number | undefined {
  let i = from;
  while (i < text.length) {
    if (isBlank(text[i])) {
      i++;
      continue;
    }
    const comment = commentAt(text, i);
    if (comment === null) return undefined;
    if (comment === undefined) return i;
    i = comment;
  }
  return undefined;
}

/** The next complete sentence from `from`, if any. */
export function nextSentence(text: string, from: number): Sentence | undefined {
  const contentStart = skipBlanksAndComments(text, from);
  if (contentStart === undefined) return undefined;

  let i = contentStart;
  while (i < text.length) {
    const c = text[i];
    if (c === "(") {
      const comment = commentAt(text, i);
      if (comment === null) return undefined;
      i = comment ?? skipOperatorParen(text, i) ?? i + 1;
    } else if (c === '"') {
      const next = skipString(text, i);
      if (next === undefined) return undefined;
      i = next;
    } else if (c === ".") {
      if (text[i + 1] === ".") {
        i += 2; // `..` is a single token
      } else if (i + 1 >= text.length || isBlank(text[i + 1])) {
        return { start: from, contentStart, end: i + 1 };
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return undefined;
}

/** All complete sentences from `from`. */
export function sentencesFrom(text: string, from: number): Sentence[] {
  const result: Sentence[] = [];
  let s = nextSentence(text, from);
  while (s) {
    result.push(s);
    s = nextSentence(text, s.end);
  }
  return result;
}

/** Where Proof General puts the cursor after processing up to `offset`. */
export function followPosition(text: string, offset: number): number {
  let i = offset;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  if (text[i] === "\n") return i + 1;
  return i;
}

/** `offset` moved back over whitespace. */
export function skipBlanksBackward(text: string, offset: number): number {
  let i = Math.min(offset, text.length);
  while (i > 0 && isBlank(text[i - 1])) i--;
  return i;
}

/** Converts a UTF-8 byte offset into `s`, as EasyCrypt reports them, to a string offset. */
export function byteToCharOffset(s: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = Buffer.from(s, "utf8");
  if (byteOffset >= bytes.length) return s.length;
  return bytes.subarray(0, byteOffset).toString("utf8").length;
}
