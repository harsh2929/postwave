/**
 * smsConversationMeta — pure validation and decoding for per-conversation
 * operator metadata: tags, internal notes, and the activity feed.
 *
 * ROUTES (apps/api/internal/sms/inbox_extras.go, all behind
 * `protectSMSInboxResponse` + `RequireExactTenantAdmin`, none release-held):
 *   GET    /api/v1/sms/conversations/{phone}/tags       :61
 *   POST   /api/v1/sms/conversations/{phone}/tags       :62  {tag, expectedAbsent:true}
 *   DELETE /api/v1/sms/conversations/{phone}/tags       :63  {tag, expectedCreatedAt}
 *   DELETE .../tags/{tag}                               :64  PERMANENTLY 410 —
 *          the path-carried tag was retired (tags are private text; URLs reach
 *          edge logs). The tag travels in the DELETE body.
 *   POST   /api/v1/sms/conversations/{phone}/notes      :60  {notes, expectedUpdatedAt}
 *   GET    /api/v1/sms/conversations/{phone}/activity   :65
 *
 * CONTRACT POINTS THE UI MUST HONOR:
 *  - Tag add requires `expectedAbsent: true` — an assertion that the tag was
 *    absent from the inventory the operator loaded. 409 `tag_state_conflict`
 *    or `tag_limit_reached` (100/conversation) must read as "refresh", not as
 *    a generic failure.
 *  - Tag remove is CAS'd on the tag's exact `createdAt` from the loaded list.
 *  - Notes are WRITE-ONLY: no read route returns the stored text (desktop
 *    renders the same caveat), and the write OVERWRITES, CAS'd on the
 *    conversation's lifecycle token (`expectedUpdatedAt`).
 *  - The activity feed is explicitly `historyComplete: false` — consent
 *    evidence plus current per-list subscription state, not an operator log.
 */
import { SmsContractError } from "./smsConversation";
import {
  wireBoolean,
  wireExactKeys,
  wireObject,
  wireOptionalTimestamp,
  wirePhone,
  wireString,
  wireTimestamp,
  wireUuid,
} from "./smsWirePrimitives";

export const SMS_TAG_MAX_CODE_POINTS = 64;
export const SMS_NOTES_MAX_CODE_POINTS = 4000;
const FORBIDDEN = /[\p{Cc}\p{Cf}]/u;

/** Mirror of the server's tag gate: 1..64 safe code points, no outer space. */
export function smsTagError(tag: string): string | null {
  if (tag.trim() !== tag || tag === "") {
    return "Tags need 1 to 64 characters without leading or trailing spaces.";
  }
  if (Array.from(tag).length > SMS_TAG_MAX_CODE_POINTS) {
    return "Tags are limited to 64 characters.";
  }
  if (FORBIDDEN.test(tag)) {
    return "Tags cannot contain control or invisible characters.";
  }
  return null;
}

/** Mirror of the server's notes gate: ≤ 4,000 safe code points, trimmed. */
export function smsNotesError(notes: string): string | null {
  if (notes.trim() !== notes) {
    return "Notes cannot start or end with whitespace.";
  }
  if (Array.from(notes).length > SMS_NOTES_MAX_CODE_POINTS) {
    return "Notes are limited to 4,000 characters.";
  }
  if (FORBIDDEN.test(notes)) {
    return "Notes cannot contain control or invisible characters.";
  }
  return null;
}

export interface SmsConversationTag {
  tag: string;
  createdAt: string;
}

export interface SmsConversationTagsPage {
  tenantId: string;
  phoneE164: string;
  tags: SmsConversationTag[];
  snapshotAt: string;
  truncated: boolean;
}

export function decodeSmsConversationTags(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsConversationTagsPage {
  const src = wireObject(raw, "tags response");
  wireExactKeys(
    src,
    ["tenantId", "phoneE164", "tags", "snapshotAt", "truncated"],
    "tags response",
  );
  const tenantId = wireUuid(src.tenantId, "tags response.tenantId");
  if (tenantId !== expected.tenantId) {
    throw new SmsContractError("tags response belongs to another tenant");
  }
  const phoneE164 = wirePhone(src.phoneE164, "tags response.phoneE164");
  if (phoneE164 !== expected.phoneE164) {
    throw new SmsContractError("tags response belongs to another phone");
  }
  if (!Array.isArray(src.tags) || src.tags.length > 100) {
    throw new SmsContractError(
      "tags response.tags must be an array of at most 100 rows",
    );
  }
  const seen = new Set<string>();
  const tags = src.tags.map((entry, index) => {
    const path = `tags response.tags[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(row, ["tag", "createdAt"], path);
    const tag = wireString(row.tag, `${path}.tag`, { max: 64 });
    if (smsTagError(tag)) {
      throw new SmsContractError(`${path}.tag violates the tag contract`);
    }
    if (seen.has(tag)) throw new SmsContractError(`${path} duplicates ${tag}`);
    seen.add(tag);
    return { tag, createdAt: wireTimestamp(row.createdAt, `${path}.createdAt`) };
  });
  return {
    tenantId,
    phoneE164,
    tags,
    snapshotAt: wireTimestamp(src.snapshotAt, "tags response.snapshotAt"),
    truncated: wireBoolean(src.truncated, "tags response.truncated"),
  };
}

export interface SmsTagMutationReceipt {
  tenantId: string;
  phoneE164: string;
  tag: string;
  createdAt: string;
  action: "add" | "remove";
}

export function decodeSmsTagMutationReceipt(
  raw: unknown,
  expected: {
    tenantId: string;
    phoneE164: string;
    tag: string;
    action: "add" | "remove";
  },
): SmsTagMutationReceipt {
  const src = wireObject(raw, "tag receipt");
  wireExactKeys(
    src,
    ["ok", "tenantId", "phoneE164", "tag", "createdAt", "action"],
    "tag receipt",
  );
  if (src.ok !== true) throw new SmsContractError("tag receipt is not ok");
  const tenantId = wireUuid(src.tenantId, "tag receipt.tenantId");
  const phoneE164 = wirePhone(src.phoneE164, "tag receipt.phoneE164");
  if (
    tenantId !== expected.tenantId ||
    phoneE164 !== expected.phoneE164 ||
    src.tag !== expected.tag ||
    src.action !== expected.action
  ) {
    throw new SmsContractError("tag receipt does not match the request");
  }
  return {
    tenantId,
    phoneE164,
    tag: expected.tag,
    createdAt: wireTimestamp(src.createdAt, "tag receipt.createdAt"),
    action: expected.action,
  };
}

export interface SmsNotesReceipt {
  tenantId: string;
  phoneE164: string;
  stateUpdatedAt: string;
}

export function decodeSmsNotesReceipt(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsNotesReceipt {
  const src = wireObject(raw, "notes receipt");
  wireExactKeys(
    src,
    [
      "ok",
      "tenantId",
      "phoneE164",
      "action",
      "snoozeUntil",
      "archivedAt",
      "assigneeUserId",
      "stateUpdatedAt",
    ],
    "notes receipt",
  );
  if (src.ok !== true || src.action !== "notes") {
    throw new SmsContractError("notes receipt is not a notes acknowledgment");
  }
  const tenantId = wireUuid(src.tenantId, "notes receipt.tenantId");
  const phoneE164 = wirePhone(src.phoneE164, "notes receipt.phoneE164");
  if (tenantId !== expected.tenantId || phoneE164 !== expected.phoneE164) {
    throw new SmsContractError("notes receipt does not match the request");
  }
  return {
    tenantId,
    phoneE164,
    stateUpdatedAt: wireTimestamp(
      src.stateUpdatedAt,
      "notes receipt.stateUpdatedAt",
    ),
  };
}

export type SmsActivityKind = "consent" | "subscription";

export interface SmsActivityEvent {
  kind: SmsActivityKind;
  at: string;
  title: string;
}

export interface SmsActivityFeed {
  tenantId: string;
  phoneE164: string;
  events: SmsActivityEvent[];
  snapshotAt: string;
  truncated: boolean;
  /** Always false by contract — the feed never claims complete history. */
  historyComplete: boolean;
}

export function decodeSmsActivityFeed(
  raw: unknown,
  expected: { tenantId: string; phoneE164: string },
): SmsActivityFeed {
  const src = wireObject(raw, "activity response");
  wireExactKeys(
    src,
    [
      "tenantId",
      "phoneE164",
      "events",
      "snapshotAt",
      "truncated",
      "sourcePlanes",
      "historyComplete",
    ],
    "activity response",
  );
  const tenantId = wireUuid(src.tenantId, "activity response.tenantId");
  const phoneE164 = wirePhone(src.phoneE164, "activity response.phoneE164");
  if (tenantId !== expected.tenantId || phoneE164 !== expected.phoneE164) {
    throw new SmsContractError("activity response does not match the request");
  }
  const snapshotAt = wireTimestamp(
    src.snapshotAt,
    "activity response.snapshotAt",
  );
  const snapshotTime = Date.parse(snapshotAt);
  if (!Array.isArray(src.events) || src.events.length > 200) {
    throw new SmsContractError(
      "activity response.events must be an array of at most 200 rows",
    );
  }
  const events = src.events.map((entry, index) => {
    const path = `activity response.events[${index}]`;
    const row = wireObject(entry, path);
    wireExactKeys(row, ["kind", "at", "title", "meta"], path);
    if (row.kind !== "consent" && row.kind !== "subscription") {
      throw new SmsContractError(`${path}.kind is unknown`);
    }
    const at = wireTimestamp(row.at, `${path}.at`);
    if (Date.parse(at) > snapshotTime) {
      throw new SmsContractError(`${path}.at is newer than the response cutoff`);
    }
    if (row.meta !== undefined) wireObject(row.meta, `${path}.meta`);
    return {
      kind: row.kind as SmsActivityKind,
      at,
      title: wireString(row.title, `${path}.title`, { max: 128 }),
    };
  });
  const historyComplete = wireBoolean(
    src.historyComplete,
    "activity response.historyComplete",
  );
  if (historyComplete) {
    // The handler hard-codes false; a true here is a contract change this
    // screen must not silently absorb (it would justify stronger copy).
    throw new SmsContractError(
      "activity response claims complete history, which the contract forbids",
    );
  }
  return {
    tenantId,
    phoneE164,
    events,
    snapshotAt,
    truncated: wireBoolean(src.truncated, "activity response.truncated"),
    historyComplete,
  };
}
