/**
 * lib/inboundEndpointAdmin.ts — the three endpoint-lifecycle verbs mobile did
 * not have: CREATE (with the shown-once signing secret), RENAME and DELETE.
 *
 * Everything here is copy and validation, kept out of the components so it is
 * testable in node and so the delete sentence has exactly one author.
 *
 * NAME BOUNDS ARE THE DESKTOP'S, NOT THE SERVER'S — and that distinction is
 * deliberate. The column is `name text NOT NULL DEFAULT ''`
 * (infra/migrations/0064_inbound_webhooks.sql:16) and neither Create nor
 * UpdateEndpoint validates it (apps/api/internal/inbound_webhooks/handlers.go
 * :178, :215), so the server would accept an empty name and a name longer than
 * any row can render. The caps below are the ones desktop's own inputs
 * enforce — 120 on create (pages/InboundWebhooks.tsx:1824) and 200 on rename
 * (components/webhooks/InboundEndpointEditDialog.tsx:160) — so a name typed on
 * the phone is a name the desktop dialogs would also accept. They are stated
 * to the operator as what they are: a label rule, not a server rejection.
 *
 * DELETE COPY IS THE SERVER'S OWN. Deletion is NOT a row disappearing: it is
 * the tombstone in migration 1793. Ingest is revoked immediately, every secret
 * column is overwritten with the destroyed sentinel (repo.go:407-433), and the
 * physical row survives until a retention pass finds no retained event and no
 * action intent left AND 24 hours have passed
 * (purge_deleted_inbound_webhook_endpoint). The confirm says all three parts,
 * because an operator deleting an endpoint to "clear the evidence" would
 * otherwise be told the opposite of the truth.
 */

/** Desktop's create-dialog cap (pages/InboundWebhooks.tsx:1824). */
export const INBOUND_ENDPOINT_CREATE_NAME_MAX = 120;
/** Desktop's rename-dialog cap (InboundEndpointEditDialog.tsx:160). */
export const INBOUND_ENDPOINT_RENAME_NAME_MAX = 200;

/**
 * Root of the endpoint LIST query key, mirrored from
 * hooks/useInboundWebhookOps (`ENDPOINTS_KEY`), which does not export it.
 * A drift of one segment here would make every create/rename/delete
 * invalidate nothing at all, so the mirror is guarded by a test rather than
 * trusted — see inboundEndpointAdmin.test.ts.
 */
export const INBOUND_ENDPOINTS_QUERY_ROOT = "inbound-webhooks";

export interface InboundEndpointNameCheck {
  /** What to send. Empty whenever `problem` is set. */
  value: string;
  /** Operator-facing sentence, or null when the name is sendable. */
  problem: string | null;
}

/**
 * C0/C1 controls plus the two Unicode line separators. A name is one line in a
 * list row; a pasted newline silently truncates it there and turns a rename
 * into "why is half my label missing".
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function checkInboundEndpointName(
  raw: string,
  max: number,
): InboundEndpointNameCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return {
      value: "",
      problem: "Enter a name so you can recognise this endpoint later.",
    };
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return {
      value: "",
      problem:
        "Remove the line breaks or control characters — a name is one line.",
    };
  }
  // Count code points, not UTF-16 units: an emoji-suffixed label is one
  // character to the person typing it and two to `.length`.
  if ([...value].length > max) {
    return {
      value: "",
      problem: `Keep the name to ${max} characters or fewer so it fits the row.`,
    };
  }
  return { value, problem: null };
}

/** What the operator calls this endpoint. The server allows an empty name. */
export function inboundEndpointLabel(endpoint: {
  name?: string | null;
  slug?: string | null;
}): string {
  const name = (endpoint.name ?? "").trim();
  if (name) return name;
  const slug = (endpoint.slug ?? "").trim();
  return slug || "this endpoint";
}

/** True when there is a new name worth sending. */
export function isInboundRenameDirty(current: string, next: string): boolean {
  const from = typeof current === "string" ? current.trim() : "";
  const to = typeof next === "string" ? next.trim() : "";
  return from !== to;
}

export interface InboundConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  confirmPhrase: string;
}

/**
 * The delete confirm, in the server's terms.
 *
 * Phrase-gated like the rotate on the same screen: this is the one verb here
 * that no other verb can undo — a disabled endpoint keeps its secret and its
 * URL, a deleted one shreds both.
 */
export function inboundEndpointDeleteConfirmCopy(endpoint: {
  name?: string | null;
  slug?: string | null;
}): InboundConfirmCopy {
  return {
    title: `Delete ${inboundEndpointLabel(endpoint)}?`,
    message:
      "Public ingest stops immediately and this endpoint leaves the list. Its signing secrets are shredded, so the URL can never be revived — a replacement gets a new URL and a new secret you must paste upstream. Retained events and action evidence are kept for governed retention and delay the physical purge. This cannot be undone; disable it instead if you only need it to stop.",
    confirmLabel: "Delete endpoint",
    confirmPhrase: "DELETE",
  };
}

export type InboundSecretKind = "create" | "rotate";

export interface InboundSecretCardCopy {
  title: string;
  description: string;
  secretLabel: string;
}

/**
 * The shown-once card's words, which differ by how the secret was minted.
 *
 * A CREATE has no predecessor, so the rotation grace window must not be
 * promised: nothing upstream is verifying yet, and the endpoint is useless
 * until this value is pasted somewhere. A ROTATE has one, and saying so is
 * what makes rotating from a phone safe.
 */
export function inboundSecretCardCopy(
  kind: InboundSecretKind,
  graceHours: number,
): InboundSecretCardCopy {
  if (kind === "create") {
    return {
      title: "Signing secret (shown once)",
      description:
        "Copy it now and paste it into the upstream system with the endpoint URL. The server returns this value exactly once and keeps only an encrypted copy — it cannot be retrieved later. If you lose it, rotate the endpoint for a new one.",
      secretLabel:
        "Inbound webhook signing secret. Shown once; save it before dismissing.",
    };
  }
  return {
    title: "New signing secret (shown once)",
    description: `Paste this into the upstream system's webhook settings. The previous secret keeps verifying for ${graceHours} hours, then stops.`,
    secretLabel: "Inbound webhook signing secret. Save it before dismissing.",
  };
}
