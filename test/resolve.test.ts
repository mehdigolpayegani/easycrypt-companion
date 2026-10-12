import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DeclarationIndex } from "../src/index";
import { nameAt, nearest, resolve } from "../src/resolve";

function index(): DeclarationIndex {
  const i = new DeclarationIndex();
  i.update("/lib/Ring.ec", "theory ZModule.\n  lemma addrC : true by [].\nend ZModule.\nlemma shared : true by [].");
  i.update("/lib/List.ec", "require import Ring.\nlemma size_cat : true by [].\nlemma shared : true by [].");
  i.update("/lib/AllCore.ec", "require export List.");
  i.update("/lib/Unrelated.ec", "lemma shared : true by [].\nlemma far : true by [].");
  i.update("/proj/Main.ec", "require import AllCore.\nlemma mine : true by [].\nlemma uses : true by apply: mine.");
  return i;
}

const where = (entries: Array<{ file: string; line: number }>) => entries.map((e) => `${e.file}:${e.line}`);

test("nameAt takes the name under the cursor, up to the part it is on", () => {
  const line = "  by rewrite Ring.ZModule.addrC size_cat.";
  assert.deepEqual(nameAt(line, line.indexOf("addrC") + 2), { name: "Ring.ZModule.addrC", start: 26, end: 31 });
  assert.deepEqual(nameAt(line, line.indexOf("ZModule")), { name: "Ring.ZModule", start: 18, end: 25 });
  assert.deepEqual(nameAt(line, line.indexOf("Ring") + 4), { name: "Ring", start: 13, end: 17 });
  assert.equal(nameAt(line, line.indexOf("size_cat") + 8)?.name, "size_cat", "just after the name counts");
  assert.equal(nameAt(line, 0), undefined);
  assert.equal(nameAt(line, line.length), undefined, "the final dot is not a name");
});

test("nameAt ignores type variables and memories, but not primed names", () => {
  assert.equal(nameAt("op f (x : 'a) = x.", 11), undefined);
  assert.equal(nameAt("Pr[M.f() @ &m : res]", 13), undefined);
  assert.equal(nameAt("rewrite x' y.", 9)?.name, "x'");
});

test("prefers the same file, then required files, then anywhere", () => {
  const i = index();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "mine"))), ["/proj/Main.ec:1"]);
  // AllCore requires List, which requires Ring.
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "size_cat"))), ["/lib/List.ec:1"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "addrC"))), ["/lib/Ring.ec:1"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "far"))), ["/lib/Unrelated.ec:1"]);
  assert.deepEqual(nearest(resolve(i, "/proj/Main.ec", "nothing")), []);
});

test("the prelude is loaded without being required", () => {
  const i = index();
  i.update("/lib/Pervasive.ec", "op mu : int.");
  i.update("/proj/Bare.ec", "lemma l : true by [].");
  assert.deepEqual(where(resolve(i, "/proj/Bare.ec", "mu").required), ["/lib/Pervasive.ec:0"]);
});

test("keeps the three groups apart", () => {
  const r = resolve(index(), "/lib/List.ec", "shared");
  assert.deepEqual(where(r.sameFile), ["/lib/List.ec:2"]);
  assert.deepEqual(where(r.required), ["/lib/Ring.ec:3"]);
  assert.deepEqual(where(r.elsewhere), ["/lib/Unrelated.ec:0"]);
});

test("a qualifier selects by theory or file name", () => {
  const i = index();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "Unrelated.shared"))), ["/lib/Unrelated.ec:0"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "ZModule.addrC"))), ["/lib/Ring.ec:1"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "Ring.ZModule.addrC"))), ["/lib/Ring.ec:1"]);
  assert.deepEqual(where(nearest(resolve(i, undefined, "Ring.shared"))), ["/lib/Ring.ec:3"]);
});

test("an unknown qualifier falls back to the name alone", () => {
  assert.deepEqual(where(nearest(resolve(index(), "/proj/Main.ec", "Alias.size_cat"))), ["/lib/List.ec:1"]);
});

test("a theory name finds the theory or the file that is the theory", () => {
  const i = index();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "ZModule"))), ["/lib/Ring.ec:0"]);
  const [list] = nearest(resolve(i, "/proj/Main.ec", "List"));
  assert.deepEqual([list.file, list.kind, list.line, list.column], ["/lib/List.ec", "theory", 0, 0]);
});

test("without a file, everything is elsewhere", () => {
  const r = resolve(index(), undefined, "shared");
  assert.equal(r.sameFile.length + r.required.length, 0);
  assert.equal(r.elsewhere.length, 3);
});
