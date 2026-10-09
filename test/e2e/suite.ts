// End-to-end checks, run inside VS Code by test/e2e/run.ts.

import { strict as assert } from "node:assert";
import { join } from "node:path";
import * as vscode from "vscode";
import type { CompanionApi } from "../../src/extension";
import { GOALS_URI, RESPONSE_URI } from "../../src/panels";
import { followPosition } from "../../src/sentences";

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function open(name: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(join(workspace(), name));
  return vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
}

function paneText(uri: vscode.Uri): string {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText() ?? "";
}

/** Waits for a pane to show `expected`; panes are refreshed asynchronously. */
function paneShows(uri: vscode.Uri, expected: RegExp | string): Promise<true> {
  return waitFor(
    `${uri.path} to show ${expected}`,
    () => (typeof expected === "string" ? paneText(uri) === expected : expected.test(paneText(uri))),
    10_000,
  );
}

function exec(command: string, ...args: unknown[]): Thenable<unknown> {
  return vscode.commands.executeCommand(`easycryptCompanion.${command}`, ...args);
}

let api: CompanionApi;

async function idle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  await api.currentSession()?.whenIdle();
  await new Promise((r) => setTimeout(r, 60)); // let the UI refresh
}

function setCursor(editor: vscode.TextEditor, offset: number): void {
  const pos = editor.document.positionAt(offset);
  editor.selection = new vscode.Selection(pos, pos);
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "activates on .ec files",
    async () => {
      const editor = await open("proof.ec");
      assert.equal(editor.document.languageId, "easycrypt");
      const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === "easycrypt-companion");
      assert.ok(ext, "extension found");
      api = (await ext.activate()) as CompanionApi;
      assert.ok(api.currentSession, "test API exported");
    },
  ],
  [
    "Next shows goals in a three-pane layout and moves the cursor",
    async () => {
      const editor = await open("proof.ec");
      await exec("next");
      await exec("next");
      await exec("next");
      await idle();
      const goals = await waitFor("goals", () => paneText(GOALS_URI).includes("Current goal") && paneText(GOALS_URI));
      assert.match(goals, /x \+ 0 = x/);
      await waitFor("three editor groups", () => vscode.window.tabGroups.all.length === 3);
      const goalsEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === GOALS_URI.toString());
      assert.equal(goalsEditor?.viewColumn, vscode.ViewColumn.Two, "goals top right");
      assert.equal(goalsEditor?.document.languageId, "easycrypt-output");
      const responseEditor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === RESPONSE_URI.toString(),
      );
      assert.equal(responseEditor?.viewColumn, vscode.ViewColumn.Three, "response bottom right");
      const paneSettings = vscode.workspace.getConfiguration("editor", { languageId: "easycrypt-output" });
      assert.equal(paneSettings.get("lineNumbers"), "off", "panes have no line numbers");
      assert.equal(paneSettings.get("minimap.enabled"), false, "panes have no minimap");
      assert.equal(paneSettings.get("renderLineHighlight"), "none", "panes have no current-line highlight");

      const script = vscode.window.visibleTextEditors.find((e) => e.document === editor.document)!;
      const text = script.document.getText();
      const expected = followPosition(text, text.indexOf("proof.") + "proof.".length);
      assert.equal(script.document.offsetAt(script.selection.active), expected, "cursor follows");
      assert.equal(vscode.window.activeTextEditor?.document, editor.document, "focus stays in the script");
    },
  ],
  [
    "Process to Cursor goes forward and back",
    async () => {
      const editor = await open("proof.ec");
      const text = editor.document.getText();
      setCursor(editor, text.indexOf("lemma bar"));
      await exec("gotoCursor");
      await idle();
      assert.equal(api.currentSession()!.processedEnd, text.indexOf("qed.") + 4);
      await paneShows(RESPONSE_URI, /added lemma: `foo'/);

      setCursor(editor, text.indexOf("foo (x"));
      await exec("gotoCursor");
      await idle();
      assert.equal(api.currentSession()!.processed.length, 1);
      await paneShows(GOALS_URI, "");
    },
  ],
  [
    "Undo moves the cursor back",
    async () => {
      const editor = await open("proof.ec");
      await exec("next");
      await exec("next");
      await idle();
      await exec("undo");
      await idle();
      const text = editor.document.getText();
      assert.equal(api.currentSession()!.processedEnd, text.indexOf("x + 0 = x.") + "x + 0 = x.".length);
      const script = vscode.window.activeTextEditor!;
      assert.equal(script.document.offsetAt(script.selection.active), followPosition(text, api.currentSession()!.processedEnd));
    },
  ],
  [
    "errors become diagnostics and editing clears them",
    async () => {
      const editor = await open("error.ec");
      await exec("processBuffer");
      await idle();
      const diags = await waitFor("diagnostic", () => {
        const d = vscode.languages.getDiagnostics(editor.document.uri);
        return d.length > 0 && d;
      });
      assert.equal(diags.length, 1);
      assert.match(diags[0].message, /unknown lemma/);
      assert.equal(editor.document.getText(diags[0].range), "nonexist");
      await paneShows(RESPONSE_URI, /unknown lemma/);

      const at = editor.document.getText().indexOf("rewrite nonexist.");
      const ok = await editor.edit((b) =>
        b.replace(
          new vscode.Range(editor.document.positionAt(at), editor.document.positionAt(at + "rewrite nonexist.".length)),
          "trivial.",
        ),
      );
      assert.ok(ok);
      await waitFor("diagnostic cleared", () => vscode.languages.getDiagnostics(editor.document.uri).length === 0);
      await exec("processBuffer");
      await idle();
      assert.equal(api.currentSession()!.processed.length, 5);
      assert.equal(vscode.languages.getDiagnostics(editor.document.uri).length, 0);
    },
  ],
  [
    "editing the processed region retracts from the edit",
    async () => {
      const editor = await open("proof.ec");
      await exec("processBuffer");
      await idle();
      assert.equal(api.currentSession()!.processed.length, 9);
      const at = editor.document.getText().indexOf("smt().");
      await editor.edit((b) => b.insert(editor.document.positionAt(at), "  "));
      await idle();
      assert.ok(api.currentSession()!.processedEnd <= at);
      assert.equal(api.currentSession()!.processed.length, 3);
    },
  ],
  [
    "print, search and locate show results in the response pane",
    async () => {
      await open("proof.ec");
      await exec("print", "aa_ok");
      await idle();
      await paneShows(RESPONSE_URI, /lemma aa_ok: aa = 3/);
      await exec("search", "(+) (<=)");
      await idle();
      await paneShows(RESPONSE_URI, /lemma /);
      await exec("locate", "aa");
      await idle();
      await paneShows(RESPONSE_URI, /Helper\.aa/);
      await exec("sendCommand", "print op aa");
      await idle();
      await paneShows(RESPONSE_URI, /op aa/);
    },
  ],
  [
    "weak-check mode toggles",
    async () => {
      await open("proof.ec");
      await exec("toggleWeakCheck");
      await idle();
      assert.equal(api.currentSession()!.mode, "weakcheck");
      await exec("toggleWeakCheck");
      await idle();
      assert.equal(api.currentSession()!.mode, "check");
    },
  ],
  [
    "interrupt stops a long smt call",
    async () => {
      const editor = await open("slow.ec");
      setCursor(editor, editor.document.getText().indexOf("smt(@Int)"));
      await exec("gotoCursor");
      await idle();
      await exec("next");
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(api.currentSession()!.busy);
      await exec("interrupt");
      await idle();
      const diags = await waitFor("interrupt diagnostic", () => {
        const d = vscode.languages.getDiagnostics(editor.document.uri);
        return d.length > 0 && d;
      });
      assert.match(diags[0].message, /interrupted/);
      assert.equal(api.currentSession()!.processed.length, 3);
    },
  ],
  [
    "Retract Buffer empties the processed region and the goals",
    async () => {
      await open("proof.ec");
      await exec("processBuffer");
      await idle();
      await exec("retractBuffer");
      await idle();
      assert.equal(api.currentSession()!.processed.length, 0);
      await paneShows(GOALS_URI, "");
    },
  ],
  [
    "VS Code registers the Proof General key chords",
    async () => {
      await vscode.commands.executeCommand("workbench.action.openDefaultKeybindingsFile");
      const text = await waitFor("default keybindings", () => {
        const doc = vscode.window.activeTextEditor?.document;
        return doc && doc.getText().includes("easycryptCompanion") && doc.getText();
      });
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      const expected: Array<[string, string]> = [
        ["ctrl+c ctrl+n", "next"],
        ["ctrl+c ctrl+u", "undo"],
        ["ctrl+c ctrl+enter", "gotoCursor"],
        ["ctrl+c ctrl+b", "processBuffer"],
        ["ctrl+c ctrl+r", "retractBuffer"],
        ["ctrl+c ctrl+c", "interrupt"],
        ["ctrl+c ctrl+l", "layout"],
        ["ctrl+c ctrl+v", "sendCommand"],
        ["ctrl+c ctrl+a ctrl+p", "print"],
        ["ctrl+c ctrl+f", "search"],
        ["alt+down", "next"],
      ];
      for (const [key, command] of expected) {
        const re = new RegExp(`"key":\\s*"${key.replace(/\+/g, "\\+")}",\\s*"command":\\s*"easycryptCompanion\\.${command}"`);
        assert.match(text, re, `${key} -> ${command}`);
      }
    },
  ],
  [
    "a missing executable is reported in the response pane",
    async () => {
      const config = vscode.workspace.getConfiguration("easycryptCompanion");
      await config.update("executable", "/nonexistent/easycrypt", vscode.ConfigurationTarget.Global);
      try {
        const doc = await vscode.workspace.openTextDocument({ language: "easycrypt", content: "lemma t : true.\n" });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        await exec("next");
        await idle();
        await waitFor("failure message", () => /exited|not found/i.test(paneText(RESPONSE_URI)));
        assert.equal(api.currentSession()!.running, false);
      } finally {
        await config.update("executable", undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
];

export async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`✔ ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      failed++;
      console.log(`✖ ${name}\n${err instanceof Error ? err.stack : String(err)}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} end-to-end tests passed`);
  if (failed) throw new Error(`${failed} end-to-end test(s) failed`);
}
