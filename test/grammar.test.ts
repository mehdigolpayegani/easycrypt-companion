// Tokenizes snippets with the same TextMate engine VS Code uses.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as oniguruma from "vscode-oniguruma";
import * as tm from "vscode-textmate";

const root = join(__dirname, "..", "..");

async function loadRegistry(): Promise<tm.Registry> {
  const wasm = readFileSync(join(root, "node_modules", "vscode-oniguruma", "release", "onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const files: Record<string, string> = {
    "source.easycrypt": "easycrypt.tmLanguage.json",
  };
  return new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope) => {
      const file = files[scope];
      if (!file) return null;
      const path = join(root, "syntaxes", file);
      return tm.parseRawGrammar(readFileSync(path, "utf8"), path);
    },
  });
}

const registryPromise = loadRegistry();

/** Tokenizes `text`; maps the text of each token to its scopes (first occurrence wins). */
async function scopesOf(scope: string, text: string): Promise<Map<string, string[]>> {
  const grammar = (await (await registryPromise).loadGrammar(scope))!;
  const result = new Map<string, string[]>();
  let state = tm.INITIAL;
  for (const line of text.split("\n")) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) {
      const word = line.slice(t.startIndex, t.endIndex).trim();
      if (word && !result.has(word)) result.set(word, t.scopes);
    }
    state = r.ruleStack;
  }
  return result;
}

function innermost(scopes: string[] | undefined): string {
  return scopes?.[scopes.length - 1] ?? "(none)";
}

test("keyword categories from the lexer", async () => {
  const s = await scopesOf(
    "source.easycrypt",
    "require import AllCore.\nproof.\n  move=> x; try smt(). admit.\nqed.\nwhile (b) { x <- x + 1; }",
  );
  assert.equal(innermost(s.get("require")), "keyword.control.easycrypt");
  assert.equal(innermost(s.get("move")), "support.function.tactic.easycrypt");
  assert.equal(innermost(s.get("try")), "keyword.operator.tactical.easycrypt");
  assert.equal(innermost(s.get("smt")), "keyword.other.closing-tactic.easycrypt");
  assert.equal(innermost(s.get("admit")), "invalid.illegal.admit.easycrypt");
  assert.equal(innermost(s.get("while")), "keyword.other.program.easycrypt");
});

test("declared names", async () => {
  const s = await scopesOf("source.easycrypt", "lemma addC (x y : int) : x + y = y + x.\nop f : int.\nmodule M = {}.");
  assert.equal(innermost(s.get("addC")), "entity.name.function.lemma.easycrypt");
  assert.equal(innermost(s.get("f")), "entity.name.function.easycrypt");
  assert.equal(innermost(s.get("M")), "entity.name.type.easycrypt");
});

test("comments nest; (*) is an operator", async () => {
  const s = await scopesOf("source.easycrypt", "(* a (* b *) lemma *) rewrite (*).");
  assert.equal(innermost(s.get("lemma")), "comment.block.easycrypt");
  assert.equal(innermost(s.get("rewrite")), "support.function.tactic.easycrypt");
  assert.equal(innermost(s.get("(*)")), "keyword.operator.easycrypt");
});

test("a theory name is a qualifier only when something follows the dot", async () => {
  const s = await scopesOf("source.easycrypt", "require import AllCore StdOrder.\nrewrite Ring.addrC GEO.c.");
  assert.equal(innermost(s.get("Ring")), "entity.name.namespace.easycrypt");
  assert.equal(innermost(s.get("GEO")), "entity.name.namespace.easycrypt");
  // `StdOrder.` ends the sentence: it must look like `AllCore`, which is plain text.
  for (const [text, scopes] of s) {
    if (text.includes("StdOrder")) assert.equal(innermost(scopes), "source.easycrypt", text);
  }
});
