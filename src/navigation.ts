// Go to Definition and hover for the names declared in EasyCrypt scripts.

import { basename } from "node:path";
import * as vscode from "vscode";
import { DeclarationIndex } from "./index";
import { nameAt, nearest, resolve } from "./resolve";

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
    return at && { at, found: resolve(index, contextFile(doc), at.name) };
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
