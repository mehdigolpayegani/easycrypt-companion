// Splits an EasyCrypt script into sentences the way EasyCrypt's lexer does
// (src/ecLexer.mll): a sentence ends at a `.` followed by a blank, a newline
// or the end of input, outside comments and strings.

export interface Sentence {
  /** Offset where scanning for this sentence started (end of the previous one). */
  start: number;
  /** First offset that is not whitespace or a comment: what is sent to EasyCrypt. */
  contentStart: number;
  /** Offset just after the terminating `.`. */
  end: number;
}

// `binop` in the lexer: opchar+ | '`' opchar+ '`' | '\\' ichar+
const BINOP = "(?:[=<>+\\-*/\\\\%&^|:#$]+|`[=<>+\\-*/\\\\%&^|:#$]+`|\\\\[A-Za-z0-9_']+)";
// `'(' blank* binop blank* ')'`: a parenthesised operator such as `(*)` or `( + )`.
const PAREN_OP_RE = new RegExp(`\\([ \\t\\r]*${BINOP}[ \\t\\r]*\\)`, "y");
// `"(*" binop "*)"`: skipped by the lexer like a comment, e.g. `(*-----*)`.
const STAR_OP_RE = new RegExp(`\\(\\*${BINOP}\\*\\)`, "y");

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

function matchAt(re: RegExp, text: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0].length : 0;
}

/**
 * Classifies the `(` at `i` as ocamllex would (longest match, then the rule
 * listed first): a skipped `(*op*)`, a parenthesised operator, or neither.
 */
function classifyParen(text: string, i: number): { kind: "skip" | "operator"; next: number } | undefined {
  const skip = matchAt(STAR_OP_RE, text, i);
  const op = matchAt(PAREN_OP_RE, text, i);
  if (skip > 0 && skip >= op) return { kind: "skip", next: i + skip };
  if (op > 0) return { kind: "operator", next: i + op };
  return undefined;
}

/** If `text[i]` opens a parenthesised operator such as `(*)`, the offset after it. */
function skipOperatorParen(text: string, i: number): number | undefined {
  const c = classifyParen(text, i);
  return c?.kind === "operator" ? c.next : undefined;
}

/** Returns the offset after the comment opened at `i`, or undefined if unterminated. */
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

/** Returns the offset after the string opened at `i`, or undefined if unterminated. */
function skipString(text: string, i: number): number | undefined {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j++;
  }
  return undefined;
}

/**
 * If a comment (or a skipped `(*op*)`) starts at `i`: the offset after it, or
 * null if it is unterminated. Undefined if no comment starts at `i`.
 */
function commentAt(text: string, i: number): number | null | undefined {
  if (text[i] !== "(" || text[i + 1] !== "*") return undefined;
  const paren = classifyParen(text, i);
  if (paren?.kind === "skip") return paren.next;
  if (paren?.kind === "operator") return undefined;
  return skipComment(text, i) ?? null;
}

/**
 * Offset of the first character at or after `from` that is not whitespace or
 * part of a comment, or undefined if there is none (end of text or an
 * unterminated comment).
 */
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

/** The next complete sentence starting at `from`, or undefined if there is none. */
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

/** All complete sentences starting at `from`, in order. */
export function sentencesFrom(text: string, from: number): Sentence[] {
  const result: Sentence[] = [];
  let s = nextSentence(text, from);
  while (s) {
    result.push(s);
    s = nextSentence(text, s.end);
  }
  return result;
}

/**
 * Where the cursor goes after processing up to `offset` (Proof General's
 * `proof-script-next-command-advance`): past spaces and tabs, and to the start
 * of the next line if the rest of the line is empty.
 */
export function followPosition(text: string, offset: number): number {
  let i = offset;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
  if (text[i] === "\n") return i + 1;
  return i;
}

/** `offset` moved back over whitespace, as Proof General does before "process to point". */
export function skipBlanksBackward(text: string, offset: number): number {
  let i = Math.min(offset, text.length);
  while (i > 0 && isBlank(text[i - 1])) i--;
  return i;
}

/**
 * Converts a byte offset into `s` (as EasyCrypt reports error locations, in
 * UTF-8 bytes) into a JavaScript string offset.
 */
export function byteToCharOffset(s: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = Buffer.from(s, "utf8");
  if (byteOffset >= bytes.length) return s.length;
  return bytes.subarray(0, byteOffset).toString("utf8").length;
}
