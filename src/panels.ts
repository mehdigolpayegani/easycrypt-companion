// The goals and response panes: read-only virtual documents, so they are
// selectable, searchable and themed like Proof General's buffers.

import * as vscode from "vscode";

export const SCHEME = "easycrypt-companion";
export const GOALS_URI = vscode.Uri.from({ scheme: SCHEME, path: "/Goals" });
export const RESPONSE_URI = vscode.Uri.from({ scheme: SCHEME, path: "/Response" });
const OUTPUT_LANGUAGE = "easycrypt-output";

export type Layout = "threePane" | "beside" | "manual";

const THREE_PANE = {
  orientation: 0,
  groups: [{ size: 0.55 }, { size: 0.45, groups: [{ size: 0.65 }, { size: 0.35 }] }],
};

export class Panels implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  /** The editor layout when the panes were hidden, to give it back. */
  private hiddenLayout?: GroupLayout;
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
    // Maximized with View: Toggle Maximize Editor Group.
    if (this.open && (await squeezed())) {
      await toggleMaximized();
      return;
    }
    if (this.hiddenLayout && !this.open) {
      await this.reopen(layout);
      return;
    }
    const goalsVisible = isVisible(GOALS_URI);
    const responseVisible = isVisible(RESPONSE_URI);
    if (goalsVisible && responseVisible) return;
    if (layout === "threePane" && vscode.window.tabGroups.all.length < 3) {
      await this.arrange("threePane");
      return;
    }
    await this.showPanes(layout, !responseVisible, !goalsVisible);
  }

  /** Whether a pane is open. */
  get open(): boolean {
    return paneTabs().length > 0;
  }

  /** C-x 1: closes the panes, remembering the layout, or shows them again as they were. */
  async toggle(layout: Layout): Promise<void> {
    if (this.open) {
      this.hiddenLayout = await vscode.commands.executeCommand<GroupLayout>("vscode.getEditorLayout");
      await vscode.window.tabGroups.close(paneTabs());
    } else {
      await this.reopen(layout);
    }
  }

  /** Shows the panes with the layout they had when hidden, unless the editor area was split since. */
  private async reopen(layout: Layout): Promise<void> {
    const saved = this.hiddenLayout;
    if (saved && vscode.window.tabGroups.all.length === 1) await this.arrange(layout, saved);
    else await this.arrange(layout);
  }

  /** C-c C-l: arranges the editor area, with `editorLayout` or the default sizes, and shows both panes. */
  async arrange(layout: Layout, editorLayout?: GroupLayout): Promise<void> {
    this.hiddenLayout = undefined;
    if (await squeezed()) await toggleMaximized();
    const script = vscode.window.activeTextEditor;
    const effective = layout === "manual" ? "threePane" : layout;
    if (editorLayout || effective === "threePane") {
      await vscode.commands.executeCommand("vscode.setEditorLayout", editorLayout ?? THREE_PANE);
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
    await lockPanes();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function paneTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === SCHEME);
}

interface GroupLayout {
  orientation?: number;
  size?: number;
  groups?: GroupLayout[];
}

/** Whether a maximized group leaves the others no room. */
async function squeezed(): Promise<boolean> {
  const layout = await vscode.commands.executeCommand<GroupLayout | undefined>("vscode.getEditorLayout");
  const empty = (groups: GroupLayout[] = []): boolean => groups.some((g) => g.size === 0 || empty(g.groups));
  return empty(layout?.groups);
}

/** Undoes a maximized group, or maximizes the active one. */
async function toggleMaximized(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.toggleMaximizeEditorGroup");
}

function isVisible(uri: vscode.Uri): boolean {
  return vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri.toString());
}

/** Locks the groups of the panes, so that files opened from a pane go to the script's side. */
async function lockPanes(): Promise<void> {
  for (const uri of [GOALS_URI, RESPONSE_URI]) {
    // Given a URI, the command locks the group showing it; the focus stays put.
    if (isVisible(uri)) await vscode.commands.executeCommand("workbench.action.lockEditorGroup", uri);
  }
}

async function showOutput(uri: vscode.Uri, viewColumn: vscode.ViewColumn): Promise<void> {
  let doc = await vscode.workspace.openTextDocument(uri);
  if (doc.languageId !== OUTPUT_LANGUAGE) {
    doc = await vscode.languages.setTextDocumentLanguage(doc, OUTPUT_LANGUAGE);
  }
  await vscode.window.showTextDocument(doc, { viewColumn, preserveFocus: true, preview: false });
}
