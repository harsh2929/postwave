/**
 * subscriberDraft — validation and the wire body for "add a subscriber from
 * a phone" (POST /api/v1/subscribers).
 *
 * WHY THIS CREATES AN *UNCONFIRMED* CONTACT, AND SAYS SO.
 *
 * The handler's `normalizeCreate` (apps/api/internal/subscribers/handlers.go
 * :931-991) has two completely different contracts depending on `status`:
 *
 *   status omitted → defaults to `unconfirmed`, and EMAIL IS THE ONLY
 *     REQUIRED FIELD.
 *
 *   status = "enabled" → the request must additionally carry a complete,
 *     defensible consent envelope: `consent_timestamp` (not in the future),
 *     `consent_source` ∈ {double_optin, single_optin}, `consent_channel`,
 *     `consent_legal_basis`, a non-empty `consent_evidence` (≤2048 chars), a
 *     non-empty `consent_reason` (≤500), a `country` jurisdiction, and a
 *     `consent_policy_version`. Every one of those is rejected with a 400
 *     when missing.
 *
 * That second contract is a compliance record, not a phone form — a
 * thumb-typed "evidence" string would be exactly the sort of unreviewed
 * attestation the envelope exists to prevent. So mobile creates the
 * `unconfirmed` shape only, and the sheet states plainly that the person is
 * not sendable until they confirm. Presenting a phone-created contact as
 * subscribed would be the dishonest version of this feature.
 *
 * AUTHORIZATION: POST /api/v1/subscribers is
 * `apikeys.RequireScope(apikeys.ScopeWriteSubscribers)` (handlers.go:159).
 * `write:subscribers` IS in `editorWriteScopes`
 * (apps/api/internal/apikeys/middleware.go:291), so owner|admin|editor may
 * create — a strictly wider set than the bulk verbs, which need admin.
 *
 * Import-free so every rule is unit-tested.
 */

import { limitRunes, runeLength, TAG_NAME_MAX_RUNES } from "@/lib/tagInput";

/**
 * Deliberately permissive: the server owns the authoritative rule
 * (emailidentity.Normalize) and a client regex that is stricter than the
 * server rejects addresses the platform accepts. This only catches the
 * shapes that are certainly wrong so the user is not made to wait for a
 * round trip to learn they typed no "@".
 */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 320) return false;
  if (/\s/.test(v)) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

export interface SubscriberDraft {
  email: string;
  firstName: string;
  lastName: string;
  tags: readonly string[];
}

export const EMPTY_SUBSCRIBER_DRAFT: SubscriberDraft = {
  email: "",
  firstName: "",
  lastName: "",
  tags: [],
};

export interface DraftValidation {
  canSubmit: boolean;
  /** Inline hint under the email field, or null when there is nothing to say. */
  emailHint: string | null;
}

export function validateSubscriberDraft(draft: SubscriberDraft): DraftValidation {
  const email = draft.email.trim();
  if (!email) return { canSubmit: false, emailHint: null };
  if (!looksLikeEmail(email)) {
    return {
      canSubmit: false,
      emailHint: "That doesn't look like an email address.",
    };
  }
  for (const tag of draft.tags) {
    if (runeLength(tag) > TAG_NAME_MAX_RUNES) {
      return {
        canSubmit: false,
        emailHint: null,
      };
    }
  }
  return { canSubmit: true, emailHint: null };
}

/**
 * Add a tag to the draft. Case-insensitively deduped and rune-limited, the
 * same rules the per-subscriber tag box applies — a tag created here goes
 * into the same workspace taxonomy.
 */
export function addDraftTag(
  draft: SubscriberDraft,
  raw: string,
): SubscriberDraft {
  const tag = limitRunes(raw.trim());
  if (!tag) return draft;
  const lower = tag.toLowerCase();
  if (draft.tags.some((t) => t.toLowerCase() === lower)) return draft;
  return { ...draft, tags: [...draft.tags, tag] };
}

export function removeDraftTag(
  draft: SubscriberDraft,
  tag: string,
): SubscriberDraft {
  return { ...draft, tags: draft.tags.filter((t) => t !== tag) };
}

/**
 * The request body.
 *
 * `status` is OMITTED rather than sent as "unconfirmed": the server defaults
 * it, and sending it explicitly would make this call silently break if the
 * default ever became something stricter. Every other field is omitted when
 * empty so the create path's Mailchimp/Klaviyo name-derivation still runs.
 */
export function subscriberCreateBody(
  draft: SubscriberDraft,
): Record<string, unknown> {
  const first = draft.firstName.trim();
  const last = draft.lastName.trim();
  return {
    email: draft.email.trim(),
    ...(first ? { first_name: first } : {}),
    ...(last ? { last_name: last } : {}),
    ...(draft.tags.length > 0 ? { tags: [...draft.tags] } : {}),
  };
}

/** What the sheet promises, and what the receipt repeats. Kept together so
 *  the two can never say different things about sendability. */
export const UNCONFIRMED_CREATE_NOTICE =
  "Added as Unconfirmed. They won't receive marketing email until they confirm — send them a confirmation from a signup form or the web admin.";

/**
 * Map the create failures that have a specific meaning onto a sentence the
 * operator can act on. Everything else falls through to the server's own
 * message, which is already written for humans.
 */
export function createSubscriberErrorMessage(
  status: number,
  code: string | undefined,
  fallback: string,
): string {
  if (code === "email_taken" || (status === 409 && code !== "erasure_blocked")) {
    return "That address already belongs to another profile. Search for it instead.";
  }
  if (code === "erasure_blocked") {
    return "That address was erased under a data-subject request. It can only be re-added from the web admin, with fresh consent.";
  }
  if (status === 403) {
    return "Your role can't add subscribers. Ask an admin, or an editor can do it.";
  }
  if (status === 402 || code === "limit_exceeded") {
    return "Your plan's contact limit is reached. Upgrade or remove contacts first.";
  }
  return fallback || "Couldn't add that subscriber.";
}
