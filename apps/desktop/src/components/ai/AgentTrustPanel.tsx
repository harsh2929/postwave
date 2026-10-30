/**
 * AgentTrustPanel — the "show your work" surface for an autonomous agent
 * run. Given an {@link AgentRoutineRun}, it renders, honestly:
 *
 *   1. Reasoning   — the MODEL's own rationale for the draft. When the
 *                    model gave none, we say so plainly ("No rationale
 *                    recorded") rather than inventing one.
 *   2. What it was told — the prompt/brief + resolved audience context
 *                    the agent actually used (the inputs, verbatim).
 *   3. Draft preview — a snapshot of exactly what the agent produced at
 *                    run time, so a reviewer can scan it before approving.
 *                    Bodies render as READABLE PLAIN TEXT (tags stripped):
 *                    this is a scan-for-approval surface, not the final
 *                    send render, and stripping keeps it XSS-safe with no
 *                    HTML injection from model output.
 *
 * Used by the Routines runs drilldown and the Approvals slideover so the
 * same trust record shows wherever an agent draft is reviewed.
 */

import { type ReactElement } from "react";

import type {
  AgentRoutineDraftPreview,
  AgentRoutineRun,
} from "../../lib/api-client";
import { VoiceRegressionBadge } from "./VoiceRegressionBadge";

/**
 * htmlToReadableText converts a model-produced HTML fragment to readable
 * plain text WITHOUT ever interpreting it as markup (no innerHTML), so no
 * script/style/handler in the draft can execute. Block tags become line
 * breaks; the rest are dropped; a few common entities are decoded.
 */
function htmlToReadableText(html: string): string {
  if (!html) return "";
  return (
    html
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // GAP-2#17: decode &amp; LAST so escaped entities (e.g. "&amp;lt;")
      // decode once to "&lt;", not twice to "<".
      .replace(/&amp;/gi, "&")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .trim()
  );
}

function hasTrust(run: AgentRoutineRun): boolean {
  return Boolean(
    (run.reasoning && run.reasoning.trim()) ||
    (run.prompt_used && run.prompt_used.trim()) ||
    (run.context_used && run.context_used.trim()) ||
    run.draft_preview,
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        className="muted"
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function preText(s: string): ReactElement {
  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {s}
    </div>
  );
}

function DraftPreviewView({
  preview,
}: {
  preview: AgentRoutineDraftPreview;
}): ReactElement {
  if (preview.kind === "sequence") {
    const steps = Array.isArray(preview.steps) ? preview.steps : [];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {preview.name ? (
          <div style={{ fontSize: 12, fontWeight: 600 }}>{preview.name}</div>
        ) : null}
        {steps.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No steps in the snapshot.
          </div>
        ) : (
          steps.map((s, i) => (
            <div
              key={s.position ?? i}
              style={{
                borderLeft: "2px solid var(--pw-border)",
                paddingLeft: 8,
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div className="muted" style={{ fontSize: 10 }}>
                Email {s.position ?? i + 1}
                {typeof s.delay_hours === "number"
                  ? s.delay_hours === 0
                    ? " · sends immediately"
                    : ` · +${s.delay_hours}h`
                  : ""}
              </div>
              {s.subject ? (
                <div style={{ fontSize: 12, fontWeight: 600 }}>{s.subject}</div>
              ) : null}
              {s.body ? preText(htmlToReadableText(s.body)) : null}
            </div>
          ))
        )}
      </div>
    );
  }
  // campaign (default)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {preview.subject ? (
        <div>
          <span className="muted" style={{ fontSize: 10 }}>
            Subject{" "}
          </span>
          <span style={{ fontSize: 12, fontWeight: 600 }}>
            {preview.subject}
          </span>
        </div>
      ) : null}
      {preview.preview_text ? (
        <div>
          <span className="muted" style={{ fontSize: 10 }}>
            Preview{" "}
          </span>
          <span style={{ fontSize: 12 }}>{preview.preview_text}</span>
        </div>
      ) : null}
      {preview.body ? preText(htmlToReadableText(preview.body)) : null}
    </div>
  );
}

/**
 * AgentTrustPanel renders the full trust record for a run. Returns a
 * compact "no trust record" note when the run carries none (e.g. a failed
 * or pre-feature run) so callers can always render it unconditionally.
 */
export function AgentTrustPanel({
  run,
}: {
  run: AgentRoutineRun;
}): ReactElement {
  if (!hasTrust(run)) {
    return (
      <div className="muted" style={{ fontSize: 11 }}>
        No reasoning or draft snapshot was recorded for this run.
      </div>
    );
  }
  const reasoning = (run.reasoning ?? "").trim();
  const prompt = (run.prompt_used ?? "").trim();
  const context = (run.context_used ?? "").trim();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <Section title="Why the agent drafted this">
        {reasoning ? (
          preText(reasoning)
        ) : (
          <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
            No rationale recorded — the model returned a draft without one.
          </div>
        )}
      </Section>

      {prompt || context ? (
        <Section title="What it was told">
          {prompt ? preText(prompt) : null}
          {context ? (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              {context}
            </div>
          ) : null}
        </Section>
      ) : null}

      {run.draft_preview ? (
        <Section title="What it produced">
          <DraftPreviewView preview={run.draft_preview} />
          <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
            Snapshot from run time · bodies shown as plain text. Open the draft
            to see the full rendered version.
          </div>
        </Section>
      ) : null}

      {run.output_kind === "campaign" ? (
        <Section title="Brand-voice continuity">
          <VoiceRegressionBadge />
        </Section>
      ) : null}
    </div>
  );
}

export { hasTrust as agentRunHasTrust };
