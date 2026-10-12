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
  });
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
