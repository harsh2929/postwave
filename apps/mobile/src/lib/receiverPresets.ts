/**
 * lib/receiverPresets.ts — the receiver preset gallery's data and its
 * field-mapping rules, kept out of the component so node vitest can reach them.
 *
 * WHAT THIS IS. Desktop's create flow opens from a gallery of named receivers
 * (apps/desktop/src/components/webhooks/receiver-presets.ts +
 * ReceiverPresetDialog.tsx): pick "Zapier" and the form opens with a Zapier
 * URL hint, a useful description and a sensible default event selection
 * already filled in. Mobile's create form offered none of that — every field
 * was typed from scratch, including the two topics every desktop preset
 * pre-selects.
 *
 * WHAT A PRESET IS NOT. It is not a create. Nothing here issues a request:
 * applying a preset only rewrites the draft the operator is looking at, and
 * they still press Create (and can still change every field first). The
 * desktop dialog behaves the same way, and it matters more on a phone, where
 * a preset chip sits a thumb's width from the submit button.
 *
 * THREE RULES THE MAPPING ENFORCES, because "fill the form" is where a
 * convenience turns into data loss:
 *
 *  1. A PRESET NEVER SUPPLIES A URL. `urlPlaceholder` is a hint, not a value —
 *     "https://hooks.zapier.com/hooks/catch/…" is not an endpoint, and a
 *     preset that wrote it into the field would create a webhook that posts
 *     into the void. Applying a preset therefore leaves a URL the operator has
 *     already typed exactly as it was.
 *  2. A DESCRIPTION THE OPERATOR TYPED SURVIVES. The preset description only
 *     fills an empty field, or replaces another preset's boilerplate. Losing
 *     a typed label to a mis-tap is the kind of small theft that stops people
 *     using a gallery at all.
 *  3. TOPICS ARE FILTERED THROUGH THE SERVER'S OWN CATALOG. The form already
 *     asks GET /outbound-webhooks/playground/events for `AllowedEvents`
 *     (lib/outboundWebhookForm), so a preset topic this deployment does not
 *     offer is dropped and NAMED rather than sent for the server to reject —
 *     the same boundary desktop draws in `canonicalPresetEvents`. If that
 *     leaves nothing at all, the operator's existing selection is kept: an
 *     empty chip row is worse than a stale one. And because desktop's dialog
 *     opens EMPTY from its gallery while this chip row sits inside a live
 *     form, an apply that clears topics the operator had already ticked SAYS
 *     SO (`replacedEvents`) instead of letting them notice at Create.
 *
 * Node-run: no react-native / expo imports.
 */

import { forwardArrow } from "./direction";

export interface ReceiverPreset {
  /** Both the identity and the chip's visible label. */
  name: string;
  /** The URL field's placeholder while this preset is applied. Never a value. */
  urlPlaceholder: string;
  /** Desktop's default topic selection, BEFORE the server catalog filters it. */
  defaultEvents: readonly string[];
  /** Desktop's setup sentence, carried verbatim so both clients say one thing. */
  helpText: string;
  /** Pre-filled description so the new subscription is named usefully. */
  description: string;
}

/**
 * Carried verbatim from apps/desktop/src/components/webhooks/receiver-presets.ts
 * — an array rather than desktop's Record because the chip row has an order and
 * a Record's key order is not a contract. "Your own server" stays last: it is
 * the fallback, not a suggestion.
 */
export const RECEIVER_PRESETS: readonly ReceiverPreset[] = [
  {
    name: "Zapier",
    urlPlaceholder: "https://hooks.zapier.com/hooks/catch/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      "Paste the Catch Hook URL from your Zap. We'll POST signed events to it whenever something happens in your workspace.",
    description: "Zapier — created via gallery",
  },
  {
    name: "Make (Integromat)",
    urlPlaceholder: "https://hook.make.com/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText: "Use the URL from your Custom Webhook module in Make.",
    description: "Make — created via gallery",
  },
  {
    name: "n8n",
    urlPlaceholder: "https://n8n.example.com/webhook/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText: "Use the production URL from your Webhook trigger node in n8n.",
    description: "n8n — created via gallery",
  },
  {
    name: "Discord",
    urlPlaceholder: "https://discord.com/api/webhooks/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    // A GETTER rather than a literal, for two reasons that both matter.
    // `forwardArrow()` reads the layout direction `useAppBootstrap` publishes
    // into lib/direction, and THIS TABLE IS BUILT AT IMPORT TIME — long before
    // that call — so a literal `forwardArrow()` here would freeze LTR forever.
    // Evaluating on access (the gallery reads helpText in render) is what
    // makes the arrow actually flip. The arrow stays an arrow rather than
    // becoming `pathLabel`'s chevron because this sentence is carried verbatim
    // from desktop and receiverPresets.test.ts compares it to that source.
    get helpText(): string {
      const to = forwardArrow();
      return `In your Discord server: Channel settings ${to} Integrations ${to} Webhooks ${to} New Webhook, then copy the Webhook URL. Moosewave POSTs signed JSON; use a relay (Zapier/n8n) if you want Discord-native embeds.`;
    },
    description: "Discord — created via gallery",
  },
  {
    name: "Microsoft Teams",
    urlPlaceholder: "https://prod-….logic.azure.com/workflows/…",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    /** A getter for the same reason Discord's is — see the note there. */
    get helpText(): string {
      const to = forwardArrow();
      return `In Teams: channel ${to} Workflows ${to} "Post to a channel when a webhook request is received", then copy the request URL. (Legacy Office 365 connector URLs ending in webhook.office.com also work until Microsoft retires them.)`;
    },
    description: "Microsoft Teams — created via gallery",
  },
  {
    name: "Your own server",
    urlPlaceholder: "https://your-domain.com/webhooks/postwave",
    defaultEvents: ["campaign.sent", "subscriber.added"],
    helpText:
      "Any HTTPS endpoint works. We sign every request with HMAC-SHA256 — see Show verification snippet for receiver code.",
    description: "Custom receiver",
  },
];

/**
 * The signing convention this form commits to, stated rather than discovered.
 *
 * Desktop's dialog offers a signing-algorithm select (hmac_sha256 / ecdsa_p256
 * / ed25519) and warns that the choice is permanent. Mobile's create body
 * (api/settings.ts `OutboundWebhookCreateInput`) carries url/description/events
 * and no `algorithm`, and an omitted algorithm defaults to hmac_sha256 in
 * outbound_webhooks.Store.Create — so every endpoint created from this screen
 * is HMAC, permanently, whichever receiver was picked. That is worth one
 * sentence in the form rather than a surprise at verification time.
 */
export const RECEIVER_PRESET_SIGNING_NOTE =
  "Whichever receiver you pick, deliveries from this form are signed with HMAC-SHA256 and the signing secret is shown once, straight after Create. The algorithm can't be changed later — pick another scheme on the web app if you need one.";

/** Look a preset up by its name (its identity). */
export function receiverPresetByName(
  name: string | null | undefined,
): ReceiverPreset | null {
  if (!name) return null;
  return RECEIVER_PRESETS.find((preset) => preset.name === name) ?? null;
}

/** The draft slice a preset can touch. */
export interface ReceiverPresetDraft {
  url: string;
  description: string;
  events: string[];
}

export interface ReceiverPresetApplication {
  draft: ReceiverPresetDraft;
  /** Preset topics this deployment's catalog does not offer, so unselected. */
  dropped: string[];
  /** True when a description the operator typed was kept, not overwritten. */
  keptDescription: boolean;
  /**
   * Topics that WERE selected before this apply and are not selected after it.
   *
   * Replacing the selection is what a template is for, so this does not block
   * anything — but on desktop the dialog opens EMPTY from the gallery, while
   * here the chips sit inside a live form, so an apply can quietly undo a
   * hand-picked set. Naming it is the same courtesy rule 2 gives a typed
   * description; the difference is that chips are re-tappable, so this is a
   * sentence rather than a veto.
   */
  replacedEvents: string[];
}

/**
 * Drop preset topics the server would reject instead of sending them.
 * Order and de-duplication follow the preset, not the catalog.
 */
export function canonicalPresetEvents(
  events: readonly string[],
  catalog: readonly string[],
): string[] {
  const allowed = new Set(catalog);
  const out: string[] = [];
  for (const event of events) {
    if (!allowed.has(event)) continue;
    if (out.includes(event)) continue;
    out.push(event);
  }
  return out;
}

/** True when this text is boilerplate a preset wrote, not something typed. */
function isPresetDescription(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return RECEIVER_PRESETS.some((preset) => preset.description === trimmed);
}

/**
 * Fill the create draft from a preset. Pure: the caller decides what to do
 * with the result, and nothing is sent.
 */
export function applyReceiverPreset(
  current: ReceiverPresetDraft,
  preset: ReceiverPreset,
  catalog: readonly string[],
): ReceiverPresetApplication {
  const keptDescription = !isPresetDescription(current.description);
  const canonical = canonicalPresetEvents(preset.defaultEvents, catalog);
  const allowed = new Set(catalog);
  const dropped: string[] = [];
  for (const event of preset.defaultEvents) {
    if (allowed.has(event)) continue;
    if (dropped.includes(event)) continue;
    dropped.push(event);
  }
  // Rule 3: an empty canonical list keeps what was already picked.
  const events = canonical.length > 0 ? canonical : [...current.events];
  const kept = new Set(events);
  const replacedEvents: string[] = [];
  for (const event of current.events) {
    if (kept.has(event)) continue;
    if (replacedEvents.includes(event)) continue;
    replacedEvents.push(event);
  }
  return {
    draft: {
      // Rule 1: the destination is the operator's, never the preset's.
      url: current.url,
      description: keptDescription ? current.description : preset.description,
      events,
    },
    dropped,
    keptDescription,
    replacedEvents,
  };
}

/** "a", "a and b", "a, b and c" — the topic list reads as a sentence. */
function joinTopics(topics: readonly string[]): string {
  if (topics.length < 2) return topics.join("");
  const last = topics[topics.length - 1] ?? "";
  return `${topics.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * What the operator is told about what the preset just did — only the parts
 * that differ from "it filled the fields", which they can see for themselves.
 */
export function receiverPresetNotes(
  application: ReceiverPresetApplication,
): string[] {
  const notes: string[] = [];
  if (application.keptDescription) {
    notes.push(
      "Kept the description you had already written — a template only fills an empty one.",
    );
  }
  if (application.dropped.length > 0) {
    notes.push(
      `This workspace doesn't offer ${joinTopics(application.dropped)}, so ${
        application.dropped.length === 1 ? "it was" : "they were"
      } left unselected.`,
    );
  }
  if (application.replacedEvents.length > 0) {
    notes.push(
      `Replaced your event selection — ${joinTopics(
        application.replacedEvents,
      )} ${
        application.replacedEvents.length === 1 ? "is" : "are"
      } no longer selected. Tap the chips below to put ${
        application.replacedEvents.length === 1 ? "it" : "them"
      } back.`,
    );
  }
  return notes;
}

export interface ReceiverPresetGalleryAccess {
  enabled: boolean;
  /** Why the templates are withheld — a sentence, never implied by absence. */
  reason?: string;
}

/**
 * Who may use the gallery. POST /api/v1/outbound-webhooks is
 * session_minimum_role "admin" with an "admin" API-key scope
 * (routeauth/manifest.json), and `canAccessMinimumRole` refuses every
 * non-viewer minimum in api_key mode — so the templates are withheld with the
 * rule named, rather than offered and then 403'd on Create.
 */
export function receiverPresetGalleryAccess(input: {
  /** canAccessMinimumRole("admin", gate.effectiveRole, mode). */
  hasAdminRole: boolean;
  apiKeyMode: boolean;
}): ReceiverPresetGalleryAccess {
  if (input.apiKeyMode) {
    return {
      enabled: false,
      reason:
        "This session is signed in with an API key, which can read webhooks but not create them.",
    };
  }
  if (!input.hasAdminRole) {
    return {
      enabled: false,
      reason:
        "Creating an outbound webhook needs an owner or admin role, so these receiver templates aren't offered.",
    };
  }
  return { enabled: true };
}
