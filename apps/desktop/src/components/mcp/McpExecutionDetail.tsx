import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import type { MCPExecution } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { Notice } from "../Notice";
import { SlideoverShell } from "../SlideoverShell";
import { toast } from "../Toast";
import {
  formatMcpAbsoluteTime,
  formatMcpLatency,
  formatMcpMicrosUsd,
  formatMcpRelativeTime,
  mcpStatusBadge,
} from "./mcp-display";
import {
  redactMcpRequestDetails,
  safeMcpDiagnostic,
  safeMcpMethod,
  safeMcpPath,
  safeMcpToolName,
  safeMcpUserAgent,
} from "./mcp-execution-security";
import { validTimestamp } from "./mcp-telemetry-validation";

async function copyMcpValue(text: string) {
  return writeClipboardText(text, {
    contentClass: "personal",
    label: "Redacted MCP execution detail",
  });
}

/** Response-minimised detail drawer for one retained api_key_calls row. */
export function ExecutionSlideover(props: {
  execution: MCPExecution;
  onClose: () => void;
}): ReactElement {
  const { execution, onClose } = props;
  const [copying, setCopying] = useState<"shape" | null>(null);
  const mountedRef = useRef(true);
  const clipboardHelpId = useId();
  const copyOperation = useSingleFlightOperation();
  const badge = mcpStatusBadge(execution.statusCode);
  const requestDetails = useMemo(
    () => redactMcpRequestDetails(execution),
    [execution],
  );
  const method = safeMcpMethod(execution.method);
  const path = safeMcpPath(execution.path);
  const toolName = safeMcpToolName(execution.toolName);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const copy = useCallback(
    (kind: "shape", value: string): void => {
      if (!value) return;
      const request = copyOperation.run(async () => {
        setCopying(kind);
        return copyMcpValue(value);
      });
      if (!request) return;
      void request
        .then((result) => {
          if (!mountedRef.current) return;
          if (result.ok) {
            toast.success("Minimized request metadata copied");
          } else {
            toast.error(result.message);
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            toast.error(
              "The redacted detail could not be copied. Focus Moosewave and retry.",
            );
          }
        })
        .finally(() => {
          if (mountedRef.current) setCopying(null);
        });
    },
    [copyOperation],
  );

  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="md"
      eyebrow={"Execution " + String(execution.id)}
      title={
        <code>
          {toolName === "Suppressed" ? "Tool identifier suppressed" : toolName}
        </code>
      }
      subtitle={
        formatMcpAbsoluteTime(execution.calledAt) + " · " + method + " " + path
      }
      headerActions={
        <span
          className={`badge ${execution.dryRunAsserted ? "warning" : "neutral"}`}
        >
          {execution.dryRunAsserted
            ? "Dry-run header asserted"
            : "No dry-run header recorded"}
        </span>
      }
    >
      <Notice
        tone="neutral"
        title="Sensitive request values stay hidden"
        announcement="off"
      >
        Query values and names, request-body values and object keys, and the
        remote IP were removed before this row entered retained UI state. Tool
        name, user agent, and dry-run status are caller-asserted metadata; they
        do not prove origin, authorization, or that side effects were prevented.
      </Notice>

      <dl className="mcp-detail-list">
        <KV
          label="When"
          valueNode={
            <time
              dateTime={
                validTimestamp(execution.calledAt)
                  ? execution.calledAt
                  : undefined
              }
              className="mcp-time-pair"
            >
              <span>{formatMcpRelativeTime(execution.calledAt)}</span>
              <span className="muted small">
                {formatMcpAbsoluteTime(execution.calledAt)}
              </span>
            </time>
          }
        />
        <KV label="Execution ID" value={String(execution.id)} mono />
        <KV
          label="Tool identifier"
          value={
            toolName === "Suppressed" ? "Not recorded or suppressed" : toolName
          }
          mono
        />
        <KV label="Method" value={method} mono />
        <KV label="Path" value={path} mono wrap />
        {requestDetails.query ? (
          <KV label="Query metadata" value={requestDetails.query} mono wrap />
        ) : null}
        <KV
          label="Status"
          valueNode={
            <span className={"badge " + badge.tone}>{badge.label}</span>
          }
        />
        <KV label="Latency" value={formatMcpLatency(execution.latencyMs)} />
        <KV
          label="API key ID"
          value={execution.apiKeyId || "Not retained"}
          mono
          wrap
        />
        <KV
          label="API key prefix"
          value={execution.apiKeyPrefix || "Not retained"}
          mono
        />
        <KV
          label="User agent"
          value={safeMcpUserAgent(execution.userAgent)}
          mono
          wrap
        />
        <KV label="Remote IP" value="Removed before UI retention" />
        {execution.errorCode ? (
          <KV
            label="Error code"
            value={safeMcpDiagnostic(execution.errorCode)}
            mono
          />
        ) : null}
        <KV
          label="Recorded cost estimate"
          value={formatMcpMicrosUsd(execution.costMicros)}
        />
      </dl>

      {requestDetails.bodyJson ? (
        <section className="mcp-slideover-block">
          <header className="mcp-slideover-block-head">
            <h4>Request body metadata</h4>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => copy("shape", requestDetails.bodyJson)}
              aria-disabled={copyOperation.active || undefined}
              aria-describedby={clipboardHelpId}
              aria-label="Copy minimized request body metadata"
            >
              {copying === "shape" ? "Copying metadata…" : "Copy metadata"}
            </button>
          </header>
          <pre
            className="mcp-codeblock"
            aria-label="Minimized request body metadata"
          >
            <code>{requestDetails.bodyJson}</code>
          </pre>
          <p className="muted small">
            Only constant type, key-count, and truncation fields remain. At
            least {requestDetails.redactionCount.toLocaleString()} request
            metadata item
            {requestDetails.redactionCount === 1 ? " was" : "s were"} omitted;
            caller-supplied key names and values are not shown.
          </p>
        </section>
      ) : null}

      <Notice
        tone="warning"
        title="Executable replay is release-held"
        announcement="off"
      >
        No command or replay clipboard action is mounted. A recorded dry-run
        header is only a caller assertion and does not prove that the target
        endpoint prevented mutations, sends, or other side effects.
      </Notice>
      <p id={clipboardHelpId} className="muted small" aria-live="polite">
        {copyOperation.active
          ? "One clipboard write is already in progress."
          : "The only available clipboard action copies constant minimized metadata without captured key names or values."}
      </p>
    </SlideoverShell>
  );
}

function KV(props: {
  label: string;
  value?: string;
  valueNode?: ReactElement;
  mono?: boolean;
  wrap?: boolean;
}): ReactElement {
  return (
    <>
      <dt>{props.label}</dt>
      <dd className={`${props.mono ? "mono" : ""} ${props.wrap ? "wrap" : ""}`}>
        {props.valueNode ?? props.value ?? "—"}
      </dd>
    </>
  );
}
