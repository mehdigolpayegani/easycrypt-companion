import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  byteToCharOffset,
  followPosition,
  nextSentence,
  sentencesFrom,
  skipBlanksBackward,
} from "../src/sentences";

/** The text of every sentence. */
function split(text: string): string[] {
  return sentencesFrom(text, 0).map((s) => text.slice(s.contentStart, s.end));
}

test("splits at a dot followed by whitespace or end of input", () => {
  assert.deepEqual(split("require import AllCore.\nlemma foo : true.\nproof. trivial. qed."), [
    "require import AllCore.",
    "lemma foo : true.",
    "proof.",
    "trivial.",
    "qed.",
  ]);
});

test("a dot not followed by whitespace does not end a sentence", () => {
  assert.deepEqual(split("rewrite Foo.bar x.[1] (1.5) r.`1.\nsmt()."), [
    "rewrite Foo.bar x.[1] (1.5) r.`1.",
    "smt().",
  ]);
});

test("`..` is one token even before whitespace", () => {
  assert.deepEqual(split("op r = [0.. ]. qed."), ["op r = [0.. ].", "qed."]);
});

test("dots inside comments and strings are ignored", () => {
  assert.deepEqual(split('(* a. b. *) lemma x : "a. b" = "c\\". d". qed.'), [
    'lemma x : "a. b" = "c\\". d".',
    "qed.",
  ]);
});

test("comments nest", () => {
  assert.deepEqual(split("(* outer (* inner. *) still. *) auto. done."), ["auto.", "done."]);
});

test("parenthesised operators are not comments", () => {
  assert.deepEqual(split("rewrite (*). rewrite ( * ) (+). rewrite (*+*). auto."), [
    "rewrite (*).",
    "rewrite ( * ) (+).",
    "rewrite (*+*).",
    "auto.",
  ]);
});

test("banner comments are comments", () => {
  assert.deepEqual(split("(* ---------------- *)\n(*-------*)\nlemma a : true. (*** x. ***) qed."), [
    "lemma a : true.",
    "qed.",
  ]);
});

test("leading comments and whitespace are excluded from the sent text", () => {
  const text = "  (* c *)\n  auto.";
  const s = nextSentence(text, 0)!;
  assert.equal(s.start, 0);
  assert.equal(text.slice(s.contentStart, s.end), "auto.");
});

test("no sentence in an unterminated comment, string or sentence", () => {
  assert.equal(nextSentence("(* open. ", 0), undefined);
  assert.equal(nextSentence('print "a. ', 0), undefined);
  assert.equal(nextSentence("auto", 0), undefined);
  assert.equal(nextSentence("   \n (* only a comment *)  ", 0), undefined);
});

test("a sentence may end at the very end of the text", () => {
  assert.deepEqual(split("auto."), ["auto."]);
});

test("offsets continue from where scanning started", () => {
  const text = "auto. smt().";
  const first = nextSentence(text, 0)!;
  const second = nextSentence(text, first.end)!;
  assert.equal(second.start, first.end);
  assert.equal(text.slice(second.contentStart, second.end), "smt().");
});

test("followPosition moves past spaces and to the next line", () => {
  assert.equal(followPosition("auto.   \nqed.", 5), 9);
  assert.equal(followPosition("auto. qed.", 5), 6);
  assert.equal(followPosition("auto.\r\nqed.", 5), 7);
  assert.equal(followPosition("auto.", 5), 5);
});

test("skipBlanksBackward stops after the previous sentence", () => {
  assert.equal(skipBlanksBackward("auto.  \n  ", 10), 5);
  assert.equal(skipBlanksBackward("auto.", 3), 3);
});

test("byteToCharOffset converts UTF-8 byte offsets", () => {
  const s = "(* é → *) rewrite foo.";
  const byteStart = Buffer.byteLength("(* é → *) rewrite ", "utf8");
  assert.equal(byteToCharOffset(s, byteStart), "(* é → *) rewrite ".length);
  assert.equal(byteToCharOffset("abc", 2), 2);
  assert.equal(byteToCharOffset("abc", 99), 3);
});
