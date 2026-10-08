// Dev tool: runs whole files through ProofSession in weak-check mode and
// reports those that fail (a splitting bug shows as a hang or parse error):
//
//   node scripts/corpus-check.mjs file.ec [more.ec ...]
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ProofSession } = require("../out/src/session.js");
const { sentencesFrom } = require("../out/src/sentences.js");

const exe = process.env.EASYCRYPT ?? "easycrypt";
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 120000);
let failures = 0;

for (const file of process.argv.slice(2)) {
  const path = resolve(file);
  const text = readFileSync(path, "utf8");
  const host = { getText: () => text, changed: () => {} };
  const session = new ProofSession(() => ({ executable: exe, args: [], cwd: dirname(path) }), host);
  const t0 = Date.now();
  let status;
  try {
    await session.toggleWeakCheck();
    session.processBuffer();
    const done = await Promise.race([
      session.whenIdle().then(() => "idle"),
      new Promise((r) => setTimeout(() => r("timeout"), timeoutMs)),
    ]);
    const total = sentencesFrom(text, 0).length;
    if (done === "timeout") status = `TIMEOUT after ${session.processed.length}/${total}`;
    else if (session.error) {
      const line = text.slice(0, session.error.start).split("\n").length;
      status = `ERROR line ${line}: ${session.error.message.split("\n")[0]} | ${JSON.stringify(text.slice(session.error.start, session.error.end).slice(0, 60))}`;
    } else if (session.processed.length !== total) status = `STOPPED ${session.processed.length}/${total}`;
    else status = `ok ${total} sentences`;
  } catch (e) {
    status = `EXCEPTION ${e.message}`;
  } finally {
    session.dispose();
  }
  if (!status.startsWith("ok")) failures++;
  console.log(`${status.padEnd(20).slice(0, 200)}  ${file}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`\n${failures} file(s) with problems`);
process.exit(failures ? 1 : 0);
