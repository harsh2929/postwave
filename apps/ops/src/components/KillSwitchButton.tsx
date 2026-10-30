"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// KillSwitchButton — the console's per-tenant send pause/resume lever.
//
// Same honesty rules as CheckActions, adapted to a state-set action:
//
//  1. HOW HARD IT ASKS follows the direction. Pausing a tenant's sending is the
//     dangerous one, so it is type-to-confirm: the operator types the tenant
//     slug, and muscle memory cannot fire it. Resuming is recovery — a plain
//     confirm.
//  2. A reason is REQUIRED either way. It lands in the audit log next to the
//     operator's identity; a kill switch pulled with no recorded why is exactly
//     the thing an audit exists to catch.
//  3. The action is idempotent (SetPaused to the same value is a no-op), so a
//     retry after an ambiguous network failure is safe — the outcome text says
//     so rather than leaving the operator guessing whether it landed.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CSRF_HEADER, CSRF_VALUE } from "@/lib/opsSecurity";

type Outcome = { ok: boolean; text: string } | null;

export default function KillSwitchButton({
  tenantId,
  tenantSlug,
  paused,
}: {
  tenantId: string;
  tenantSlug: string;
  paused: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.contains(document.activeElement)) {
        const first = firstFocusable(dialog.current);
        if (first) first.focus();
        else dialog.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // The lever does the opposite of the current state.
  const willPause = !paused;
  const needsType = willPause; // pausing is the dangerous direction
  const canRun = !busy && reason.trim().length > 0 && (!needsType || typed.trim() === tenantSlug);

  function close() {
    if (inFlight.current) return;
    setOpen(false);
    setTyped("");
    setReason("");
    trigger.current?.focus();
  }

  async function run() {
    if (!canRun || inFlight.current) return;
    inFlight.current = true;
    const currentSequence = ++sequence.current;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/kill-switch`, {
        method: "POST",
        headers: { "content-type": "application/json", [CSRF_HEADER]: CSRF_VALUE },
        body: JSON.stringify({ paused: willPause, reason: reason.trim() }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!mounted.current || currentSequence !== sequence.current) return;
      if (!res.ok) {
        setOutcome({ ok: false, text: apiError(res.status, body) });
        return;
      }
      const applied = (body as { paused?: boolean } | null)?.paused;
      setOutcome({ ok: true, text: applied ? "sending paused" : "sending resumed" });
      setOpen(false);
      setTyped("");
      setReason("");
      trigger.current?.focus();
      // The directory's health is derived server-side; reload so the row
      // reflects the new state instead of the stale one that opened the dialog.
      router.refresh();
    } catch (err) {
      if (mounted.current && currentSequence === sequence.current) {
        setOutcome({
          ok: false,
          text: `no answer from the console API (${msg(err)}) — the kill switch is idempotent, so clicking again is safe`,
        });
      }
    } finally {
      if (currentSequence === sequence.current) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  const label = willPause ? "Pause sending" : "Resume sending";
  const color = willPause ? "var(--amber-ink)" : "var(--green-ink)";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      {outcome ? (
        <span role={outcome.ok ? "status" : "alert"} style={{ color: outcome.ok ? "var(--green-ink)" : "var(--red-ink)", fontSize: "0.7rem", maxWidth: "18rem" }}>
          {outcome.text}
        </span>
      ) : null}
      <button ref={trigger} type="button" className="btn" disabled={busy} onClick={() => setOpen(true)} style={tint(color)}>
        {busy ? "working…" : label}
      </button>

      {open ? (
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) close();
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
            <h3 style={{ margin: "0 0 0.6rem", color: "var(--text)", fontSize: "1rem" }}>{label}</h3>
            <p style={pStyle}>
              {willPause ? (
                <>
                  This immediately stops <code style={codeStyle}>{tenantSlug}</code> from sending any
                  email. In-flight and future sends halt until you resume.
                </>
              ) : (
                <>
                  This lets <code style={codeStyle}>{tenantSlug}</code> send email again. Verify the
                  reason it was paused is resolved.
                </>
              )}
            </p>

            {needsType ? (
              <label style={labelStyle}>
                Type <code style={codeStyle}>{tenantSlug}</code> to confirm
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  autoFocus
                  style={fieldStyle}
                />
              </label>
            ) : null}

            <label style={labelStyle}>
              Why (required — this lands in the audit log)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus={!needsType}
                maxLength={4096}
                required
                rows={3}
                placeholder={willPause ? "e.g. spam complaint spike, containing blast radius" : "e.g. sender fixed DKIM, complaints back to baseline"}
                style={{ ...fieldStyle, resize: "vertical" }}
              />
            </label>

            {outcome && !outcome.ok ? <p style={{ ...pStyle, color: "var(--red-ink)" }}>{outcome.text}</p> : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
              <button type="button" className="btn" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn" onClick={() => void run()} disabled={!canRun} style={tint(color)}>
                {busy ? "working…" : label}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </span>
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
// serves as the outline, so the direction (pause = caution, resume = go) stays
// legible without inventing a new button shape.
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
