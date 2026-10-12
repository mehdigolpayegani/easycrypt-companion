import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { includeOptions, libraryDirectories, parseLoadPath } from "../src/library";

const EXECUTABLE = process.env.EASYCRYPT ?? "easycrypt";
const available = spawnSync(EXECUTABLE, ["--help"]).status === 0;

// Printed by `easycrypt config -I Foo:/tmp` (r2026.03).
const CONFIG = `git-hash: r2026.03-7-gb4d56e6
load-path:
  Foo@/tmp
  <system>@/opt/easycrypt/theories
  <system>@/opt/easycrypt/theories/datatypes
  <system>@/opt/easycrypt/theories
known provers: Alt-Ergo@2.6.0, Z3@4.13.4
System PATH:
  /usr/bin
`;

test("reads the load path printed by easycrypt config", () => {
  assert.deepEqual(parseLoadPath(CONFIG), ["/tmp", "/opt/easycrypt/theories", "/opt/easycrypt/theories/datatypes"]);
  assert.deepEqual(parseLoadPath("git-hash: x\n"), []);
});

test("passes on only the -I options", () => {
  assert.deepEqual(includeOptions(["-I", "lib", "-timeout", "5", "-I", "Foo:../foo", "-I"]), [
    "-I",
    "lib",
    "-I",
    "Foo:../foo",
  ]);
  assert.deepEqual(includeOptions([]), []);
});

test("asks the real EasyCrypt where its library is", { skip: !available && `${EXECUTABLE} not found` }, async () => {
  const dirs = await libraryDirectories(EXECUTABLE, ["-timeout", "5", "-I", tmpdir()], tmpdir());
  assert.ok(dirs.includes(tmpdir()), "the -I directory is listed");
  assert.ok(
    dirs.some((dir) => existsSync(join(dir, "List.ec"))),
    "a library directory contains List.ec",
  );
});

test("a missing executable is an error", async () => {
  await assert.rejects(libraryDirectories("/nonexistent/easycrypt", [], tmpdir()), /config failed/);
});
