import type { FrequencyCap, FrequencyCapInput } from "../../lib/api-client";

export const FREQUENCY_CAP_LABEL_MAX = 160;
export const FREQUENCY_CAP_MAX_SENDS = 1_000;
export const FREQUENCY_CAP_MAX_WINDOW_HOURS = 720;

export const FREQUENCY_CAP_CHANNELS = ["email", "sms", "push"] as const;
export type FrequencyCapChannel = (typeof FREQUENCY_CAP_CHANNELS)[number];

const FREQUENCY_CAP_CHANNEL_SET = new Set<string>(FREQUENCY_CAP_CHANNELS);
const RFC3339_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

function isRevisionTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    year >= 2000 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number.isFinite(Date.parse(value))
  );
}

export interface FrequencyCapDraft {
  label: string;
  maxSends: string;
  windowHours: string;
  active: boolean;
  channels: FrequencyCapChannel[];
}

export interface FrequencyCapDraftErrors {
  label?: string;
  maxSends?: string;
  windowHours?: string;
  channels?: string;
}

export const EMPTY_FREQUENCY_CAP_DRAFT: Readonly<FrequencyCapDraft> = {
  label: "",
  maxSends: "3",
  windowHours: "24",
  active: true,
  channels: ["email"],
};

/** Runtime boundary used before a server row reaches the renderer. */
export function isFrequencyCap(value: unknown): value is FrequencyCap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const label = candidate.label;
  const channels = candidate.channels;
  const validChannels =
    channels === undefined ||
    (Array.isArray(channels) &&
      channels.length <= FREQUENCY_CAP_CHANNELS.length &&
      new Set(channels).size === channels.length &&
      channels.every(
        (channel) =>
          typeof channel === "string" && FREQUENCY_CAP_CHANNEL_SET.has(channel),
      ));
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id.length <= 128 &&
    typeof label === "string" &&
    label === label.trim() &&
    label.length > 0 &&
    label.length <= FREQUENCY_CAP_LABEL_MAX &&
    typeof candidate.max_sends === "number" &&
    Number.isSafeInteger(candidate.max_sends) &&
    candidate.max_sends >= 1 &&
    candidate.max_sends <= FREQUENCY_CAP_MAX_SENDS &&
    typeof candidate.window_hours === "number" &&
    Number.isSafeInteger(candidate.window_hours) &&
    candidate.window_hours >= 1 &&
    candidate.window_hours <= FREQUENCY_CAP_MAX_WINDOW_HOURS &&
    typeof candidate.active === "boolean" &&
    isRevisionTimestamp(candidate.updated_at) &&
    validChannels
  );
}

export function validateFrequencyCapDraft(
  draft: FrequencyCapDraft,
): FrequencyCapDraftErrors {
  const errors: FrequencyCapDraftErrors = {};
  const label = draft.label.trim();
  if (!label) {
    errors.label = "Label is required.";
  } else if (label.length > FREQUENCY_CAP_LABEL_MAX) {
    errors.label = `Label must be ${FREQUENCY_CAP_LABEL_MAX} characters or fewer.`;
  }

  const maxSends = Number(draft.maxSends);
  if (
    draft.maxSends.trim() === "" ||
    !Number.isSafeInteger(maxSends) ||
    maxSends < 1 ||
    maxSends > FREQUENCY_CAP_MAX_SENDS
  ) {
    errors.maxSends = "Use a whole number from 1 to 1,000.";
  }

  const windowHours = Number(draft.windowHours);
  if (
    draft.windowHours.trim() === "" ||
    !Number.isSafeInteger(windowHours) ||
    windowHours < 1 ||
    windowHours > FREQUENCY_CAP_MAX_WINDOW_HOURS
  ) {
    errors.windowHours = "Use a whole number from 1 to 720.";
  }

  if (draft.channels.length === 0) {
    errors.channels = "Select at least one channel.";
  }
  return errors;
}

export function frequencyCapDraftInput(
  draft: FrequencyCapDraft,
): FrequencyCapInput {
  return {
    label: draft.label.trim(),
    max_sends: Number(draft.maxSends),
    window_hours: Number(draft.windowHours),
    active: draft.active,
    channels: [...draft.channels],
  };
}

export function frequencyCapDraftFromRow(cap: FrequencyCap): FrequencyCapDraft {
  const channels = cap.channels;
  return {
    label: cap.label,
    maxSends: String(cap.max_sends),
    windowHours: String(cap.window_hours),
    active: cap.active,
    // An empty array is a legacy global rule. Represent it as every supported
    // channel and omit `channels` on an unchanged update so its scope survives.
    channels:
      channels && channels.length > 0
        ? ([...channels] as FrequencyCapChannel[])
        : channels
          ? [...FREQUENCY_CAP_CHANNELS]
          : ["email"],
  };
}

export function sameFrequencyCapDraft(
  left: FrequencyCapDraft,
  right: FrequencyCapDraft,
): boolean {
  return (
    left.label === right.label &&
    left.maxSends === right.maxSends &&
    left.windowHours === right.windowHours &&
    left.active === right.active &&
    left.channels.length === right.channels.length &&
    left.channels.every((channel) => right.channels.includes(channel))
  );
}

export function frequencyCapChannelsChanged(
  cap: FrequencyCap,
  next: readonly FrequencyCapChannel[],
): boolean {
  if (cap.channels?.length === 0) {
    return !FREQUENCY_CAP_CHANNELS.every((channel) => next.includes(channel));
  }
  const current = cap.channels ?? ["email"];
  return (
    current.length !== next.length ||
    !current.every((channel) => next.includes(channel as FrequencyCapChannel))
  );
}

export function firstFrequencyCapDraftError(
  errors: FrequencyCapDraftErrors,
): string | null {
  return (
    errors.label ??
    errors.maxSends ??
    errors.windowHours ??
    errors.channels ??
    null
  );
}
