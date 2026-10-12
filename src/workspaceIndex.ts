// Keeps an index of the declarations of the workspace and of EasyCrypt's
// library up to date, and answers Go to Symbol in Workspace from it.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { resolveExecutable } from "./executable";
import { DeclarationIndex } from "./index";
import { libraryDirectories } from "./library";
import { SYMBOL_KINDS } from "./symbols";

const SCRIPT = /\.eca?$/;
const SCRIPTS = "**/*.{ec,eca}";
// Build and install folders hold copies of the scripts.
const COPIES = "**/{_build,_opam,node_modules}/**";
const IN_COPIES = /[\\/](?:_build|_opam|node_modules)[\\/]/;

function isScriptFile(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && SCRIPT.test(doc.uri.fsPath);
}

async function scriptsIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((name) => SCRIPT.test(name)).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export class WorkspaceIndex implements vscode.Disposable {
  readonly index = new DeclarationIndex();
  /** Resolves when the workspace and the library have been read once. */
  readonly ready: Promise<void>;
  private libraryFiles: string[] = [];
  /** Folders of scripts opened from outside the workspace. */
  private readonly outsideFolders = new Set<string>();
  private readonly pendingEdits = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher(SCRIPTS);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => void this.changed(uri.fsPath)),
      watcher.onDidChange((uri) => void this.changed(uri.fsPath)),
      watcher.onDidDelete((uri) => this.index.remove(uri.fsPath)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.opened(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.edited(e.document)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        const library = ["executable", "arguments"].some((s) => e.affectsConfiguration(`easycryptCompanion.${s}`));
        if (library) void this.scanLibrary();
      }),
      vscode.languages.registerWorkspaceSymbolProvider({
        provideWorkspaceSymbols: (query) => this.symbols(query),
      }),
    );
    this.ready = Promise.all([this.scanWorkspace(), this.scanLibrary()]).then(() => {
      for (const doc of vscode.workspace.textDocuments) this.opened(doc);
    });
  }

  private async scanWorkspace(): Promise<void> {
    const uris = await vscode.workspace.findFiles(SCRIPTS, COPIES);
    await this.readAll(uris.map((uri) => uri.fsPath));
  }

  private async scanLibrary(): Promise<void> {
    const config = vscode.workspace.getConfiguration("easycryptCompanion");
    const executable = resolveExecutable(config.get<string>("executable", "easycrypt"));
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    let dirs: string[] = [];
    try {
      dirs = await libraryDirectories(executable, config.get<string[]>("arguments", []), cwd);
    } catch (err) {
      this.log.appendLine(`EasyCrypt's library is not indexed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const files = (await Promise.all(dirs.map(scriptsIn))).flat();
    const kept = new Set(files);
    for (const old of this.libraryFiles) if (!kept.has(old)) this.index.remove(old);
    this.libraryFiles = files;
    await this.readAll(files);
    this.log.appendLine(`Indexed ${this.index.size} declarations (${files.length} library files).`);
  }

  private async readAll(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 32) {
      await Promise.all(paths.slice(i, i + 32).map((path) => this.read(path)));
    }
  }

  private async changed(path: string): Promise<void> {
    if (!IN_COPIES.test(path)) await this.read(path);
  }

  /** Indexes `path` from the open editor if there is one, else from disk. */
  private async read(path: string): Promise<void> {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && doc.uri.fsPath === path);
    if (open) {
      this.index.update(path, open.getText());
      return;
    }
    try {
      this.index.update(path, await fs.readFile(path, "utf8"));
    } catch {
      this.index.remove(path);
    }
  }

  private opened(doc: vscode.TextDocument): void {
    if (!isScriptFile(doc)) return;
    this.index.update(doc.uri.fsPath, doc.getText());
    // A script outside the workspace can require its neighbours.
    const folder = dirname(doc.uri.fsPath);
    if (!vscode.workspace.getWorkspaceFolder(doc.uri) && !this.outsideFolders.has(folder)) {
      this.outsideFolders.add(folder);
      void scriptsIn(folder).then((files) => this.readAll(files.filter((file) => !this.index.has(file))));
    }
  }

  private edited(doc: vscode.TextDocument): void {
    if (!isScriptFile(doc)) return;
    const path = doc.uri.fsPath;
    clearTimeout(this.pendingEdits.get(path));
    this.pendingEdits.set(
      path,
      setTimeout(() => {
        this.pendingEdits.delete(path);
        this.index.update(path, doc.getText());
      }, 200),
    );
  }

  private symbols(query: string): vscode.SymbolInformation[] {
    // VS Code filters by container with the words after the first one.
    const name = query.trim().split(/\s+/)[0];
    return this.index.search(name).map(
      (e) =>
        new vscode.SymbolInformation(
          e.name,
          SYMBOL_KINDS[e.kind],
          e.path.join("."),
          new vscode.Location(vscode.Uri.file(e.file), new vscode.Range(e.line, e.column, e.line, e.endColumn)),
        ),
    );
  }

  dispose(): void {
    for (const timer of this.pendingEdits.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
  }
}
