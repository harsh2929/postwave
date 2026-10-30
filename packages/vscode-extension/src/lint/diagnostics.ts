// SPDX-License-Identifier: MIT
import * as vscode from "vscode";

import { runAllRules, type LintFinding } from "./rules/index.js";

const SUPPORTED_EXT_RE = /\.(email\.tsx|email\.md|mjml)$/i;

export function isPostwaveEmailDoc(doc: vscode.TextDocument): boolean {
  return SUPPORTED_EXT_RE.test(doc.uri.fsPath);
}

/** Convert a pure LintFinding into a VSCode Diagnostic. */
export function findingToDiagnostic(
  doc: vscode.TextDocument,
  finding: LintFinding,
): vscode.Diagnostic {
  const range = new vscode.Range(
    doc.positionAt(finding.start),
    doc.positionAt(finding.end),
  );
  const diag = new vscode.Diagnostic(
    range,
    finding.message,
    vscode.DiagnosticSeverity.Warning,
  );
  diag.source = "postwave";
  diag.code = finding.ruleId;
  return diag;
}

/** Lint a document and push diagnostics into the given collection. */
export function lintDocument(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): void {
  if (!isPostwaveEmailDoc(doc)) {
    collection.delete(doc.uri);
    return;
  }
  const findings = runAllRules(doc.getText());
  collection.set(doc.uri, findings.map((f) => findingToDiagnostic(doc, f)));
}

/** Wire save / close handlers and return a Disposable for the extension. */
export function registerDiagnostics(
  context: vscode.ExtensionContext,
): vscode.DiagnosticCollection {
  const collection = vscode.languages.createDiagnosticCollection("postwave");
  context.subscriptions.push(collection);

  for (const doc of vscode.workspace.textDocuments) {
    lintDocument(doc, collection);
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => lintDocument(doc, collection)),
    vscode.workspace.onDidOpenTextDocument((doc) => lintDocument(doc, collection)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
  );

  return collection;
}
