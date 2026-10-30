// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the preferences/topics endpoints. Mirrors the
// forms-api / abtests-api pattern: real fetch by default; mocks are opt-in
// via NEXT_PUBLIC_USE_MOCKS=1.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import { isSafePublicHttpsAssetURL } from "./preference-branding-security";

export type TopicId = string;

export interface Topic {
  id: TopicId;
  tenantId: string;
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Explicit opt-in/opt-out toggle counts (SETA-038); admin ListTopics
      only. Counts active toggles, not full reach (default-fallback
      subscribers have no row). */
  optedInCount?: number;
  optedOutCount?: number;
}

export interface CreateTopicInput {
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder: number;
}

export interface UpdateTopicInput {
  slug?: string;
  name?: string;
  description?: string;
  defaultOptIn?: boolean;
  displayOrder?: number;
}

export interface SubscriberTopicView {
  topic: Topic;
  optedIn: boolean;
}

/** Subscriber-safe topic projection. Tenant identity and internal audit
 * timestamps are intentionally absent from the public token surface. */
export interface PublicPreferenceTopic {
  id: TopicId;
  slug: string;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  displayOrder: number;
}

export interface PublicSubscriberTopicView {
  topic: PublicPreferenceTopic;
  optedIn: boolean;
}

export interface TopicOptIn {
  topicId: TopicId;
  optedIn: boolean;
}

export interface PreferenceLookupResponse {
  email: string;
  expiresAt: string;
  topics: PublicSubscriberTopicView[];
  frequencyPreference: FrequencyChoice;
  pausedUntil?: string;
  /** SUB-043 — acknowledgement of the subscriber's recorded GPC signal. */
  gpc: boolean;
  customization: PublicPreferenceCustomization;
}

export interface PublicPreferenceCustomization {
  logo_url: string;
  primary_color: string;
  footer_text: string;
  show_postwave_badge: boolean;
}

const PUBLIC_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ADMIN_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PUBLIC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/u;
const PUBLIC_UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const PUBLIC_UNSAFE_MULTILINE =
  /[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export class PreferencesContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreferencesContractError";
  }
}

function publicRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function publicSafeText(
  value: unknown,
  maxScalars: number,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    [...value].length <= maxScalars &&
    new TextEncoder().encode(value).length <= maxBytes &&
    !PUBLIC_UNSAFE_TEXT.test(value)
  );
}

function publicTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = PUBLIC_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = Date.parse(value);
  if (
    year < 2000 ||
    year >= 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    Number(match[9] ?? 0) > 14 ||
    (Number(match[9] ?? 0) === 14 && Number(match[10] ?? 0) !== 0) ||
    Number(match[10] ?? 0) > 59 ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    return null;
  }
  return parsed;
}

function publicLogo(value: unknown): value is string {
  return typeof value === "string" && isSafePublicHttpsAssetURL(value);
}

function decodePublicCustomization(
  value: unknown,
): PublicPreferenceCustomization {
  if (
    !publicRecord(value) ||
    !publicExactKeys(value, [
      "logo_url",
      "primary_color",
      "footer_text",
      "show_postwave_badge",
    ]) ||
    !publicLogo(value.logo_url) ||
    typeof value.primary_color !== "string" ||
    !/^#[0-9A-Fa-f]{6}$/u.test(value.primary_color) ||
    typeof value.footer_text !== "string" ||
    [...value.footer_text].length > 4_096 ||
    new TextEncoder().encode(value.footer_text).length > 4_096 ||
    PUBLIC_UNSAFE_MULTILINE.test(value.footer_text) ||
    typeof value.show_postwave_badge !== "boolean"
  ) {
    throw new Error("Invalid public preference customization response");
  }
  return value as unknown as PublicPreferenceCustomization;
}

function decodePublicTopic(value: unknown): PublicPreferenceTopic {
  if (
    !publicRecord(value) ||
    !publicExactKeys(
      value,
      ["id", "slug", "name", "defaultOptIn", "displayOrder"],
      ["description"],
    ) ||
    typeof value.id !== "string" ||
    !PUBLIC_UUID.test(value.id) ||
    !publicSafeText(value.slug, 128, 512) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug) ||
    !publicSafeText(value.name, 256, 1_024) ||
    (value.description !== undefined &&
      !publicSafeText(value.description, 2_048, 8_192, true)) ||
    typeof value.defaultOptIn !== "boolean" ||
    !Number.isSafeInteger(value.displayOrder) ||
    Number(value.displayOrder) < -1_000_000 ||
    Number(value.displayOrder) > 1_000_000
  ) {
    throw new Error("Invalid public preference topic response");
  }
  return value as unknown as PublicPreferenceTopic;
}

function normalizeSubscriberEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    new TextEncoder().encode(normalized).byteLength > 1_280 ||
    !ADMIN_EMAIL.test(normalized) ||
    PUBLIC_UNSAFE_TEXT.test(normalized)
  ) {
    throw new PreferencesContractError(
      "Subscriber preferences require a valid email address.",
    );
  }
  return normalized;
}

function decodeSubscriberTopicViews(value: unknown): SubscriberTopicView[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new PreferencesContractError(
      "Subscriber topic response must be a bounded array.",
    );
  }
  const rows: SubscriberTopicView[] = [];
  const ids = new Set<string>();
  let tenantId: string | null = null;
  let previousOrder = Number.NEGATIVE_INFINITY;
  let previousSlug = "";
  for (const [index, candidate] of value.entries()) {
    if (
      !publicRecord(candidate) ||
      !publicExactKeys(candidate, ["topic", "optedIn"]) ||
      typeof candidate.optedIn !== "boolean" ||
      !publicRecord(candidate.topic) ||
      !publicExactKeys(
        candidate.topic,
        [
          "id",
          "tenantId",
          "slug",
          "name",
          "defaultOptIn",
          "displayOrder",
          "createdAt",
          "updatedAt",
        ],
        ["description"],
      )
    ) {
      throw new PreferencesContractError(
        `Subscriber topic row ${index} has an invalid shape.`,
      );
    }
    const topic = candidate.topic;
    if (
      typeof topic.id !== "string" ||
      !PUBLIC_UUID.test(topic.id) ||
      typeof topic.tenantId !== "string" ||
      !PUBLIC_UUID.test(topic.tenantId) ||
      !publicSafeText(topic.slug, 64, 64) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(topic.slug) ||
      !publicSafeText(topic.name, 256, 1_024) ||
      (topic.description !== undefined &&
        !publicSafeText(topic.description, 2_048, 8_192, true)) ||
      typeof topic.defaultOptIn !== "boolean" ||
      !Number.isSafeInteger(topic.displayOrder) ||
      Number(topic.displayOrder) < -1_000_000 ||
      Number(topic.displayOrder) > 1_000_000 ||
      publicTime(topic.createdAt) === null ||
      publicTime(topic.updatedAt) === null ||
      ids.has(topic.id) ||
      (tenantId !== null && topic.tenantId !== tenantId) ||
      Number(topic.displayOrder) < previousOrder ||
      (Number(topic.displayOrder) === previousOrder &&
        previousSlug !== "" &&
        topic.slug <= previousSlug)
    ) {
      throw new PreferencesContractError(
        `Subscriber topic row ${index} violates the topic contract.`,
      );
    }
    ids.add(topic.id);
    tenantId ??= topic.tenantId;
    previousOrder = Number(topic.displayOrder);
    previousSlug = topic.slug;
    rows.push({
      topic: topic as unknown as Topic,
      optedIn: candidate.optedIn,
    });
  }
  return rows;
}

function normalizeTopicOptIns(items: TopicOptIn[]): TopicOptIn[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > 1_000) {
    throw new PreferencesContractError(
      "Select between one and 1,000 subscriber topics.",
    );
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.topicId !== "string" ||
      !PUBLIC_UUID.test(item.topicId) ||
      typeof item.optedIn !== "boolean" ||
      seen.has(item.topicId)
    ) {
      throw new PreferencesContractError(
        `Subscriber topic selection ${index} is invalid or duplicated.`,
      );
    }
    seen.add(item.topicId);
    return { topicId: item.topicId, optedIn: item.optedIn };
  });
}

function decodeMutationAck(value: unknown): { ok: true } {
  if (
    !publicRecord(value) ||
    !publicExactKeys(value, ["ok"]) ||
    value.ok !== true
  ) {
    throw new PreferencesContractError(
      "Subscriber topic update was not acknowledged.",
    );
  }
  return { ok: true };
}

export function decodePublicPreferenceLookup(
  value: unknown,
): PreferenceLookupResponse {
  if (
    !publicRecord(value) ||
    !publicExactKeys(
      value,
      [
        "email",
        "expiresAt",
        "topics",
        "frequencyPreference",
        "gpc",
        "customization",
      ],
      ["pausedUntil"],
    ) ||
    !publicSafeText(value.email, 320, 1_280) ||
    !value.email.includes("@") ||
    publicTime(value.expiresAt) === null ||
    !Array.isArray(value.topics) ||
    value.topics.length > 1_000 ||
    !["default", "weekly", "monthly", "paused"].includes(
      String(value.frequencyPreference),
    ) ||
    (value.pausedUntil !== undefined &&
      publicTime(value.pausedUntil) === null) ||
    typeof value.gpc !== "boolean"
  ) {
    throw new Error("Invalid public preference response");
  }
  const topics: PublicSubscriberTopicView[] = [];
  const ids = new Set<string>();
  let previousOrder = Number.NEGATIVE_INFINITY;
  let previousSlug = "";
  for (const candidate of value.topics) {
    if (
      !publicRecord(candidate) ||
      !publicExactKeys(candidate, ["topic", "optedIn"]) ||
      typeof candidate.optedIn !== "boolean"
    ) {
      throw new Error("Invalid public preference topic selection");
    }
    const topic = decodePublicTopic(candidate.topic);
    if (
      ids.has(topic.id) ||
      topic.displayOrder < previousOrder ||
      (topic.displayOrder === previousOrder &&
        previousSlug !== "" &&
        topic.slug <= previousSlug)
    ) {
      throw new Error("Invalid public preference topic inventory");
    }
    ids.add(topic.id);
    previousOrder = topic.displayOrder;
    previousSlug = topic.slug;
    topics.push({ topic, optedIn: candidate.optedIn });
  }
  return {
    email: value.email,
    expiresAt: value.expiresAt as string,
    topics,
    frequencyPreference: value.frequencyPreference as FrequencyChoice,
    ...(typeof value.pausedUntil === "string"
      ? { pausedUntil: value.pausedUntil }
      : {}),
    gpc: value.gpc,
    customization: decodePublicCustomization(value.customization),
  };
}

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./preferences-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listTopics(): Promise<Topic[]> {
  return withMockFallback(
    () => api.get<Topic[]>("/api/v1/topics"),
    async () => (await loadMocks()).mockListTopics(),
  );
}

export function createTopic(input: CreateTopicInput): Promise<Topic> {
  return withMockFallback(
    () => api.post<Topic>("/api/v1/topics", input),
    async () => (await loadMocks()).mockCreateTopic(input),
  );
}

export function updateTopic(
  id: TopicId,
  patch: UpdateTopicInput,
): Promise<Topic> {
  return withMockFallback(
    () => api.patch<Topic>(`/api/v1/topics/${encodeURIComponent(id)}`, patch),
    async () => (await loadMocks()).mockUpdateTopic(id, patch),
  );
}

export function deleteTopic(id: TopicId): Promise<{ ok: true }> {
  return withMockFallback(
    () => api.delete<{ ok: true }>(`/api/v1/topics/${encodeURIComponent(id)}`),
    async () => {
      (await loadMocks()).mockDeleteTopic(id);
      return { ok: true as const };
    },
  );
}

export function listSubscriberTopics(
  email: string,
  options: { signal?: AbortSignal } = {},
): Promise<SubscriberTopicView[]> {
  return withMockFallback(
    async () => {
      const normalizedEmail = normalizeSubscriberEmail(email);
      const response = await api.get<unknown>(
        `/api/v1/subscribers/${encodeURIComponent(normalizedEmail)}/topics`,
        {
          signal: options.signal,
          requireOnline: true,
          maxAttempts: 1,
          cache: "no-store",
        },
      );
      return decodeSubscriberTopicViews(response);
    },
    async () => (await loadMocks()).mockListSubscriberTopics(email),
  );
}

export function setSubscriberTopics(
  email: string,
  topics: TopicOptIn[],
  options: { signal?: AbortSignal } = {},
): Promise<{ ok: true }> {
  return withMockFallback(
    async () => {
      const normalizedEmail = normalizeSubscriberEmail(email);
      const normalizedTopics = normalizeTopicOptIns(topics);
      return decodeMutationAck(
        await api.put<unknown>(
          `/api/v1/subscribers/${encodeURIComponent(normalizedEmail)}/topics`,
          { topics: normalizedTopics },
          {
            signal: options.signal,
            requireOnline: true,
            maxAttempts: 1,
          },
        ),
      );
    },
    async () => {
      (await loadMocks()).mockSetSubscriberTopics(email, topics);
      return { ok: true as const };
    },
  );
}

/** Public token-gated lookup used by the hosted preference page. */
export function publicLookup(token: string): Promise<PreferenceLookupResponse> {
  return withMockFallback(
    () =>
      api
        .get<unknown>(`/api/public/preferences/${encodeURIComponent(token)}`, {
          credentials: "omit",
        })
        .then(decodePublicPreferenceLookup),
    async () => (await loadMocks()).mockPublicLookup(token),
  );
}

export function publicUpdate(
  token: string,
  topics: TopicOptIn[],
): Promise<{ ok: true }> {
  return withMockFallback(
    () =>
      api.post<{ ok: true }>(
        `/api/public/preferences/${encodeURIComponent(token)}`,
        { topics },
        { credentials: "omit" },
      ),
    async () => {
      (await loadMocks()).mockPublicUpdate(token, topics);
      return { ok: true as const };
    },
  );
}

/** Human-confirmed global opt-out. Uses the same suppression path as RFC 8058
 * but is invoked by an explicit button on the hosted preference page. */
export function publicUnsubscribeAll(
  token: string,
): Promise<{ unsubscribed: true }> {
  return withMockFallback(
    () =>
      api.postRaw<{ unsubscribed: true }>(
        `/api/public/preferences/${encodeURIComponent(token)}/one-click`,
        "List-Unsubscribe=One-Click",
        {
          credentials: "omit",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
      ),
    async () => ({ unsubscribed: true as const }),
  );
}

/**
 * Smart-unsubscribe preferences — the subscriber-facing alternative
 * to immediate opt-out. Backend at
 * POST /api/public/preferences/{token}/frequency. Persists onto
 * subscribers.frequency_preference + subscribers.paused_until
 * (migration 0180).
 */
export type FrequencyChoice = "default" | "weekly" | "monthly" | "paused";

export interface SmartUnsubscribeResponse {
  choice: FrequencyChoice;
  /** RFC3339 when choice === "paused", else undefined. */
  pausedUntil?: string;
}

export function publicSmartUnsubscribe(
  token: string,
  body: { choice: FrequencyChoice; pauseDays?: number },
): Promise<SmartUnsubscribeResponse> {
  return withMockFallback(
    () =>
      api.post<SmartUnsubscribeResponse>(
        `/api/public/preferences/${encodeURIComponent(token)}/frequency`,
        body,
        { credentials: "omit" },
      ),
    async () => {
      // Mock fallback for offline dev: echo the choice + synthesise
      // a pausedUntil when relevant. Real fetch hits the API.
      const out: SmartUnsubscribeResponse = { choice: body.choice };
      if (body.choice === "paused") {
        const days = Math.max(1, Math.min(365, body.pauseDays ?? 30));
        out.pausedUntil = new Date(
          Date.now() + days * 86_400_000,
        ).toISOString();
      }
      return out;
    },
  );
}
