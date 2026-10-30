"use client";

// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { IncidentStatus } from "@/lib/incidents";
import { newIntentKey } from "@/lib/intentKey";
import { CSRF_HEADER, CSRF_VALUE } from "@/lib/opsSecurity";

type Outcome = { ok: boolean; text: string } | null;

export default function IncidentActions({
  incidentId,
  incidentStatus,
}: {
  incidentId: string;
  incidentStatus: IncidentStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const intent = useRef<{ key: string; fingerprint: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  // Return focus to the trigger when the form collapses after being opened
  // (cancel or a posted update), so keyboard users are not stranded. The flag
  // suppresses this on the initial closed render.
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  const canRun = !busy && body.trim().length > 0;
  const statusOptions = incidentStatus === "monitoring"
    ? [
        { value: "", label: "Note only (no status change)" },
        { value: "open", label: "→ Mark open" },
        { value: "resolved", label: "→ Resolve (terminal)" },
      ]
    : [
        { value: "", label: "Note only (no status change)" },
        { value: "monitoring", label: "→ Monitoring" },
        { value: "resolved", label: "→ Resolve (terminal)" },
      ];

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRun || inFlight.current || incidentStatus === "resolved") return;
    inFlight.current = true;
    const currentSequence = ++sequence.current;
    setBusy(true);
    setOutcome(null);
    const payload = { body: body.trim(), status };
    const fingerprint = JSON.stringify({ incidentId, ...payload });

    try {
      if (!intent.current || intent.current.fingerprint !== fingerprint) {
        intent.current = { key: newIntentKey(), fingerprint };
      }
      const response = await fetch(
        `/api/incidents/${encodeURIComponent(incidentId)}/updates`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CSRF_HEADER]: CSRF_VALUE,
          },
          body: JSON.stringify({ ...payload, idempotency_key: intent.current.key }),
        },
      );
      const responseBody: unknown = await response.json().catch(() => null);
      if (!mounted.current || currentSequence !== sequence.current) return;
      if (!response.ok) {
        if (response.status < 500) intent.current = null;
        setOutcome({ ok: false, text: apiError(response.status, responseBody) });
        return;
      }
      const replayed = (responseBody as { replayed?: boolean } | null)?.replayed === true;
      intent.current = null;
      setOutcome({ ok: true, text: replayed ? "update already posted (safe replay)" : "update posted" });
      setBody("");
      setStatus("");
      restoreFocus.current = true;
      setOpen(false);
      router.refresh();
    } catch (error) {
      if (mounted.current && currentSequence === sequence.current) {
        setOutcome({
          ok: false,
          text: `no definitive answer from the console API (${message(error)}); retry the same unchanged update to replay safely`,
        });
      }
    } finally {
      if (currentSequence === sequence.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  if (incidentStatus === "resolved") {
    return <span style={{ color: "var(--text-4)", fontSize: "0.75rem" }}>Resolved — terminal</span>;
  }

  if (!open) {
    return (
      <span>
        <button ref={trigger} type="button" className="btn" onClick={() => setOpen(true)}>
          Update
        </button>
        {outcome ? (
          <span role={outcome.ok ? "status" : "alert"} style={{ display: "block", color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)", fontSize: "0.7rem", marginTop: "0.25rem" }}>
            {outcome.text}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <form onSubmit={(event) => void run(event)} aria-busy={busy} style={{ display: "flex", flexDirection: "column", gap: "0.35rem", minWidth: "18rem" }}>
      <label>
        <span style={visuallyHidden}>Status transition</span>
        <select autoFocus value={status} onChange={(event) => setStatus(event.target.value)} style={field}>
          {statusOptions.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span style={visuallyHidden}>Incident update</span>
        <textarea required maxLength={4096} value={body} onChange={(event) => setBody(event.target.value)} rows={2} placeholder="What changed? (lands in the timeline + audit log)" style={{ ...field, resize: "vertical" }} />
      </label>
      {outcome ? <span role={outcome.ok ? "status" : "alert"} style={{ color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)", fontSize: "0.7rem" }}>{outcome.text}</span> : null}
      <span style={{ display: "flex", gap: "0.4rem" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => { restoreFocus.current = true; setOpen(false); }}>Cancel</button>
        <button type="submit" className="btn" disabled={!canRun}>
          {busy ? "posting…" : "Post update"}
        </button>
      </span>
    </form>
  );
}

function apiError(status: number, body: unknown): string {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
  const parts = [error?.code, error?.message].filter(Boolean);
  return parts.length > 0 ? `${status}: ${parts.join(" — ")}` : `the ops API returned ${status}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const field: React.CSSProperties = {
  width: "100%",
  fontSize: "0.8rem",
};

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
