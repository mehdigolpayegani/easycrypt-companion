// Opens EasyCrypt's library files read-only, with a CodeLens at the top to
// allow editing. Library files inside the workspace are left alone.

import * as vscode from "vscode";

const ALLOW = "easycryptCompanion.allowEditing";

export class LibraryGuard implements vscode.CodeLensProvider, vscode.Disposable {
  /** Files the user chose to edit. */
  private readonly allowed = new Set<string>();
  /** Files this guard made read-only, so it only ever unlocks those. */
  private readonly locked = new Set<string>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly disposables: vscode.Disposable[];

  constructor(
    language: string,
    private readonly isLibraryFile: (path: string) => boolean,
  ) {
    this.disposables = [
      this.lensesChanged,
      vscode.languages.registerCodeLensProvider({ language, scheme: "file" }, this),
      vscode.window.onDidChangeActiveTextEditor(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("easycryptCompanion.library.readOnly")) void this.refresh();
      }),
      vscode.commands.registerCommand(ALLOW, (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (target) this.allowed.add(target.fsPath);
        return this.refresh();
      }),
    ];
  }

  private guarded(doc: vscode.TextDocument): boolean {
    return (
      doc.uri.scheme === "file" &&
      vscode.workspace.getConfiguration("easycryptCompanion").get<boolean>("library.readOnly", true) &&
      this.isLibraryFile(doc.uri.fsPath) &&
      !vscode.workspace.getWorkspaceFolder(doc.uri) &&
      !this.allowed.has(doc.uri.fsPath)
    );
  }

  /** Locks or unlocks the active editor; call when what counts as a library file changes. */
  async refresh(): Promise<void> {
    this.lensesChanged.fire();
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const path = doc.uri.fsPath;
    if (this.guarded(doc)) {
      this.locked.add(path);
      await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
    } else if (this.locked.delete(path)) {
      await vscode.commands.executeCommand("workbench.action.files.resetActiveEditorReadonlyInSession");
    }
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.guarded(doc)) return [];
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: "EasyCrypt library file, read-only · Allow editing",
        command: ALLOW,
        arguments: [doc.uri],
      }),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
