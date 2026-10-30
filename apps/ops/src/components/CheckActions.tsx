"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// CheckActions — the only interactive part of the console: a check's one
// button, and the snooze dialog every check gets.
//
// Three rules, all of them about not lying to the operator:
//
//  1. HOW HARD IT ASKS follows the server's danger tier, never the client's
//     opinion of it. safe = one click. confirm = a modal. type_to_confirm =
//     the operator types the check id, so muscle memory cannot fire it.
//  2. The idempotency key is generated ONCE PER INTENT, not per request. On a
//     network failure — the case where nobody knows whether the action ran —
//     the key is KEPT, so clicking again replays the stored result instead of
//     replaying the customer's money. Only a definitive answer from the server
//     retires a key.
//  3. status:"failed" arrives as HTTP 200 (the run happened; it did not
//     succeed). A replay can also truthfully return status:"running" while the
//     first detached execution is still in flight. Neither is painted green,
//     and a running replay keeps its key until a terminal result arrives.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionMeta } from "@/lib/board";
import {
  bindPayloadIntent,
  type PayloadBoundIntent,
  shouldRetireIntent,
} from "@/lib/intentKey";
import { CSRF_HEADER, CSRF_VALUE } from "@/lib/opsSecurity";

type Outcome = { ok: boolean; text: string } | null;

// Snooze durations an operator actually reaches for. The API caps CRITICAL
// checks at 7 days and will reject anything longer — the list stops there so
// the cap is a rule, not a surprise.
const SNOOZE_DURATIONS = [
  { value: "1h", label: "1 hour" },
  { value: "8h", label: "8 hours" },
  { value: "24h", label: "1 day" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
];

export default function CheckActions({
  checkId,
  action,
}: {
  checkId: string;
  action?: ActionMeta;
}) {
  const router = useRouter();

  const [dialog, setDialog] = useState<"action" | "snooze" | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const [input, setInput] = useState("");
  const [typed, setTyped] = useState(""); // type_to_confirm box
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState("24h");

  // One key per payload-bound INTENT. An operator may edit the input after an
  // ambiguous response; that is a new intent and must not reuse the old key.
  const actionIntent = useRef<PayloadBoundIntent | null>(null);
  const snoozeIntent = useRef<PayloadBoundIntent | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  function closeDialog() {
    setDialog(null);
    setTyped("");
  }

  async function runAction() {
    if (!action || busy || inFlight.current) return;

    inFlight.current = true;
    const currentSequence = ++sequence.current;
    setBusy(true);
    setOutcome(null);

    try {
      const fingerprint = JSON.stringify({ checkId, input });
      actionIntent.current = bindPayloadIntent(actionIntent.current, fingerprint);
      const res = await fetch(`/api/checks/${encodeURIComponent(checkId)}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: CSRF_VALUE,
        },
        body: JSON.stringify({ idempotency_key: actionIntent.current.key, input }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!mounted.current || currentSequence !== sequence.current) return;

      if (!res.ok) {
        // 4xx responses are definitive refusals. A 5xx may have happened after
        // the action committed, so keep the payload-bound key for a safe retry.
        if (shouldRetireIntent({ kind: "http-error", status: res.status })) {
          actionIntent.current = null;
        }
        setOutcome({ ok: false, text: apiError(res.status, body) });
        return;
      }

      const run = body as { status?: string; result?: string; replayed?: boolean } | null;
      if (run?.status === "running") {
        // Do not retire the payload-bound key: a fresh key here could execute
        // the same operator action twice while the original is still running.
        setOutcome({
          ok: false,
          text: "the original action is still running; wait, then retry the same unchanged input to query this intent again",
        });
        router.refresh();
        return;
      }
      const succeeded = run?.status === "succeeded";
      const text = [
        run?.result || `run ${run?.status ?? "returned nothing"}`,
        run?.replayed ? "· replayed (same key — not run twice)" : "",
      ]
        .filter(Boolean)
        .join(" ");

      if (
        run?.status === "succeeded" ||
        run?.status === "failed"
      ) {
        if (shouldRetireIntent({ kind: "operation", status: run.status })) {
          actionIntent.current = null;
        }
      }
      setOutcome({ ok: succeeded, text });
      if (succeeded) {
        closeDialog();
        setInput("");
      }
      router.refresh(); // the board is the truth; re-derive it
    } catch (err) {
      // No answer. The action MAY have run. Keep the key.
      if (mounted.current && currentSequence === sequence.current) {
        setOutcome({
          ok: false,
          text: `no answer from the console API (${msg(err)}) — the action may have run; retry the same unchanged input to reuse its idempotency key`,
        });
      }
    } finally {
      if (currentSequence === sequence.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  async function snooze() {
    if (busy || inFlight.current) return;
    if (!reason.trim()) {
      setOutcome({ ok: false, text: "a snooze without a reason is a mute button; say why" });
      return;
    }
    inFlight.current = true;
    const currentSequence = ++sequence.current;
    setBusy(true);
    setOutcome(null);
    try {
      const normalizedReason = reason.trim();
      const fingerprint = JSON.stringify({ checkId, duration, reason: normalizedReason });
      snoozeIntent.current = bindPayloadIntent(snoozeIntent.current, fingerprint);
      const res = await fetch(`/api/checks/${encodeURIComponent(checkId)}/snooze`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: CSRF_VALUE,
        },
        body: JSON.stringify({
          idempotency_key: snoozeIntent.current.key,
          duration,
          reason: normalizedReason,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!mounted.current || currentSequence !== sequence.current) return;
      if (!res.ok) {
        if (shouldRetireIntent({ kind: "http-error", status: res.status })) {
          snoozeIntent.current = null;
        }
        setOutcome({ ok: false, text: apiError(res.status, body) });
        return;
      }
      const snooze = body as {
        status?: "running" | "succeeded" | "failed";
        result?: string;
        snoozed_until?: string | null;
        replayed?: boolean;
      } | null;
      if (snooze?.status === "running") {
        setOutcome({
          ok: false,
          text: "the original snooze is still running; retry the same unchanged duration and reason to query this intent — it will not extend the expiry",
        });
        router.refresh();
        return;
      }
      if (snooze?.status === "failed") {
        // A database acknowledgement can be ambiguous even when the ledger
        // records failure. Keep the key so unchanged retries can only replay;
        // editing the payload or reloading is the deliberate new-intent path.
        if (shouldRetireIntent({ kind: "operation", status: "failed" }, true)) {
          snoozeIntent.current = null;
        }
        setOutcome({
          ok: false,
          text: `${snooze.result || "the snooze failed"}${snooze.replayed ? " · replayed (same key — not extended)" : ""}`,
        });
        router.refresh();
        return;
      }
      if (snooze?.status !== "succeeded" || !snooze.snoozed_until) {
        setOutcome({ ok: false, text: "the console returned an incomplete snooze outcome; retry the unchanged intent" });
        return;
      }
      if (shouldRetireIntent({ kind: "operation", status: "succeeded" }, true)) {
        snoozeIntent.current = null;
      }
      setOutcome({
        ok: true,
        text: `snoozed until ${snooze.snoozed_until}${snooze.replayed ? " · replayed (same key — not extended)" : ""}`,
      });
      closeDialog();
      setReason("");
      router.refresh();
    } catch (err) {
      if (mounted.current && currentSequence === sequence.current) {
        setOutcome({
          ok: false,
          text: `no answer from the console API (${msg(err)}) — the snooze may have applied; retry the same unchanged duration and reason to reuse its idempotency key`,
        });
      }
    } finally {
      if (currentSequence === sequence.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  const needsInput = Boolean(action?.input_hint);
  const typeToConfirm = action?.danger === "type_to_confirm";
  const canRun = !busy && (!typeToConfirm || typed.trim() === checkId);

  return (
    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.4rem" }}>
      {outcome ? (
        <span
          role={outcome.ok ? "status" : "alert"}
          style={{
            color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)",
            fontSize: "0.75rem",
            maxWidth: "34rem",
          }}
        >
          {outcome.text}
        </span>
      ) : null}

      {action ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            // safe = one click, no ceremony. Anything else asks first.
            if (action.danger === "safe") void runAction();
            else setDialog("action");
          }}
          style={tint(action.danger === "safe" ? "var(--accent)" : "var(--amber-ink)")}
        >
          {busy && dialog === null ? "running…" : action.label}
        </button>
      ) : null}

      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => setDialog("snooze")}
      >
        Snooze
      </button>

      {dialog === "action" && action ? (
        <Modal title={action.label} onClose={closeDialog} closeDisabled={busy}>
          <p style={pStyle}>
            <code style={codeStyle}>{checkId}</code> — this runs against production.
          </p>

          {needsInput ? (
            <label style={labelStyle}>
              {action.input_hint}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={4096}
                placeholder={action.input_hint}
                autoFocus
                style={fieldStyle}
              />
            </label>
          ) : null}

          {typeToConfirm ? (
            <label style={labelStyle}>
              Type <code style={codeStyle}>{checkId}</code> to confirm
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoFocus={!needsInput}
                style={fieldStyle}
              />
            </label>
          ) : null}

          {outcome && !outcome.ok ? (
            <p style={{ ...pStyle, color: "var(--red-ink)" }}>{outcome.text}</p>
          ) : null}

          <DialogButtons
            onClose={closeDialog}
            onRun={() => void runAction()}
            runLabel={busy ? "running…" : action.label}
            canRun={canRun}
            closeDisabled={busy}
            danger
          />
        </Modal>
      ) : null}

      {dialog === "snooze" ? (
        <Modal title={`Snooze ${checkId}`} onClose={closeDialog} closeDisabled={busy}>
          <p style={pStyle}>
            A snoozed check leaves the fire lanes and keeps its reason on the
            board. It does not stop being true. Critical checks cap at 7 days.
          </p>

          <label style={labelStyle}>
            For how long
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              autoFocus
              style={fieldStyle}
            >
              {SNOOZE_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Why (required — this lands in the audit log)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={4096}
              rows={3}
              placeholder="e.g. vendor incident #4412, fix expected Thursday"
              style={{ ...fieldStyle, resize: "vertical" }}
            />
          </label>

          {outcome && !outcome.ok ? (
            <p style={{ ...pStyle, color: "var(--red-ink)" }}>{outcome.text}</p>
          ) : null}

          <DialogButtons
            onClose={closeDialog}
            onRun={() => void snooze()}
            runLabel={busy ? "snoozing…" : "Snooze"}
            canRun={!busy && reason.trim().length > 0}
            closeDisabled={busy}
          />
        </Modal>
      ) : null}
    </span>
  );
}

function DialogButtons({
  onClose,
  onRun,
  runLabel,
  canRun,
  closeDisabled,
  danger,
}: {
  onClose: () => void;
  onRun: () => void;
  runLabel: string;
  canRun: boolean;
  closeDisabled: boolean;
  danger?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
      <button type="button" className="btn" onClick={onClose} disabled={closeDisabled}>
        Cancel
      </button>
      <button
        type="button"
        className="btn"
        onClick={onRun}
        disabled={!canRun}
        style={tint(danger ? "var(--amber-ink)" : "var(--accent)")}
      >
        {runLabel}
      </button>
    </div>
  );
}

function Modal({
  title,
  onClose,
  closeDisabled,
  children,
}: {
  title: string;
  onClose: () => void;
  closeDisabled: boolean;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.contains(document.activeElement)) {
        const first = firstFocusable(dialog.current);
        if (first) first.focus();
        else dialog.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !closeDisabled) onClose();
        if (e.key === "Tab") trapDialogTab(e, dialog.current);
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--bg) 75%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "1rem",
      }}
    >
      <div
        className="panel"
        style={{
          width: "min(34rem, 100%)",
          padding: "1rem 1.1rem 1.1rem",
          textAlign: "left",
        }}
      >
        <h3 style={{ margin: "0 0 0.6rem", color: "var(--text)", fontSize: "1rem" }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function dialogFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getAttribute("aria-hidden") !== "true",
  );
}

function firstFocusable(container: HTMLElement | null): HTMLElement | undefined {
  return dialogFocusable(container)[0];
}

function trapDialogTab(event: React.KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  const focusable = dialogFocusable(container);
  if (focusable.length === 0) {
    event.preventDefault();
    container?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !container?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function apiError(status: number, body: unknown): string {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  const parts = [err?.code, err?.message].filter(Boolean);
  return parts.length > 0 ? `${status}: ${parts.join(" — ")}` : `the ops API returned ${status}`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A semantic tint layered over the shared .btn base: the accent colour also
// serves as the outline, so the danger tier stays legible without inventing a
// new button shape.
function tint(color: string): React.CSSProperties {
  return { color, borderColor: color, whiteSpace: "nowrap" };
}

const pStyle: React.CSSProperties = {
  color: "var(--text-2)",
  fontSize: "0.85rem",
  margin: "0 0 0.7rem",
  lineHeight: 1.5,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  color: "var(--text-3)",
  fontSize: "0.75rem",
  marginBottom: "0.7rem",
};

// Colour/border/radius come from the global input theme; only the modal layout
// (block, full-width, top gap) stays inline.
const fieldStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
};

const codeStyle: React.CSSProperties = { color: "var(--accent)" };
