import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Near, suggest, Typed, typedName } from "../src/completion";
import { DeclarationIndex } from "../src/index";

const MAIN = "/proj/Main.ec";

function index(): DeclarationIndex {
  const i = new DeclarationIndex();
  i.update(
    "/lib/List.ec",
    "op size : int.\nlemma size_cat : true by [].\nlemma size_cons : true by [].\nlemma cat_size : true by [].\nop (++) : int.",
  );
  i.update("/lib/AllCore.ec", "require export List.");
  i.update("/lib/FSet.ec", "theory Inner.\n  lemma size_fset : true by [].\nend Inner.\nlemma fsize : true by [].");
  i.update(
    MAIN,
    "require import AllCore.\nlemma size_mine : true by [].\nmodule M = {\n  var size_v : int\n  proc size_p() : unit = {}\n}.\nlemma l : true.\nproof.\n",
  );
  return i;
}

const typed = (name: string): Typed => {
  const parts = name.split(".");
  return { word: parts.pop()!, qualifier: parts, start: 0 };
};
const names = (i: DeclarationIndex, name: string, line = 7, texts: string[] = []) =>
  suggest(i, MAIN, line, typed(name), texts).items.map((s) => s.name);

test("typedName reads the name before the cursor", () => {
  const at = (line: string) => typedName(line, line.length);
  assert.deepEqual(at("  by rewrite size_c"), { qualifier: [], word: "size_c", start: 13 });
  assert.deepEqual(at("apply List.si"), { qualifier: ["List"], word: "si", start: 11 });
  assert.deepEqual(at("apply Ring.ZModule."), { qualifier: ["Ring", "ZModule"], word: "", start: 19 });
  assert.deepEqual(typedName("rewrite size_cat foo", 13), { qualifier: [], word: "size_", start: 8 });
  assert.equal(at("move=> h'")?.word, "h'");
});

test("typedName leaves out the arguments of a module", () => {
  const at = (line: string) => typedName(line, line.length);
  assert.deepEqual(at("call G(A, B).ma"), { qualifier: ["G"], word: "ma", start: 13 });
  assert.deepEqual(at("inline G(A).O."), { qualifier: ["G", "O"], word: "", start: 14 });
});

test("typedName finds nothing after a blank, a memory or a type variable", () => {
  for (const line of ["", "smt(). ", "x <- ", "Pr[M.f() @ &m", "op f (x : 'a", "rewrite (addrC x)."]) {
    assert.equal(typedName(line, line.length), undefined, line);
  }
});

test("names starting with what was typed come first, the nearest first", () => {
  const { items, complete } = suggest(index(), MAIN, 7, typed("size"));
  assert.deepEqual(
    items.map((s) => [s.name, Near[s.near], s.needs]),
    [
      ["size_mine", "File", undefined],
      ["size", "Required", undefined],
      ["size_cat", "Required", undefined],
      ["size_cons", "Required", undefined],
      ["size_fset", "Elsewhere", "FSet"],
      // At the start of a later part of the name; `fsize` has it nowhere.
      ["cat_size", "Required", undefined],
    ],
  );
  assert.equal(complete, true);
  assert.equal(items[2].entry?.signature, "lemma size_cat : true by [].");
});

test("case is ignored, operators and sections are left out", () => {
  const i = index();
  i.update("/lib/Ops.ec", "op (\\\\sizeop) : int.\nsection SizeSection.\nend section SizeSection.\nlemma SIZE_up : true by [].");
  assert.deepEqual(names(i, "size_u"), ["SIZE_up"]);
  assert.deepEqual(names(i, "sizeop"), []);
  assert.deepEqual(names(i, "SizeS"), []);
});

test("one or no letter suggests nothing", () => {
  assert.deepEqual(suggest(index(), MAIN, 7, typed("s")), { items: [], complete: true });
  assert.deepEqual(suggest(index(), MAIN, 7, typed("")), { items: [], complete: true });
});

test("the names of other files wait for a third letter", () => {
  const i = index();
  assert.deepEqual(names(i, "si"), ["size_mine"]);
  assert.deepEqual(names(i, "siz").slice(0, 3), ["size_mine", "size", "size_cat"]);
  assert.deepEqual(names(i, "fs"), []);
  assert.deepEqual(names(i, "fsi"), ["fsize"]);
  assert.deepEqual(names(i, "Li"), [], "files too");
  assert.deepEqual(names(i, "FSet.fs"), ["fsize"], "but not after a qualifier");
});

test("variables and procedures are suggested inside their module", () => {
  const i = index();
  assert.deepEqual(names(i, "size_", 4).slice(0, 3), ["size_p", "size_v", "size_mine"]);
  assert.ok(!names(i, "size_", 7).includes("size_p"));
});

test("a qualifier lists the members of a theory, a file or a module", () => {
  const i = index();
  assert.deepEqual(names(i, "List."), ["size", "cat_size", "size_cat", "size_cons"]);
  assert.deepEqual(names(i, "List.size_c"), ["size_cat", "size_cons"]);
  assert.deepEqual(names(i, "M.size"), ["size_p", "size_v"]);
  assert.deepEqual(names(i, "FSet.Inner."), ["size_fset"]);
  assert.deepEqual(names(i, "FSet."), ["fsize", "Inner"]);
  assert.deepEqual(names(i, "Nothing."), []);
  // The first names may be those of a clone.
  assert.deepEqual(names(i, "Alias.Inner."), ["size_fset"]);
});

test("a nearer theory or module hides those of the same name", () => {
  const i = index();
  i.update("/lib/Far.ec", "module M = {\n  proc size_far() : unit = {}\n}.\ntheory Only.\n  op size_only : int.\nend Only.");
  assert.deepEqual(names(i, "M.size"), ["size_p", "size_v"]);
  assert.deepEqual(
    suggest(i, MAIN, 7, typed("Only.")).items.map((s) => [s.name, s.needs]),
    [["size_only", "Far"]],
  );
});

test("files are suggested as theories, without a require note", () => {
  const i = index();
  const [list] = suggest(i, MAIN, 0, typed("Lis")).items;
  assert.deepEqual([list.name, list.entry?.kind, list.entry?.file, list.needs], ["List", "theory", "/lib/List.ec", undefined]);
  const [fset] = suggest(i, MAIN, 0, typed("FSe")).items;
  assert.deepEqual([fset.name, Near[fset.near], fset.needs], ["FSet", "Elsewhere", undefined]);
  assert.deepEqual(names(i, "Mai"), [], "not the script itself");
});

test("of several declarations of a name, the nearest is kept", () => {
  const i = index();
  i.update("/lib/Other.ec", "lemma size_cat : false by [].\nlemma size_mine : false by [].");
  const found = suggest(i, MAIN, 7, typed("size_")).items.filter((s) => s.name === "size_cat" || s.name === "size_mine");
  assert.deepEqual(
    found.map((s) => [s.name, s.entry?.file]),
    [
      ["size_mine", MAIN],
      ["size_cat", "/lib/List.ec"],
    ],
  );
});

test("the words of the scripts are suggested, but not the one being typed", () => {
  const i = index();
  const texts = ["move=> hsize hsizes hs.\nrewrite size_cat hsize.", "(* another script *) hsize hsizer"];
  const found = suggest(i, MAIN, 7, typed("hsize"), texts).items;
  assert.deepEqual(
    found.map((s) => [s.name, Near[s.near], s.entry]),
    [
      ["hsizer", "Word", undefined],
      ["hsizes", "Word", undefined],
    ],
  );
  // A declared name is not repeated as a word; words come after the file's own names.
  assert.deepEqual(names(i, "size_", 7, texts).slice(0, 3), ["size_mine", "size_cat", "size_cons"]);
  assert.deepEqual(names(i, "List.hs", 7, texts), [], "no words after a qualifier");
});

test("a script that is not indexed gets no require notes", () => {
  const found = suggest(index(), undefined, 0, typed("fsize")).items;
  assert.deepEqual(found.map((s) => [s.name, Near[s.near], s.needs]), [["fsize", "Elsewhere", undefined]]);
});

test("long lists are cut and reported as incomplete", () => {
  const i = new DeclarationIndex();
  i.update("/lib/Many.ec", Array.from({ length: 300 }, (_, n) => `lemma lem_${n} : true by [].`).join("\n"));
  const { items, complete } = suggest(i, "/lib/Many.ec", 0, typed("lem"));
  assert.equal(items.length, 200);
  assert.equal(complete, false);
  assert.equal(items[0].name, "lem_0");
  assert.equal(suggest(i, "/lib/Many.ec", 0, typed("lem_29")).complete, true);
});
