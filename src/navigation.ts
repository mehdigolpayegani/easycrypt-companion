// Go to Definition, hover and completion for the names declared in EasyCrypt scripts.

import { basename } from "node:path";
import * as vscode from "vscode";
import { Suggestion, suggest, typedName } from "./completion";
import { DeclarationIndex } from "./index";
import { nameAt, nearest, resolve } from "./resolve";
import { COMPLETION_KINDS } from "./symbols";

const MAX_HOVERS = 3;

/**
 * `contextFile` gives the script a document belongs to: itself, or for the
 * goals and response panes the script being proved.
 */
export function registerNavigation(
  context: vscode.ExtensionContext,
  index: DeclarationIndex,
  languages: string[],
  contextFile: (doc: vscode.TextDocument) => string | undefined,
): void {
  const lookup = (doc: vscode.TextDocument, position: vscode.Position) => {
    const at = nameAt(doc.lineAt(position.line).text, position.character);
    const file = contextFile(doc);
    // The line only means something in the script itself.
    const line = doc.uri.scheme === "file" && doc.uri.fsPath === file ? position.line : undefined;
    return at && { at, found: resolve(index, file, at.name, line) };
  };
  const selector = languages.map((language) => ({ language }));

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc, position) {
        const result = lookup(doc, position);
        if (!result) return undefined;
        return nearest(result.found).map(
          (e) => new vscode.Location(vscode.Uri.file(e.file), new vscode.Range(e.line, e.column, e.line, e.endColumn)),
        );
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, position) {
        const result = lookup(doc, position);
        if (!result) return undefined;
        // Not `elsewhere`: a local variable must not show an unrelated declaration.
        const { sameFile, required } = result.found;
        const near = sameFile.length > 0 ? sameFile : required;
        if (near.length === 0) return undefined;
        const text = new vscode.MarkdownString();
        for (const e of near.slice(0, MAX_HOVERS)) {
          if (e.signature) text.appendCodeblock(e.signature, "easycrypt");
          text.appendMarkdown(`${e.kind} \`${[...e.path, e.name].join(".")}\` — ${basename(e.file)}\n\n`);
        }
        if (near.length > MAX_HOVERS) text.appendMarkdown(`and ${near.length - MAX_HOVERS} more`);
        return new vscode.Hover(text, new vscode.Range(position.line, result.at.start, position.line, result.at.end));
      },
    }),
  );
}

type CompletionRange = { inserting: vscode.Range; replacing: vscode.Range };

function completionItem(s: Suggestion, range: CompletionRange): vscode.CompletionItem {
  const e = s.entry;
  const item = e
    ? new vscode.CompletionItem(
        { label: s.name, description: s.needs ? `needs require ${s.needs}` : basename(s.via ?? e.file) },
        COMPLETION_KINDS[e.kind],
      )
    : new vscode.CompletionItem(s.name, vscode.CompletionItemKind.Text);
  if (e) item.detail = `${e.kind} ${[...e.path, e.name].join(".")} — ${basename(e.file)}`;
  if (e?.signature) item.documentation = new vscode.MarkdownString().appendCodeblock(e.signature, "easycrypt");
  // Among equally good matches, the nearest come first.
  item.sortText = `${s.near}${s.name}`;
  item.range = range;
  return item;
}

/** Suggests declared names, and the words of the open scripts, while typing in a script. */
export function registerCompletion(context: vscode.ExtensionContext, index: DeclarationIndex, language: string): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language },
      {
        provideCompletionItems(doc, position) {
          const enabled = vscode.workspace.getConfiguration("easycryptCompanion").get<boolean>("completion", true);
          // With nothing from here, VS Code suggests the words of the scripts itself.
          if (!enabled) return undefined;
          const typed = typedName(doc.lineAt(position.line).text, position.character);
          if (!typed) return undefined;
          const file = doc.uri.scheme === "file" ? doc.uri.fsPath : undefined;
          const scripts = vscode.workspace.textDocuments.filter((d) => d.languageId === language);
          const texts = scripts.map((d) => d.getText());
          const { items, complete } = suggest(index, file, position.line, typed, texts);
          // Replacing also takes the rest of the name the cursor is in.
          const start = new vscode.Position(position.line, typed.start);
          const end = doc.getWordRangeAtPosition(position)?.end ?? position;
          const range = { inserting: new vscode.Range(start, position), replacing: new vscode.Range(start, end) };
          return new vscode.CompletionList(
            items.map((s) => completionItem(s, range)),
            !complete,
          );
        },
      },
    ),
  );
}
