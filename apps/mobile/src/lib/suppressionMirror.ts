/**
 * lib/suppressionMirror.ts — the pure half of "pull my ESP's suppression list".
 *
 * POST /api/v1/suppressions/mirror/{provider} (admin, mounted in main.go's
 * ScopeAdmin group next to the X1 bulk routes) walks the provider's recent
 * suppression pages and upserts each row, deduped on
 * (tenant, source, source_event_id) — running it twice cannot double-import.
 *
 * THE 503 THAT IS NOT AN ERROR. A provider whose mirror credential is absent
 * answers 503 with `{not_configured: true, not_configured_reason}` — an
 * EXPECTED workspace state, not a fault (the handler writes it deliberately,
 * apps/api/internal/suppressions/mirror.go:124-155). Desktop's wrapper folds
 * that reply into the data channel (MirrorFromEspModal) and mobile keeps the
 * same rule: `interpretMirrorFailure` turns it into a typed outcome the sheet
 * renders as a setup pointer, never as a failure toast.
 *
 * Only providers with REAL mirror clients that read the tenant's own
 * provider-config credential belong in the picker — the same two desktop
 * offers. SES/Mailgun/Postmark source their credentials from server env, so
 * offering them here would mostly manufacture not-configured dead ends.
 *
 * Import-free of react-native so the node vitest environment covers every
 * branch, including the 503 fold.
 */

import { pathLabel } from "./direction";
import { num } from "./format";
import { WireShapeError } from "./wireShapeError";

export const MIRROR_PROVIDERS = [
  {
    value: "mailchimp",
    label: "Mailchimp",
    hint: "Pulls unsubscribed and cleaned members from the connected audience.",
  },
  {
    value: "sendgrid",
    label: "SendGrid",
    hint: "Pulls bounces, blocks, spam reports, and unsubscribes.",
  },
] as const;

export type MirrorProvider = (typeof MIRROR_PROVIDERS)[number]["value"];

export interface MirrorRunResult {
  provider: string;
  fetched: number;
  imported: number;
  skipped: number;
  errors: number;
}

export type MirrorOutcome =
  | { kind: "imported"; result: MirrorRunResult }
  | { kind: "not_configured"; reason: string };

/** Thrown instead of queueing: a compliance write never replays from a phone. */
export class MirrorOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super("Mirroring needs a connection and is never queued for later.");
    this.name = "MirrorOfflineError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * The setup pointer for an unconfigured provider. Both offered providers read
 * the tenant's own `config.api_key` mirror credential, so the pointer names
 * the exact field — the same sentence desktop shows.
 */
export function mirrorNotConfiguredCopy(
  provider: string,
  serverReason: string | undefined,
): string {
  const trimmed = (serverReason ?? "").trim();
  // The handler's generic internal sentence explains nothing an operator can
  // act on; replace it with the pointer, keep anything more specific.
  if (trimmed && trimmed !== "an internal error occurred") return trimmed;
  return (
    `The ${provider} mirror has no API key. In the desktop admin, open ` +
    `${pathLabel(["Deliverability", "Provider config"])}, pick ${provider}, ` +
    `and set the "ESP API key (mirror credential)" field to enable it.`
  );
}

/**
 * Fold a request failure into the data channel when it is the 503
 * not-configured reply; return null for every genuine failure.
 */
export function interpretMirrorFailure(
  status: number,
  payload: unknown,
  provider: string,
): MirrorOutcome | null {
  if (status !== 503 || !isRecord(payload)) return null;
  if (payload.not_configured !== true) return null;
  const reason =
    typeof payload.not_configured_reason === "string"
      ? payload.not_configured_reason
      : "";
  return {
    kind: "not_configured",
    reason: mirrorNotConfiguredCopy(provider, reason),
  };
}

/** Read the success body; a shape that is not the summary throws. */
export function parseMirrorResult(value: unknown, provider: string): MirrorRunResult {
  if (!isRecord(value)) {
    throw new WireShapeError(
      "mirror summary",
      "The mirror finished but its summary could not be read.",
    );
  }
  return {
    provider:
      typeof value.provider === "string" && value.provider
        ? value.provider
        : provider,
    fetched: count(value.fetched),
    imported: count(value.imported),
    skipped: count(value.skipped),
    errors: count(value.errors),
  };
}

/** The toast/summary sentence for a finished run. */
export function summarizeMirrorRun(result: MirrorRunResult): string {
  const parts = [
    `${num(result.imported)} imported`,
    `${num(result.skipped)} already present`,
  ];
  if (result.errors > 0) {
    parts.push(`${num(result.errors)} failed`);
  }
  return `Checked ${num(result.fetched)} provider rows — ${parts.join(", ")}.`;
}
