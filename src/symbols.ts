// Gives VS Code the outline and the folding ranges of EasyCrypt scripts, and
// the outline of the response pane.

import * as vscode from "vscode";
import { DeclarationKind, parseDeclarations } from "./declarations";
import { foldingRanges, OutlineNode, outlineTree } from "./outline";
import { results } from "./results";

export const SYMBOL_KINDS: Record<DeclarationKind, vscode.SymbolKind> = {
  lemma: vscode.SymbolKind.Function,
  axiom: vscode.SymbolKind.Constant,
  op: vscode.SymbolKind.Operator,
  abbrev: vscode.SymbolKind.Operator,
  pred: vscode.SymbolKind.Boolean,
  type: vscode.SymbolKind.Struct,
  module: vscode.SymbolKind.Module,
  "module type": vscode.SymbolKind.Interface,
  var: vscode.SymbolKind.Variable,
  proc: vscode.SymbolKind.Method,
  theory: vscode.SymbolKind.Namespace,
  section: vscode.SymbolKind.Package,
  clone: vscode.SymbolKind.Namespace,
};

export const COMPLETION_KINDS: Record<DeclarationKind, vscode.CompletionItemKind> = {
  lemma: vscode.CompletionItemKind.Function,
  axiom: vscode.CompletionItemKind.Constant,
  op: vscode.CompletionItemKind.Operator,
  abbrev: vscode.CompletionItemKind.Operator,
  pred: vscode.CompletionItemKind.Value,
  type: vscode.CompletionItemKind.Struct,
  module: vscode.CompletionItemKind.Class,
  "module type": vscode.CompletionItemKind.Interface,
  var: vscode.CompletionItemKind.Variable,
  proc: vscode.CompletionItemKind.Method,
  theory: vscode.CompletionItemKind.Module,
  section: vscode.CompletionItemKind.Module,
  clone: vscode.CompletionItemKind.Module,
};

function toSymbol(doc: vscode.TextDocument, node: OutlineNode): vscode.DocumentSymbol {
  const d = node.declaration;
  const symbol = new vscode.DocumentSymbol(
    d.name || d.keyword, // an unnamed section
    d.name ? d.keyword : "",
    SYMBOL_KINDS[d.kind],
    new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end)),
    new vscode.Range(doc.positionAt(d.nameStart), doc.positionAt(d.nameEnd)),
  );
  symbol.children = node.children.map((child) => toSymbol(doc, child));
  return symbol;
}

export function registerOutline(context: vscode.ExtensionContext, language: string): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      { language },
      {
        provideDocumentSymbols: (doc) =>
          outlineTree(parseDeclarations(doc.getText())).map((node) => toSymbol(doc, node)),
      },
    ),
    vscode.languages.registerFoldingRangeProvider(
      { language },
      {
        provideFoldingRanges: (doc) => {
          const text = doc.getText();
          return foldingRanges(text, parseDeclarations(text)).map(
            (r) => new vscode.FoldingRange(r.start, r.end, r.comment ? vscode.FoldingRangeKind.Comment : undefined),
          );
        },
      },
    ),
  );
}

/** Lists the lemmas and axioms of the response pane, for its outline and Go to Symbol. */
export function registerResultsOutline(context: vscode.ExtensionContext, language: string): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      { language },
      {
        provideDocumentSymbols: (doc) =>
          results(doc.getText()).map(
            (r) =>
              new vscode.DocumentSymbol(
                r.name,
                r.kind,
                SYMBOL_KINDS[r.kind],
                new vscode.Range(r.start, 0, r.end, doc.lineAt(r.end).text.length),
                new vscode.Range(r.line, r.column, r.line, r.endColumn),
              ),
          ),
      },
    ),
  );
}
