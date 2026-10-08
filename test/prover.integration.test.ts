// Runs Prover against a real EasyCrypt ($EASYCRYPT, or `easycrypt` on PATH).

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Prover, ProverExitedError } from "../src/prover";

const EXECUTABLE = process.env.EASYCRYPT ?? "easycrypt";
const available = spawnSync(EXECUTABLE, ["--help"]).status === 0;
const opts = { skip: available ? false : `${EXECUTABLE} not found`, timeout: 60_000 };

function prover(executable = EXECUTABLE): Prover {
  return new Prover({ executable, args: [], cwd: tmpdir() });
}

test("starts and reports the first prompt", opts, async () => {
  const p = prover();
  try {
    assert.deepEqual(await p.start(), { state: 0, mode: "check" });
    assert.match(p.banner, /Copyright/);
    assert.equal(p.running, true);
  } finally {
    p.kill();
  }
});

test("a command advances the state and returns the goal", opts, async () => {
  const p = prover();
  try {
    await p.start();
    assert.equal((await p.send("require import AllCore.")).state, 1);
    const lemma = await p.send("lemma foo (x : int) : x + 0 = x.");
    assert.equal(lemma.state, 2);
    assert.equal(lemma.error, undefined);
    assert.match(lemma.goals ?? "", /x \+ 0 = x/);
  } finally {
    p.kill();
  }
});

test("an error leaves the state unchanged, and undo goes back", opts, async () => {
  const p = prover();
  try {
    await p.start();
    await p.send("require import AllCore.");
    await p.send("lemma foo (x : int) : x + 0 = x.");
    await p.send("proof.");
    const bad = await p.send("rewrite nonexist.");
    assert.equal(bad.state, 3);
    assert.match(bad.error?.message ?? "", /unknown lemma/);

    const back = await p.send("undo 1.");
    assert.equal(back.state, 1);
    assert.equal(back.goals, undefined, "no longer inside the proof");
  } finally {
    p.kill();
  }
});

test("only one command may be in flight", opts, async () => {
  const p = prover();
  try {
    await p.start();
    const first = p.send("require import AllCore.");
    await assert.rejects(p.send("print true."), /busy/);
    assert.equal((await first).state, 1);
  } finally {
    p.kill();
  }
});

test("interrupt stops a long command and keeps EasyCrypt alive", opts, async () => {
  const p = prover();
  try {
    await p.start();
    await p.send("require import AllCore.");
    await p.send("lemma slow (x y z : int) : (x + y) * (x - y) * z * z * z = x*x*z*z*z - y*y*z*z*z + 1.");
    await p.send("proof.");
    const pending = p.send("smt(@Int).");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(p.busy, true, "smt is still running");
    p.interrupt();
    const reply = await pending;
    assert.match(reply.error?.message ?? "", /interrupted/);
    assert.equal(reply.state, 3);

    const next = await p.send("trivial.");
    assert.equal(next.error, undefined, "the prover still answers");
  } finally {
    p.kill();
  }
});

test("a missing executable is reported", { timeout: 60_000 }, async () => {
  const p = prover("/nonexistent/easycrypt");
  await assert.rejects(p.start(), (err: unknown) => err instanceof ProverExitedError);
  assert.equal(p.running, false);
});
