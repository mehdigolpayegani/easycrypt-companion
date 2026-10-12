// Lists what an EasyCrypt script declares (lemmas, operators, types, modules,
// theories, ...) from the way each sentence starts. Text only: no EasyCrypt.

import { nextSentence, Sentence, skipBlanksAndComments } from "./sentences";

export type DeclarationKind =
  | "lemma"
  | "axiom"
  | "op"
  | "pred"
  | "abbrev"
  | "type"
  | "module"
  | "module type"
  | "theory"
  | "section"
  | "clone";

export interface Declaration {
  kind: DeclarationKind;
  /** As written: `addrC`, `(+)`, `[-]`, `"_.[_]"`. Empty for an unnamed section. */
  name: string;
  /** The keywords used, e.g. `local lemma`, `abstract theory`, `equiv`. */
  keyword: string;
  /** Enclosing theories, outermost first. */
  path: string[];
  nameStart: number;
  nameEnd: number;
  /** Start of the declaring sentence. */
  start: number;
  /** End of the declaring sentence. */
  signatureEnd: number;
  /** End of the whole declaration: after `qed.` for a lemma, after `end T.` for a theory. */
  end: number;
  /** For a clone: the theory it copies. */
  source?: string;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_']*/y;
const QUALIFIED = /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/y;
// `(+)`, `( - )`, `(\in)`
const PAREN_OPERATOR = /\(\s*(?:[=<>+\-*/\\%&^|:#$]+|`[^`\s]+`|\\[A-Za-z0-9_']+)\s*\)/y;
// `[-]`, `[!]`: prefix operators, unlike attributes such as `[opaque]`
const BRACKET_OPERATOR = /\[\s*(?:[-+]+|!|\\[A-Za-z0-9_']+)\s*\]/y;
const ATTRIBUTES = /\[[^\]]*\]/y;
const STRING_NAME = /"[^"\n]*"/y;
const TYPE_VARIABLE = /'[A-Za-z_][A-Za-z0-9_']*/y;
const PARENTHESES = /\([^)]*\)/y;
// `op n : { int | 0 < n } as gt0_n.` also declares the axiom `gt0_n`.
const AS_AXIOM = /\}\s*as\s+([A-Za-z_][A-Za-z0-9_']*)\s*\.$/;

const MODIFIERS = new Set(["local", "declare", "abstract", "global"]);
const GOAL_KEYWORDS = new Set(["lemma", "equiv", "hoare", "phoare", "ehoare"]);
const PROOF_END = new Set(["qed", "admitted", "abort"]);
// A sentence starting with one of these cannot be a tactic. `hoare` and
// friends are left out: inside a proof they are tactics.
const TOP_LEVEL = new Set([
  ...MODIFIERS,
  ...["lemma", "axiom", "op", "pred", "abbrev", "const", "inductive", "type", "subtype", "module"],
  ...["theory", "section", "end", "clone", "require", "import", "export", "from", "hint", "realize"],
  ...["instance", "notation", "exception"],
]);
const CLONE_FLAGS = new Set(["import", "export", "include"]);
const SIMPLE_KINDS: Record<string, DeclarationKind> = {
  op: "op",
  const: "op",
  pred: "pred",
  inductive: "pred",
  abbrev: "abbrev",
};

/** Reads tokens of one sentence, skipping blanks and comments. */
class Reader {
  constructor(
    private readonly text: string,
    private pos: number,
    private readonly limit: number,
  ) {}

  private skip(): boolean {
    const p = skipBlanksAndComments(this.text, this.pos);
    this.pos = p === undefined || p >= this.limit ? this.limit : p;
    return this.pos < this.limit;
  }

  /** The token matching `re` at the cursor, if any. */
  match(re: RegExp): Token | undefined {
    if (!this.skip()) return undefined;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m || this.pos + m[0].length > this.limit) return undefined;
    const token = { text: m[0], start: this.pos, end: this.pos + m[0].length };
    this.pos = token.end;
    return token;
  }

  peekWord(): Token | undefined {
    const saved = this.pos;
    const token = this.match(IDENT);
    this.pos = saved;
    return token;
  }

  word(): Token | undefined {
    return this.match(IDENT);
  }

  /** Consumes the next word if it is `word`. */
  accept(word: string): boolean {
    if (this.peekWord()?.text !== word) return false;
    this.word();
    return true;
  }

  peekChar(): string | undefined {
    return this.skip() ? this.text[this.pos] : undefined;
  }

  skipAttributes(): void {
    while (this.peekChar() === "[" && !this.peekBracketOperator()) {
      if (!this.match(ATTRIBUTES)) return;
    }
  }

  private peekBracketOperator(): boolean {
    const saved = this.pos;
    const found = this.match(BRACKET_OPERATOR) !== undefined;
    this.pos = saved;
    return found;
  }

  /** A declared name: an identifier, an operator such as `(+)` or `[-]`, or `"_.[_]"`. */
  name(): Token | undefined {
    this.skipAttributes();
    const operator = this.match(BRACKET_OPERATOR) ?? this.match(PAREN_OPERATOR);
    if (operator) return { ...operator, text: operator.text.replace(/\s+/g, "") };
    return this.match(STRING_NAME) ?? this.match(IDENT);
  }

  /** Whether only the final `.` is left. */
  atEnd(): boolean {
    this.skip();
    return this.pos >= this.limit - 1;
  }
}

/** Whether `word` occurs in [from, end) outside comments and strings. */
function hasWord(text: string, from: number, end: number, word: string): boolean {
  let i = from;
  for (;;) {
    const next = skipBlanksAndComments(text, i);
    if (next === undefined || next >= end) return false;
    i = next;
    if (text[i] === '"') {
      i++;
      while (i < end && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    IDENT.lastIndex = i;
    const m = IDENT.exec(text);
    if (!m) {
      i++;
    } else if (m[0] === word) {
      return true;
    } else {
      i += m[0].length;
    }
  }
}

export function parseDeclarations(text: string): Declaration[] {
  const declarations: Declaration[] = [];
  /** Open theories and sections, outermost first. */
  const scopes: Declaration[] = [];
  /** Set while inside a proof; `lemma` is missing for `realize`. */
  let proof: { lemma?: Declaration } | undefined;
  let previousEnd = 0;

  const add = (kind: DeclarationKind, name: Token, keyword: string, s: Sentence, source?: string): Declaration => {
    const declaration: Declaration = {
      kind,
      name: name.text,
      keyword,
      path: scopes.filter((d) => d.kind === "theory").map((d) => d.name),
      nameStart: name.start,
      nameEnd: name.end,
      start: s.contentStart,
      signatureEnd: s.end,
      end: s.end,
    };
    if (source !== undefined) declaration.source = source;
    declarations.push(declaration);
    return declaration;
  };

  const closeScope = (kind: "theory" | "section", name: string | undefined, end: number) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].kind === kind && (name === undefined || scopes[i].name === name)) {
        for (const closed of scopes.splice(i)) closed.end = end;
        return;
      }
    }
  };

  const closeProof = (end: number) => {
    if (proof?.lemma) proof.lemma.end = end;
    proof = undefined;
  };

  const topLevel = (s: Sentence) => {
    const r = new Reader(text, s.contentStart, s.end);
    const words: string[] = [];
    let keyword = r.word();
    while (keyword && MODIFIERS.has(keyword.text)) {
      words.push(keyword.text);
      keyword = r.word();
    }
    if (!keyword) return;
    words.push(keyword.text);
    const label = () => words.join(" ");

    if (GOAL_KEYWORDS.has(keyword.text) || keyword.text === "axiom") {
      r.skipAttributes();
      const name = r.word();
      if (!name) return;
      const kind = keyword.text === "axiom" ? "axiom" : "lemma";
      const lemma = add(kind, name, label(), s);
      if (kind === "lemma" && !hasWord(text, name.end, s.end, "by")) proof = { lemma };
    } else if (keyword.text === "realize") {
      const name = r.match(QUALIFIED);
      if (name && !hasWord(text, name.end, s.end, "by")) proof = {};
    } else if (keyword.text in SIMPLE_KINDS) {
      const name = r.name();
      if (!name) return;
      add(SIMPLE_KINDS[keyword.text], name, label(), s);
      const axiom = AS_AXIOM.exec(text.slice(name.end, s.end));
      if (axiom) {
        const end = s.end - axiom[0].length + axiom[0].lastIndexOf(axiom[1]) + axiom[1].length;
        add("axiom", { text: axiom[1], start: end - axiom[1].length, end }, "axiom", s);
      }
    } else if (keyword.text === "type") {
      do {
        if (r.peekChar() === "(") r.match(PARENTHESES);
        else r.match(TYPE_VARIABLE);
        const name = r.word();
        if (!name) return;
        add("type", name, label(), s);
      } while (r.match(/,/y));
    } else if (keyword.text === "subtype") {
      const name = r.word();
      if (name) add("type", name, label(), s);
    } else if (keyword.text === "module") {
      const isType = r.accept("type");
      if (isType) words.push("type");
      r.match(/\(/y); // `module (M : T) (A : X) = ...`
      const name = r.word();
      if (name) add(isType ? "module type" : "module", name, label(), s);
    } else if (keyword.text === "theory") {
      const name = r.word();
      if (name) scopes.push(add("theory", name, label(), s));
    } else if (keyword.text === "section") {
      const name = r.word() ?? { ...keyword, text: "" };
      scopes.push(add("section", name, label(), s));
    } else if (keyword.text === "end") {
      if (r.accept("section")) closeScope("section", r.word()?.text, s.end);
      else closeScope("theory", r.word()?.text, s.end);
    } else if (keyword.text === "clone") {
      for (let flag = r.peekWord(); flag && CLONE_FLAGS.has(flag.text); flag = r.peekWord()) {
        words.push(r.word()!.text);
      }
      const source = r.match(QUALIFIED);
      if (!source) return;
      const last = source.text.slice(source.text.lastIndexOf(".") + 1);
      const alias = r.accept("as") ? r.word() : undefined;
      const name = alias ?? { text: last, start: source.end - last.length, end: source.end };
      add("clone", name, label(), s, source.text);
    }
  };

  for (let s = nextSentence(text, 0); s; s = nextSentence(text, s.end)) {
    if (proof) {
      const r = new Reader(text, s.contentStart, s.end);
      const first = r.word();
      if (first && PROOF_END.has(first.text) && r.atEnd()) {
        if (first.text === "abort" && proof.lemma) declarations.splice(declarations.indexOf(proof.lemma), 1);
        closeProof(s.end);
        previousEnd = s.end;
        continue;
      }
      if (!first || !TOP_LEVEL.has(first.text)) {
        previousEnd = s.end; // a tactic
        continue;
      }
      closeProof(previousEnd); // a declaration follows, so the proof is over
    }
    topLevel(s);
    previousEnd = s.end;
  }

  closeProof(previousEnd);
  for (const open of scopes) open.end = previousEnd;
  return declarations;
}

/** The theories a script loads with `require`, e.g. `AllCore` and `List`. */
export function requiredTheories(text: string): string[] {
  const names = new Set<string>();
  for (let s = nextSentence(text, 0); s; s = nextSentence(text, s.end)) {
    const r = new Reader(text, s.contentStart, s.end);
    if (r.accept("from")) r.word(); // `from Jasmin require import JModel.`
    if (!r.accept("require")) continue;
    if (!r.accept("import")) r.accept("export");
    for (let name = r.word(); name; name = r.word()) names.add(name.text);
  }
  return [...names];
}

/** `Ring.addrC` for the lemma `addrC` declared in the theory `Ring`. */
export function qualifiedName(d: Declaration): string {
  return [...d.path, d.name].join(".");
}
