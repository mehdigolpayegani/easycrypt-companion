import { strict as assert } from "node:assert";
import { test } from "node:test";
import { membersOf } from "../src/clones";
import { DeclarationIndex, IndexEntry } from "../src/index";
import { nearest, resolve } from "../src/resolve";

// A small library shaped like EasyCrypt's Ring.ec, Distr.ec and DBool.ec.
const RING = `abstract theory ZModule.
  axiom addrC : true.
end ZModule.
abstract theory ComRing.
  clone include ZModule.
  axiom mulrC : true.
end ComRing.
theory IntID.
  clone include ComRing with type t <- int.
end IntID.
clone ComRing as RField with type t <- real.
abstract theory Additive.
  clone import Self.ZModule as ZM1 with type t <- t1.
end Additive.
`;
const DISTR = `abstract theory MFinite.
  type t.
  op dunifin : t.
  lemma dunifin_ll : true by [].
  lemma dunifinE : true by [].
end MFinite.
`;
const DBOOL = `require import Distr.
clone include Distr.MFinite with type t <- bool
  rename "dunifinE" as "dboolE_count"
  rename "dunifin" as "dbool"
  rename [type] "t" as "elem".
`;
const OTHER = "theory T.\n  lemma far_lemma : true by [].\nend T.\n";
const LOOP = "theory A.\n  clone include B.\nend A.\ntheory B.\n  clone include A.\n  lemma inB : true by [].\nend B.\n";
const MAIN = "require import Ring DBool.\nclone import Other.T as OT.\nlemma mine : true by [].\n";

function index(): DeclarationIndex {
  const i = new DeclarationIndex();
  i.update("/lib/Ring.ec", RING);
  i.update("/lib/Distr.ec", DISTR);
  i.update("/lib/DBool.ec", DBOOL);
  i.update("/lib/Other.ec", OTHER);
  i.update("/lib/Loop.ec", LOOP);
  i.update("/proj/Main.ec", MAIN);
  return i;
}

const show = (entries: IndexEntry[]) => entries.map((e) => `${e.kind} ${[...e.path, e.name].join(".")}`);
const find = (name: string, file = "/proj/Main.ec") => show(nearest(resolve(index(), file, name)));

test("a member reached through clone include", () => {
  assert.deepEqual(find("ComRing.addrC"), ["axiom ZModule.addrC"]);
  assert.deepEqual(find("IntID.addrC"), ["axiom ZModule.addrC"], "through two includes");
  assert.deepEqual(find("IntID.mulrC"), ["axiom ComRing.mulrC"]);
  assert.deepEqual(find("Ring.IntID.addrC"), ["axiom ZModule.addrC"]);
});

test("a member of a clone with an alias", () => {
  assert.deepEqual(find("RField.mulrC"), ["axiom ComRing.mulrC"]);
  assert.deepEqual(find("RField.addrC"), ["axiom ZModule.addrC"]);
  assert.deepEqual(find("OT.far_lemma"), ["lemma T.far_lemma"]);
});

test("Self is the file the clone is in", () => {
  assert.deepEqual(find("ZM1.addrC", "/lib/Ring.ec"), ["axiom ZModule.addrC"]);
});

test("renamed members are found under their new name", () => {
  assert.deepEqual(find("dbool"), ["op MFinite.dunifin"]);
  assert.deepEqual(find("dbool_ll"), ["lemma MFinite.dunifin_ll"]);
  assert.deepEqual(find("dboolE_count"), ["lemma MFinite.dunifinE"], "the first rename wins");
  assert.deepEqual(find("DBool.dbool"), ["op MFinite.dunifin"]);
});

test("a rename only applies to the kinds it lists", () => {
  const from = { file: "/proj/Main.ec", path: [] };
  assert.deepEqual(show(membersOf(index(), from, ["DBool"], "elem")), ["type MFinite.t"]);
  assert.deepEqual(show(membersOf(index(), from, ["DBool"], "t")), [], "the type is no longer called t");
  assert.deepEqual(show(membersOf(index(), from, ["DBool"], "dunifin")), [], "nor the operator dunifin");
});

test("names opened by a clone import are near", () => {
  const r = resolve(index(), "/proj/Main.ec", "far_lemma");
  assert.deepEqual(show(r.required), ["lemma T.far_lemma"]);
  assert.deepEqual(r.elsewhere, []);
});

test("clones that include each other do not loop", () => {
  const from = { file: "/lib/Loop.ec", path: [] };
  assert.deepEqual(show(membersOf(index(), from, ["A"], "inB")), ["lemma B.inB"]);
  assert.deepEqual(show(membersOf(index(), from, ["A"], "missing")), []);
});

test("an unknown qualifier still falls back to the name", () => {
  assert.deepEqual(find("Nowhere.addrC"), ["axiom ZModule.addrC"]);
});
