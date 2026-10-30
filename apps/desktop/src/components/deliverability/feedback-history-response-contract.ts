import type {
  BounceEvent,
  ComplaintEvent,
  FeedbackHistory,
} from "../../lib/api/feedback";

const MAX_EVENTS_PER_KIND = 200;
const MAX_PROVIDER_LENGTH = 96;
const MAX_MESSAGE_ID_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum);
}

function safeId(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function validTime(value: unknown): value is string {
  return (
    boundedString(value, 64) &&
    value.length > 0 &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function bounceEvent(value: unknown): BounceEvent | null {
  if (!isRecord(value)) return null;
  const messageID = value.esp_message_id;
  if (
    !safeId(value.id) ||
    !["hard", "soft", "transient"].includes(String(value.bounce_type)) ||
    !boundedString(value.esp, MAX_PROVIDER_LENGTH) ||
    !optionalBoundedString(messageID, MAX_MESSAGE_ID_LENGTH) ||
    !validTime(value.received_at)
  ) {
    return null;
  }
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    bounce_type: value.bounce_type as BounceEvent["bounce_type"],
    esp: value.esp,
    ...(typeof messageID === "string" ? { esp_message_id: messageID } : {}),
    received_at: value.received_at,
  };
}

function complaintEvent(value: unknown): ComplaintEvent | null {
  if (!isRecord(value)) return null;
  const provider = value.esp;
  const messageID = value.esp_message_id;
  if (
    !safeId(value.id) ||
    !["abuse", "fbl", "spam"].includes(String(value.complaint_type)) ||
    !optionalBoundedString(provider, MAX_PROVIDER_LENGTH) ||
    !optionalBoundedString(messageID, MAX_MESSAGE_ID_LENGTH) ||
    !validTime(value.received_at)
  ) {
    return null;
  }
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    complaint_type: value.complaint_type as ComplaintEvent["complaint_type"],
    ...(typeof provider === "string" ? { esp: provider } : {}),
    ...(typeof messageID === "string" ? { esp_message_id: messageID } : {}),
    received_at: value.received_at,
  };
}

/**
 * Strictly contains the admin-only recipient response. Raw provider payloads,
 * tenant identifiers, and unknown fields are deliberately discarded before
 * the value reaches React state.
 */
export function parseFeedbackHistory(value: unknown): FeedbackHistory | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.bounces) ||
    !Array.isArray(value.complaints) ||
    value.bounces.length > MAX_EVENTS_PER_KIND ||
    value.complaints.length > MAX_EVENTS_PER_KIND
  ) {
    return null;
  }
  const bounces = value.bounces.map(bounceEvent);
  const complaints = value.complaints.map(complaintEvent);
  if (bounces.includes(null) || complaints.includes(null)) return null;
  return {
    bounces: bounces as BounceEvent[],
    complaints: complaints as ComplaintEvent[],
  };
}
