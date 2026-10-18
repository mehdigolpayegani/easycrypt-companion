// End-to-end checks, run inside VS Code by test/e2e/run.ts.

import { strict as assert } from "node:assert";
import { join } from "node:path";
import * as vscode from "vscode";
import type { CompanionApi } from "../../src/extension";
import { GOALS_URI, RESPONSE_URI } from "../../src/panels";
import { followPosition } from "../../src/sentences";

const workspace = () => vscode.workspace.workspaceFolders![0].uri.fsPath;

type Maybe<T> = T | undefined | false;

async function waitFor<T>(what: string, fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
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
    "search results are listed, and each leads to its own lemma",
    async () => {
      await open("proof.ec");
      await exec("search", "zz");
      await idle();
      await paneShows(RESPONSE_URI, /Left\.same/);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        RESPONSE_URI,
      );
      assert.deepEqual(symbols.map((s) => s.name).sort(), ["Left.same", "Right.same"]);
      // Both are called `same`: the comment above each tells them apart.
      const helper = (await vscode.workspace.openTextDocument(join(workspace(), "Helper.ec"))).getText().split("\n");
      for (const s of symbols) {
        const found = await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeDefinitionProvider",
          RESPONSE_URI,
          s.selectionRange.start,
        );
        const lemma = helper.indexOf(`theory ${s.name.split(".")[0]}.`) + 1;
        assert.deepEqual(found.map((l) => `${l.uri.fsPath.split("/").pop()}:${l.range.start.line}`), [`Helper.ec:${lemma}`], s.name);
      }
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
    "outline and folding come from the declarations",
    async () => {
      const editor = await open("outline.ec");
      const uri = editor.document.uri;
      const symbols = await waitFor("outline", async () => {
        const found = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
        return found?.length ? found : undefined;
      });
      assert.deepEqual(
        symbols.map((s) => [s.name, s.detail, vscode.SymbolKind[s.kind]]),
        [["T", "theory", "Namespace"]],
      );
      assert.deepEqual(
        symbols[0].children.map((s) => [s.name, vscode.SymbolKind[s.kind]]),
        [
          ["x", "Operator"],
          ["l", "Function"],
        ],
      );
      assert.equal(editor.document.getText(symbols[0].children[1].selectionRange), "l");

      const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", uri);
      assert.deepEqual(
        folds.map((f) => [f.start, f.end]),
        [
          [0, 5],
          [2, 5],
        ],
      );
    },
  ],
  [
    "Go to Symbol in Workspace finds lemmas of the project and of the library",
    async () => {
      await api.indexReady;
      const find = async (query: string) =>
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)) ?? [];

      const project = (await find("aa_ok")).find((s) => s.name === "aa_ok");
      assert.ok(project, "aa_ok found");
      assert.match(project.location.uri.fsPath, /Helper\.ec$/);
      assert.equal(project.location.range.start.line, 1);
      assert.equal(vscode.SymbolKind[project.kind], "Function");

      assert.ok(
        (await find("size_cat")).some((s) => s.name === "size_cat" && /List\.ec$/.test(s.location.uri.fsPath)),
        "size_cat found in the library",
      );
      assert.ok(
        (await find("l")).some((s) => s.name === "l" && s.containerName === "T"),
        "a lemma inside a theory names its theory",
      );
      assert.deepEqual(await find("build_copy_lemma"), [], "copies in _build are left out");

      // A file added to the project is picked up.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(workspace(), "Fresh.ec"), "lemma fresh_lemma : true by [].\n");
      await waitFor("new file indexed", async () => (await find("fresh_lemma")).length > 0, 15_000);

      // So is typing in an open file, before it is saved.
      const editor = await open("outline.ec");
      const end = editor.document.positionAt(editor.document.getText().length);
      await editor.edit((b) => b.insert(end, "lemma typed_now : true by [].\n"));
      await waitFor("edit indexed", async () => (await find("typed_now")).length > 0, 15_000);
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await waitFor("revert indexed", async () => (await find("typed_now")).length === 0, 15_000);
    },
  ],
  [
    "go to definition and hover find declarations by name",
    async () => {
      await api.indexReady;
      const editor = await open("nav.ec");
      const doc = editor.document;
      const text = doc.getText();
      /** The position inside the last occurrence of `word`. */
      const at = (word: string) => doc.positionAt(text.lastIndexOf(word) + 1);
      const definitions = async (word: string) => {
        const found = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", doc.uri, at(word));
        return found.map((l) => `${l.uri.fsPath.split("/").pop()}:${l.range.start.line}`);
      };

      assert.deepEqual(await definitions("aa_ok"), ["Helper.ec:1"], "a lemma of a required file");
      assert.deepEqual(await definitions("local_one."), ["nav.ec:8"], "a lemma of the same file");
      const lineOf = (name: string, file: RegExp) => api.index.named(name).find((e) => file.test(e.file))!.line;
      assert.deepEqual(await definitions("addrC"), [`Ring.ec:${lineOf("addrC", /Ring\.ec$/)}`], "through clone include");
      assert.deepEqual(await definitions("dbool_ll"), [`Distr.ec:${lineOf("dunifin_ll", /Distr\.ec$/)}`], "a renamed member");
      assert.deepEqual(await definitions("size_cat"), ["List.ec:" + api.index.named("size_cat").find((e) => /List\.ec$/.test(e.file))!.line]);
      assert.deepEqual(await definitions("List.size_cat"), ["List.ec:0"], "a theory that is a file");

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, at("aa_ok"));
      const shown = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
      assert.match(shown, /lemma aa_ok : aa = 3 by rewrite \/aa\./);
      assert.match(shown, /Helper\.ec/);
      assert.equal(doc.getText(hovers[0].range), "aa_ok");

      const viaClone = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, at("dbool_ll"));
      assert.match(viaClone.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n"), /lemma dunifin_ll/);

      const none = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, at("(s t"));
      assert.deepEqual(none, [], "a local variable shows nothing");
    },
  ],
  [
    "module variables and procedures are in the outline and can be reached",
    async () => {
      await api.indexReady;
      const doc = (await open("game.ec")).document;
      const text = doc.getText();
      const symbols = await waitFor("outline", async () => {
        const found = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri);
        return found?.length ? found : undefined;
      });
      assert.deepEqual(
        symbols.map((s) => [s.name, ...s.children.map((c) => `${vscode.SymbolKind[c.kind]} ${c.name}`)]),
        [["Adv", "Method guess"], ["G", "Variable b", "Method main"], ["main_ll"]],
      );

      /** The position of the last character of the last occurrence of `use`. */
      const atEnd = (use: string) => doc.positionAt(text.lastIndexOf(use) + use.length - 1);
      const definitions = async (use: string) => {
        const found = await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", doc.uri, atEnd(use));
        return found.map((l) => `${l.uri.fsPath.split("/").pop()}:${l.range.start.line}`);
      };
      assert.deepEqual(await definitions("G(A).main"), ["game.ec:9"], "a procedure of an applied module");
      assert.deepEqual(await definitions("return b"), ["game.ec:7"], "a variable, inside its module");
      assert.deepEqual(await definitions("b <@ A.guess"), ["game.ec:3"], "a procedure of a module parameter");

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, atEnd("G(A).main"));
      const shown = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
      assert.match(shown, /proc main\(\) : bool/);
      assert.match(shown, /proc `G\.main`/);
    },
  ],
  [
    "completion suggests declared names and says which need a require",
    async () => {
      await api.indexReady;
      /** What is suggested after typing `typed` at the end of `file`, by name. */
      const complete = async (file: string, typed: string) => {
        const editor = await open(file);
        const doc = editor.document;
        await editor.edit((b) => b.insert(doc.positionAt(doc.getText().length), typed));
        const end = doc.positionAt(doc.getText().length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, end);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        const label = (item: vscode.CompletionItem) => (typeof item.label === "string" ? { label: item.label } : item.label);
        return new Map(list.items.map((item) => [label(item).label, { item, note: label(item).description }]));
      };

      const inNav = await complete("nav.ec", "\nlemma c : true by rewrite size_ca");
      const sizeCat = inNav.get("size_cat");
      assert.ok(sizeCat, "a lemma of a required file");
      assert.equal(sizeCat.note, "List.ec");
      assert.equal(sizeCat.item.kind, vscode.CompletionItemKind.Function);
      assert.match((sizeCat.item.documentation as vscode.MarkdownString).value, /lemma size_cat/);
      assert.equal((await complete("nav.ec", "\nlemma c : true by apply: local_o")).get("local_one")?.note, "nav.ec");

      const far = await complete("outline.ec", "\nlemma c : true by rewrite aa_");
      assert.equal(far.get("aa_ok")?.note, "needs require Helper");
      const members = await complete("outline.ec", "\nlemma c : true by rewrite T.");
      assert.deepEqual([...members.keys()].sort(), ["l", "x"], "the members of a theory");
      const procs = await complete("game.ec", "\nlemma c : islossless G(A).ma");
      assert.equal(procs.get("main")?.item.kind, vscode.CompletionItemKind.Method);

      // Through clones, under the names they give.
      assert.ok((await complete("nav.ec", "\nlemma c : true by rewrite IntID.addr")).has("addrC"), "through clone include");
      const renamed = (await complete("nav.ec", "\nlemma c : true by apply: dbool_l")).get("dbool_ll");
      assert.equal(renamed?.note, "DBool.ec", "a renamed member");
      assert.match((renamed!.item.documentation as vscode.MarkdownString).value, /lemma dunifin_ll/);

      // Words of the scripts: with our names, and from VS Code itself for a single letter.
      const words = await complete("outline.ec", "\nlemma c : true by tri");
      assert.equal(words.get("trivial")?.item.kind, vscode.CompletionItemKind.Text);
      assert.ok((await complete("outline.ec", "\nlemma c : true by tru")).has("true"), "a name of the prelude");
      const short = await complete("outline.ec", "\nlemma c : true by tr");
      assert.ok(short.has("trivial"));
      const notes = [...short.values()].map((v) => v.note);
      assert.ok(notes.every((note) => note === undefined || note === "outline.ec"), "two letters: no names of other files");
      assert.ok((await complete("outline.ec", "\nlemma c : true by t")).has("trivial"), "VS Code's own words");

      // Turned off, only VS Code's words are left.
      const config = vscode.workspace.getConfiguration("easycryptCompanion");
      await config.update("completion", false, vscode.ConfigurationTarget.Global);
      try {
        const off = await complete("nav.ec", "\nlemma c : true by rewrite size_ca");
        assert.ok(off.has("size_cat"), "a word of the script");
        assert.ok([...off.values()].every((v) => v.note === undefined), "no declared names");
      } finally {
        await config.update("completion", undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
  [
    "library files open read-only until editing is allowed",
    async () => {
      await api.indexReady;
      const entry = api.index.search("size_cat").find((e) => /List\.ec$/.test(e.file));
      assert.ok(entry, "List.ec is indexed");
      const doc = await vscode.workspace.openTextDocument(entry.file);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const lenses = () => vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
      /** Tries to insert a character; true if the text changed. */
      const type = async () => {
        const before = doc.getText();
        await editor.edit((b) => b.insert(new vscode.Position(0, 0), " "));
        await new Promise((r) => setTimeout(r, 150));
        return doc.getText() !== before;
      };

      const [lens] = await waitFor("the read-only notice", async () => {
        const found = await lenses();
        return found.length > 0 && found;
      });
      assert.match(lens.command!.title, /read-only/);
      assert.equal(await type(), false, "typing is refused");
      assert.equal(doc.isDirty, false);

      await vscode.commands.executeCommand(lens.command!.command, ...(lens.command!.arguments ?? []));
      await waitFor("editing to be allowed", type, 10_000);
      assert.deepEqual(await lenses(), [], "the notice is gone");
      await vscode.commands.executeCommand("workbench.action.files.revert");
      assert.equal(doc.isDirty, false);
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
        ["ctrl+x 1", "togglePanes"],
        ["ctrl+c ctrl+v", "sendCommand"],
        ["ctrl+c ctrl+a ctrl+p", "print"],
        ["ctrl+c ctrl+f", "search"],
        ["alt+down", "next"],
      ];
      assert.match(text, /"key":\s*"ctrl\+c v",\s*"command":\s*"editor\.toggleFold"/, "C-c v -> fold");
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
  [
    "the panes can be hidden and come back as they were",
    async () => {
      await open("proof.ec");
      await exec("next");
      await idle();
      const panes = () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === GOALS_URI.scheme);
      type Layout = { orientation?: number; size?: number; groups?: Layout[] };
      const layout = () => vscode.commands.executeCommand<Layout>("vscode.getEditorLayout");
      /** Same shape, sizes within a pixel or two. */
      const same = (a: Layout, b: Layout): boolean =>
        Math.abs((a.size ?? 0) - (b.size ?? 0)) <= 2 &&
        (a.groups ?? []).length === (b.groups ?? []).length &&
        (a.groups ?? []).every((g, i) => same(g, b.groups![i]));
      await waitFor("the panes", () => panes().length === 2, 10_000);
      // Sizes of the user's own, not the default ones.
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0,
        groups: [{ size: 0.7 }, { size: 0.3, groups: [{ size: 0.4 }, { size: 0.6 }] }],
      });
      const before = await layout();
      const processed = api.currentSession()!.processed.length;
      const response = paneText(RESPONSE_URI);

      await exec("togglePanes");
      await waitFor("the panes to be hidden", () => panes().length === 0 && vscode.window.tabGroups.all.length === 1, 10_000);
      assert.equal(api.currentSession()!.processed.length, processed, "EasyCrypt keeps its state");
      await exec("togglePanes");
      await waitFor("the panes to come back", () => panes().length === 2, 10_000);
      assert.ok(same(await layout(), before), `with the same sizes: ${JSON.stringify(await layout())} vs ${JSON.stringify(before)}`);
      await paneShows(RESPONSE_URI, response); // and the same text

      await exec("togglePanes");
      await waitFor("the panes to be hidden again", () => panes().length === 0, 10_000);
      await exec("next");
      await idle();
      await waitFor("the next command to bring them back", () => panes().length === 2, 10_000);
      assert.ok(same(await layout(), before), "as they were");

      // VS Code's own maximize is undone by the next command too.
      await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
      await exec("next");
      await idle();
      await waitFor("the maximize to be undone", async () => same(await layout(), before), 10_000);

      // Closed by hand, they are opened again.
      await vscode.window.tabGroups.close(panes());
      await waitFor("the panes to close", () => panes().length === 0, 10_000);
      await exec("togglePanes");
      await waitFor("the panes to be opened", () => panes().length === 2, 10_000);
    },
  ],
  // Last: it moves the focus into a pane, which VS Code then keeps reporting
  // as the active editor for as long as its window is in the background.
  [
    "files opened from a pane do not cover it",
    async () => {
      const script = await open("proof.ec");
      await exec("next");
      await idle();
      const goals = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === GOALS_URI.toString());
      assert.ok(goals, "goals pane visible");
      // Put the focus in the goals pane, then open a file as a user would.
      await vscode.window.showTextDocument(goals.document, { viewColumn: goals.viewColumn });
      const helper = await vscode.workspace.openTextDocument(join(workspace(), "Helper.ec"));
      const opened = await vscode.window.showTextDocument(helper);
      assert.equal(opened.viewColumn, vscode.ViewColumn.One, "the file opened on the script's side");
      assert.ok(
        vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === GOALS_URI.toString()),
        "the goals pane is still visible",
      );
      await vscode.window.showTextDocument(script.document, vscode.ViewColumn.One);
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
