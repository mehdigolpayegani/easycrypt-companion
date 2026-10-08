import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseReply, PromptSplitter } from "../src/protocol";

// Output captured from `easycrypt cli -emacs` (r2026.03).
const BANNER = "[W]+ >> Copyright (c) 2012 IMDEA Software Institute\n[W]| >> GIT hash: r2026.03\n";
const GOAL = [
  "Current goal",
  "",
  "Type variables: <none>",
  "",
  "x: int",
  "------------------------------------------------------------------------",
  "x + 0 = x",
].join("\n");

test("splits output at prompts, even across chunks", () => {
  const sp = new PromptSplitter();
  assert.deepEqual(sp.push(BANNER + "[0|che"), []);
  const first = sp.push("ck]>\n[1|check]>\n" + GOAL + "\n[2|che");
  assert.equal(first.length, 2);
  assert.equal(first[0].body, BANNER.slice(0, -1));
  assert.deepEqual(first[0].prompt, { state: 0, mode: "check" });
  assert.equal(first[1].body, "");
  assert.deepEqual(first[1].prompt, { state: 1, mode: "check" });
  const second = sp.push("ck]>\n");
  assert.equal(second[0].body, GOAL);
  assert.deepEqual(second[0].prompt, { state: 2, mode: "check" });
  assert.equal(sp.pending(), "");
});

test("parses the weakcheck mode", () => {
  const sp = new PromptSplitter();
  assert.deepEqual(sp.push("[3|weakcheck]>\n")[0].prompt, { state: 3, mode: "weakcheck" });
});

test("separates goals from other output", () => {
  const r = parseReply("* In [lemmas or axioms]:\n\nlemma aa_ok: aa = 3.\n\n" + GOAL, { state: 4, mode: "check" });
  assert.equal(r.goals, GOAL);
  assert.equal(r.messages, "* In [lemmas or axioms]:\n\nlemma aa_ok: aa = 3.");
  assert.equal(r.error, undefined);
});

test("recognises every goal header", () => {
  assert.equal(parseReply("No more goals", { state: 1, mode: "check" }).goals, "No more goals");
  assert.equal(
    parseReply("Current goal (remaining: 2)\n\nfoo", { state: 1, mode: "check" }).goals,
    "Current goal (remaining: 2)\n\nfoo",
  );
  assert.equal(
    parseReply("Remaining lemmas to prove:\n M.foo: true", { state: 1, mode: "check" }).goals,
    "Remaining lemmas to prove:\n M.foo: true",
  );
});

test("parses errors with their byte range", () => {
  const r = parseReply("[error-9-18]unknown lemma `nonexist'\n\n", { state: 3, mode: "check" });
  assert.deepEqual(r.error, { startByte: 9, endByte: 18, message: "unknown lemma `nonexist'" });
  assert.equal(r.goals, undefined);
});

test("keeps multi-line error messages and notices printed before them", () => {
  const r = parseReply("+ a notice\n[error-0-5]cannot apply:\n  first\n  second\n", { state: 1, mode: "check" });
  assert.equal(r.error?.message, "cannot apply:\n  first\n  second");
  assert.equal(r.messages, "a notice");
});

test("strips notice prefixes", () => {
  const r = parseReply("+ added lemma: `foo'", { state: 5, mode: "check" });
  assert.equal(r.messages, "added lemma: `foo'");
  const s = parseReply(
    "+ (* RField.AddMonoid.addmC *)\n| lemma addmC: commutative (+).\n| (* RField.subrr *)\n| lemma subrr: forall (x : real), x - x = 0%r.",
    { state: 3, mode: "check" },
  );
  assert.equal(
    s.messages,
    "(* RField.AddMonoid.addmC *)\nlemma addmC: commutative (+).\n(* RField.subrr *)\nlemma subrr: forall (x : real), x - x = 0%r.",
  );
});

test("does not strip `| ` outside notice blocks", () => {
  const r = parseReply("op f = fun x =>\n| None => 0", { state: 1, mode: "check" });
  assert.equal(r.messages, "op f = fun x =>\n| None => 0");
});

test("collects warnings", () => {
  const r = parseReply(BANNER.slice(0, -1), { state: 0, mode: "check" });
  assert.deepEqual(r.warnings, [">> Copyright (c) 2012 IMDEA Software Institute\n>> GIT hash: r2026.03"]);
  assert.equal(r.messages, "");
});
