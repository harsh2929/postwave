"use client";

// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { newIntentKey } from "@/lib/intentKey";
import { CSRF_HEADER, CSRF_VALUE } from "@/lib/opsSecurity";

type Outcome = { ok: boolean; text: string } | null;

const SEVERITIES = [
  { value: "sev1", label: "SEV1 — critical / customer-facing outage" },
  { value: "sev2", label: "SEV2 — degraded / partial impact" },
  { value: "sev3", label: "SEV3 — minor / internal" },
] as const;

export default function DeclareIncidentForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("");
  const [body, setBody] = useState("");
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

  // When the form collapses after the operator opened it (cancel or a
  // successful declare), return focus to the trigger so keyboard users are not
  // dropped at the top of the document. The flag keeps this from firing on the
  // initial closed render.
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  const canRun =
    !busy &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    SEVERITIES.some((item) => item.value === severity);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRun || inFlight.current) return;
    inFlight.current = true;
    const currentSequence = ++sequence.current;
    setBusy(true);
    setOutcome(null);

    const payload = {
      title: title.trim(),
      severity,
      body: body.trim(),
    };
    const fingerprint = JSON.stringify(payload);
    try {
      if (!intent.current || intent.current.fingerprint !== fingerprint) {
        intent.current = { key: newIntentKey(), fingerprint };
      }
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: CSRF_VALUE,
        },
        body: JSON.stringify({ ...payload, idempotency_key: intent.current.key }),
      });
      const responseBody: unknown = await response.json().catch(() => null);
      if (!mounted.current || currentSequence !== sequence.current) return;
      if (!response.ok) {
        if (response.status < 500) intent.current = null;
        setOutcome({ ok: false, text: apiError(response.status, responseBody) });
        return;
      }
      const replayed = (responseBody as { replayed?: boolean } | null)?.replayed === true;
      intent.current = null;
      setOutcome({ ok: true, text: replayed ? "incident already declared (safe replay)" : "incident declared" });
      setTitle("");
      setSeverity("");
      setBody("");
      restoreFocus.current = true;
      setOpen(false);
      router.refresh();
    } catch (error) {
      if (mounted.current && currentSequence === sequence.current) {
        setOutcome({
          ok: false,
          text: `no definitive answer from the console API (${message(error)}); retry the same unchanged intent to replay safely`,
        });
      }
    } finally {
      if (currentSequence === sequence.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  if (!open) {
    return (
      <div style={{ margin: "1rem 0" }}>
        <button ref={trigger} type="button" onClick={() => setOpen(true)} className="btn">
          Declare incident
        </button>
        {outcome ? (
          <span role={outcome.ok ? "status" : "alert"} style={{ marginLeft: "0.75rem", color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)" }}>
            {outcome.text}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void run(event)}
      aria-busy={busy}
      className="panel"
      style={{ padding: "1rem", margin: "1rem 0" }}
    >
      <h2>Declare an incident</h2>
      <label style={labelStyle}>
        Title
        <input required autoFocus maxLength={256} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Stripe webhooks dead-lettering" style={fieldStyle} />
      </label>
      <label style={labelStyle}>
        Severity
        <select required value={severity} onChange={(event) => setSeverity(event.target.value)} style={fieldStyle}>
          <option value="" disabled>Choose severity</option>
          {SEVERITIES.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        Opening note (required — the first line of the timeline)
        <textarea required maxLength={4096} value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="What is happening, and what is the current impact?" style={{ ...fieldStyle, resize: "vertical" }} />
      </label>
      {outcome ? <p role={outcome.ok ? "status" : "alert"} style={{ color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)", fontSize: "0.8rem", margin: "0 0 0.7rem" }}>{outcome.text}</p> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
        <button type="button" disabled={busy} onClick={() => { restoreFocus.current = true; setOpen(false); }} className="btn">Cancel</button>
        <button type="submit" disabled={!canRun} className="btn">
          {busy ? "declaring…" : "Declare"}
        </button>
      </div>
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

const labelStyle: React.CSSProperties = { display: "block", marginBottom: "0.7rem" };
const fieldStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
};
