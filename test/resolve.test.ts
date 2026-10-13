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

test("nameAt leaves out the arguments of a module", () => {
  const line = "equiv e : G(A(O), B).main ~ M(A).O.f : true ==> (res{1}).`1.";
  assert.deepEqual(nameAt(line, line.indexOf("main")), { name: "G.main", start: 21, end: 25 });
  assert.equal(nameAt(line, line.indexOf("G("))?.name, "G");
  assert.equal(nameAt(line, line.indexOf("O)"))?.name, "O");
  assert.equal(nameAt(line, line.indexOf(".f") + 1)?.name, "M.O.f");
  assert.equal(nameAt(line, line.indexOf("O.f"))?.name, "M.O");
  assert.equal(nameAt("rewrite (addrC x).y", 18)?.name, "y", "not after a module");
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

const GAME = `require import AllCore.
module type Adv = {
  proc guess() : bool
}.
module G (A : Adv) = {
  var b : bool
  proc main() : bool = {
    b <@ A.guess();
    return b;
  }
}.
lemma l (b : bool) &m : Pr[G(A).main() @ &m : G.b] = 1%r.
`;

function game(): DeclarationIndex {
  const i = index();
  i.update("/lib/Other.ec", "module G = {\n  var b : int\n}.\ntheory Lazy.\nmodule RO = {\n  var m : int\n}.\nend Lazy.");
  i.update("/proj/Game.ec", GAME);
  return i;
}

test("a module name selects its variables and procedures", () => {
  const i = game();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "G.b"))), ["/proj/Game.ec:5"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "G.main"))), ["/proj/Game.ec:6"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Main.ec", "G.b"))), ["/lib/Other.ec:1", "/proj/Game.ec:5"]);
  // `A` is a parameter: only the name is left.
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "A.guess"))), ["/proj/Game.ec:2"]);
});

test("a bare name is a variable or procedure only inside its module", () => {
  const i = game();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "b", 7))), ["/proj/Game.ec:5"]);
  assert.deepEqual(nearest(resolve(i, "/proj/Game.ec", "b", 11)), [], "a lemma's own variable");
  assert.deepEqual(nearest(resolve(i, "/proj/Game.ec", "b")), [], "the line is not known");
  assert.deepEqual(nearest(resolve(i, "/proj/Main.ec", "main", 1)), []);
});

test("the names of a clone before a module are dropped", () => {
  const i = game();
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "H.Lazy.RO.m"))), ["/lib/Other.ec:5"]);
  assert.deepEqual(where(nearest(resolve(i, "/proj/Game.ec", "H.RO.m"))), ["/lib/Other.ec:5"]);
});
