/**
 * lib/sendingKillSwitch.ts — the tenant-wide "stop sending email" control.
 *
 * ── WHY THIS BELONGS ON A PHONE MORE THAN ANYWHERE ─────────────────────────
 * `POST /api/v1/sending/controls/pause` (apps/api/internal/server/sending_forms_routes.go:58,
 * handler apps/api/internal/handlers/sending.go:180) stops email for the whole
 * workspace. It is the single most time-critical verb the product has — a campaign
 * going out with the wrong link, a compromised key, a provider incident — and it is
 * exactly the situation where nobody is at a desk. Mobile had no client for it: the
 * closest thing was a READ of /api/v1/settings/sending/status.
 *
 * That is finding MAP#74 in its purest form: the urgent verbs were the ones that
 * stayed on desktop.
 *
 * ── WHAT THE SERVER ACTUALLY PROMISES ──────────────────────────────────────
 * The control is a TENANT flag, not a queue drain. `Paused` gates future sends; it
 * makes no claim about a send already in flight at the provider. The copy here says
 * so, because "stopped" would be a promise the API does not make and the operator
 * would stop looking.
 *
 * Reason is OPTIONAL to the server (`pauseInput{Reason string}` with
 * AllowEmptyBody), and required by THIS client. A tenant-wide halt that survives
 * into the next person's shift with no note is an incident nobody can hand over, and
 * the response carries pause_reason/pause_changed_by precisely so it can be read
 * back.
 *
 * Import-free of react-native, so every rule is node-tested.
 */

/** `EmailSendingControl` as the server serialises it (tenantcontrols/email.go:22-27). */
export interface SendingControlWire {
  paused?: unknown;
  pause_reason?: unknown;
  pause_changed_at?: unknown;
  pause_changed_by?: unknown;
  source?: unknown;
}

export interface SendingControl {
  paused: boolean;
  reason: string;
  changedAt: string;
  changedBy: string;
  source: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseSendingControl(
  wire: SendingControlWire | null | undefined,
): SendingControl {
  return {
    // Anything that is not an explicit `true` is treated as NOT paused. A missing
    // or malformed field must never render as "sending is halted" — that would have
    // an operator stand down during an incident.
    paused: wire?.paused === true,
    reason: text(wire?.pause_reason),
    changedAt: text(wire?.pause_changed_at),
    changedBy: text(wire?.pause_changed_by),
    source: text(wire?.source),
  };
}

export const KILL_SWITCH_REASON_MAX = 280;

/** Whether a pause may be submitted. */
export function killSwitchReasonUsable(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= KILL_SWITCH_REASON_MAX;
}

/**
 * What the card says about the current state.
 *
 * The paused sentence deliberately does NOT say "sending stopped": the flag gates
 * future sends and says nothing about a batch already handed to the provider.
 */
export function sendingControlSummary(control: SendingControl): string {
  if (!control.paused) {
    return "Email sending is active for this workspace.";
  }
  const who = control.changedBy ? ` by ${control.changedBy}` : "";
  const why = control.reason ? ` — ${control.reason}` : "";
  return `New email sends are held for the whole workspace${who}${why}. Anything already handed to the provider may still deliver.`;
}

/** The confirmation an operator must read before halting a whole workspace. */
export function killSwitchConfirmCopy(paused: boolean): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  if (paused) {
    return {
      title: "Resume email sending?",
      body: "New sends across the whole workspace will start going out again, including anything queued while sending was held.",
      confirmLabel: "Resume sending",
    };
  }
  return {
    title: "Hold all email sending?",
    body: "This stops NEW email for the entire workspace, not just this campaign. Sends already handed to the provider may still deliver.",
    confirmLabel: "Hold all sending",
  };
}
