// Connects ProofSessions to VS Code: one session per script, region
// decorations, error diagnostics, the panes and the status bar.

import { delimiter, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { resolveExecutable } from "./executable";
import { Layout, Panels, SCHEME } from "./panels";
import { ProverOptions } from "./prover";
import { ProofSession } from "./session";
import { followPosition } from "./sentences";

export const LANGUAGE = "easycrypt";

interface Entry {
  doc: vscode.TextDocument;
  session: ProofSession;
  refreshScheduled: boolean;
  lastErrorShown?: string;
}

function config() {
  const c = vscode.workspace.getConfiguration("easycryptCompanion");
  return {
    executable: c.get<string>("executable", "easycrypt"),
    arguments: c.get<string[]>("arguments", []),
    layout: c.get<Layout>("layout", "threePane"),
    followMode: c.get<string>("followMode", "locked"),
    trace: c.get<boolean>("trace", false),
  };
}

/** Whether `doc` is an EasyCrypt script (not one of our panes). */
export function isScript(doc: vscode.TextDocument): boolean {
  return doc.languageId === LANGUAGE && doc.uri.scheme !== SCHEME;
}

function regionTypes(color: string) {
  const background = new vscode.ThemeColor(color);
  return {
    whole: vscode.window.createTextEditorDecorationType({ backgroundColor: background, isWholeLine: true }),
    partial: vscode.window.createTextEditorDecorationType({ backgroundColor: background }),
  };
}

/** Splits [start, end) into fully covered lines (decorated edge to edge) and partial ranges. */
function regionRanges(doc: vscode.TextDocument, start: number, end: number) {
  const whole: vscode.Range[] = [];
  const partial: vscode.Range[] = [];
  if (end <= start) return { whole, partial };
  const s = doc.positionAt(start);
  const e = doc.positionAt(end);
  for (let line = s.line; line <= e.line; line++) {
    const l = doc.lineAt(line);
    const from = line === s.line ? s.character : 0;
    const to = line === e.line ? e.character : l.text.length;
    const coversStart = from <= l.firstNonWhitespaceCharacterIndex;
    const coversEnd = l.text.slice(to).trim() === "";
    if (coversStart && coversEnd) whole.push(l.range);
    else partial.push(new vscode.Range(line, from, line, to));
  }
  return { whole, partial };
}

export class SessionManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  /** The session shown in the panes and status bar. */
  private current?: Entry;
  private readonly processedDeco = regionTypes("easycryptCompanion.processedBackground");
  private readonly queuedDeco = regionTypes("easycryptCompanion.queuedBackground");
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("easycrypt");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly panels: Panels,
    private readonly log: vscode.OutputChannel,
    private readonly onFailure: (message: string) => void,
  ) {
    this.status.command = "easycryptCompanion.statusMenu";
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.close(doc)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const entry of this.entries.values()) this.decorate(entry);
      }),
    );
    this.onActiveEditor(vscode.window.activeTextEditor);
  }

  // --- Finding the session a command applies to ---

  /** The active script editor, or the last script used. */
  scriptEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && isScript(active.document)) return active;
    const doc = this.current?.doc;
    if (!doc) return undefined;
    return vscode.window.visibleTextEditors.find((e) => e.document === doc);
  }

  /** The session for `doc`, created on first use. */
  sessionFor(doc: vscode.TextDocument): Entry {
    const key = doc.uri.toString();
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = { doc, session: undefined!, refreshScheduled: false };
      created.session = new ProofSession(() => this.proverOptions(doc), {
        getText: () => created.doc.getText(),
        changed: () => this.scheduleRefresh(created),
        failed: (message) => this.onFailure(message),
      });
      this.entries.set(key, created);
      entry = created;
    }
    this.current = entry;
    return entry;
  }

  /** The session of the active or last used script. */
  currentSession(): ProofSession | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && isScript(active.document)) return this.sessionFor(active.document).session;
    return this.current?.session;
  }

  private proverOptions(doc: vscode.TextDocument): ProverOptions {
    const c = config();
    const executable = resolveExecutable(c.executable);
    const cwd =
      doc.uri.scheme === "file"
        ? dirname(doc.uri.fsPath)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const env = { ...process.env };
    // Provers in the same opam switch sit next to easycrypt.
    if (isAbsolute(executable)) env.PATH = `${dirname(executable)}${delimiter}${env.PATH ?? ""}`;
    this.log.appendLine(`Starting ${executable} cli -emacs ${c.arguments.join(" ")} (in ${cwd})`);
    return {
      executable,
      args: c.arguments,
      cwd,
      env,
      trace: c.trace ? (dir, text) => this.log.append(`${dir} ${text.replace(/\n(?!$)/g, `\n${dir} `)}`) : undefined,
    };
  }

  // --- Cursor ---

  /** Moves the cursor after the processed region (Proof General's follow mode). */
  follow(editor: vscode.TextEditor, session: ProofSession): void {
    if (config().followMode !== "locked") return;
    const pos = editor.document.positionAt(followPosition(editor.document.getText(), session.queuedEnd));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
  }

  async showPanels(): Promise<void> {
    await this.panels.ensureVisible(config().layout);
  }

  async arrangePanels(): Promise<void> {
    await this.panels.arrange(config().layout);
  }

  /** C-x 1: hides the panes if they are open, else arranges them. */
  async togglePanels(): Promise<void> {
    if (this.panels.open) await this.panels.hide();
    else await this.arrangePanels();
  }

  // --- Events ---

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const entry = this.entries.get(e.document.uri.toString());
    if (!entry) return;
    const start = Math.min(...e.contentChanges.map((c) => c.rangeOffset));
    entry.session.edited(start, e.document.getText());
  }

  private close(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.session.dispose();
    this.diagnostics.delete(doc.uri);
    if (this.current === entry) {
      this.current = undefined;
      this.panels.update("", "");
      this.updateStatus();
    }
  }

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (editor && isScript(editor.document)) {
      const entry = this.entries.get(editor.document.uri.toString());
      if (entry && entry !== this.current) {
        this.current = entry;
        this.refresh(entry);
      }
    }
    this.updateStatus();
  }

  // --- Rendering ---

  private scheduleRefresh(entry: Entry): void {
    if (entry.refreshScheduled) return;
    entry.refreshScheduled = true;
    setTimeout(() => {
      entry.refreshScheduled = false;
      if (this.entries.get(entry.doc.uri.toString()) === entry) this.refresh(entry);
    }, 15);
  }

  private refresh(entry: Entry): void {
    const { session, doc } = entry;
    this.decorate(entry);

    const error = session.error;
    if (error) {
      const range = new vscode.Range(doc.positionAt(error.start), doc.positionAt(error.end));
      const diag = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
      diag.source = "EasyCrypt";
      this.diagnostics.set(doc.uri, [diag]);
      const key = `${error.start}:${error.message}`;
      if (entry.lastErrorShown !== key) {
        entry.lastErrorShown = key;
        // Scroll to a new error without moving the cursor.
        for (const ed of vscode.window.visibleTextEditors) {
          if (ed.document === doc) ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      }
    } else {
      entry.lastErrorShown = undefined;
      this.diagnostics.delete(doc.uri);
    }

    if (entry === this.current) {
      this.panels.update(session.goals, session.response);
      this.updateStatus();
    }
  }

  private decorate(entry: Entry): void {
    const { doc, session } = entry;
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === doc);
    if (editors.length === 0) return;
    const processed = regionRanges(doc, 0, session.processedEnd);
    const queued = regionRanges(doc, session.processedEnd, session.queuedEnd);
    for (const ed of editors) {
      ed.setDecorations(this.processedDeco.whole, processed.whole);
      ed.setDecorations(this.processedDeco.partial, processed.partial);
      ed.setDecorations(this.queuedDeco.whole, queued.whole);
      ed.setDecorations(this.queuedDeco.partial, queued.partial);
    }
  }

  private updateStatus(): void {
    const active = vscode.window.activeTextEditor?.document;
    const relevant = active && (active.languageId === LANGUAGE || active.uri.scheme === SCHEME);
    const session = this.current?.session;
    void vscode.commands.executeCommand("setContext", "easycryptCompanion.busy", session?.busy ?? false);
    if (!relevant) {
      this.status.hide();
      return;
    }
    if (!session || !session.running) {
      this.status.text = "$(circle-outline) EasyCrypt";
      this.status.tooltip = "EasyCrypt is not running. It starts with the first proof command.";
    } else if (session.busy) {
      this.status.text = "$(sync~spin) EasyCrypt";
      this.status.tooltip = "EasyCrypt is working. Click for the prover menu.";
    } else if (session.mode === "weakcheck") {
      this.status.text = "$(eye-closed) EasyCrypt: weak";
      this.status.tooltip = "Weak-check mode: proofs are not checked. Click to change.";
    } else {
      this.status.text = "$(check) EasyCrypt";
      this.status.tooltip = "EasyCrypt is ready. Click for the prover menu.";
    }
    this.status.show();
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.session.dispose();
    this.entries.clear();
    for (const d of this.disposables) d.dispose();
    for (const t of [this.processedDeco, this.queuedDeco]) {
      t.whole.dispose();
      t.partial.dispose();
    }
    this.diagnostics.dispose();
    this.status.dispose();
  }
}
