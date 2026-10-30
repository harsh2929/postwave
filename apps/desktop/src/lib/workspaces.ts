/**
 * Multi-workspace switcher store (roadmap: "Multi-workspace switcher").
 *
 * A workspace profile is {id, name, apiUrl, hasKey}. Profiles are
 * persisted in localStorage under `postwave_workspaces_v1` — NEVER the
 * API keys themselves. Keys live behind purpose-specific native broker
 * commands which can store, probe, activate, and remove—but never read—them.
 *
 * Switching is a journaled identity transaction. Dispatch is barred and old
 * identity state is detached before Rust activates the target credential;
 * URL and metadata commit in separate verified stages, then the app reloads.
 * An interrupted transaction is rolled back to its recorded source during
 * secure credential hydration before React mounts.
 *
 * Migration: the first load with no persisted profiles creates a single
 * "Default" profile from the existing `postwave_api_url` — existing
 * single-workspace installs keep working unchanged.
 */

import {
  beginApiIdentityTransition,
  PENDING_WORKSPACE_SWITCH_STORAGE_KEY,
  releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests,
  type ApiIdentityTransitionToken,
} from "./api-identity-transition";
import { acquireWebhookPlaygroundFireIdentityTransitionLease } from "./webhook-playground-fire-identity-transition";
import { invalidateApiUrlCache, syncOfflineIdentity } from "./api-client";
import { observeApiAuthority } from "./api-authority";
import { persistWorkspaceApiUrl } from "./workspace-api-url";
import { DEFAULT_API_URL, validateApiUrl } from "./config";
import { requestLifecycleTransition } from "./lifecycle-coordinator";
import { parkOfflineStores } from "./offline-store";
import { clearPersistedQueryCache } from "./query-client";
import { purgePrivateSessionState } from "./private-session-state";
import { tauriApi, type NativeApiBrokerStatus } from "./tauri";
import { useSyncExternalStore } from "react";

export interface WorkspaceProfile {
  /** Stable id — UUID, or "default" for the migrated legacy profile. */
  id: string;
  /** User-facing display name ("Acme prod", "Staging", …). */
  name: string;
  /** Base API URL for this workspace. */
  apiUrl: string;
  /**
   * Best-effort flag: does a saved API key exist for this profile in the
   * OS keychain? Refreshed by {@link refreshWorkspaceKeyFlags}; the
   * keychain remains the source of truth.
   */
  hasKey: boolean;
}

export interface WorkspacesState {
  activeId: string;
  profiles: WorkspaceProfile[];
}

export const DEFAULT_WORKSPACE_ID = "default";

const LS_WORKSPACES = "postwave_workspaces_v1";
/** Mirrors api-client.ts — the active workspace's URL slot. */
const LS_API_URL = "postwave_api_url";

const MAX_WORKSPACES = 20;
const MAX_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 128;
const MAX_API_URL_LENGTH = 2_048;
const MAX_WORKSPACES_RECORD_BYTES = 64 * 1024;
const MAX_SWITCH_JOURNAL_BYTES = 8 * 1024;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]+$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const TRANSACTION_ID_RE = /^[A-Za-z0-9-]{8,80}$/u;
const CREDENTIAL_FINGERPRINT_RE = /^[a-f0-9]{64}$/u;

const SWITCH_PHASES = [
  "prepared",
  "quiesced",
  "native-activated",
  "config-activated",
  "metadata-committed",
  "rolling-back",
  "native-restored",
  "config-restored",
  "metadata-restored",
] as const;

type WorkspaceSwitchPhase = (typeof SWITCH_PHASES)[number];

interface WorkspaceSwitchEndpoint {
  id: string;
  apiUrl: string;
}

interface WorkspaceNativeIdentity {
  configured: boolean;
  baseUrl: string | null;
  credentialFingerprint: string | null;
}

interface PendingWorkspaceSwitch {
  version: 1;
  transactionId: string;
  startedAt: number;
  phase: WorkspaceSwitchPhase;
  source: WorkspaceSwitchEndpoint;
  target: WorkspaceSwitchEndpoint;
  sourceNative: WorkspaceNativeIdentity;
  targetNative?: WorkspaceNativeIdentity;
}

/* ------------------------------------------------------------------ */
/*  Persistence + tiny pub-sub                                          */
/* ------------------------------------------------------------------ */

let state: WorkspacesState | null = null;
const listeners = new Set<() => void>();

function setApiUrlForIdentityTransition(url: string): void {
  persistWorkspaceApiUrl(url, invalidateApiUrlCache);
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[postwave-workspaces] listener threw");
    }
  }
}

function readStoredUrl(): string | null {
  try {
    const v = window.localStorage.getItem(LS_API_URL);
    if (!v) return null;
    if (v.length > MAX_API_URL_LENGTH || CONTROL_RE.test(v)) {
      window.localStorage.removeItem(LS_API_URL);
      invalidateApiUrlCache();
      return null;
    }
    const validation = validateApiUrl(v);
    if (!validation.ok) {
      window.localStorage.removeItem(LS_API_URL);
      invalidateApiUrlCache();
      return null;
    }
    return validation.url;
  } catch {
    return null;
  }
}

function persist(next: WorkspacesState, required = false): boolean {
  const payload = JSON.stringify(next);
  let durable = false;
  try {
    window.localStorage.setItem(LS_WORKSPACES, payload);
    durable = window.localStorage.getItem(LS_WORKSPACES) === payload;
  } catch {
    /* localStorage locked down */
  }
  if (!durable && required) return false;
  state = next;
  emit();
  return durable;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function parseProfile(value: unknown): WorkspaceProfile | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const profile = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(profile, ["id", "name", "apiUrl", "hasKey"]) ||
    typeof profile.id !== "string" ||
    !profile.id ||
    profile.id.length > MAX_ID_LENGTH ||
    !WORKSPACE_ID_RE.test(profile.id) ||
    typeof profile.name !== "string" ||
    !profile.name.trim() ||
    profile.name.length > MAX_NAME_LENGTH ||
    CONTROL_RE.test(profile.name) ||
    typeof profile.apiUrl !== "string" ||
    profile.apiUrl.length > MAX_API_URL_LENGTH ||
    CONTROL_RE.test(profile.apiUrl) ||
    typeof profile.hasKey !== "boolean"
  ) {
    return null;
  }
  const apiUrl = validateApiUrl(profile.apiUrl);
  if (!apiUrl.ok) return null;
  return {
    id: profile.id,
    name: profile.name.trim(),
    apiUrl: apiUrl.url,
    hasKey: profile.hasKey,
  };
}

function parseSwitchEndpoint(value: unknown): WorkspaceSwitchEndpoint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const endpoint = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(endpoint, ["id", "apiUrl"]) ||
    typeof endpoint.id !== "string" ||
    !endpoint.id ||
    endpoint.id.length > MAX_ID_LENGTH ||
    !WORKSPACE_ID_RE.test(endpoint.id) ||
    typeof endpoint.apiUrl !== "string" ||
    endpoint.apiUrl.length > MAX_API_URL_LENGTH ||
    CONTROL_RE.test(endpoint.apiUrl)
  ) {
    return null;
  }
  const apiUrl = validateApiUrl(endpoint.apiUrl);
  if (!apiUrl.ok) return null;
  return { id: endpoint.id, apiUrl: apiUrl.url };
}

function normalizeNativeIdentity(
  status: Pick<
    NativeApiBrokerStatus,
    "configured" | "baseUrl" | "credentialFingerprint"
  >,
  expectedUrl: string,
): WorkspaceNativeIdentity | null {
  if (typeof status.configured !== "boolean") return null;
  if (!status.configured) {
    return status.baseUrl === null && status.credentialFingerprint === null
      ? { configured: false, baseUrl: null, credentialFingerprint: null }
      : null;
  }
  if (
    typeof status.baseUrl !== "string" ||
    typeof status.credentialFingerprint !== "string" ||
    !CREDENTIAL_FINGERPRINT_RE.test(status.credentialFingerprint)
  ) {
    return null;
  }
  const baseUrl = validateApiUrl(status.baseUrl);
  const expected = validateApiUrl(expectedUrl);
  if (!baseUrl.ok || !expected.ok || baseUrl.url !== expected.url) return null;
  return {
    configured: true,
    baseUrl: baseUrl.url,
    credentialFingerprint: status.credentialFingerprint,
  };
}

function parseNativeIdentity(
  value: unknown,
  expectedUrl: string,
): WorkspaceNativeIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const native = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(native, ["configured", "baseUrl", "credentialFingerprint"]) ||
    typeof native.configured !== "boolean" ||
    (native.baseUrl !== null && typeof native.baseUrl !== "string") ||
    (native.credentialFingerprint !== null &&
      typeof native.credentialFingerprint !== "string")
  ) {
    return null;
  }
  return normalizeNativeIdentity(
    {
      configured: native.configured,
      baseUrl: native.baseUrl,
      credentialFingerprint: native.credentialFingerprint,
    },
    expectedUrl,
  );
}

function pendingSwitchRawExists(): boolean {
  try {
    return (
      window.localStorage.getItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY) !== null
    );
  } catch {
    // Storage denial means ownership state is unknown; suppress URL re-sync.
    return true;
  }
}

function readPendingWorkspaceSwitch(): PendingWorkspaceSwitch | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY);
  } catch {
    throw new Error("Workspace switch recovery storage is unavailable.");
  }
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_SWITCH_JOURNAL_BYTES) {
    throw new Error("Workspace switch recovery record is oversized.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Workspace switch recovery record is malformed.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Workspace switch recovery record is invalid.");
  }
  const value = parsed as Record<string, unknown>;
  if (
    !hasOnlyKeys(value, [
      "version",
      "transactionId",
      "startedAt",
      "phase",
      "source",
      "target",
      "sourceNative",
      "targetNative",
    ]) ||
    value.version !== 1 ||
    typeof value.transactionId !== "string" ||
    !TRANSACTION_ID_RE.test(value.transactionId) ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt <= 0 ||
    value.startedAt > 1_000_000_000_000_000 ||
    typeof value.phase !== "string" ||
    !SWITCH_PHASES.includes(value.phase as WorkspaceSwitchPhase)
  ) {
    throw new Error("Workspace switch recovery record is invalid.");
  }
  const source = parseSwitchEndpoint(value.source);
  const target = parseSwitchEndpoint(value.target);
  if (!source || !target || source.id === target.id) {
    throw new Error("Workspace switch recovery endpoints are invalid.");
  }
  const sourceNative = parseNativeIdentity(value.sourceNative, source.apiUrl);
  const targetNative =
    value.targetNative === undefined
      ? undefined
      : parseNativeIdentity(value.targetNative, target.apiUrl);
  if (!sourceNative || targetNative === null) {
    throw new Error("Workspace switch recovery identity is invalid.");
  }
  return {
    version: 1,
    transactionId: value.transactionId,
    startedAt: value.startedAt,
    phase: value.phase as WorkspaceSwitchPhase,
    source,
    target,
    sourceNative,
    ...(targetNative === undefined ? {} : { targetNative }),
  };
}

function writePendingWorkspaceSwitch(journal: PendingWorkspaceSwitch): void {
  const payload = JSON.stringify(journal);
  if (new TextEncoder().encode(payload).byteLength > MAX_SWITCH_JOURNAL_BYTES) {
    throw new Error("Workspace switch recovery record is oversized.");
  }
  try {
    window.localStorage.setItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY, payload);
    if (
      window.localStorage.getItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY) !==
      payload
    ) {
      throw new Error("recovery write verification failed");
    }
  } catch {
    throw new Error("Moosewave could not durably journal the workspace switch.");
  }
}

function clearPendingWorkspaceSwitch(): void {
  try {
    window.localStorage.removeItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY);
    if (
      window.localStorage.getItem(PENDING_WORKSPACE_SWITCH_STORAGE_KEY) !== null
    ) {
      throw new Error("recovery deletion verification failed");
    }
  } catch {
    throw new Error(
      "Moosewave could not clear workspace switch recovery state.",
    );
  }
}

function setJournalPhase(
  journal: PendingWorkspaceSwitch,
  phase: WorkspaceSwitchPhase,
  targetNative?: WorkspaceNativeIdentity,
): PendingWorkspaceSwitch {
  const next: PendingWorkspaceSwitch = {
    ...journal,
    phase,
    ...(targetNative === undefined ? {} : { targetNative }),
  };
  writePendingWorkspaceSwitch(next);
  return next;
}

function setJournalPhaseBestEffort(
  journal: PendingWorkspaceSwitch,
  phase: WorkspaceSwitchPhase,
): PendingWorkspaceSwitch {
  try {
    return setJournalPhase(journal, phase);
  } catch {
    return journal;
  }
}

function newSwitchTransactionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `switch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function loadPersisted(): WorkspacesState | null {
  try {
    const raw = window.localStorage.getItem(LS_WORKSPACES);
    if (!raw) return null;
    if (
      new TextEncoder().encode(raw).byteLength > MAX_WORKSPACES_RECORD_BYTES
    ) {
      window.localStorage.removeItem(LS_WORKSPACES);
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    if (
      !hasOnlyKeys(o, ["activeId", "profiles"]) ||
      typeof o.activeId !== "string" ||
      !Array.isArray(o.profiles) ||
      o.profiles.length === 0 ||
      o.profiles.length > MAX_WORKSPACES
    ) {
      return null;
    }
    const profiles = o.profiles.map(parseProfile);
    if (profiles.some((profile) => profile === null)) return null;
    const safeProfiles = profiles as WorkspaceProfile[];
    if (
      new Set(safeProfiles.map((profile) => profile.id)).size !==
      safeProfiles.length
    ) {
      return null;
    }
    if (!safeProfiles.some((profile) => profile.id === o.activeId)) return null;
    return { activeId: o.activeId, profiles: safeProfiles };
  } catch {
    return null;
  }
}

/**
 * Load (and lazily migrate) the workspaces state.
 *
 * - No persisted store → create the "Default" profile from the current
 *   `postwave_api_url` (or the build default when none is stored yet).
 * - The ACTIVE profile's URL is re-synced from `postwave_api_url` on
 *   every load: Settings can change the URL without going through this
 *   module, and the stored URL is what requests actually use.
 */
export function getWorkspaces(): WorkspacesState {
  if (state) return state;
  const persisted = loadPersisted();
  if (persisted) {
    // The API URL may legitimately be one transaction stage ahead of
    // metadata. Reconciliation owns it while any raw journal exists; adopting
    // it here would erase the evidence needed to distinguish source/target.
    const storedUrl = pendingSwitchRawExists() ? null : readStoredUrl();
    if (storedUrl) {
      const active = persisted.profiles.find(
        (p) => p.id === persisted.activeId,
      );
      if (active && active.apiUrl !== storedUrl) {
        active.apiUrl = storedUrl;
        persist(persisted);
        return persisted;
      }
    }
    state = persisted;
    return persisted;
  }
  const migrated: WorkspacesState = {
    activeId: DEFAULT_WORKSPACE_ID,
    profiles: [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "Default",
        apiUrl: readStoredUrl() ?? DEFAULT_API_URL,
        // Unknown until the async keychain probe runs; honest default is
        // false — refreshWorkspaceKeyFlags() flips it when a key exists.
        hasKey: false,
      },
    ],
  };
  persist(migrated);
  return migrated;
}

/** React hook over the workspaces state. */
export function useWorkspaces(): WorkspacesState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getWorkspaces,
    getWorkspaces,
  );
}

export function getActiveWorkspace(): WorkspaceProfile | null {
  const s = getWorkspaces();
  return s.profiles.find((p) => p.id === s.activeId) ?? null;
}

function stateForJournal(journal: PendingWorkspaceSwitch): WorkspacesState {
  const persisted = loadPersisted();
  if (!persisted) {
    throw new Error("Workspace metadata is unavailable during recovery.");
  }
  if (
    persisted.activeId !== journal.source.id &&
    persisted.activeId !== journal.target.id
  ) {
    throw new Error("The active workspace no longer matches recovery state.");
  }
  for (const endpoint of [journal.source, journal.target]) {
    const profile = persisted.profiles.find((item) => item.id === endpoint.id);
    if (!profile || profile.apiUrl !== endpoint.apiUrl) {
      throw new Error("Workspace metadata no longer matches recovery state.");
    }
  }
  let rawStoredUrl: string | null;
  try {
    rawStoredUrl = window.localStorage.getItem(LS_API_URL);
  } catch {
    throw new Error("The stored API URL is unavailable during recovery.");
  }
  const storedUrl = rawStoredUrl === null ? null : validateApiUrl(rawStoredUrl);
  if (storedUrl !== null && !storedUrl.ok) {
    throw new Error("The stored API URL is invalid during recovery.");
  }
  if (
    storedUrl !== null &&
    storedUrl.url !== journal.source.apiUrl &&
    storedUrl.url !== journal.target.apiUrl
  ) {
    throw new Error("The stored API URL no longer matches recovery state.");
  }
  return persisted;
}

function sameNativeIdentity(
  left: WorkspaceNativeIdentity,
  right: WorkspaceNativeIdentity,
): boolean {
  return (
    left.configured === right.configured &&
    left.baseUrl === right.baseUrl &&
    left.credentialFingerprint === right.credentialFingerprint
  );
}

function statusMatchesNativeIdentity(
  status: NativeApiBrokerStatus,
  identity: WorkspaceNativeIdentity,
  endpoint: WorkspaceSwitchEndpoint,
): boolean {
  const normalized = normalizeNativeIdentity(status, endpoint.apiUrl);
  return normalized !== null && sameNativeIdentity(normalized, identity);
}

function statusCouldBeTarget(
  status: NativeApiBrokerStatus,
  journal: PendingWorkspaceSwitch,
): boolean {
  const normalized = normalizeNativeIdentity(status, journal.target.apiUrl);
  if (!normalized) return false;
  return journal.targetNative
    ? sameNativeIdentity(normalized, journal.targetNative)
    : !sameNativeIdentity(normalized, journal.sourceNative);
}

function storedApiUrlIs(expectedUrl: string): boolean {
  try {
    const raw = window.localStorage.getItem(LS_API_URL);
    if (!raw) return false;
    const validation = validateApiUrl(raw);
    return validation.ok && validation.url === expectedUrl;
  } catch {
    return false;
  }
}

function metadataActiveIdIs(expectedId: string): boolean {
  return loadPersisted()?.activeId === expectedId;
}

async function quiesceWorkspaceIdentity(): Promise<void> {
  await parkOfflineStores();
  await clearPersistedQueryCache();
  // V2/v3 recovery tombstones are the only durable evidence that a corrupt
  // encrypted idempotency checkpoint once existed. Preserve them across an
  // identity switch while still purging ordinary customer-bearing plaintext.
  purgePrivateSessionState({ preserveInternalNoteQuarantine: true });
}

async function restoreJournalSource(
  journal: PendingWorkspaceSwitch,
  observedStatus: NativeApiBrokerStatus,
  token: ApiIdentityTransitionToken,
): Promise<void> {
  journal = setJournalPhaseBestEffort(journal, "rolling-back");
  const failures: string[] = [];
  let sourceStatus = observedStatus;

  if (
    !statusMatchesNativeIdentity(
      sourceStatus,
      journal.sourceNative,
      journal.source,
    )
  ) {
    if (!statusCouldBeTarget(sourceStatus, journal)) {
      failures.push(
        "native credential did not match the journal source or target",
      );
    } else {
      try {
        sourceStatus = await tauriApi.switchWorkspaceCredential(
          journal.target.id,
          journal.source.id,
          journal.source.apiUrl,
        );
      } catch {
        failures.push("native source credential could not be restored");
      }
    }
  }
  if (
    statusMatchesNativeIdentity(
      sourceStatus,
      journal.sourceNative,
      journal.source,
    )
  ) {
    journal = setJournalPhaseBestEffort(journal, "native-restored");
  } else if (!failures.some((failure) => failure.startsWith("native"))) {
    failures.push("native source credential verification failed");
  }

  try {
    setApiUrlForIdentityTransition(journal.source.apiUrl);
    journal = setJournalPhaseBestEffort(journal, "config-restored");
  } catch {
    failures.push("source API URL could not be restored durably");
  }

  try {
    const metadata = stateForJournal(journal);
    if (!persist({ ...metadata, activeId: journal.source.id }, true)) {
      failures.push("source workspace metadata persistence was denied");
    } else {
      journal = setJournalPhaseBestEffort(journal, "metadata-restored");
    }
  } catch {
    failures.push("source workspace metadata could not be restored");
  }

  if (!storedApiUrlIs(journal.source.apiUrl)) {
    failures.push("source API URL verification failed");
  }
  if (!metadataActiveIdIs(journal.source.id)) {
    failures.push("source workspace metadata verification failed");
  }
  if (
    !statusMatchesNativeIdentity(
      sourceStatus,
      journal.sourceNative,
      journal.source,
    )
  ) {
    failures.push("source native identity verification failed");
  }

  if (failures.length > 0) {
    throw new Error(
      `Workspace recovery remains pending: ${[...new Set(failures)].join("; ")}.`,
    );
  }

  await syncOfflineIdentity();
  clearPendingWorkspaceSwitch();
  releaseApiIdentityTransition(token);
}

/**
 * Resolve a crash-interrupted switch before React mounts. Recovery always
 * returns to the journal source; a later explicit switch can try the target
 * again from a fully coherent credential/config/metadata boundary.
 */
export async function reconcilePendingWorkspaceSwitch(
  hydratedStatus: NativeApiBrokerStatus,
): Promise<void> {
  const journal = readPendingWorkspaceSwitch();
  if (!journal) return;
  stateForJournal(journal);
  const token = beginApiIdentityTransition();
  await quiesceWorkspaceIdentity();
  await restoreJournalSource(journal, hydratedStatus, token);
}

/** Re-probe native credential presence without returning any plaintext. */
export async function refreshWorkspaceKeyFlags(): Promise<void> {
  const s = getWorkspaces();
  let changed = false;
  let statuses: Awaited<ReturnType<typeof tauriApi.workspaceCredentialStatus>>;
  try {
    statuses = await tauriApi.workspaceCredentialStatus(
      s.profiles.map((p) => ({ id: p.id, baseUrl: p.apiUrl })),
    );
  } catch {
    return;
  }
  const profiles = s.profiles.map((p) => {
    const saved = statuses.find((status) => status.id === p.id)?.configured;
    const hasKey = Boolean(
      saved || (p.id === s.activeId && tauriApi.apiBrokerStatus().configured),
    );
    if (hasKey !== p.hasKey) changed = true;
    return { ...p, hasKey };
  });
  // Re-read fresh state before persisting. The probes above ran async
  // off the `s` snapshot taken at entry; a concurrent switchWorkspace
  // can persist a new `activeId` while they're in flight. Spreading the
  // STALE `s` here would silently revert that switch — so spread the
  // CURRENT state and only overwrite `profiles` (the hasKey flags are
  // keyed by id and stay correct even if the active workspace changed).
  if (changed) {
    const current = getWorkspaces();
    // Carry the freshly-probed hasKey flags onto whatever the profile
    // set is NOW (a concurrent add/remove could have changed it): for
    // each current profile take its probed flag if we have one, else
    // leave it untouched. Profiles that were removed mid-probe simply
    // don't appear here, and ones added mid-probe keep their own flag.
    const merged = current.profiles.map((p) => {
      const probed = profiles.find((pp) => pp.id === p.id);
      return probed ? { ...p, hasKey: probed.hasKey } : p;
    });
    persist({ ...current, profiles: merged });
  }
}

/* ------------------------------------------------------------------ */
/*  Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface AddWorkspaceInput {
  name: string;
  apiUrl: string;
  /** Optional — session-cookie users can add a URL-only profile. */
  key?: string;
}

/**
 * Validate + store a new workspace profile. The key (when given) goes
 * straight to an origin-bound native broker record; only metadata is
 * written to localStorage. Throws with a user-facing message on invalid
 * input or keychain failure (nothing is persisted in that case).
 */
export async function addWorkspace(
  input: AddWorkspaceInput,
): Promise<WorkspaceProfile> {
  const s = getWorkspaces();
  const name = input.name.trim();
  if (!name) throw new Error("Workspace name is required.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Workspace name must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }
  if (s.profiles.length >= MAX_WORKSPACES) {
    throw new Error(`You can keep at most ${MAX_WORKSPACES} workspaces.`);
  }
  const validation = validateApiUrl(input.apiUrl);
  if (!validation.ok) throw new Error(validation.message);

  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const key = input.key?.trim() ?? "";
  if (key) {
    // Keychain write FIRST — if it fails we add nothing, so the profile
    // list never claims a key that was never saved.
    await tauriApi.storeWorkspaceCredential(id, validation.url, key);
  }

  const profile: WorkspaceProfile = {
    id,
    name,
    apiUrl: validation.url,
    hasKey: Boolean(key),
  };
  if (!persist({ ...s, profiles: [...s.profiles, profile] }, true)) {
    if (key) {
      try {
        await tauriApi.removeWorkspaceCredential(id);
      } catch {
        /* inaccessible orphan; the profile itself was not accepted */
      }
    }
    throw new Error(
      "Moosewave could not store the workspace profile on this device.",
    );
  }
  return profile;
}

/**
 * Remove a (non-active) workspace profile and delete its keychain entry.
 * Removing the active workspace is refused — switch away first; that
 * keeps "remove" from doubling as a surprise sign-out.
 */
export async function removeWorkspace(id: string): Promise<void> {
  const s = getWorkspaces();
  if (id === s.activeId) {
    throw new Error(
      "Switch to another workspace before removing the active one.",
    );
  }
  const profile = s.profiles.find((p) => p.id === id);
  if (!profile) return;
  if (
    !persist({ ...s, profiles: s.profiles.filter((p) => p.id !== id) }, true)
  ) {
    throw new Error(
      "Moosewave could not remove the workspace profile from device storage.",
    );
  }
  try {
    await tauriApi.removeWorkspaceCredential(id);
  } catch {
    // Keychain unavailable — still drop the profile; the orphaned entry
    // is unreadable by anything (the menu re-creates ids as UUIDs).
  }
}

/**
 * Sign-out purge (D02#9): delete EVERY per-workspace saved API key from
 * the keychain and drop all workspace profiles, so the next user who signs
 * in on this device cannot restore the previous owner's key via the
 * workspace switcher. The active `api_key` slot is cleared separately by
 * auth.fullSignOut → clearApiConfig.
 */
export async function clearAllWorkspaces(): Promise<void> {
  const s = getWorkspaces();
  for (const p of s.profiles) {
    try {
      await tauriApi.removeWorkspaceCredential(p.id);
    } catch {
      /* keychain unavailable — still drop the profiles below */
    }
  }
  try {
    window.localStorage.removeItem(LS_WORKSPACES);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Switch the active workspace through the lifecycle review and durable
 * identity transaction. Rust never returns a credential; successful commit
 * reloads while dispatch remains barred.
 */
export async function switchWorkspace(id: string): Promise<void> {
  const s = getWorkspaces();
  if (id === s.activeId) return;
  const target = s.profiles.find((p) => p.id === id);
  if (!target) throw new Error("That workspace no longer exists.");

  const result = await requestLifecycleTransition(
    {
      kind: "workspace-switch",
      disposition: "identity-change",
      title: `Switch to ${target.name}?`,
      description:
        "Moosewave will check unsaved drafts and active operations before changing the credential, cache, and workspace context.",
      confirmLabel: `Switch to ${target.name}`,
      targetLabel: target.name,
    },
    () => performWorkspaceSwitch(s, target),
  );
  if (result === "failed") {
    throw new Error("Moosewave could not safely switch workspaces.");
  }
  if (result === "busy") {
    throw new Error(
      "Another close, sign-out, restart, or switch is in progress.",
    );
  }
}

async function performWorkspaceSwitch(
  reviewedState: WorkspacesState,
  reviewedTarget: WorkspaceProfile,
): Promise<void> {
  const recoveryTransitionLease =
    acquireWebhookPlaygroundFireIdentityTransitionLease();
  try {
    await performWorkspaceSwitchWithRecoveryLease(
      reviewedState,
      reviewedTarget,
    );
  } finally {
    recoveryTransitionLease.release();
  }
}

async function performWorkspaceSwitchWithRecoveryLease(
  reviewedState: WorkspacesState,
  reviewedTarget: WorkspaceProfile,
): Promise<void> {
  const s = loadPersisted();
  if (!s || s.activeId !== reviewedState.activeId) {
    throw new Error("The active workspace changed during switch review.");
  }
  const target = s.profiles.find((profile) => profile.id === reviewedTarget.id);
  if (!target || target.apiUrl !== reviewedTarget.apiUrl) {
    throw new Error("The target workspace changed during switch review.");
  }
  const previous = s.profiles.find((profile) => profile.id === s.activeId);
  if (!previous) throw new Error("The active workspace profile is invalid.");
  // Establish that the source metadata itself is durable before journaling a
  // transition away from it. This writes the same logical state.
  if (!persist(s, true)) {
    throw new Error(
      "Moosewave could not verify the active workspace on this device.",
    );
  }
  const sourceNative = normalizeNativeIdentity(
    tauriApi.apiBrokerStatus(),
    previous.apiUrl,
  );
  if (!sourceNative) {
    throw new Error(
      "The active native credential does not match this workspace.",
    );
  }

  const token = beginApiIdentityTransition();
  let journal: PendingWorkspaceSwitch = {
    version: 1,
    transactionId: newSwitchTransactionId(),
    startedAt: Date.now(),
    phase: "prepared",
    source: { id: previous.id, apiUrl: previous.apiUrl },
    target: { id: target.id, apiUrl: target.apiUrl },
    sourceNative,
  };
  try {
    writePendingWorkspaceSwitch(journal);
  } catch (error) {
    releaseApiIdentityTransition(token);
    throw error;
  }

  let activatedStatus: NativeApiBrokerStatus | null = null;
  try {
    await quiesceWorkspaceIdentity();
    journal = setJournalPhase(journal, "quiesced");

    // Clear authority-bound identities before native IPC can atomically swap
    // the broker. Renderer events may continue while the command is pending.
    observeApiAuthority(target.apiUrl);
    activatedStatus = await tauriApi.switchWorkspaceCredential(
      s.activeId,
      target.id,
      target.apiUrl,
    );
    const targetNative = normalizeNativeIdentity(
      activatedStatus,
      target.apiUrl,
    );
    if (!targetNative) {
      throw new Error(
        "The native broker activated an unexpected workspace identity.",
      );
    }
    journal = setJournalPhase(journal, "native-activated", targetNative);

    setApiUrlForIdentityTransition(target.apiUrl);
    journal = setJournalPhase(journal, "config-activated");

    if (!persist({ ...s, activeId: target.id }, true)) {
      throw new Error(
        "Moosewave could not durably commit the target workspace metadata.",
      );
    }
    journal = setJournalPhase(journal, "metadata-committed");

    if (
      !statusMatchesNativeIdentity(
        activatedStatus,
        targetNative,
        journal.target,
      ) ||
      !storedApiUrlIs(target.apiUrl) ||
      !metadataActiveIdIs(target.id)
    ) {
      throw new Error("Workspace switch commit verification failed.");
    }
    clearPendingWorkspaceSwitch();
  } catch (error) {
    try {
      if (String(error).includes("FATAL_WORKSPACE_SWITCH_INCONSISTENT")) {
        throw new Error("Native credential recovery requires a restart.");
      }
      await restoreJournalSource(
        journal,
        activatedStatus ?? tauriApi.apiBrokerStatus(),
        token,
      );
    } catch {
      throw new Error(
        "Workspace switching failed and recovery remains pending. Restart Moosewave to restore the previous workspace safely.",
      );
    }
    throw error;
  }

  // Success deliberately leaves the API barrier engaged. Reload is the commit
  // boundary that creates a fresh request/query/offline process generation.
  try {
    window.location.reload();
  } catch {
    /* tests / SSR */
  }
}

/* ------------------------------------------------------------------ */
/*  Test hook                                                           */
/* ------------------------------------------------------------------ */

/** Reset the in-memory cache — unit tests only. */
export function __resetWorkspacesForTests(): void {
  state = null;
  resetApiIdentityTransitionForTests();
}
