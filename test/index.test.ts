import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DeclarationIndex } from "../src/index";

const RING = `theory Ring.
  op zero : int.
  lemma addrC (x y : int) : x + y = y + x by smt().
  lemma addrA : true by [].
end Ring.
`;
const LIST = "lemma size_cat : true by [].\nlemma cat_size_add : true by [].\nop size : int.\nsection.\nend section.\n";

function index(): DeclarationIndex {
  const i = new DeclarationIndex();
  i.update("/lib/Ring.ec", RING);
  i.update("/lib/List.ec", LIST);
  return i;
}

const names = (i: DeclarationIndex, query: string) => i.search(query).map((e) => e.name);

test("finds declarations by name, with where they are", () => {
  const [found] = index().search("addrC");
  assert.deepEqual(found, {
    file: "/lib/Ring.ec",
    kind: "lemma",
    name: "addrC",
    path: ["Ring"],
    line: 2,
    column: 8,
    endColumn: 13,
    signature: "lemma addrC (x y : int) : x + y = y + x by smt().",
  });
});

test("keeps each declaration's text, dedented and cut short", () => {
  const i = new DeclarationIndex();
  const body = Array.from({ length: 30 }, (_, n) => `    proc p${n}() = {}`).join("\n");
  i.update("/a.ec", `theory T.\n  op f (x : int) =\n    x + 1.\n  module M = {\n${body}\n  }.\nend T.`);
  assert.equal(i.named("f")[0].signature, "op f (x : int) =\n  x + 1.");
  const lines = i.named("M")[0].signature.split("\n");
  assert.equal(lines.length, 13);
  assert.equal(lines[1], "  proc p0() = {}");
  assert.equal(lines[12], "\u2026");
});

test("looks names up exactly, and knows theories and requires", () => {
  const i = index();
  i.update("/proj/Mine.eca", "require import AllCore Ring.\nrequire List.\nlemma size : true by [].");
  assert.deepEqual(
    i.named("size").map((e) => e.file),
    ["/lib/List.ec", "/proj/Mine.eca"],
  );
  assert.deepEqual(i.named("siz"), []);
  assert.deepEqual(i.requiresOf("/proj/Mine.eca"), ["AllCore", "Ring", "List"]);
  assert.deepEqual(i.requiresOf("/unknown.ec"), []);
  assert.deepEqual(i.filesOfTheory("Mine"), ["/proj/Mine.eca"]);
  assert.deepEqual(i.filesOfTheory("List"), ["/lib/List.ec"]);
  i.remove("/proj/Mine.eca");
  assert.deepEqual(i.filesOfTheory("Mine"), []);
  assert.deepEqual(
    i.named("size").map((e) => e.file),
    ["/lib/List.ec"],
  );
});

test("ranks exact matches, then prefixes, substrings and letters in order", () => {
  assert.deepEqual(names(index(), "size"), ["size", "size_cat", "cat_size_add"]);
  assert.deepEqual(names(index(), "szcat"), ["size_cat"]);
  assert.deepEqual(names(index(), "addr"), ["addrA", "addrC"]);
});

test("ignores case and surrounding spaces", () => {
  assert.deepEqual(names(index(), "  ADDRc "), ["addrC"]);
});

test("an empty query and names that do not match find nothing", () => {
  assert.deepEqual(names(index(), ""), []);
  assert.deepEqual(names(index(), "nothing_like_this"), []);
});

test("unnamed sections are not indexed", () => {
  const i = index();
  assert.equal(i.size, 7);
  assert.deepEqual(names(i, "section"), []);
});

test("updating a file replaces its declarations; removing it forgets them", () => {
  const i = index();
  i.update("/lib/Ring.ec", "lemma renamed : true by [].");
  assert.deepEqual(names(i, "addrC"), []);
  assert.deepEqual(names(i, "renamed"), ["renamed"]);
  assert.equal(i.has("/lib/List.ec"), true);
  i.remove("/lib/List.ec");
  assert.equal(i.has("/lib/List.ec"), false);
  assert.deepEqual(names(i, "size"), []);
});

test("the number of results is limited", () => {
  const i = new DeclarationIndex();
  i.update("/a.ec", Array.from({ length: 50 }, (_, n) => `lemma l${n} : true by [].`).join("\n"));
  assert.equal(i.search("l", 10).length, 10);
  assert.equal(i.search("l").length, 50);
});
