import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseDeclarations } from "../src/declarations";
import { foldingRanges, OutlineNode, outlineTree } from "../src/outline";

/** The tree as indented names. */
function render(nodes: OutlineNode[], indent = ""): string[] {
  return nodes.flatMap((n) => [
    `${indent}${n.declaration.name || n.declaration.keyword}`,
    ...render(n.children, indent + "  "),
  ]);
}

/** Folding ranges as `start-end`, with 1-based lines as an editor shows them. */
function folds(text: string): string[] {
  return foldingRanges(text, parseDeclarations(text)).map(
    (r) => `${r.start + 1}-${r.end + 1}${r.comment ? " comment" : ""}`,
  );
}

test("declarations nest inside their theories and sections", () => {
  const text = `
op top : int.
theory A.
  op x : int.
  section.
    local lemma l : true by [].
  end section.
  theory B.
    type key, plain.
  end B.
end A.
lemma last : true by [].
`;
  assert.deepEqual(render(outlineTree(parseDeclarations(text))), [
    "top",
    "A",
    "  x",
    "  section",
    "    l",
    "  B",
    "    key",
    "    plain",
    "last",
  ]);
});

test("a proof folds under its statement", () => {
  const text = ["lemma a (x : int) :", "  x = x.", "proof.", "  trivial.", "qed.", "lemma b : true by []."].join("\n");
  assert.deepEqual(folds(text), ["2-5"]);
});

test("a proof on the statement's line has nothing to fold", () => {
  assert.deepEqual(folds("lemma a : true. proof. trivial. qed.\nop x : int."), []);
});

test("theories and sections fold up to their end line, which stays visible", () => {
  const text = ["theory A.", "  op x : int.", "  section.", "    op y : int.", "  end section.", "end A."].join("\n");
  assert.deepEqual(folds(text), ["1-5", "3-4"]);
});

test("a theory left open folds to the end of the text", () => {
  assert.deepEqual(folds("theory A.\nop x : int.\nop y : int."), ["1-3"]);
});

test("modules fold at their braces, keeping the closing one visible", () => {
  const text = [
    "module M = {",
    "  proc f() = {",
    "    var x;",
    "    x <- 1;",
    "  }",
    "}.",
    "op pair = {0,1}.",
  ].join("\n");
  assert.deepEqual(folds(text), ["1-5", "2-4"]);
});

test("long declarations and comments fold", () => {
  const text = [
    "(* a comment",
    "   over two lines *)",
    "op f (x : int) =",
    "  x + 1.",
    "clone import Ring as R with",
    "  type t <- int,",
    "  op zero <- 0.",
  ].join("\n");
  assert.deepEqual(folds(text), ["1-2 comment", "3-4", "5-7"]);
});

test("braces inside comments and strings do not fold", () => {
  assert.deepEqual(folds('op s = "{".\nop t = 1.\nop u = "}".\n(* {\n} *)'), ["4-5 comment"]);
});
