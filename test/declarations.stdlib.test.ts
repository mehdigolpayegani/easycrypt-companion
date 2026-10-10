// Runs the declaration parser over EasyCrypt's installed standard library
// (found with `easycrypt config`). Skipped when EasyCrypt is not installed.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseDeclarations, qualifiedName } from "../src/declarations";

const EXECUTABLE = process.env.EASYCRYPT ?? "easycrypt";

function stdlibFiles(): string[] {
  const config = spawnSync(EXECUTABLE, ["config"], { encoding: "utf8" });
  if (config.status !== 0) return [];
  const dirs = [...`${config.stdout}\n${config.stderr}`.matchAll(/^\s*<system>@(.+)$/gm)].map((m) => m[1].trim());
  return [...new Set(dirs)].flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.eca?$/.test(name))
      .map((name) => join(dir, name)),
  );
}

const files = stdlibFiles();
const opts = { skip: files.length > 0 ? false : "EasyCrypt standard library not found" };

/** `text` with comments blanked out, keeping line breaks. */
function withoutComments(text: string): string {
  return text.replace(/\(\*[\s\S]*?\*\)/g, (c) => c.replace(/[^\n]/g, " "));
}

test("every lemma line of the standard library is found", opts, () => {
  let lemmas = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const found = parseDeclarations(text).filter((d) => d.keyword.endsWith("lemma")).length;
    // Lines such as `lemma addrA <- addbA,` are substitutions of a clone.
    const lines = withoutComments(text)
      .split("\n")
      .filter((line) => /^\s*(?:local\s+)?lemma\b/.test(line) && !/^\s*lemma\s+[\w.']+\s*<-/.test(line)).length;
    assert.equal(found, lines, basename(file));
    lemmas += found;
  }
  assert.ok(lemmas > 1000, `only ${lemmas} lemmas found`);
});

test("every proof of the standard library is closed where it ends", opts, () => {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const d of parseDeclarations(text)) {
      if (d.kind !== "lemma" || d.end === d.signatureEnd) continue;
      assert.match(text.slice(d.signatureEnd, d.end), /\b(?:qed|admitted)\s*\.$/, `${basename(file)}: ${d.name}`);
    }
  }
});

test("well-known declarations are found where they are", opts, () => {
  const declarationsOf = (name: string) => {
    const file = files.find((f) => basename(f) === name);
    assert.ok(file, `${name} not in the standard library`);
    return parseDeclarations(readFileSync(file, "utf8")).map((d) => `${d.kind} ${qualifiedName(d)}`);
  };
  assert.ok(declarationsOf("List.ec").includes("lemma size_cat"));
  assert.ok(declarationsOf("Ring.ec").includes("axiom ZModule.addrC"));
  assert.ok(declarationsOf("Ring.ec").includes("theory ComRing"));
});
