/**
 * Tiny in-memory store with `useSyncExternalStore`. Tracks:
 *   - active section (sidebar selection)
 *   - API connection state (for status bar dot)
 *   - command palette open/closed state
 *   - resolved theme ("dark" | "light") plus the persisted
 *     System/Light/Dark preference
 *   - the signed-in user (`me`), including their RBAC role
 *
 * Plain pub-sub. No external state library.
 */

import { useSyncExternalStore } from "react";

import { api, apiAuth, getApiKey, getApiUrl } from "./api-client";
import { requestFullSignOut } from "./auth";
import { canonicalApiBaseUrl } from "./config";
import {
  apiIdentityGenerationIsCurrent,
  captureApiIdentityGeneration,
} from "./api-identity-transition";
import {
  GOTO_SHORTCUT_SECTIONS,
  LETTER_SHORTCUT_SECTIONS,
  NUMERIC_SHORTCUT_SECTIONS,
} from "./desktop-shortcuts";
import {
  getDesktopRoute,
  navigateDesktopSection,
  parseDesktopRoute,
  setDesktopRouterIdentity,
  subscribeDesktopRoute,
} from "./desktop-router";
import { configureTransferHistoryIdentity } from "./file-transfer-history";
import { configureNotificationCenterIdentity } from "./notification-center";
import {
  credentialIdentityHash,
  normalizeDesktopApiKey,
} from "./secure-api-key";
import { isTauri, tauriApi } from "./tauri";
import { deriveWebhookPlaygroundFireRecoveryScope } from "./webhook-playground-fire-recovery-scope";
import { registerVerifiedWebhookPlaygroundFireScope } from "./webhook-playground-fire-verified-scope";

export type Section =
  | "dashboard"
  | "subscribers"
  | "tags"
  | "lists"
  | "segments"
  | "suppressions"
  | "smsSuppressions"
  | "pushSuppressions"
  | "deliverabilityHub"
  | "privacyPortal"
  | "audienceSyncs"
  | "campaigns"
  | "sequences"
  | "automations"
  | "forms"
  | "templates"
  | "assets"
  | "collections"
  | "webhooks"
  | "outboundWebhooks"
  | "track"
  | "analytics"
  | "sendtime"
  | "archive"
  | "referrals"
  | "affiliates"
  | "discounts"
  | "gifts"
  | "commerce"
  | "reviews"
  | "retentionOffers"
  | "aeoSensor"
  | "domains"
  | "dmarc"
  | "approvals"
  | "audit"
  | "consent"
  | "mcp"
  | "smsInbox"
  | "helpdesk"
  | "apiPlayground"
  | "webhookSimulator"
  | "ai"
  | "aiChangelog"
  | "migrations"
  | "integrations"
  | "dataPlatform"
  | "sending"
  | "agency"
  | "inboundRoutes"
  | "scim"
  | "hipaa"
  | "compliance"
  | "privacyIncidents"
  | "auditSinks"
  | "auditAlerts"
  | "auditInvestigation"
  | "settings";

export type ConnState = "unknown" | "connecting" | "online" | "offline";

export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";

/**
 * RBAC roles, mirroring the backend's session.role field. The desktop
 * uses these to decide whether to disable / hide destructive controls
 * (delete, send, etc). See {@link canWrite}, {@link canAdmin}.
 */
export type Role = "admin" | "editor" | "viewer";
export type RoleStatus = "loading" | "resolved" | "unavailable";

export interface TelemetryIdentity {
  apiBaseUrl: string;
  user: string;
  tenant: string;
}

export interface NoteRecoveryPrincipal {
  apiBaseUrl: string;
  apiIdentityGeneration: number;
  user: string;
  tenant: string;
}

const CANONICAL_SESSION_PRINCIPAL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NATIVE_CREDENTIAL_FINGERPRINT_RE = /^[a-f0-9]{64}$/u;
const BROWSER_CREDENTIAL_FINGERPRINT_RE =
  /^api-credential:sha256:[a-f0-9]{64}$/u;

function canonicalSessionPrincipal(
  user: unknown,
  tenant: unknown,
  apiBaseUrl: unknown,
  apiIdentityGeneration: unknown,
): NoteRecoveryPrincipal | null {
  const canonicalBaseUrl =
    typeof apiBaseUrl === "string" ? canonicalApiBaseUrl(apiBaseUrl) : null;
  return typeof user === "string" &&
    typeof tenant === "string" &&
    CANONICAL_SESSION_PRINCIPAL_RE.test(user) &&
    CANONICAL_SESSION_PRINCIPAL_RE.test(tenant) &&
    Number.isSafeInteger(apiIdentityGeneration) &&
    (apiIdentityGeneration as number) >= 0 &&
    canonicalBaseUrl
    ? {
        apiBaseUrl: canonicalBaseUrl,
        apiIdentityGeneration: apiIdentityGeneration as number,
        user,
        tenant,
      }
    : null;
}

async function currentApiKeyCredentialFingerprint(
  apiUrl: string,
  apiIdentityGeneration: number | null,
): Promise<string | null> {
  const canonicalBase = canonicalApiBaseUrl(apiUrl);
  if (
    !canonicalBase ||
    apiIdentityGeneration === null ||
    !apiIdentityGenerationIsCurrent(apiIdentityGeneration)
  ) {
    return null;
  }
  if (isTauri()) {
    const broker = tauriApi.apiBrokerStatus();
    const brokerBase = broker.baseUrl
      ? canonicalApiBaseUrl(broker.baseUrl)
      : null;
    return broker.configured &&
      brokerBase === canonicalBase &&
      typeof broker.credentialFingerprint === "string" &&
      NATIVE_CREDENTIAL_FINGERPRINT_RE.test(broker.credentialFingerprint)
      ? broker.credentialFingerprint
      : null;
  }
  const key = normalizeDesktopApiKey(getApiKey());
  if (!key) return null;
  const fingerprint = await credentialIdentityHash(apiUrl, key);
  if (
    !apiIdentityGenerationIsCurrent(apiIdentityGeneration) ||
    canonicalApiBaseUrl(getApiUrl()) !== canonicalBase
  ) {
    return null;
  }
  return typeof fingerprint === "string" &&
    BROWSER_CREDENTIAL_FINGERPRINT_RE.test(fingerprint)
    ? fingerprint
    : null;
}

/**
 * The signed-in user, populated on boot from /api/v1/auth/me.
 *
 * `null` means we haven't resolved the user yet or no identity endpoint
 * returned a usable user/tenant projection.
 */
export interface Me {
  user: string;
  tenant: string;
  /** Authentication surface that authoritatively resolved this projection. */
  credentialSource?: "session" | "api-key";
  /**
   * Collision-resistant identity of the exact API credential. Present only
   * for API-key Me; the plaintext credential never enters store state.
   */
  credentialFingerprint?: string | null;
  /**
   * SHA-256 recovery namespace over API base, provenance, exact principal,
   * and tenant. Precomputed because recovery authority construction is sync.
   */
  webhookPlaygroundRecoveryScope?: string | null;
  /**
   * Durable account role from users.role. Authoritative for "your
   * account is an admin" UI even while previewing as a viewer.
   */
  role: Role;
  /**
   * SUB-091: the role the UI should GATE on for this session. Equals
   * {@link role} unless View-as-Viewer preview is active, in which case
   * it's the (down-only) preview role. {@link canWrite}/{@link canAdmin}
   * read this, not `role`.
   */
  effectiveRole: Role;
  /**
   * Present only when this identity was resolved by the cookie-session
   * `/auth/me` endpoint. API-key actor labels are display identities, even
   * when a caller chooses a UUID-shaped label, and must never become a
   * telemetry identity.
   */
  telemetryIdentity?: TelemetryIdentity | null;
  /** Stable server principal for durable internal-note recovery only. */
  noteRecoveryPrincipal?: NoteRecoveryPrincipal | null;
}

const LS_THEME = "postwave_theme";

/**
 * Refined Dashboard (PR 2): ambient live slices written by the
 * Dashboard page and read by TopBar / StatusBar so the workspace
 * counter and active-send strip stay in lock-step with the dashboard.
 *
 * Both are nullable until the dashboard has loaded at least once.
 */
export interface LiveSubs {
  total: number;
  /** Newly added in the active dashboard window. */
  added: number;
  /** Epoch-ms when this snapshot was set. */
  at: number;
}

export interface ActiveSend {
  campaignId: string;
  name: string;
  /** Best-effort: most recently observed open rate (0..1 or 0..100). */
  openRate?: number | null;
  clickRate?: number | null;
}

export interface AppState {
  section: Section;
  conn: ConnState;
  commandOpen: boolean;
  /** Persisted operator choice. `system` follows OS changes live. */
  themePreference: ThemePreference;
  /** Resolved palette consumed by visual components. */
  theme: Theme;
  /** Current signed-in user + RBAC role. `null` until /me resolves. */
  me: Me | null;
  /** Whether the role is authoritative enough to enable mutating UI. */
  roleStatus: RoleStatus;
  /**
   * SUB-091: true when this session is actively previewing as a lower-
   * privilege role (View-as-Viewer). Mirrors `me.effectiveRole !==
   * me.role`; lifted to a primitive slice so the TopBar indicator can
   * subscribe without re-rendering on every `me` churn.
   */
  viewerModeActive: boolean;
  /**
   * SUB-091: whether the durable role may activate the preview at all
   * (admin/owner only). Drives whether the TopBar toggle renders.
   */
  canUseViewerMode: boolean;
  /** Latest tenant-subscriber snapshot, pushed by the dashboard. */
  liveSubs: LiveSubs | null;
  /** When non-null, a campaign is currently sending — strip on StatusBar. */
  activeSend: ActiveSend | null;
}

/**
 * Read the operator's durable preference. Missing/legacy-invalid values
 * migrate safely to System without writing during module initialization.
 */
export function loadThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(LS_THEME);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    // localStorage may throw in private-mode or sandboxed contexts.
  }
  return "system";
}

/** Resolve the current operating-system palette, with the historical dark
 * fallback when the media query is unavailable or denied. */
export function loadSystemTheme(): Theme {
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches
    ) {
      return "light";
    }
  } catch {
    // matchMedia can throw if the query string is malformed in older engines.
  }
  return "dark";
}

/** Resolve a durable preference to the palette visual consumers expect. */
export function resolveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? loadSystemTheme() : preference;
}

/** Backward-compatible resolved-theme boot helper. */
export function loadTheme(): Theme {
  return resolveTheme(loadThemePreference());
}

function applyThemeToDoc(theme: Theme, preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme-preference", preference);
  if (theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
}

const initialThemePreference: ThemePreference =
  typeof window !== "undefined" ? loadThemePreference() : "system";
const initial: AppState = {
  section: getDesktopRoute().section,
  conn: "unknown",
  commandOpen: false,
  themePreference: initialThemePreference,
  theme:
    typeof window !== "undefined"
      ? resolveTheme(initialThemePreference)
      : "dark",
  me: null,
  roleStatus: "loading",
  viewerModeActive: false,
  canUseViewerMode: false,
  liveSubs: null,
  activeSend: null,
};

// Apply persisted theme on module load (before React renders).
if (typeof window !== "undefined") {
  applyThemeToDoc(initial.theme, initial.themePreference);
}

let state: AppState = initial;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // eslint-disable-next-line no-console
      console.error("[postwave-store] listener threw");
    }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): AppState {
  return state;
}

// Compatibility bridge: typed route changes (including popstate, native
// deep links, route-backed tabs, reload restore) synchronously update the
// historical `section` slice without creating a route/store feedback loop.
subscribeDesktopRoute(() => {
  const section = getDesktopRoute().section;
  if (state.section === section) return;
  state = { ...state, section };
  emit();
});

export function setSection(section: Section): void {
  // The route controller is authoritative. Its synchronous subscription
  // below keeps this compatibility slice current for the many existing
  // section-only consumers while ensuring every entry point participates in
  // canonical browser history.
  navigateDesktopSection(section);
}

/**
 * Canonical writer for the connection slice. The ONLY production
 * caller is onlineManager (see lib/online-manager). Other modules
 * read the slice via useConn() / useOnline() but must never write
 * directly — this keeps online state single-sourced.
 */
export function setConn(conn: ConnState): void {
  if (state.conn === conn) return;
  state = { ...state, conn };
  emit();
}

export function setCommandOpen(open: boolean): void {
  if (state.commandOpen === open) return;
  state = { ...state, commandOpen: open };
  emit();
}

export function toggleCommand(): void {
  state = { ...state, commandOpen: !state.commandOpen };
  emit();
}

function updateThemeState(preference: ThemePreference, persist: boolean): void {
  if (persist) {
    try {
      window.localStorage.setItem(LS_THEME, preference);
    } catch {
      /* localStorage locked down — keep in-memory only */
    }
  }

  const theme = resolveTheme(preference);
  applyThemeToDoc(theme, preference);
  if (state.theme === theme && state.themePreference === preference) return;
  state = { ...state, theme, themePreference: preference };
  emit();
}

/** Set System, Light or Dark. System remains a first-class stored choice. */
export function setThemePreference(preference: ThemePreference): void {
  updateThemeState(preference, true);
}

/** Compatibility writer for callers that intentionally choose a fixed theme. */
export function setTheme(theme: Theme): void {
  setThemePreference(theme);
}

export function toggleTheme(): void {
  setTheme(state.theme === "dark" ? "light" : "dark");
}

function onSystemThemeChange(event: MediaQueryListEvent): void {
  if (state.themePreference !== "system") return;
  const theme: Theme = event.matches ? "light" : "dark";
  if (state.theme === theme) return;
  state = { ...state, theme };
  applyThemeToDoc(theme, "system");
  emit();
}

function onThemeStorageChange(event: StorageEvent): void {
  if (event.key !== LS_THEME) return;
  const value = event.newValue;
  const preference: ThemePreference =
    value === "dark" || value === "light" || value === "system"
      ? value
      : "system";
  updateThemeState(preference, false);
}

function startThemeSynchronization(): void {
  if (typeof window === "undefined") return;
  try {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (typeof query?.addEventListener === "function") {
      query.addEventListener("change", onSystemThemeChange);
    } else {
      // WKWebView versions predating EventTarget support expose addListener.
      query?.addListener?.(onSystemThemeChange);
    }
  } catch {
    // An unavailable media-query listener leaves System on its boot palette.
  }
  window.addEventListener?.("storage", onThemeStorageChange);
}

startThemeSynchronization();

/* ---------- Refined Dashboard (PR 2) live slices ------------------ */

/**
 * Update the global subscriber-counter snapshot. Called by the
 * Dashboard page whenever it receives fresh stats. TopBar reads
 * this to render the live counter chip.
 *
 * No-op when called with the same values — avoids waking the topbar
 * subscriber on every SSE tick that didn't actually change the count.
 */
export function setLiveSubs(s: LiveSubs | null): void {
  const cur = state.liveSubs;
  // Same reference (covers both-null) — nothing changed, don't emit.
  if (s === cur) return;
  // Identical snapshot — ignore .at drift so we don't churn on every
  // SSE tick.
  if (s && cur && s.total === cur.total && s.added === cur.added) return;
  state = { ...state, liveSubs: s };
  emit();
}

/**
 * Update / clear the actively-sending campaign strip. Null hides
 * the strip; non-null shows it. StatusBar reads this.
 */
export function setActiveSend(a: ActiveSend | null): void {
  const cur = state.activeSend;
  if (a === cur) return;
  if (
    a &&
    cur &&
    a.campaignId === cur.campaignId &&
    a.name === cur.name &&
    a.openRate === cur.openRate &&
    a.clickRate === cur.clickRate
  ) {
    return;
  }
  state = { ...state, activeSend: a };
  emit();
}

/* ---------- RBAC: me + role helpers --------------------------------- */

/**
 * Set / clear the signed-in user. `null` resets to "unknown".
 *
 * Keeps the derived `viewerModeActive` slice in lock-step with
 * `me.effectiveRole !== me.role` so UI that only cares about "are we
 * previewing?" can subscribe to the primitive slice.
 */
export function setMe(
  me: Me | null,
  roleStatus: RoleStatus = me ? "resolved" : "loading",
): void {
  if (!me) registerVerifiedWebhookPlaygroundFireScope(null);
  const nextViewerActive = me ? me.effectiveRole !== me.role : false;
  if (
    me &&
    state.me &&
    me.user === state.me.user &&
    me.tenant === state.me.tenant &&
    me.role === state.me.role &&
    me.effectiveRole === state.me.effectiveRole &&
    (me.credentialSource ?? null) === (state.me.credentialSource ?? null) &&
    (me.credentialFingerprint ?? null) ===
      (state.me.credentialFingerprint ?? null) &&
    (me.webhookPlaygroundRecoveryScope ?? null) ===
      (state.me.webhookPlaygroundRecoveryScope ?? null) &&
    (me.telemetryIdentity?.user ?? null) ===
      (state.me.telemetryIdentity?.user ?? null) &&
    (me.telemetryIdentity?.tenant ?? null) ===
      (state.me.telemetryIdentity?.tenant ?? null) &&
    (me.telemetryIdentity?.apiBaseUrl ?? null) ===
      (state.me.telemetryIdentity?.apiBaseUrl ?? null) &&
    (me.noteRecoveryPrincipal?.user ?? null) ===
      (state.me.noteRecoveryPrincipal?.user ?? null) &&
    (me.noteRecoveryPrincipal?.tenant ?? null) ===
      (state.me.noteRecoveryPrincipal?.tenant ?? null) &&
    (me.noteRecoveryPrincipal?.apiBaseUrl ?? null) ===
      (state.me.noteRecoveryPrincipal?.apiBaseUrl ?? null) &&
    state.roleStatus === roleStatus &&
    state.viewerModeActive === nextViewerActive
  ) {
    return;
  }
  if (
    me === null &&
    state.me === null &&
    state.roleStatus === roleStatus &&
    state.viewerModeActive === false
  ) {
    return;
  }
  state = { ...state, me, roleStatus, viewerModeActive: nextViewerActive };
  configureTransferHistoryIdentity(me?.user, me?.tenant);
  if (me) {
    setDesktopRouterIdentity(me.user, me.tenant);
    void configureNotificationCenterIdentity(me.user, me.tenant);
  } else {
    void configureNotificationCenterIdentity(null, null);
  }
  emit();
}

function setRoleStatus(roleStatus: RoleStatus): void {
  if (state.roleStatus === roleStatus) return;
  state = { ...state, roleStatus };
  emit();
}

/**
 * SUB-091: record whether the durable role can use View-as-Viewer at
 * all. Set once from /me; drives whether the TopBar toggle renders.
 */
export function setCanUseViewerMode(can: boolean): void {
  if (state.canUseViewerMode === can) return;
  state = { ...state, canUseViewerMode: can };
  emit();
}

/**
 * Coerce an arbitrary string into a {@link Role}, defaulting to
 * "viewer" on anything unrecognised — viewer is the SAFEST fallback
 * because it disables destructive actions.
 */
function normalizeRole(raw: string | undefined | null): Role {
  const v = (raw ?? "").toLowerCase();
  if (v === "admin" || v === "owner") return "admin";
  if (v === "editor" || v === "member" || v === "writer") return "editor";
  if (v === "viewer" || v === "reader") return "viewer";
  // Unknown role → safest is viewer so destructive UI stays gated.
  return "viewer";
}

/**
 * Populate the signed-in user from the server. Tries the cookie-session
 * `/auth/me` first (it returns a `role` field); falls back to the API-key
 * self-info route. API-key scopes are server-verified capabilities, so the
 * desktop can project the matching UI role without trusting renderer state.
 */
export async function loadMe(): Promise<void> {
  setRoleStatus("loading");
  // Prefer session-cookie /me — it carries role.
  try {
    const sessionApiBaseUrl = canonicalApiBaseUrl(getApiUrl());
    const sessionApiIdentityGeneration = captureApiIdentityGeneration();
    const res = await apiAuth.getAuthMe();
    if (res.data && typeof res.data.role === "string") {
      const currentApiBaseUrl = canonicalApiBaseUrl(getApiUrl());
      const sessionPrincipal = canonicalSessionPrincipal(
        res.data.user_id,
        res.data.tenant_id,
        sessionApiBaseUrl && sessionApiBaseUrl === currentApiBaseUrl
          ? sessionApiBaseUrl
          : null,
        sessionApiIdentityGeneration !== null &&
          apiIdentityGenerationIsCurrent(sessionApiIdentityGeneration)
          ? sessionApiIdentityGeneration
          : null,
      );
      const durable = normalizeRole(res.data.role);
      // SUB-091: gate the UI on effective_role (the down-only preview
      // role) when present, else the durable role. Older servers that
      // predate SUB-091 omit effective_role → fall back to durable.
      const effective =
        typeof res.data.effective_role === "string" && res.data.effective_role
          ? normalizeRole(res.data.effective_role)
          : durable;
      const webhookPlaygroundRecoveryScope = sessionPrincipal
        ? await deriveWebhookPlaygroundFireRecoveryScope({
            apiBaseUrl: sessionPrincipal.apiBaseUrl,
            credentialSource: "session",
            principal: sessionPrincipal.user,
            tenant: sessionPrincipal.tenant,
          })
        : null;
      const sessionIdentityStillCurrent =
        sessionApiIdentityGeneration !== null &&
        apiIdentityGenerationIsCurrent(sessionApiIdentityGeneration) &&
        sessionApiBaseUrl === canonicalApiBaseUrl(getApiUrl());
      const qualifiedSessionPrincipal = sessionIdentityStillCurrent
        ? sessionPrincipal
        : null;
      registerVerifiedWebhookPlaygroundFireScope(
        sessionIdentityStillCurrent &&
          sessionApiIdentityGeneration !== null &&
          webhookPlaygroundRecoveryScope
          ? {
              apiIdentityGeneration: sessionApiIdentityGeneration,
              credentialSource: "session",
              recoveryScope: webhookPlaygroundRecoveryScope,
            }
          : null,
      );
      setMe(
        {
          user: res.data.user_id,
          tenant: res.data.tenant_id,
          credentialSource: "session",
          credentialFingerprint: null,
          webhookPlaygroundRecoveryScope: sessionIdentityStillCurrent
            ? webhookPlaygroundRecoveryScope
            : null,
          role: durable,
          effectiveRole: effective,
          telemetryIdentity: qualifiedSessionPrincipal
            ? {
                apiBaseUrl: qualifiedSessionPrincipal.apiBaseUrl,
                tenant: qualifiedSessionPrincipal.tenant,
                user: qualifiedSessionPrincipal.user,
              }
            : null,
          noteRecoveryPrincipal: qualifiedSessionPrincipal
            ? { ...qualifiedSessionPrincipal }
            : null,
        },
        "resolved",
      );
      setCanUseViewerMode(res.data.can_use_viewer_mode === true);
      return;
    }
  } catch {
    /* fall through to API-key path */
  }
  // API-key path: self-info is authenticated by the native bearer broker and
  // returns the authoritative tenant + scopes for this exact credential.
  try {
    const apiKeyApiUrl = getApiUrl();
    const apiKeyApiIdentityGeneration = captureApiIdentityGeneration();
    const res = await api.getApiKeySelfInfo();
    if (res.data?.tenant_id) {
      const credentialFingerprint = await currentApiKeyCredentialFingerprint(
        apiKeyApiUrl,
        apiKeyApiIdentityGeneration,
      );
      const webhookPlaygroundRecoveryScope = credentialFingerprint
        ? await deriveWebhookPlaygroundFireRecoveryScope({
            apiBaseUrl: apiKeyApiUrl,
            credentialSource: "api-key",
            principal: credentialFingerprint,
            tenant: res.data.tenant_id,
          })
        : null;
      const apiKeyIdentityStillCurrent =
        apiKeyApiIdentityGeneration !== null &&
        apiIdentityGenerationIsCurrent(apiKeyApiIdentityGeneration) &&
        canonicalApiBaseUrl(apiKeyApiUrl) === canonicalApiBaseUrl(getApiUrl());
      if (!apiKeyIdentityStillCurrent) {
        registerVerifiedWebhookPlaygroundFireScope(null);
        setMe(null, "unavailable");
        setCanUseViewerMode(false);
        return;
      }
      const scopes = new Set(res.data.scopes ?? []);
      const role: Role = scopes.has("admin")
        ? "admin"
        : scopes.has("write") ||
            [...scopes].some((scope) => scope.startsWith("write:"))
          ? "editor"
          : "viewer";
      registerVerifiedWebhookPlaygroundFireScope(
        apiKeyApiIdentityGeneration !== null && webhookPlaygroundRecoveryScope
          ? {
              apiIdentityGeneration: apiKeyApiIdentityGeneration,
              credentialSource: "api-key",
              recoveryScope: webhookPlaygroundRecoveryScope,
            }
          : null,
      );
      setMe(
        {
          user: res.data.actor?.trim() || "api-key",
          tenant: res.data.tenant_id,
          credentialSource: "api-key",
          credentialFingerprint,
          webhookPlaygroundRecoveryScope,
          role,
          effectiveRole: role,
          telemetryIdentity: null,
          noteRecoveryPrincipal: null,
        },
        "resolved",
      );
      setCanUseViewerMode(false);
      return;
    }
  } catch {
    /* ignore */
  }
  registerVerifiedWebhookPlaygroundFireScope(null);
  setMe(null, "unavailable");
  setCanUseViewerMode(false);
}

/**
 * Hook: returns the current user's EFFECTIVE role (the one the UI gates
 * on), or null if unknown. When View-as-Viewer preview is active this is
 * the down-only preview role; otherwise it equals the durable role.
 */
export function useRole(): Role | null {
  const me = useStoreSlice((s) => s.me);
  return me ? me.effectiveRole : null;
}

export function useRoleStatus(): RoleStatus {
  return useStoreSlice((s) => s.roleStatus);
}

/**
 * Hook: returns the durable account role (users.role), ignoring any
 * active View-as-Viewer preview. Use this only for "your account is an
 * admin"-style display, NOT for gating destructive UI.
 */
export function useDurableRole(): Role | null {
  const me = useStoreSlice((s) => s.me);
  return me ? me.role : null;
}

/** Hook: returns the current `me` projection (or null). */
export function useMe(): Me | null {
  return useStoreSlice((s) => s.me);
}

/** Read-only provenance-qualified pair used by the telemetry owner. */
export function readTelemetryIdentity(): TelemetryIdentity | null {
  return state.me?.telemetryIdentity ?? null;
}

export function readCredentialSource(): Me["credentialSource"] | null {
  return state.me?.credentialSource ?? null;
}

/** Exact non-secret API-key identity retained only in the in-memory Me. */
export function readCredentialFingerprint(): string | null {
  return state.me?.credentialFingerprint ?? null;
}

export function readNoteRecoveryPrincipal(): NoteRecoveryPrincipal | null {
  return state.me?.noteRecoveryPrincipal ?? null;
}

/**
 * Can the current user perform "write" actions (create / edit / delete
 * / send)? True for admin + editor, false for viewer.
 *
 * If `me` is null or the API-key identity lacks role metadata, default to
 * FALSE. The server is still the final authority, but the UI must not show
 * destructive affordances before identity is resolved.
 */
export function canWrite(role?: Role | null): boolean {
  // SUB-091: default to the EFFECTIVE role so View-as-Viewer preview
  // actually gates write affordances.
  const r = role !== undefined ? role : state.me?.effectiveRole;
  if (!r) return false;
  return r === "admin" || r === "editor";
}

/**
 * Can the current user perform admin-only actions (API-key CRUD,
 * suppression delete, custom-domain delete, billing changes,
 * member management)?
 *
 * If `me` is null or unresolved, defaults to FALSE.
 */
export function canAdmin(role?: Role | null): boolean {
  // SUB-091: default to the EFFECTIVE role (preview-aware).
  const r = role !== undefined ? role : state.me?.effectiveRole;
  if (!r) return false;
  return r === "admin";
}

/**
 * Hook variant of {@link canWrite}. Re-renders when role changes.
 */
export function useCanWrite(): boolean {
  return canWrite(useRole());
}

/**
 * Hook variant of {@link canAdmin}. Re-renders when role changes.
 */
export function useCanAdmin(): boolean {
  return canAdmin(useRole());
}

/* ---------- SUB-091: View-as-Viewer preview ------------------------- */

/** Hook: is the session currently previewing as a lower-privilege role? */
export const useViewerModeActive = (): boolean =>
  useStoreSlice((s) => s.viewerModeActive);

/** Hook: may the durable role activate the preview at all (admin/owner)? */
export const useCanUseViewerMode = (): boolean =>
  useStoreSlice((s) => s.canUseViewerMode);

/**
 * Toggle the per-session View-as-Viewer preview. Calls the backend
 * (PATCH /api/v1/auth/me/viewer-mode), then re-reads /me so the derived
 * `me.effectiveRole` + `viewerModeActive` slice reflect the server's
 * authoritative answer.
 *
 * @param enabled true → enter preview, false → exit.
 * @param role optional preview role (default "viewer" server-side); must
 *             be a strict downgrade of the durable role.
 * @returns true on success, false if the server rejected (e.g. 403 for a
 *          non-admin or an attempted escalation).
 */
export async function toggleViewerMode(
  enabled: boolean,
  role?: Role,
): Promise<boolean> {
  try {
    const res = await apiAuth.setViewerMode({ enabled, role });
    if (res.error) return false;
    // Re-resolve identity so effectiveRole + viewerModeActive update.
    await loadMe();
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign out: wipe local credentials and reload to land on Welcome.
 * Doesn't hit the API — the API key is the only auth artifact and
 * removing it is sufficient for "log out of this device".
 */
export async function signOut(): Promise<void> {
  // Single source of truth for sign-out cleanup (D02#10). This used to do
  // a PARTIAL subset (server logout + clearApiConfig + clearOfflineStores),
  // so signing out via the workspace menu left the per-workspace keychain
  // keys, the persisted query cache, the remembered-session hint, and the
  // telemetry identity behind — a divergence from auth.fullSignOut (used by
  // the account menu). Delegate to the full path, then reload to Welcome.
  const result = await requestFullSignOut();
  if (result !== "proceeded") return;
  try {
    window.location.reload();
  } catch {
    /* tests / SSR */
  }
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to a *slice* of the store. React's `useSyncExternalStore`
 * bails out when `getSnapshot()` returns the same reference as last
 * call — so for primitive slices (string/boolean/number) bailout is
 * automatic via Object.is, and unrelated state mutations don't trigger
 * re-renders.
 *
 * For non-primitive slices (objects, arrays) you'd want a memoising
 * variant — when we need one we can add it. The selectors below all
 * return primitives or nullable refs that don't churn.
 *
 *   const section = useSection();         // string
 *   const theme   = useTheme();           // 'dark' | 'light'
 *   const choice  = useThemePreference(); // 'system' | 'dark' | 'light'
 *
 * Two consumers of different slices won't trigger each other's
 * re-renders any more — kills the AppShell-wide broadcast that the
 * full `useStore()` causes.
 */
function useStoreSlice<T>(selector: (state: AppState) => T): T {
  const get = (): T => selector(state);
  return useSyncExternalStore(subscribe, get, get);
}

/** Common selectors. Prefer these over `useStore().x` for single-slice
 *  reads — they keep the AppShell subtree from re-rendering on
 *  unrelated state changes. */
export const useSection = (): Section =>
  useStoreSlice<Section>((s) => s.section);
export const useConn = (): ConnState => useStoreSlice<ConnState>((s) => s.conn);
export const useTheme = (): Theme => useStoreSlice<Theme>((s) => s.theme);
export const useThemePreference = (): ThemePreference =>
  useStoreSlice<ThemePreference>((s) => s.themePreference);
export const useCommandOpen = (): boolean =>
  useStoreSlice((s) => s.commandOpen);
export const useLiveSubs = (): LiveSubs | null =>
  useStoreSlice((s) => s.liveSubs);
export const useActiveSend = (): ActiveSend | null =>
  useStoreSlice((s) => s.activeSend);

/** Compatibility aliases derived from the canonical shortcut registry. */
export const NUMERIC_SECTIONS = NUMERIC_SHORTCUT_SECTIONS;

/** Non-digit letter shortcuts. Avoiding letters that collide with OS /
 * browser bindings (W=close, T=new tab, N=new window, etc). The few
 * letter shortcuts here are mnemonic for the high-frequency surfaces
 * the X1+X2+X3 audience expansion added; everything else is reachable
 * via ⌘K palette + sidebar click.
 *
 * `m` (Migrations) was removed: ⌘M is macOS Minimize and the native
 * menu intercepts it before the webview. No obviously-free mnemonic
 * letter remains, so Migrations is palette/sidebar-only. */
export const LETTER_SECTIONS = LETTER_SHORTCUT_SECTIONS;

/** "Go-to" navigation (Linear-style): press G, then one of these keys, to
 * jump to a top section — no modifier. Keyed by the second key, lowercased.
 * Letters are mnemonic and collision-free: d=Dashboard, s=Subscribers,
 * c=Campaigns, q=seQuences, u=aUtomations, e=sEgments, a=Analytics,
 * f=Forms, t=Templates. */
export const GOTO_SECTIONS = GOTO_SHORTCUT_SECTIONS;

/** Map a Tauri tray/menu event payload to a section, when possible. */
export function eventToSection(event: string): Section | null {
  switch (event) {
    case "menu:dashboard":
    case "tray:open":
      return "dashboard";
    case "menu:new-campaign":
    case "tray:new-campaign":
      return "campaigns";
    case "menu:settings":
    case "tray:settings":
      return "settings";
    case "menu:approvals":
      return "approvals";
    default:
      return null;
  }
}

/* ---------- presence (realtime event-bus) --------------------------- */

/**
 * Per-tenant presence snapshot, populated from `presence.update` events
 * on the realtime event-bus. The Go `events.Presence` tracker emits a
 * fresh snapshot every time someone connects or disconnects, so this
 * slice always mirrors the live count.
 *
 * `users` is a list of opaque labels (currently `user-N` placeholders
 * until identity is plumbed through on the server). The desktop avatar
 * stack just renders initials, so the wire format is intentionally
 * loose.
 */
export interface PresenceSlice {
  count: number;
  users: string[];
}

/**
 * Subscribe to live presence in a React component:
 *
 *   const { count, users } = usePresence();
 */
export interface AppStateWithPresence extends AppState {
  presence: PresenceSlice;
}

let presence: PresenceSlice = { count: 0, users: [] };
const presenceListeners = new Set<() => void>();

/**
 * Setter for the presence slice. Called from the EventBus subscriber
 * inside <PresenceIndicator /> when a `presence.update` event arrives.
 * Idempotent on no-change to avoid spurious re-renders.
 */
export function setPresence(next: PresenceSlice): void {
  if (
    presence.count === next.count &&
    presence.users.length === next.users.length &&
    presence.users.every((u, i) => u === next.users[i])
  ) {
    return;
  }
  presence = { count: next.count, users: next.users.slice() };
  for (const fn of presenceListeners) {
    try {
      fn();
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[postwave-store] presence listener threw");
    }
  }
}

/** Hook into the presence slice. Re-renders on any change. */
export function usePresence(): PresenceSlice {
  return useSyncExternalStore(
    (cb) => {
      presenceListeners.add(cb);
      return () => {
        presenceListeners.delete(cb);
      };
    },
    () => presence,
    () => presence,
  );
}

/* ---------- end presence ------------------------------------------- */

/** Map a deep-link path string into a section. */
export function pathToSection(path: string | null): Section | null {
  if (!path) return null;
  const parsed = parseDesktopRoute(path);
  return parsed.ok ? parsed.route.section : null;
}
