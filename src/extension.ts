import * as vscode from "vscode";
import { LANGUAGE, SessionManager } from "./manager";
import { Panels, SCHEME } from "./panels";
import { ProofSession } from "./session";
import { followPosition } from "./sentences";
import { registerOutline } from "./symbols";
import { DeclarationIndex } from "./index";
import { LibraryGuard } from "./libraryGuard";
import { WorkspaceIndex } from "./workspaceIndex";

/** A possibly qualified identifier: `addrC`, `Ring.IntID.addrC`, `x'`. */
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*/;

/** Returned from activate() for tests. */
export interface CompanionApi {
  currentSession(): ProofSession | undefined;
  index: DeclarationIndex;
  /** Resolves when the workspace and the library have been indexed. */
  indexReady: Promise<void>;
}

export function activate(context: vscode.ExtensionContext): CompanionApi {
  const log = vscode.window.createOutputChannel("EasyCrypt Companion");
  const panels = new Panels();
  const manager = new SessionManager(panels, log, (message) => reportFailure(message, log));
  context.subscriptions.push(
    log,
    panels,
    manager,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, panels),
  );

  const register = (name: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`easycryptCompanion.${name}`, fn));

  /** Runs `fn` on the script the command applies to. */
  const withScript =
    (fn: (editor: vscode.TextEditor, session: ProofSession) => unknown) => async () => {
      const editor = manager.scriptEditor();
      if (!editor) {
        void vscode.window.showInformationMessage("Open an EasyCrypt file (.ec or .eca) first.");
        return;
      }
      await fn(editor, manager.sessionFor(editor.document).session);
    };

  // ---------------------------------------------------------------- navigation
  register(
    "next",
    withScript((editor, session) => {
      if (!session.next()) vscode.window.setStatusBarMessage("EasyCrypt: nothing more to process", 3000);
      manager.follow(editor, session);
      void manager.showPanels();
    }),
  );
  register(
    "undo",
    withScript((editor, session) => {
      session.undo();
      manager.follow(editor, session);
    }),
  );
  register(
    "gotoCursor",
    withScript((editor, session) => {
      session.gotoOffset(editor.document.offsetAt(editor.selection.active));
      void manager.showPanels();
    }),
  );
  register(
    "processBuffer",
    withScript((_editor, session) => {
      session.processBuffer();
      void manager.showPanels();
    }),
  );
  register(
    "retractBuffer",
    withScript((_editor, session) => session.retractBuffer()),
  );
  register(
    "gotoProcessedEnd",
    withScript((editor, session) => {
      const pos = editor.document.positionAt(followPosition(editor.document.getText(), session.processedEnd));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }),
  );

  // ---------------------------------------------------------------- prover
  register("interrupt", () => manager.currentSession()?.interrupt());
  register("exit", () => manager.currentSession()?.exit("EasyCrypt stopped."));
  register(
    "restart",
    withScript(async (_editor, session) => {
      await session.restart();
      void manager.showPanels();
    }),
  );
  register("toggleWeakCheck", async () => {
    const session = manager.currentSession();
    if (session) await runQuery(session, session.mode === "weakcheck" ? "pragma Proofs:check." : "pragma Proofs:weak.");
  });

  // ---------------------------------------------------------------- panes
  register("layout", () => manager.arrangePanels());
  register("showGoals", () => manager.showPanels());
  register("clearResponse", () => manager.currentSession()?.clearResponse());

  // ---------------------------------------------------------------- queries
  const runQuery = async (session: ProofSession, command: string) => {
    void manager.showPanels();
    try {
      await session.query(command);
    } catch (err) {
      void vscode.window.showWarningMessage(`EasyCrypt: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let lastCommand = "";
  register("sendCommand", async (preset?: unknown) => {
    const session = requireSession(manager);
    if (!session) return;
    const cmd = typeof preset === "string" ? preset : await vscode.window.showInputBox({
      title: "Send Command to EasyCrypt",
      prompt: "Runs in the current state. Commands that change the state are not recorded in the script.",
      placeHolder: "e.g. print addrC.   search (+) (<=).   pragma Goals:printall.",
      value: lastCommand,
      valueSelection: [0, lastCommand.length],
    });
    if (!cmd?.trim()) return;
    lastCommand = cmd.trim();
    await runQuery(session, withDot(lastCommand));
  });

  // An argument (e.g. keybinding "args") skips the input box.
  const query = (keyword: string, title: string, placeHolder: string) => async (preset?: unknown) => {
    const session = requireSession(manager);
    if (!session) return;
    const initial = identifierAtCursor();
    const arg = typeof preset === "string" ? preset : await vscode.window.showInputBox({
      title,
      prompt: `Runs \`${keyword} <argument>.\` in the current state.`,
      placeHolder,
      value: initial,
      valueSelection: [0, initial.length],
    });
    if (!arg?.trim()) return;
    await runQuery(session, withDot(`${keyword} ${arg.trim()}`));
  };
  register("print", query("print", "Print", "a lemma, operator, type, module, theory... e.g. addrC, op (+), theory List"));
  register("search", query("search", "Search Lemmas", "operators or patterns, e.g. (+) (<=)  or  (_ + _ = _ + _)"));
  register("locate", query("locate", "Locate", "a name, e.g. addrC"));

  register(
    "insertLastOutputAsComment",
    withScript(async (editor) => {
      const text = panels.responseText.trim();
      if (!text) return;
      // `*)` would close the comment early.
      const body = text.replace(/\*\)/g, "* )");
      await editor.edit((b) => b.insert(editor.selection.active, `(* ${body} *)`));
    }),
  );

  // ---------------------------------------------------------------- status bar
  register("statusMenu", async () => {
    const session = manager.currentSession();
    const items: Array<vscode.QuickPickItem & { command: string; args?: unknown[] }> = [
      {
        label: session?.mode === "weakcheck" ? "$(check) Check proofs" : "$(eye-closed) Weak-check mode",
        description: session?.mode === "weakcheck" ? "pragma Proofs:check" : "pragma Proofs:weak (skip proof checking)",
        command: "easycryptCompanion.toggleWeakCheck",
      },
      { label: "$(debug-stop) Interrupt", command: "easycryptCompanion.interrupt" },
      { label: "$(debug-restart) Restart prover", command: "easycryptCompanion.restart" },
      { label: "$(close) Exit prover", command: "easycryptCompanion.exit" },
      { label: "$(layout) Reset layout", command: "easycryptCompanion.layout" },
      { label: "$(output) Show log", command: "easycryptCompanion.showLog" },
      {
        label: "$(gear) Settings",
        command: "workbench.action.openSettings",
        args: ["easycryptCompanion"],
      },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: "EasyCrypt" });
    if (pick) await vscode.commands.executeCommand(pick.command, ...(pick.args ?? []));
  });
  register("showLog", () => log.show());

  registerOutline(context, LANGUAGE);
  const workspaceIndex = new WorkspaceIndex(log);
  const guard = new LibraryGuard(LANGUAGE, (path) => workspaceIndex.isLibraryFile(path));
  context.subscriptions.push(
    workspaceIndex,
    guard,
    workspaceIndex.onDidScanLibrary(() => void guard.refresh()),
  );
  warnAboutConflicts(context);
  return {
    currentSession: () => manager.currentSession(),
    index: workspaceIndex.index,
    indexReady: workspaceIndex.ready,
  };
}

export function deactivate(): void {
  // Sessions are disposed through context.subscriptions.
}

function withDot(command: string): string {
  return command.endsWith(".") ? command : `${command}.`;
}

function requireSession(manager: SessionManager): ProofSession | undefined {
  const session = manager.currentSession();
  if (!session) void vscode.window.showInformationMessage("Open an EasyCrypt file (.ec or .eca) first.");
  return session;
}

/** The selection, or the identifier under the cursor. */
function identifierAtCursor(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";
  if (!editor.selection.isEmpty) return editor.document.getText(editor.selection).trim();
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, IDENT_RE);
  return range ? editor.document.getText(range) : "";
}

function reportFailure(message: string, log: vscode.OutputChannel): void {
  log.appendLine(message);
  const first = message.split("\n")[0];
  void vscode.window
    .showErrorMessage(`EasyCrypt: ${first}`, "Open Settings", "Show Log")
    .then((choice) => {
      if (choice === "Open Settings") {
        void vscode.commands.executeCommand("workbench.action.openSettings", "easycryptCompanion.executable");
      } else if (choice === "Show Log") {
        log.show();
      }
    });
}

/** Other extensions handling `.ec` files cause conflicting keys and highlighting. */
function warnAboutConflicts(context: vscode.ExtensionContext): void {
  const key = "easycryptCompanion.conflictWarningDismissed";
  if (context.globalState.get<boolean>(key)) return;
  const others = vscode.extensions.all.filter((ext) => {
    if (ext.id === context.extension.id) return false;
    const languages: Array<{ id?: string }> = ext.packageJSON?.contributes?.languages ?? [];
    return languages.some((l) => l.id === "easycrypt");
  });
  if (others.length === 0) return;
  const names = others.map((e) => e.packageJSON?.displayName ?? e.id).join(", ");
  void vscode.window
    .showWarningMessage(
      `Another EasyCrypt extension is installed (${names}). Both handle .ec files, which causes conflicting keybindings and highlighting. Consider disabling it.`,
      "Show Extension",
      "Don't Show Again",
    )
    .then((choice) => {
      if (choice === "Show Extension") {
        void vscode.commands.executeCommand("workbench.extensions.search", `@id:${others[0].id}`);
      } else if (choice === "Don't Show Again") {
        void context.globalState.update(key, true);
      }
    });
}
