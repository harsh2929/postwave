/**
 * social-capture-helpers — pure logic behind the Social capture
 * section on the Forms page (apps/api/internal/social_capture).
 * JSX-free for the node vitest suite.
 *
 * Wire notes (ROADMAP-WRAPPERS T3): list endpoints return {items}
 * envelopes; creates are 201 and admin-scoped. catalog and
 * validateRule responses are loosely typed (Record<string, unknown> —
 * the server emits nested literal maps), so everything here that
 * reads them is defensive. The machine-to-machine endpoints
 * (auto-reply events, tap-to-text consent, the public redirect) are
 * intentionally NOT part of the desktop surface.
 */

import type {
  SocialCaptureRule,
  SocialCaptureTapLink,
} from "../../lib/api-client";

/* ---------- trigger phrases --------------------------------------------- */

/** Comma/newline-separated editor text → trimmed, de-duped phrase
 *  list (case-insensitive de-dupe, first casing wins). */
export function parseTriggerPhrases(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const p = raw.trim();
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function triggerPhrasesText(phrases: ReadonlyArray<string> | undefined): string {
  return (phrases ?? []).join(", ");
}

/* ---------- catalog (loose map) ------------------------------------------ */

export interface CatalogNetwork {
  key: string;
  label: string;
  capabilities: string[];
}

/**
 * Normalise the loosely-typed catalog body. Accepts the shapes the
 * server is known to emit: `networks` as an array of objects
 * (`{key,label,capabilities}`) or as a map keyed by network. Anything
 * unrecognisable yields [] — the section renders an honest "catalog
 * shape unrecognised" line instead of guessing.
 */
export function catalogNetworks(
  catalog: Record<string, unknown> | null | undefined,
): CatalogNetwork[] {
  if (!catalog) return [];
  const raw = catalog["networks"];
  const out: CatalogNetwork[] = [];
  const push = (key: string, v: unknown): void => {
    const obj = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const label = typeof obj["label"] === "string" && obj["label"] ? obj["label"] : key;
    const capsRaw = obj["capabilities"];
    const capabilities = Array.isArray(capsRaw)
      ? capsRaw.filter((c): c is string => typeof c === "string")
      : [];
    if (key) out.push({ key, label, capabilities });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const key =
          typeof obj["key"] === "string"
            ? obj["key"]
            : typeof obj["network"] === "string"
              ? obj["network"]
              : "";
        push(key, obj);
      } else if (typeof item === "string") {
        push(item, {});
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
      push(key, v);
    }
  }
  return out;
}

/* ---------- validation verdict (loose map) -------------------------------- */

export interface RuleVerdict {
  /** null when the body didn't carry a recognisable valid flag. */
  valid: boolean | null;
  errors: string[];
  warnings: string[];
}

/** Read the validate endpoint's loose verdict body defensively. */
export function ruleVerdict(
  body: Record<string, unknown> | null | undefined,
): RuleVerdict {
  if (!body) return { valid: null, errors: [], warnings: [] };
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((e) =>
          typeof e === "string" ? e : e && typeof e === "object" ? JSON.stringify(e) : String(e),
        )
      : [];
  const valid = typeof body["valid"] === "boolean" ? (body["valid"] as boolean) : null;
  return {
    valid,
    errors: strings(body["errors"]),
    warnings: strings(body["warnings"]),
  };
}

/* ---------- rule editor ---------------------------------------------------- */

export interface RuleDraft {
  name: string;
  network: string;
  triggerPhrasesText: string;
  replyTemplate: string;
  targetListId: string;
}

export function newRuleDraft(): RuleDraft {
  return { name: "", network: "", triggerPhrasesText: "", replyTemplate: "", targetListId: "" };
}

export type RuleBuildResult =
  | { ok: true; rule: SocialCaptureRule }
  | { ok: false; field: "name" | "network" | "triggerPhrases"; error: string };

export function buildRuleInput(d: RuleDraft): RuleBuildResult {
  const name = d.name.trim();
  if (!name) return { ok: false, field: "name", error: "Name is required." };
  const network = d.network.trim();
  if (!network) {
    return { ok: false, field: "network", error: "Pick the network this rule listens on." };
  }
  const phrases = parseTriggerPhrases(d.triggerPhrasesText);
  if (phrases.length === 0) {
    return {
      ok: false,
      field: "triggerPhrases",
      error: "At least one trigger phrase is required (comma-separated).",
    };
  }
  const rule: SocialCaptureRule = {
    name,
    network,
    status: "active",
    trigger_phrases: phrases,
  };
  const reply = d.replyTemplate.trim();
  if (reply) rule.reply_template = reply;
  const listId = d.targetListId.trim();
  if (listId) rule.target_list_id = listId;
  return { ok: true, rule };
}

/* ---------- tap-to-text editor --------------------------------------------- */

export interface TapLinkDraft {
  name: string;
  destinationPhone: string;
  keyword: string;
  messageBody: string;
  consentText: string;
  successUrl: string;
}

export function newTapLinkDraft(): TapLinkDraft {
  return {
    name: "",
    destinationPhone: "",
    keyword: "",
    messageBody: "",
    consentText: "",
    successUrl: "",
  };
}

export type TapLinkBuildResult =
  | { ok: true; link: SocialCaptureTapLink }
  | {
      ok: false;
      field: "name" | "destinationPhone" | "keyword" | "messageBody" | "successUrl";
      error: string;
    };

export function buildTapLinkInput(d: TapLinkDraft): TapLinkBuildResult {
  const name = d.name.trim();
  if (!name) return { ok: false, field: "name", error: "Name is required." };
  const phone = d.destinationPhone.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return {
      ok: false,
      field: "destinationPhone",
      error: "Destination must be E.164 (e.g. +14155551234).",
    };
  }
  const keyword = d.keyword.trim();
  if (!keyword) {
    return { ok: false, field: "keyword", error: "Keyword is required (e.g. JOIN)." };
  }
  const messageBody = d.messageBody.trim();
  if (!messageBody) {
    return { ok: false, field: "messageBody", error: "Pre-filled message body is required." };
  }
  const successUrl = d.successUrl.trim();
  if (successUrl && !/^https?:\/\//i.test(successUrl)) {
    return {
      ok: false,
      field: "successUrl",
      error: "Success URL must start with http(s)://.",
    };
  }
  const link: SocialCaptureTapLink = {
    name,
    status: "active",
    destination_phone: phone,
    keyword,
    message_body: messageBody,
  };
  const consent = d.consentText.trim();
  if (consent) link.consent_text = consent;
  if (successUrl) link.success_url = successUrl;
  return { ok: true, link };
}

/* ---------- leads ----------------------------------------------------------- */

/** Best identity we can show for a captured lead — email, then phone,
 *  then the network-side user id. */
export function leadIdentity(lead: {
  subscriber_email?: string;
  phone_e164?: string;
  external_user_id?: string;
}): string {
  return (
    lead.subscriber_email?.trim() ||
    lead.phone_e164?.trim() ||
    (lead.external_user_id ? `user ${lead.external_user_id}` : "") ||
    "—"
  );
}

/** Count of answered questions in a lead's answers bag. */
export function answersCount(answers: Record<string, unknown> | undefined): number {
  return answers ? Object.keys(answers).length : 0;
}
