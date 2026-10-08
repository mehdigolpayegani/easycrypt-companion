// Runs ProofSession against a real EasyCrypt binary ($EASYCRYPT, or
// `easycrypt` on PATH). Skipped when EasyCrypt is not installed.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProofSession } from "../src/session";

const EXECUTABLE = process.env.EASYCRYPT ?? "easycrypt";
const available = spawnSync(EXECUTABLE, ["--help"]).status === 0;
const opts = { skip: available ? false : `${EXECUTABLE} not found`, timeout: 120_000 };

const dir = mkdtempSync(join(tmpdir(), "ecc-test-"));
writeFileSync(join(dir, "Helper.ec"), "op aa : int = 3.\nlemma aa_ok : aa = 3 by rewrite /aa.\n");

class Host {
  changes = 0;
  constructor(public text: string) {}
  getText = () => this.text;
  changed = () => {
    this.changes++;
  };
  /** Applies an edit and notifies the session, as the VS Code glue does. */
  edit(session: ProofSession, start: number, end: number, insert: string): void {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
    session.edited(start, this.text);
  }
}

function makeSession(text: string): { host: Host; session: ProofSession } {
  const host = new Host(text);
  const session = new ProofSession(() => ({ executable: EXECUTABLE, args: [], cwd: dir }), host);
  return { host, session };
}

/** Text of each processed sentence. */
function processedText(host: Host, session: ProofSession): string[] {
  return session.processed.map((s) => host.text.slice(s.contentStart, s.end));
}

const SCRIPT = `require import AllCore Helper.

lemma foo (x : int) : x + 0 = x.
proof.
  smt().
qed.

lemma bar (y : int) : y = y.
proof. trivial. qed.
`;

test("steps forward one sentence at a time and shows goals", opts, async () => {
  const { host, session } = makeSession(SCRIPT);
  try {
    session.next();
    session.next();
    session.next();
    await session.whenIdle();
    assert.deepEqual(processedText(host, session), [
      "require import AllCore Helper.",
      "lemma foo (x : int) : x + 0 = x.",
      "proof.",
    ]);
    assert.match(session.goals, /^Current goal/);
    assert.match(session.goals, /x \+ 0 = x/);

    session.next();
    session.next();
    await session.whenIdle();
    assert.equal(session.goals, "");
    assert.match(session.response, /added lemma: `foo'/);
    assert.equal(session.processedEnd, SCRIPT.indexOf("qed.") + 4);
  } finally {
    session.dispose();
  }
});

test("processes to the cursor and back, like C-c C-RET", opts, async () => {
  const { host, session } = makeSession(SCRIPT);
  try {
    // Cursor at the start of the line after `proof.`: processes up to `proof.`.
    session.gotoOffset(SCRIPT.indexOf("  smt()"));
    await session.whenIdle();
    assert.equal(processedText(host, session).at(-1), "proof.");

    // Cursor in the middle of `lemma foo`: retracts that lemma.
    session.gotoOffset(SCRIPT.indexOf("foo (x"));
    await session.whenIdle();
    assert.deepEqual(processedText(host, session), ["require import AllCore Helper."]);
    assert.equal(session.goals, "");

    session.processBuffer();
    await session.whenIdle();
    assert.equal(session.processed.length, 9);
    assert.equal(session.error, undefined);
  } finally {
    session.dispose();
  }
});

test("undo returns EasyCrypt to the previous state", opts, async () => {
  const { host, session } = makeSession(SCRIPT);
  try {
    session.gotoOffset(SCRIPT.indexOf("qed."));
    await session.whenIdle();
    const goalsInProof = session.goals;
    session.next(); // qed.
    await session.whenIdle();
    assert.equal(session.goals, "");

    session.undo();
    await session.whenIdle();
    assert.equal(processedText(host, session).at(-1), "smt().");
    assert.equal(session.goals, goalsInProof);

    // EasyCrypt really is back inside the proof: qed can be replayed.
    session.next();
    await session.whenIdle();
    assert.equal(session.error, undefined);
    assert.match(session.response, /added lemma: `foo'/);
  } finally {
    session.dispose();
  }
});

test("reports errors at the right place, even after multi-byte characters", opts, async () => {
  const script = `require import AllCore.
lemma baz (x : int) : x = x.
proof.
  (* é → ∀ *) rewrite nonexist.
qed.
`;
  const { host, session } = makeSession(script);
  try {
    session.processBuffer();
    await session.whenIdle();
    assert.equal(session.processed.length, 3, "stops before the failing sentence");
    assert.ok(session.error);
    assert.match(session.error.message, /unknown lemma/);
    assert.equal(host.text.slice(session.error.start, session.error.end), "nonexist");
    assert.match(session.response, /unknown lemma/);
    assert.match(session.goals, /x = x/, "goals are those before the error");

    // Fixing the sentence clears the error; processing continues.
    const at = host.text.indexOf("rewrite nonexist.");
    host.edit(session, at, at + "rewrite nonexist.".length, "trivial.");
    assert.equal(session.error, undefined);
    session.processBuffer();
    await session.whenIdle();
    assert.equal(session.error, undefined);
    assert.equal(session.processed.length, 5);
  } finally {
    session.dispose();
  }
});

test("editing the processed region retracts from the edit", opts, async () => {
  const { host, session } = makeSession(SCRIPT);
  try {
    session.processBuffer();
    await session.whenIdle();
    const at = host.text.indexOf("smt().");
    host.edit(session, at, at + "smt().".length, "smt(@Int).");
    assert.equal(processedText(host, session).at(-1), "proof.");
    await session.whenIdle();

    session.processBuffer();
    await session.whenIdle();
    assert.equal(session.error, undefined);
    assert.equal(session.processed.length, 9);
  } finally {
    session.dispose();
  }
});

test("typing right after a processed `.` retracts that sentence", opts, async () => {
  const { host, session } = makeSession("require import AllCore.\nlemma t : true.\n");
  try {
    session.processBuffer();
    await session.whenIdle();
    assert.equal(session.processed.length, 2);
    // Typing a space after the dot keeps both sentences.
    const end = session.processedEnd;
    host.edit(session, end, end, " ");
    assert.equal(session.processed.length, 2);
    // Typing a letter right after the dot changes where the sentence ends.
    host.edit(session, end, end + 1, "x");
    assert.equal(session.processed.length, 1);
  } finally {
    session.dispose();
  }
});

test("interrupting a long command keeps the session usable", opts, async () => {
  const script = `require import AllCore.
lemma slow (x y z : int) : (x + y) * (x - y) * z * z * z = x*x*z*z*z - y*y*z*z*z + 1.
proof.
smt(@Int).
`;
  const { session } = makeSession(script);
  try {
    session.gotoOffset(script.indexOf("smt(@Int)"));
    await session.whenIdle();
    session.next();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(session.busy, "smt is still running");
    session.interrupt();
    await session.whenIdle();
    assert.match(session.error?.message ?? "", /interrupted/);
    assert.equal(session.processed.length, 3);

    // The prover still answers.
    const reply = await session.query("print aa_ok.").catch((e) => e);
    assert.ok(reply instanceof Error === false);
  } finally {
    session.dispose();
  }
});

test("undo while a command runs interrupts it and retracts it", opts, async () => {
  const script = `require import AllCore.
lemma slow (x y z : int) : (x + y) * (x - y) * z * z * z = x*x*z*z*z - y*y*z*z*z + 1.
proof.
smt(@Int).
`;
  const { session } = makeSession(script);
  try {
    session.gotoOffset(script.indexOf("smt(@Int)"));
    await session.whenIdle();
    session.next();
    await new Promise((r) => setTimeout(r, 1000));
    session.undo(); // the smt call
    session.undo(); // proof.
    await session.whenIdle();
    assert.equal(session.processed.length, 2);
    assert.equal(session.error, undefined, "an interrupt caused by undo is not an error");
    session.next();
    await session.whenIdle();
    assert.equal(session.processed.length, 3);
    assert.match(session.goals, /Current goal/);
  } finally {
    session.dispose();
  }
});

test("queries: print, search, locate", opts, async () => {
  const { host, session } = makeSession(SCRIPT);
  try {
    session.gotoOffset(SCRIPT.indexOf("  smt()"));
    await session.whenIdle();

    const printed = await session.query("print aa_ok.");
    assert.match(printed.messages, /lemma aa_ok: aa = 3/);
    assert.match(session.response, /lemma aa_ok/);
    assert.match(session.goals, /x \+ 0 = x/, "goals stay those of the proof");

    const found = await session.query("search (+) (<=).");
    assert.ok(found.messages.length > 0);

    const located = await session.query("locate aa.");
    assert.match(located.messages, /Helper\.aa/);

    // Not an error for EasyCrypt, just a message.
    const unknown = await session.query("print nosuchthing.");
    assert.match(unknown.messages, /no such object/);

    const bad = await session.query("search (.");
    assert.ok(bad.error, "a parse error is reported as an error");

    // Stepping and undoing still work after queries changed the state number.
    session.next();
    session.next();
    await session.whenIdle();
    assert.equal(processedText(host, session).at(-1), "qed.");
    session.undo();
    session.undo();
    session.undo();
    await session.whenIdle();
    assert.equal(processedText(host, session).at(-1), "lemma foo (x : int) : x + 0 = x.");
    session.next();
    await session.whenIdle();
    assert.equal(session.error, undefined);
    assert.match(session.goals, /x \+ 0 = x/);
  } finally {
    session.dispose();
  }
});

test("weak-check mode toggles", opts, async () => {
  const { session } = makeSession(SCRIPT);
  try {
    session.next();
    await session.whenIdle();
    assert.equal(session.mode, "check");
    await session.toggleWeakCheck();
    assert.equal(session.mode, "weakcheck");
    await session.toggleWeakCheck();
    assert.equal(session.mode, "check");
  } finally {
    session.dispose();
  }
});

test("retracting the buffer and exiting", opts, async () => {
  const { session } = makeSession(SCRIPT);
  try {
    session.processBuffer();
    await session.whenIdle();
    session.retractBuffer();
    await session.whenIdle();
    assert.equal(session.processed.length, 0);
    assert.equal(session.goals, "");
    session.gotoOffset(SCRIPT.indexOf("  smt()"));
    await session.whenIdle();
    assert.equal(session.processed.length, 3);

    session.exit();
    assert.equal(session.processed.length, 0);
    assert.equal(session.running, false);
    session.next();
    await session.whenIdle();
    assert.equal(session.processed.length, 1, "a new prover starts on demand");
  } finally {
    session.dispose();
  }
});

test("a missing executable is reported, not thrown", opts, async () => {
  const host = new Host(SCRIPT);
  const session = new ProofSession(
    () => ({ executable: "/nonexistent/easycrypt", args: [], cwd: dir }),
    host,
  );
  session.next();
  await session.whenIdle();
  assert.equal(session.processed.length, 0);
  assert.equal(session.running, false);
  assert.match(session.response, /exited|not found|No such file/i);
  session.dispose();
});
