// The goals and response panes: read-only virtual documents, so they are
// selectable, searchable and themed like Proof General's buffers.

import * as vscode from "vscode";

export const SCHEME = "easycrypt-companion";
export const GOALS_URI = vscode.Uri.from({ scheme: SCHEME, path: "/Goals" });
export const RESPONSE_URI = vscode.Uri.from({ scheme: SCHEME, path: "/Response" });
const OUTPUT_LANGUAGE = "easycrypt-output";

export type Layout = "threePane" | "beside" | "manual";

export class Panels implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private goals = "";
  private response = "";

  provideTextDocumentContent(uri: vscode.Uri): string {
    return uri.path === GOALS_URI.path ? this.goals : this.response;
  }

  get responseText(): string {
    return this.response;
  }

  update(goals: string, response: string): void {
    if (goals !== this.goals) {
      this.goals = goals;
      this.emitter.fire(GOALS_URI);
    }
    if (response !== this.response) {
      this.response = response;
      this.emitter.fire(RESPONSE_URI);
    }
  }

  /** Opens the panes if hidden, following the layout setting. */
  async ensureVisible(layout: Layout): Promise<void> {
    if (layout === "manual") return;
    const goalsVisible = isVisible(GOALS_URI);
    const responseVisible = isVisible(RESPONSE_URI);
    if (goalsVisible && responseVisible) return;
    if (layout === "threePane" && vscode.window.tabGroups.all.length < 3) {
      await this.arrange("threePane");
      return;
    }
    await this.showPanes(layout, !responseVisible, !goalsVisible);
  }

  /** C-c C-l: arranges the editor area and shows both panes. */
  async arrange(layout: Layout): Promise<void> {
    const script = vscode.window.activeTextEditor;
    const effective = layout === "manual" ? "threePane" : layout;
    if (effective === "threePane") {
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 0,
        groups: [{ size: 0.55 }, { size: 0.45, groups: [{ size: 0.65 }, { size: 0.35 }] }],
      });
      if (script && script.document.uri.scheme !== SCHEME) {
        await vscode.window.showTextDocument(script.document, {
          viewColumn: vscode.ViewColumn.One,
          selection: script.selection,
          preview: false,
        });
      }
    }
    await this.showPanes(effective, true, true);
  }

  private async showPanes(layout: Layout, response: boolean, goals: boolean): Promise<void> {
    // "beside": both panes share a group; open the goals last so they show.
    if (response) {
      await showOutput(RESPONSE_URI, layout === "threePane" ? vscode.ViewColumn.Three : vscode.ViewColumn.Beside);
    }
    if (goals) {
      await showOutput(GOALS_URI, layout === "threePane" ? vscode.ViewColumn.Two : vscode.ViewColumn.Beside);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function isVisible(uri: vscode.Uri): boolean {
  return vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString());
}

async function showOutput(uri: vscode.Uri, viewColumn: vscode.ViewColumn): Promise<void> {
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== OUTPUT_LANGUAGE) {
    doc = await vscode.languages.setTextDocumentLanguage(doc, OUTPUT_LANGUAGE);
  }
  await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus: true, preview: false });
}
