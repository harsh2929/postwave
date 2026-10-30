/** Corpus-derived voice profile and source controls for the AI inspector. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import "../../styles-postwave-ai-context.css";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  boundedDisplayText,
  inspectorFailureMessage,
  safeDateTime,
} from "./contextual-inspector-helpers";

const MAX_SOURCE_URL = 2048;
const MAX_SOURCES = 100;
const MAX_PROFILE_SAMPLES = 5;

interface ProfileView {
  description: string | null;
  version: string;
  builtAt: string | null;
  samples: string[];
}

type SourceTone = "ready" | "warning" | "danger" | "neutral";

interface SourceView {
  id: string;
  label: string;
  status: string;
  tone: SourceTone;
}

type Mutation =
  | { kind: "add" }
  | { kind: "build" }
  | { kind: "delete"; id: string }
  | { kind: "ingest"; id: string };

interface VoiceProfileViewProps {
  profile: ProfileView | null;
  sources: SourceView[];
  loading: boolean;
  verified: boolean;
  unavailable: boolean;
  loadError: string | null;
  mutation: Mutation | null;
  newUrl: string;
  pendingDelete: SourceView | null;
  canMutate: boolean;
  guidanceId: string;
  urlId: string;
  guidance: string;
  mutationBusy: boolean;
  hasIngestedSource: boolean;
  trimmedUrl: string;
  urlValid: boolean;
  urlHelp: string;
  onNewUrlChange: (value: string) => void;
  onReload: (showLoading?: boolean) => Promise<void>;
  onRebuild: () => Promise<void>;
  onAddSource: () => Promise<void>;
  onIngest: (source: SourceView) => Promise<void>;
  onRequestDelete: (source: SourceView) => void;
  onConfirmRemove: () => Promise<void>;
  onCloseDelete: () => void;
}

function timestamp(value: unknown): string | null {
  return safeDateTime(value);
}

function decodeSamples(profile: Record<string, unknown>): string[] | null {
  const modeled = profile["samples"];
  const representatives = profile["representative_samples"];
  const raw = Array.isArray(modeled)
    ? modeled
    : Array.isArray(representatives)
      ? representatives.map((sample) =>
          sample && typeof sample === "object"
            ? (sample as Record<string, unknown>)["text"]
            : sample,
        )
      : [];
  if (raw.length > 100) return null;
  const samples: string[] = [];
  for (const candidate of raw) {
    const sample = boundedDisplayText(candidate, 1000);
    if (candidate != null && !sample) return null;
    if (sample) samples.push(sample);
  }
  return samples.slice(0, MAX_PROFILE_SAMPLES);
}

function decodeProfile(value: unknown): ProfileView | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Record<string, unknown>;
  const samples = decodeSamples(profile);
  if (!samples) return null;
  const rawVersion = profile["version"];
  const version =
    typeof rawVersion === "number" &&
    Number.isSafeInteger(rawVersion) &&
    rawVersion > 0
      ? `v${rawVersion}`
      : "Available";
  return {
    description: boundedDisplayText(profile["description"], 400),
    version,
    builtAt:
      timestamp(profile["built_at"]) ?? timestamp(profile["generated_at"]),
    samples,
  };
}

function sourceArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  for (const key of ["sources", "items", "data"] as const) {
    if (Array.isArray(envelope[key])) return envelope[key] as unknown[];
  }
  return null;
}

function sourceStatus(source: Record<string, unknown>): {
  label: string;
  tone: SourceTone;
} {
  const explicit = boundedDisplayText(source["status"], 40)?.toLowerCase();
  if (explicit === "ready" || explicit === "ingested") {
    return { label: "Ingested", tone: "ready" };
  }
  if (explicit === "failed") {
    return { label: "Ingest failed", tone: "danger" };
  }
  if (explicit === "ingesting" || explicit === "running") {
    return { label: "Ingest in progress", tone: "warning" };
  }
  if (explicit === "pending" || explicit === "queued") {
    return { label: "Not ingested yet", tone: "neutral" };
  }
  const ingestedAt =
    timestamp(source["last_ingested_at"]) ?? timestamp(source["ingested_at"]);
  if (ingestedAt) {
    const count = source["last_item_count"];
    return {
      label:
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0
          ? `${count.toLocaleString()} item${count === 1 ? "" : "s"} ingested`
          : "Ingested",
      tone: "ready",
    };
  }
  return { label: "Not ingested yet", tone: "neutral" };
}

function decodeSources(payload: unknown): SourceView[] | null {
  const raw = sourceArray(payload);
  if (!raw || raw.length > MAX_SOURCES) return null;
  const sources: SourceView[] = [];
  const ids = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return null;
    const source = candidate as Record<string, unknown>;
    const id = boundedDisplayText(source["id"], 200);
    if (!id || ids.has(id)) return null;
    ids.add(id);
    const params =
      source["params"] && typeof source["params"] === "object"
        ? (source["params"] as Record<string, unknown>)
        : {};
    const label =
      boundedDisplayText(source["label"], 600) ??
      boundedDisplayText(source["url"], 600) ??
      boundedDisplayText(params["FeedURL"], 600) ??
      boundedDisplayText(source["type"], 80) ??
      boundedDisplayText(source["kind"], 80) ??
      "Source label unavailable";
    const state = sourceStatus(source);
    sources.push({ id, label, status: state.label, tone: state.tone });
  }
  return sources;
}

function validSourceUrl(value: string): boolean {
  if (!value || value.length > MAX_SOURCE_URL) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function VoiceProfileCard(): ReactElement {
  const canMutate = useCanAdmin();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [newUrl, setNewUrl] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SourceView | null>(null);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const mutationRef = useRef(false);
  const guidanceId = useId();
  const urlId = useId();

  const reload = useCallback(async (showLoading = true): Promise<void> => {
    // Deliberately allow a newer verification request to supersede an older
    // one. React StrictMode replays mount effects in development: treating the
    // first request as an unjoinable boolean "flight" lets cleanup invalidate
    // it while the replayed effect is refused, leaving the card busy forever.
    // The monotonically increasing request id keeps this latest-wins without
    // permitting a stale response to overwrite verified state.
    const requestId = ++loadRequestRef.current;
    if (showLoading) setLoading(true);
    setLoadError(null);
    let responses: [
      Awaited<ReturnType<typeof api.getVoiceProfile>>,
      Awaited<ReturnType<typeof api.listVoiceSources>>,
    ];
    try {
      responses = await Promise.all([
        api.getVoiceProfile(),
        api.listVoiceSources(),
      ]);
    } catch (caught) {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return;
      setVerified(false);
      setUnavailable(false);
      setLoadError(inspectorFailureMessage(caught, "profile-load"));
      setLoading(false);
      return;
    }
    if (!mountedRef.current || requestId !== loadRequestRef.current) return;
    const [profileResponse, sourcesResponse] = responses;
    const unavailableFailure = [profileResponse, sourcesResponse]
      .map((response) => response.error)
      .find(
        (error) =>
          error?.status === 502 ||
          error?.status === 503 ||
          error?.kind === "invalid_config",
      );
    if (unavailableFailure) {
      setVerified(false);
      setUnavailable(true);
      setLoadError(inspectorFailureMessage(unavailableFailure, "profile-load"));
      setLoading(false);
      return;
    }
    setUnavailable(false);
    if (profileResponse.error && profileResponse.error.status !== 404) {
      setVerified(false);
      setLoadError(
        inspectorFailureMessage(profileResponse.error, "profile-load"),
      );
      setLoading(false);
      return;
    }
    if (sourcesResponse.error) {
      setVerified(false);
      setLoadError(
        inspectorFailureMessage(sourcesResponse.error, "profile-load"),
      );
      setLoading(false);
      return;
    }
    const decodedProfile = profileResponse.error
      ? null
      : decodeProfile(profileResponse.data);
    const decodedSources = decodeSources(sourcesResponse.data);
    if ((!profileResponse.error && !decodedProfile) || !decodedSources) {
      setVerified(false);
      setLoadError(inspectorFailureMessage({ kind: "parse" }, "profile-load"));
      setLoading(false);
      return;
    }
    setProfile(decodedProfile);
    setSources(decodedSources);
    setVerified(true);
    setLoadError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, [reload]);

  const finishMutation = async (success: string): Promise<void> => {
    if (!mountedRef.current) return;
    toast.success(success);
    await reload(false);
  };

  const addSource = async (): Promise<void> => {
    const url = newUrl.trim();
    if (
      !canMutate ||
      !verified ||
      loading ||
      mutationRef.current ||
      !validSourceUrl(url)
    ) {
      return;
    }
    mutationRef.current = true;
    setMutation({ kind: "add" });
    try {
      const response = await api.createVoiceSource({ kind: "url", url });
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error(inspectorFailureMessage(response.error, "profile-mutate"));
        return;
      }
      setNewUrl((current) => (current.trim() === url ? "" : current));
      await finishMutation(
        "Source registered. Start ingest when you're ready to fetch its content.",
      );
    } catch (caught) {
      if (mountedRef.current) {
        toast.error(inspectorFailureMessage(caught, "profile-mutate"));
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setMutation(null);
    }
  };

  const ingest = async (source: SourceView): Promise<void> => {
    if (!canMutate || !verified || mutationRef.current) return;
    mutationRef.current = true;
    setMutation({ kind: "ingest", id: source.id });
    try {
      const response = await api.ingestVoiceSource(source.id);
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error(inspectorFailureMessage(response.error, "profile-mutate"));
        return;
      }
      await finishMutation(
        "Ingest request accepted. Refresh status after it settles to verify the result.",
      );
    } catch (caught) {
      if (mountedRef.current) {
        toast.error(inspectorFailureMessage(caught, "profile-mutate"));
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setMutation(null);
    }
  };

  const confirmRemove = async (): Promise<void> => {
    if (!pendingDelete || !canMutate || !verified || mutationRef.current)
      return;
    const target = pendingDelete;
    mutationRef.current = true;
    setMutation({ kind: "delete", id: target.id });
    try {
      const response = await api.deleteVoiceSource(target.id);
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error(inspectorFailureMessage(response.error, "profile-mutate"));
        return;
      }
      setPendingDelete(null);
      await finishMutation("Voice source deleted.");
    } catch (caught) {
      if (mountedRef.current) {
        toast.error(inspectorFailureMessage(caught, "profile-mutate"));
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setMutation(null);
    }
  };

  const rebuild = async (): Promise<void> => {
    const hasIngestedSource = sources.some((source) => source.tone === "ready");
    if (!canMutate || !verified || !hasIngestedSource || mutationRef.current) {
      return;
    }
    mutationRef.current = true;
    setMutation({ kind: "build" });
    try {
      const response = await api.buildVoiceProfile();
      if (!mountedRef.current) return;
      if (response.error) {
        toast.error(inspectorFailureMessage(response.error, "profile-mutate"));
        return;
      }
      await finishMutation(
        "Rebuild request accepted. Refresh status after it finishes to verify a new profile version.",
      );
    } catch (caught) {
      if (mountedRef.current) {
        toast.error(inspectorFailureMessage(caught, "profile-mutate"));
      }
    } finally {
      mutationRef.current = false;
      if (mountedRef.current) setMutation(null);
    }
  };

  const mutationBusy = mutation !== null;
  const hasIngestedSource = sources.some((source) => source.tone === "ready");
  const trimmedUrl = newUrl.trim();
  const urlValid = validSourceUrl(trimmedUrl);
  const urlHelp = !trimmedUrl
    ? "Enter a complete HTTP or HTTPS feed URL without embedded credentials."
    : urlValid
      ? "URL is valid and ready to register."
      : `Use a complete HTTP or HTTPS URL of ${MAX_SOURCE_URL.toLocaleString()} characters or fewer, without embedded credentials.`;
  const guidance = !canMutate
    ? "Admin access is required to register, ingest, delete, or rebuild tenant voice sources."
    : !verified
      ? "Voice controls stay locked until both the profile and source list are verified."
      : mutationBusy
        ? "One voice-profile operation is settling. Keep this page open until the refresh finishes."
        : !hasIngestedSource
          ? "Register and successfully ingest at least one source before requesting a rebuild. Refresh status after an ingest settles."
          : "Ingest fetches source content. Rebuild then requests a new corpus-derived profile and may be rate-limited.";

  return (
    <VoiceProfileView
      profile={profile}
      sources={sources}
      loading={loading}
      verified={verified}
      unavailable={unavailable}
      loadError={loadError}
      mutation={mutation}
      newUrl={newUrl}
      pendingDelete={pendingDelete}
      canMutate={canMutate}
      guidanceId={guidanceId}
      urlId={urlId}
      guidance={guidance}
      mutationBusy={mutationBusy}
      hasIngestedSource={hasIngestedSource}
      trimmedUrl={trimmedUrl}
      urlValid={urlValid}
      urlHelp={urlHelp}
      onNewUrlChange={setNewUrl}
      onReload={reload}
      onRebuild={rebuild}
      onAddSource={addSource}
      onIngest={ingest}
      onRequestDelete={setPendingDelete}
      onConfirmRemove={confirmRemove}
      onCloseDelete={() => {
        if (!mutationRef.current) setPendingDelete(null);
      }}
    />
  );
}

function VoiceProfileView({
  profile,
  sources,
  loading,
  verified,
  unavailable,
  loadError,
  mutation,
  newUrl,
  pendingDelete,
  canMutate,
  guidanceId,
  urlId,
  guidance,
  mutationBusy,
  hasIngestedSource,
  trimmedUrl,
  urlValid,
  urlHelp,
  onNewUrlChange,
  onReload,
  onRebuild,
  onAddSource,
  onIngest,
  onRequestDelete,
  onConfirmRemove,
  onCloseDelete,
}: VoiceProfileViewProps): ReactElement {
  const urlHelpId = `${urlId}-help`;
  return (
    <section
      className="card ai-context-card"
      aria-labelledby="voice-profile-title"
      aria-busy={loading || mutationBusy}
    >
      <header className="ai-context-header">
        <div className="ai-context-header-copy">
          <span className="ai-context-kicker">Corpus voice</span>
          <h3 id="voice-profile-title" className="ai-context-title">
            Voice profile
          </h3>
          <p className="ai-context-copy">
            {profile?.description ??
              "A corpus-derived profile that supported AI workflows can request as context."}
          </p>
        </div>
        {verified ? (
          <div className="ai-context-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void onReload()}
              disabled={mutationBusy || loading}
            >
              Refresh status
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void onRebuild()}
              disabled={mutationBusy || loading}
              aria-disabled={
                !canMutate || !hasIngestedSource ? true : undefined
              }
              aria-describedby={guidanceId}
            >
              {mutation?.kind === "build"
                ? "Requesting rebuild…"
                : "Rebuild from sources"}
            </button>
          </div>
        ) : null}
      </header>

      <p
        id={guidanceId}
        className="ai-context-guidance"
        data-tone={!canMutate || !verified ? "locked" : undefined}
        role="status"
        aria-live="polite"
      >
        {guidance}
      </p>

      {loading ? (
        <div className="ai-context-loading" role="status">
          <span className="sr-only">Loading voice profile and sources…</span>
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
        </div>
      ) : unavailable || loadError || !verified ? (
        <Notice
          tone="danger"
          announcement="assertive"
          className="ai-context-notice"
          action={
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void onReload()}
              disabled={loading || mutationBusy}
            >
              Retry load
            </button>
          }
        >
          {loadError ?? "Voice-profile data couldn't be verified."}
        </Notice>
      ) : (
        <>
          <div className="ai-context-stat-grid">
            <Stat label="Profile" value={profile?.version ?? "Not built"} />
            <Stat label="Last built" value={profile?.builtAt ?? "Not built"} />
          </div>

          {profile?.samples.length ? (
            <section
              className="ai-context-section"
              aria-labelledby={`${urlId}-samples`}
            >
              <div className="ai-context-section-heading">
                <h4 id={`${urlId}-samples`} className="ai-context-label">
                  Representative samples
                </h4>
                <span className="ai-context-meta">
                  Returned by the current profile
                </span>
              </div>
              <ul className="ai-context-samples">
                {profile.samples.map((sample, index) => (
                  <li key={`${index}-${sample.slice(0, 32)}`}>{sample}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section
            className="ai-context-section"
            aria-labelledby={`${urlId}-sources`}
          >
            <div className="ai-context-section-heading">
              <h4 id={`${urlId}-sources`} className="ai-context-label">
                Registered sources
              </h4>
              <span className="ai-context-meta">
                {sources.length.toLocaleString()} source
                {sources.length === 1 ? "" : "s"}
              </span>
            </div>
            <form
              className="ai-voice-source-form"
              onSubmit={(event) => {
                event.preventDefault();
                void onAddSource();
              }}
            >
              <label htmlFor={urlId} className="sr-only">
                Voice feed URL
              </label>
              <input
                id={urlId}
                className="ai-voice-source-input"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://example.com/feed.xml"
                value={newUrl}
                aria-label="Voice feed URL"
                maxLength={MAX_SOURCE_URL}
                onChange={(event) => onNewUrlChange(event.target.value)}
                readOnly={!canMutate || mutationBusy}
                aria-describedby={`${guidanceId} ${urlHelpId}`}
                aria-invalid={trimmedUrl.length > 0 && !urlValid}
              />
              <button
                type="submit"
                className="btn btn-sm"
                disabled={mutationBusy}
                aria-disabled={!canMutate || !urlValid ? true : undefined}
                aria-describedby={`${guidanceId} ${urlHelpId}`}
              >
                {mutation?.kind === "add" ? "Registering…" : "Add URL"}
              </button>
            </form>
            <p
              id={urlHelpId}
              className="ai-context-meta"
              role="status"
              aria-live="polite"
            >
              {urlHelp}
            </p>
            {sources.length === 0 ? (
              <p className="ai-context-empty">
                No sources are registered. Adding a feed URL only registers it;
                fetching its content remains a separate, explicit ingest action.
              </p>
            ) : (
              <ul className="ai-context-list ai-voice-source-list">
                {sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    busy={mutationBusy}
                    ingesting={
                      mutation?.kind === "ingest" && mutation.id === source.id
                    }
                    blocked={!canMutate}
                    guidanceId={guidanceId}
                    onIngest={() => void onIngest(source)}
                    onDelete={() => onRequestDelete(source)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete voice source?"
        description={`${pendingDelete ? `“${pendingDelete.label}”` : "This source"} will be excluded from future rebuilds. The currently displayed profile will not change until a later rebuild completes.`}
        confirmLabel="Delete source"
        danger
        busy={mutation?.kind === "delete"}
        onConfirm={onConfirmRemove}
        onClose={onCloseDelete}
      />
    </section>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="ai-context-stat">
      <span className="ai-context-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SourceRow({
  source,
  busy,
  ingesting,
  blocked,
  guidanceId,
  onIngest,
  onDelete,
}: {
  source: SourceView;
  busy: boolean;
  ingesting: boolean;
  blocked: boolean;
  guidanceId: string;
  onIngest: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <li className="ai-voice-source-row">
      <div className="ai-voice-source-copy">
        <span className="ai-voice-source-name">{source.label}</span>
        <span className="ai-voice-source-state" data-state={source.tone}>
          {source.status}
        </span>
      </div>
      <div className="ai-voice-source-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (!blocked) onIngest();
          }}
          disabled={busy}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={guidanceId}
        >
          {ingesting ? "Requesting…" : "Re-ingest"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            if (!blocked) onDelete();
          }}
          disabled={busy}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={guidanceId}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
