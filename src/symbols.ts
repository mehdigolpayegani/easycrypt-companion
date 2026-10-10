// Gives VS Code the outline and the folding ranges of EasyCrypt scripts.

import * as vscode from "vscode";
import { DeclarationKind, parseDeclarations } from "./declarations";
import { foldingRanges, OutlineNode, outlineTree } from "./outline";

const SYMBOL_KINDS: Record<DeclarationKind, vscode.SymbolKind> = {
  lemma: vscode.SymbolKind.Function,
  axiom: vscode.SymbolKind.Constant,
  op: vscode.SymbolKind.Operator,
  abbrev: vscode.SymbolKind.Operator,
  pred: vscode.SymbolKind.Boolean,
  type: vscode.SymbolKind.Struct,
  module: vscode.SymbolKind.Module,
  "module type": vscode.SymbolKind.Interface,
  theory: vscode.SymbolKind.Namespace,
  section: vscode.SymbolKind.Package,
  clone: vscode.SymbolKind.Namespace,
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
