// Runs test/e2e/suite.ts inside VS Code ($VSCODE_EXECUTABLE, or the macOS
// install) with a throwaway profile. Requires EasyCrypt on PATH.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const FILES: Record<string, string> = {
  "Helper.ec": "op aa : int = 3.\nlemma aa_ok : aa = 3 by rewrite /aa.\n",
  "proof.ec": `require import AllCore Helper.

lemma foo (x : int) : x + 0 = x.
proof.
  smt().
qed.

lemma bar (y : int) : y = y.
proof. trivial. qed.
`,
  "error.ec": `require import AllCore.
lemma baz (x : int) : x = x.
proof.
  rewrite nonexist.
qed.
`,
  "slow.ec": `require import AllCore.
lemma slow (x y z : int) : (x + y) * (x - y) * z * z * z = x*x*z*z*z - y*y*z*z*z + 1.
proof.
smt(@Int).
`,
};

async function main(): Promise<void> {
  const root = resolve(__dirname, "..", "..", "..");
  const scratch = mkdtempSync(join(tmpdir(), "ecc-e2e-"));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(workspace, name), text);

  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ??
    (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : undefined);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "out", "test", "e2e", "suite.js"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--user-data-dir",
      join(scratch, "user-data"),
      "--extensions-dir",
      join(scratch, "extensions"),
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
