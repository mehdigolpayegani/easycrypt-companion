import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resultAt, results } from "../src/results";

// As the response pane shows `search (+) (<=)` and `search zz`.
const SEARCH = `(* RField.ofintS *)
lemma ofintS:
  forall (i : int), 0 <= i => RField.ofint (i + 1) = 1%r + RField.ofint i.
lemma size_cat ['a]:
  forall (s1 s2 : 'a list), size (s1 ++ s2) = size s1 + size s2.
lemma dbool_ll: Distr.is_lossless {0,1}.
(* Right.same *)
lemma same: zz = zz.
(* Left.same *)
lemma same: zz = zz.
`;

const summary = (text: string) => results(text).map((r) => `${r.kind} ${r.name} ${r.start}-${r.end} @${r.line}:${r.column}`);

test("reads each result, under the full name of its comment", () => {
  assert.deepEqual(summary(SEARCH), [
    "lemma RField.ofintS 0-2 @1:6",
    "lemma size_cat 3-4 @3:6",
    "lemma dbool_ll 5-5 @5:6",
    "lemma Right.same 6-7 @7:6",
    "lemma Left.same 8-9 @9:6",
  ]);
});

test("as print shows them, with keywords before the name", () => {
  const text = "* In [lemmas or axioms]:\n\n(* Left.same *)\nlemma same: zz = zz.\n\nlocal axiom nosmt [simplify] ax ['a]: true.\n";
  assert.deepEqual(summary(text), ["lemma Left.same 2-3 @3:6", "axiom ax 5-5 @5:29"]);
});

test("a comment that is not the result's name is left alone", () => {
  assert.deepEqual(summary("(* Ring.addrC *)\nlemma mulrC: true.\n(* a remark *)\nlemma x: true."), [
    "lemma mulrC 1-1 @1:6",
    "lemma x 3-3 @3:6",
  ]);
});

test("goals and other text have no results", () => {
  assert.deepEqual(results("Current goal\n\nType variables: <none>\n\nx: int\n------------------------\nx = x"), []);
  assert.deepEqual(results("  lemma indented: true."), []);
});

test("resultAt finds the result whose name is at a position", () => {
  assert.equal(resultAt(SEARCH, 9, 8)?.name, "Left.same");
  assert.equal(resultAt(SEARCH, 7, 10)?.name, "Right.same", "just after the name");
  assert.equal(resultAt(SEARCH, 9, 2), undefined, "on the keyword");
  assert.equal(resultAt(SEARCH, 2, 10), undefined, "in the statement");
});
