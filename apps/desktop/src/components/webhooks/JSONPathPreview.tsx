/**
 * JSONPathPreview — live-evaluates a JSONPath expression + operator
 * against a sample payload. PR 2 — used inside the trigger editor so
 * users can confirm "yes this fires" before saving.
 *
 * Pure presentation; the heavy lifting is in lib/jsonpath.
 */

import { type ReactElement, useMemo } from "react";

import {
  type MatchOperator,
  inspectJSONPath,
  matchOperator,
  validateMatchOperand,
} from "../../lib/jsonpath";

interface Props {
  /** Raw JSON string — typically the body of a recent inbound event. */
  sampleJSON: string;
  jsonpath: string;
  operator: MatchOperator;
  expected?: string | null;
}

export function JSONPathPreview({
  sampleJSON,
  jsonpath,
  operator,
  expected,
}: Props): ReactElement {
  const evalResult = useMemo(() => {
    if (!sampleJSON.trim()) {
      return { kind: "empty" as const };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(sampleJSON);
    } catch (e) {
      return {
        kind: "bad-json" as const,
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (!jsonpath.trim()) {
      return { kind: "no-path" as const };
    }
    const inspected = inspectJSONPath(parsed, jsonpath);
    if (!inspected.valid) {
      return {
        kind: "invalid-path" as const,
        message: inspected.error,
      };
    }
    const operandError = validateMatchOperand(operator, expected);
    if (operandError) {
      return {
        kind: "invalid-operand" as const,
        message: operandError,
      };
    }
    if (operator === "regex") {
      return {
        kind: "regex-server" as const,
        matches: inspected.matches,
      };
    }
    const fires = matchOperator(operator, inspected.matches, expected);
    return { kind: "ok" as const, matches: inspected.matches, fires };
  }, [sampleJSON, jsonpath, operator, expected]);

  if (evalResult.kind === "empty") {
    return (
      <div className="wh-jp-preview is-muted">
        Paste a recent event body above to preview matches.
      </div>
    );
  }
  if (evalResult.kind === "bad-json") {
    return (
      <div className="wh-jp-preview is-error">
        Body isn&apos;t valid JSON: {evalResult.message}
      </div>
    );
  }
  if (evalResult.kind === "no-path") {
    return (
      <div className="wh-jp-preview is-muted">
        Enter a JSONPath to see what it matches.
      </div>
    );
  }
  if (evalResult.kind === "invalid-path") {
    return (
      <div className="wh-jp-preview is-error" role="status">
        <strong>Invalid path.</strong> {evalResult.message} Preview withheld.
      </div>
    );
  }
  if (evalResult.kind === "invalid-operand") {
    return (
      <div className="wh-jp-preview is-error" role="status">
        <strong>Incomplete condition.</strong> {evalResult.message} Preview
        withheld.
      </div>
    );
  }
  if (evalResult.kind === "regex-server") {
    return (
      <div className="wh-jp-preview is-muted" role="status">
        <strong>Regex preview withheld.</strong> The renderer does not execute
        user-supplied patterns. Moosewave validates the bounded RE2 pattern when
        you save; {evalResult.matches.length} path match
        {evalResult.matches.length === 1 ? "" : "es"} found.
      </div>
    );
  }
  return (
    <div className="wh-jp-preview">
      <div className="wh-jp-verdict">
        {evalResult.fires ? (
          <span className="wh-jp-fires">✓ Trigger fires</span>
        ) : (
          <span className="wh-jp-no-fire">✗ No match</span>
        )}
        <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
          {evalResult.matches.length} match
          {evalResult.matches.length === 1 ? "" : "es"}
        </span>
      </div>
      {evalResult.matches.length > 0 ? (
        <pre className="wh-jp-matches">
          {evalResult.matches
            .slice(0, 5)
            .map(
              (m, i) =>
                `${i + 1}. ${typeof m === "string" ? m : JSON.stringify(m, null, 2)}`,
            )
            .join("\n")}
          {evalResult.matches.length > 5
            ? `\n…${evalResult.matches.length - 5} more`
            : ""}
        </pre>
      ) : null}
    </div>
  );
}
