import type { TemplateGoal } from "./api-client";
import { registerPrivateSessionReset } from "./private-session-state";

export type CampaignTemplateDiscoverySort =
  | "recommended"
  | "name"
  | "most_used";
export type CampaignTemplateDiscoveryView = "grid" | "compact";
export type CampaignTemplateDiscoveryLifecycle =
  | "active"
  | "archived"
  | "all";
export type CampaignTemplateDiscoverySource =
  | "all"
  | "platform"
  | "team"
  | "mine"
  | "favorited"
  | "archived"
  | "saved_blocks";

export interface CampaignTemplateDiscoveryPreferences {
  query: string;
  goal: TemplateGoal | "";
  source: CampaignTemplateDiscoverySource;
  sort: CampaignTemplateDiscoverySort;
  view: CampaignTemplateDiscoveryView;
  lifecycle: CampaignTemplateDiscoveryLifecycle;
}

type PreferenceStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

const STORAGE_PREFIX = "postwave.template-discovery-preferences.v1";
const IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_RECORD_BYTES = 1_024;
const SOURCES = new Set<CampaignTemplateDiscoverySource>([
  "all",
  "platform",
  "team",
  "mine",
  "favorited",
  "archived",
  "saved_blocks",
]);
const GOALS = new Set<TemplateGoal>([
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
]);
const SORTS = new Set<CampaignTemplateDiscoverySort>([
  "recommended",
  "name",
  "most_used",
]);
const VIEWS = new Set<CampaignTemplateDiscoveryView>(["grid", "compact"]);
const LIFECYCLES = new Set<CampaignTemplateDiscoveryLifecycle>([
  "active",
  "archived",
  "all",
]);

export const DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES: CampaignTemplateDiscoveryPreferences =
  {
    query: "",
    goal: "",
    source: "all",
    sort: "recommended",
    view: "grid",
    lifecycle: "active",
  };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function storageKey(identityScope: string): string | null {
  return IDENTITY_SCOPE_RE.test(identityScope)
    ? `${STORAGE_PREFIX}.${identityScope}`
    : null;
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function decodePreferences(
  raw: string,
): CampaignTemplateDiscoveryPreferences | null {
  if (byteLength(raw) > MAX_RECORD_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 7 ||
      ![
        "version",
        "query",
        "goal",
        "source",
        "sort",
        "view",
        "lifecycle",
      ].every((key) => keys.includes(key)) ||
      record.version !== 1 ||
      typeof record.query !== "string" ||
      Array.from(record.query).length > 200 ||
      CONTROL_RE.test(record.query) ||
      typeof record.goal !== "string" ||
      (record.goal !== "" && !GOALS.has(record.goal as TemplateGoal)) ||
      typeof record.source !== "string" ||
      !SOURCES.has(record.source as CampaignTemplateDiscoverySource) ||
      typeof record.sort !== "string" ||
      !SORTS.has(record.sort as CampaignTemplateDiscoverySort) ||
      typeof record.view !== "string" ||
      !VIEWS.has(record.view as CampaignTemplateDiscoveryView) ||
      typeof record.lifecycle !== "string" ||
      !LIFECYCLES.has(
        record.lifecycle as CampaignTemplateDiscoveryLifecycle,
      ) ||
      (record.source === "archived" && record.lifecycle !== "archived")
    ) {
      return null;
    }
    return {
      query: record.query,
      goal: record.goal as TemplateGoal | "",
      source: record.source as CampaignTemplateDiscoverySource,
      sort: record.sort as CampaignTemplateDiscoverySort,
      view: record.view as CampaignTemplateDiscoveryView,
      lifecycle: record.lifecycle as CampaignTemplateDiscoveryLifecycle,
    };
  } catch {
    return null;
  }
}

export function readCampaignTemplateDiscoveryPreferences(
  identityScope: string | null,
  storage?: PreferenceStorage,
): CampaignTemplateDiscoveryPreferences {
  if (!identityScope) {
    return { ...DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES };
  }
  const key = storageKey(identityScope);
  const activeStorage = storage ?? browserStorage();
  if (!key || !activeStorage) {
    return { ...DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES };
  }
  try {
    const raw = activeStorage.getItem(key);
    if (raw === null) {
      return { ...DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES };
    }
    const decoded = decodePreferences(raw);
    if (decoded) return decoded;
    activeStorage.removeItem(key);
  } catch {
    // Preferences are optional; default without adopting unverified data.
  }
  return { ...DEFAULT_CAMPAIGN_TEMPLATE_DISCOVERY_PREFERENCES };
}

export function writeCampaignTemplateDiscoveryPreferences(
  identityScope: string | null,
  preferences: CampaignTemplateDiscoveryPreferences,
  storage?: PreferenceStorage,
): boolean {
  if (!identityScope) return false;
  const key = storageKey(identityScope);
  const activeStorage = storage ?? browserStorage();
  if (!key || !activeStorage) return false;
  const raw = JSON.stringify({ version: 1, ...preferences });
  if (!decodePreferences(raw) || byteLength(raw) > MAX_RECORD_BYTES) {
    return false;
  }
  try {
    activeStorage.setItem(key, raw);
    return activeStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}

function purgeCampaignTemplateDiscoveryPreferences(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${STORAGE_PREFIX}.`)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Scope validation still prevents another identity from adopting a record.
  }
}

registerPrivateSessionReset(
  "campaign-template-discovery-preferences",
  purgeCampaignTemplateDiscoveryPreferences,
);
