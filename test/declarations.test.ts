import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Declaration, parseDeclarations, qualifiedName, requiredTheories } from "../src/declarations";

/** `kind qualified-name` for every declaration. */
function summary(text: string): string[] {
  return parseDeclarations(text).map((d) => `${d.kind} ${qualifiedName(d)}`);
}

function find(text: string, name: string): Declaration {
  const d = parseDeclarations(text).find((x) => x.name === name);
  assert.ok(d, `declaration ${name} not found`);
  return d;
}

test("finds the usual declarations", () => {
  const text = `
type t.
op zero : t.
pred small (x : t) = x = zero.
abbrev z = zero.
axiom zeroP : small zero.
lemma zero_small : small zero by exact: zeroP.
module M = { proc f() = {} }.
module type T = { proc f() : unit }.
`;
  assert.deepEqual(summary(text), [
    "type t",
    "op zero",
    "pred small",
    "abbrev z",
    "axiom zeroP",
    "lemma zero_small",
    "module M",
    "module type T",
  ]);
});

test("names are qualified by the enclosing theories, not by sections", () => {
  const text = `
theory Ring.
  op one : int.
  abstract theory Sub.
    section Proofs.
      local lemma inner : true by [].
    end section Proofs.
  end Sub.
  lemma outer : true by [].
end Ring.
lemma top : true by [].
`;
  assert.deepEqual(summary(text), [
    "theory Ring",
    "op Ring.one",
    "theory Ring.Sub",
    "section Ring.Sub.Proofs",
    "lemma Ring.Sub.inner",
    "lemma Ring.outer",
    "lemma top",
  ]);
  assert.equal(find(text, "Sub").keyword, "abstract theory");
  assert.equal(find(text, "inner").keyword, "local lemma");
});

test("a theory or section spans up to its end", () => {
  const text = "theory A.\nop x : int.\nsection.\nop y : int.\nend section.\nend A.\nop z : int.";
  const [a, , section] = parseDeclarations(text);
  assert.equal(text.slice(a.start, a.end), "theory A.\nop x : int.\nsection.\nop y : int.\nend section.\nend A.");
  assert.equal(text.slice(a.start, a.signatureEnd), "theory A.");
  assert.equal(section.name, "");
  assert.equal(text.slice(section.start, section.end), "section.\nop y : int.\nend section.");
});

test("a lemma spans up to the end of its proof", () => {
  const text = "lemma a : true.\nproof.\n  trivial.\nqed.\nlemma b : true by [].\nlemma c : true.\nproof. admitted.\nop x : int.";
  const [a, b, c] = parseDeclarations(text);
  assert.equal(text.slice(a.start, a.signatureEnd), "lemma a : true.");
  assert.equal(text.slice(a.start, a.end), "lemma a : true.\nproof.\n  trivial.\nqed.");
  assert.equal(text.slice(b.start, b.end), "lemma b : true by [].");
  assert.equal(text.slice(c.start, c.end), "lemma c : true.\nproof. admitted.");
});

test("tactics inside a proof declare nothing", () => {
  const text = `
lemma l : hoare [M.f : true ==> true].
proof.
  hoare.
  + phoare split 1%r 0%r.
  equiv foo : true.
  conseq (_ : true ==> true).
qed.
hoare h : M.f : true ==> true.
proof. proc. qed.
equiv e : M.f ~ M.f : true ==> true by sim.
`;
  assert.deepEqual(summary(text), ["lemma l", "lemma h", "lemma e"]);
  assert.equal(find(text, "h").keyword, "hoare");
});

test("an aborted lemma is not declared", () => {
  assert.deepEqual(summary("lemma a : false.\nproof.\nabort.\nlemma b : true by []."), ["lemma b"]);
});

test("a proof left open ends at the next declaration", () => {
  const text = "lemma a : true.\nproof.\n  trivial.\nop x : int.";
  const [a, x] = parseDeclarations(text);
  assert.equal(text.slice(a.start, a.end), "lemma a : true.\nproof.\n  trivial.");
  assert.equal(x.name, "x");
});

test("realize opens a proof but declares nothing", () => {
  assert.deepEqual(summary("realize A.ax.\nproof.\n  hoare.\nqed.\nrealize B.ax by smt().\nop x : int."), ["op x"]);
});

test("operator names", () => {
  const text = `
op (+) : int -> int -> int.
op ( * ) (x y : int) = x.
op [-] : int -> int.
op [ - ] (x : int) = x.
abbrev (\\in) (x : int) (s : int list) = true.
op "_.[_]" : int list -> int -> int.
`;
  assert.deepEqual(
    parseDeclarations(text).map((d) => d.name),
    ["(+)", "(*)", "[-]", "[-]", "(\\in)", '"_.[_]"'],
  );
});

test("attributes before a name are skipped", () => {
  const text = "op [opaque smt_opaque] f : int.\nop [lossless] d : int distr.\nabbrev [-printing] g = f.\nlemma [nosmt] l : true by [].";
  assert.deepEqual(summary(text), ["op f", "op d", "abbrev g", "lemma l"]);
});

test("types: parameters and several names", () => {
  const text = "type 'a t.\ntype ('a, 'b) fmap.\ntype key, plain, cipher.\ntype u = int * int.\nsubtype word = { w : int list | size w = 8 }.";
  assert.deepEqual(summary(text), [
    "type t",
    "type fmap",
    "type key",
    "type plain",
    "type cipher",
    "type u",
    "type word",
  ]);
});

test("modules: functors, declared and parenthesised names", () => {
  const text = `
module G (A : Adv) = { proc main() = {} }.
declare module A <: Adv {-G}.
local module (S : Sim) (O : Orcl) = { proc f() = {} }.
module type Adv (O : Orcl) = { proc a() : unit }.
`;
  assert.deepEqual(summary(text), ["module G", "module A", "module S", "module type Adv"]);
  assert.equal(find(text, "A").keyword, "declare module");
});

test("const and inductive; `as` names an axiom", () => {
  const text = "const n : { int | 0 < n } as gt0_n.\ninductive ok (x : int) = Ok of (0 <= x).\ndeclare axiom ax : true.";
  assert.deepEqual(summary(text), ["op n", "axiom gt0_n", "pred ok", "axiom ax"]);
  const axiom = find(text, "gt0_n");
  assert.equal(text.slice(axiom.nameStart, axiom.nameEnd), "gt0_n");
});

test("clones record their source and alias", () => {
  const text = `
clone import Ring.ComRing as IntRing with type t <- int.
clone include Monoid with type t <- t.
local clone export Bigop as BAdd.
clone MFinite.
`;
  const clones = parseDeclarations(text);
  assert.deepEqual(
    clones.map((d) => [d.kind, d.name, d.source, d.keyword]),
    [
      ["clone", "IntRing", "Ring.ComRing", "clone import"],
      ["clone", "Monoid", "Monoid", "clone include"],
      ["clone", "BAdd", "Bigop", "local clone export"],
      ["clone", "MFinite", "MFinite", "clone"],
    ],
  );
});

test("clones record their renames", () => {
  const text = `clone include Distr.MFinite with type t <- bool
  rename "dunifinE" as "dboolE_count"
  rename [type] "t" as "u" [module type, op] "x" as "y".
clone Ring as R.`;
  const [first, second] = parseDeclarations(text);
  assert.deepEqual(first.renames, [
    { kinds: [], pattern: "dunifinE", replacement: "dboolE_count" },
    { kinds: ["type"], pattern: "t", replacement: "u" },
    { kinds: ["module type", "op"], pattern: "x", replacement: "y" },
  ]);
  assert.deepEqual(second.renames, []);
});

test("name offsets point at the name, even after comments", () => {
  const text = "(* intro *)\nlemma (* why *) addrC (x y : int) : x + y = y + x by smt().";
  const d = find(text, "addrC");
  assert.equal(text.slice(d.nameStart, d.nameEnd), "addrC");
  assert.equal(d.start, text.indexOf("lemma"));
});

test("things that are not declarations are ignored", () => {
  const text = 'require import AllCore List.\nimport Ring.\nhint simplify foo.\nprint foo.\npragma Goals:printall.\n(* lemma hidden : true. *)\nop s = "lemma x : true.".';
  assert.deepEqual(summary(text), ["op s"]);
});

test("unfinished text does not fail", () => {
  assert.deepEqual(summary("theory A.\nlemma l : true.\nproof.\n  move=> x"), ["theory A", "lemma A.l"]);
  assert.deepEqual(summary(""), []);
  assert.deepEqual(summary("lemma"), []);
  assert.deepEqual(summary("lemma ."), []);
});

test("lists the theories a script requires", () => {
  const text = `
require import AllCore List.
require (*--*) Distr.
require export Ring.
from Jasmin require import JModel.
(* require Hidden. *)
lemma l : true.
proof. qed.
require import List.
`;
  assert.deepEqual(requiredTheories(text), ["AllCore", "List", "Distr", "Ring", "JModel"]);
  assert.deepEqual(requiredTheories("lemma l : true by []."), []);
});
