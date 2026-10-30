/** Tenant-wide, admin-authored brand-voice profile editor. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDiscardOnlyDraftLifecycle } from "../../hooks/useSettingsDraftLifecycle";
import { api } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import "../../styles-postwave-ai-context.css";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  inspectorFailureMessage,
  safeDateTime,
  utf8ByteLength,
} from "./contextual-inspector-helpers";

interface Props {
  maxDescriptors?: number;
  maxRules?: number;
  maxSnippets?: number;
}

interface ProfileMeta {
  updatedAt: string | null;
  extractedAt: string | null;
}

interface BrandVoiceViewProps {
  maxDescriptors: number;
  maxRules: number;
  maxSnippets: number;
  canEdit: boolean;
  profileMeta: ProfileMeta | null;
  verified: boolean;
  loading: boolean;
  saving: boolean;
  descText: string;
  rulesText: string;
  snipsText: string;
  loadError: string | null;
  saveError: string | null;
  descriptorId: string;
  rulesId: string;
  snippetsId: string;
  guidanceId: string;
  limitsId: string;
  descriptors: string[];
  writingRules: string[];
  sampleSnippets: string[];
  descriptorOversize: number | null;
  ruleOversize: number | null;
  snippetOversize: number | null;
  validationError: string | null;
  dirty: boolean;
  fieldReadOnly: boolean;
  guidance: string;
  onLoad: () => Promise<void>;
  onSave: () => Promise<void>;
  onDescriptorsChange: (value: string) => void;
  onRulesChange: (value: string) => void;
  onSnippetsChange: (value: string) => void;
}

const SERVER_MAX_DESCRIPTORS = 20;
const SERVER_MAX_RULES = 30;
const SERVER_MAX_SNIPPETS = 10;
const DESCRIPTOR_BYTES = 64;
const RULE_BYTES = 512;
const SNIPPET_BYTES = 4096;

function countCap(
  value: number | undefined,
  maximum: number,
  minimum = 0,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function snippetsFromText(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function snapshot(
  descriptors: string[],
  rules: string[],
  snippets: string[],
): string {
  return JSON.stringify([descriptors, rules, snippets]);
}

function decodeStringArray(
  value: unknown,
  maximumItems: number,
  maximumBytes: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const normalized = item.trim();
    if (!normalized) continue;
    if (utf8ByteLength(normalized) > maximumBytes) return null;
    result.push(normalized);
  }
  return result;
}

function decodeProfile(value: unknown): {
  descriptors: string[];
  rules: string[];
  snippets: string[];
  meta: ProfileMeta;
} | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Record<string, unknown>;
  const descriptors = decodeStringArray(
    profile["descriptors"],
    SERVER_MAX_DESCRIPTORS,
    DESCRIPTOR_BYTES,
  );
  const rules = decodeStringArray(
    profile["writing_rules"],
    SERVER_MAX_RULES,
    RULE_BYTES,
  );
  const snippets = decodeStringArray(
    profile["sample_snippets"],
    SERVER_MAX_SNIPPETS,
    SNIPPET_BYTES,
  );
  if (!descriptors || !rules || !snippets) return null;
  return {
    descriptors,
    rules,
    snippets,
    meta: {
      updatedAt: safeDateTime(profile["updated_at"]),
      extractedAt: safeDateTime(profile["extracted_at"]),
    },
  };
}

function firstOversize(values: string[], maximumBytes: number): number | null {
  const index = values.findIndex(
    (value) => utf8ByteLength(value) > maximumBytes,
  );
  return index < 0 ? null : index + 1;
}

export function BrandVoicePanel({
  maxDescriptors: requestedDescriptors,
  maxRules: requestedRules,
  maxSnippets: requestedSnippets,
}: Props = {}): ReactElement {
  const maxDescriptors = countCap(
    requestedDescriptors,
    SERVER_MAX_DESCRIPTORS,
    1,
  );
  const maxRules = countCap(requestedRules, SERVER_MAX_RULES);
  const maxSnippets = countCap(requestedSnippets, SERVER_MAX_SNIPPETS);
  const canEdit = useCanAdmin();
  const [profileMeta, setProfileMeta] = useState<ProfileMeta | null>(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [descText, setDescText] = useState("");
  const [rulesText, setRulesText] = useState("");
  const [snipsText, setSnipsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const saveRef = useRef(false);
  const savePromiseRef = useRef<Promise<unknown> | null>(null);
  const savedSnapshotRef = useRef(snapshot([], [], []));
  const savedDraftRef = useRef({ descriptors: "", rules: "", snippets: "" });
  const idPrefix = useId();
  const descriptorId = `${idPrefix}-descriptors`;
  const rulesId = `${idPrefix}-rules`;
  const snippetsId = `${idPrefix}-snippets`;
  const guidanceId = `${idPrefix}-guidance`;
  const limitsId = `${idPrefix}-limits`;

  const applyVerifiedProfile = useCallback(
    (decoded: ReturnType<typeof decodeProfile>): void => {
      if (!decoded) return;
      const descriptorDraft = decoded.descriptors.join("\n");
      const ruleDraft = decoded.rules.join("\n");
      const snippetDraft = decoded.snippets.join("\n\n");
      setProfileMeta(decoded.meta);
      setDescText(descriptorDraft);
      setRulesText(ruleDraft);
      setSnipsText(snippetDraft);
      savedSnapshotRef.current = snapshot(
        decoded.descriptors,
        decoded.rules,
        decoded.snippets,
      );
      savedDraftRef.current = {
        descriptors: descriptorDraft,
        rules: ruleDraft,
        snippets: snippetDraft,
      };
      setVerified(true);
    },
    [],
  );

  const load = useCallback(async (): Promise<void> => {
    // A later verification owns the result. This is intentionally latest-wins
    // instead of a boolean single-flight: React StrictMode performs
    // setup -> cleanup -> setup for mount effects, and cleanup invalidates the
    // first request. Refusing the replayed request would strand loading=true.
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    let response: Awaited<ReturnType<typeof api.getBrandVoiceProfile>>;
    try {
      response = await api.getBrandVoiceProfile();
    } catch (caught) {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return;
      setVerified(false);
      setLoadError(inspectorFailureMessage(caught, "brand-load"));
      setLoading(false);
      return;
    }
    if (!mountedRef.current || requestId !== loadRequestRef.current) return;
    setLoading(false);
    if (response.error) {
      if (response.error.status === 404) {
        setProfileMeta(null);
        setDescText("");
        setRulesText("");
        setSnipsText("");
        savedSnapshotRef.current = snapshot([], [], []);
        savedDraftRef.current = {
          descriptors: "",
          rules: "",
          snippets: "",
        };
        setVerified(true);
        return;
      }
      setVerified(false);
      setLoadError(inspectorFailureMessage(response.error, "brand-load"));
      return;
    }
    const decoded = decodeProfile(response.data);
    if (!decoded) {
      setVerified(false);
      setLoadError(inspectorFailureMessage({ kind: "parse" }, "brand-load"));
      return;
    }
    applyVerifiedProfile(decoded);
  }, [applyVerifiedProfile]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, [load]);

  const descriptors = nonEmptyLines(descText);
  const writingRules = nonEmptyLines(rulesText);
  const sampleSnippets = snippetsFromText(snipsText);
  const descriptorOversize = firstOversize(descriptors, DESCRIPTOR_BYTES);
  const ruleOversize = firstOversize(writingRules, RULE_BYTES);
  const snippetOversize = firstOversize(sampleSnippets, SNIPPET_BYTES);
  const currentSnapshot = snapshot(descriptors, writingRules, sampleSnippets);
  const dirty = currentSnapshot !== savedSnapshotRef.current;
  const validationError = !verified
    ? "Reload a verified profile before editing."
    : descriptors.length < 1
      ? "Add at least one descriptor before saving."
      : descriptors.length > maxDescriptors
        ? `Reduce descriptors to ${maxDescriptors} or fewer.`
        : descriptorOversize
          ? `Descriptor ${descriptorOversize} exceeds the ${DESCRIPTOR_BYTES}-byte limit.`
          : writingRules.length > maxRules
            ? `Reduce writing rules to ${maxRules} or fewer.`
            : ruleOversize
              ? `Writing rule ${ruleOversize} exceeds the ${RULE_BYTES}-byte limit.`
              : sampleSnippets.length > maxSnippets
                ? `Reduce sample snippets to ${maxSnippets} or fewer.`
                : snippetOversize
                  ? `Sample snippet ${snippetOversize} exceeds the ${SNIPPET_BYTES.toLocaleString()}-byte limit.`
                  : null;
  const discardDraft = useCallback((): void => {
    const saved = savedDraftRef.current;
    setDescText(saved.descriptors);
    setRulesText(saved.rules);
    setSnipsText(saved.snippets);
    setSaveError(null);
  }, []);
  useDiscardOnlyDraftLifecycle({
    ownerId: "brand-voice-profile",
    label: "Brand-voice draft",
    dirty,
    operationRef: savePromiseRef,
    discard: discardDraft,
    detail:
      "This brand-voice profile has unsaved descriptors, rules, or samples.",
  });

  const save = async (): Promise<void> => {
    if (!canEdit || !verified || validationError || !dirty || saveRef.current) {
      return;
    }
    saveRef.current = true;
    const submittedSnapshot = currentSnapshot;
    setSaving(true);
    setSaveError(null);
    let response: Awaited<ReturnType<typeof api.putBrandVoiceProfile>>;
    try {
      const request = api.putBrandVoiceProfile({
        descriptors,
        writing_rules: writingRules,
        sample_snippets: sampleSnippets,
      });
      savePromiseRef.current = request;
      response = await request;
    } catch (caught) {
      if (mountedRef.current) {
        setSaveError(inspectorFailureMessage(caught, "brand-save"));
      }
      return;
    } finally {
      saveRef.current = false;
      savePromiseRef.current = null;
      if (mountedRef.current) setSaving(false);
    }
    if (!mountedRef.current) return;
    if (response.error) {
      setSaveError(inspectorFailureMessage(response.error, "brand-save"));
      return;
    }
    const decoded = decodeProfile(response.data);
    if (!decoded) {
      setVerified(false);
      setSaveError(
        "The server accepted the request, but its response couldn't be verified. Reload the profile before making another change.",
      );
      return;
    }
    setProfileMeta(decoded.meta);
    savedSnapshotRef.current = submittedSnapshot;
    savedDraftRef.current = {
      descriptors: descText,
      rules: rulesText,
      snippets: snipsText,
    };
    toast.success("Brand voice profile saved");
  };

  const fieldReadOnly = !canEdit || saving || loading || !verified;
  const guidance = !canEdit
    ? "Admin access is required to edit this tenant-wide profile. The verified values remain readable."
    : loading
      ? "Verifying the saved brand-voice profile…"
      : !verified
        ? "Editing is paused until a saved profile can be verified."
        : saving
          ? "Saving this exact profile. Keep the page open until it finishes."
          : validationError
            ? validationError
            : dirty
              ? "Unsaved brand-voice changes are ready to save."
              : "The displayed profile matches the saved version last verified by this app.";

  return (
    <BrandVoiceView
      maxDescriptors={maxDescriptors}
      maxRules={maxRules}
      maxSnippets={maxSnippets}
      canEdit={canEdit}
      profileMeta={profileMeta}
      verified={verified}
      loading={loading}
      saving={saving}
      descText={descText}
      rulesText={rulesText}
      snipsText={snipsText}
      loadError={loadError}
      saveError={saveError}
      descriptorId={descriptorId}
      rulesId={rulesId}
      snippetsId={snippetsId}
      guidanceId={guidanceId}
      limitsId={limitsId}
      descriptors={descriptors}
      writingRules={writingRules}
      sampleSnippets={sampleSnippets}
      descriptorOversize={descriptorOversize}
      ruleOversize={ruleOversize}
      snippetOversize={snippetOversize}
      validationError={validationError}
      dirty={dirty}
      fieldReadOnly={fieldReadOnly}
      guidance={guidance}
      onLoad={load}
      onSave={save}
      onDescriptorsChange={setDescText}
      onRulesChange={setRulesText}
      onSnippetsChange={setSnipsText}
    />
  );
}

function BrandVoiceView({
  maxDescriptors,
  maxRules,
  maxSnippets,
  canEdit,
  profileMeta,
  verified,
  loading,
  saving,
  descText,
  rulesText,
  snipsText,
  loadError,
  saveError,
  descriptorId,
  rulesId,
  snippetsId,
  guidanceId,
  limitsId,
  descriptors,
  writingRules,
  sampleSnippets,
  descriptorOversize,
  ruleOversize,
  snippetOversize,
  validationError,
  dirty,
  fieldReadOnly,
  guidance,
  onLoad,
  onSave,
  onDescriptorsChange,
  onRulesChange,
  onSnippetsChange,
}: BrandVoiceViewProps): ReactElement {
  return (
    <section
      className="card ai-context-card brand-voice-panel"
      aria-labelledby="brand-voice-title"
      aria-busy={loading || saving}
    >
      <BrandVoiceIntro />

      <p
        id={guidanceId}
        className="ai-context-guidance"
        data-tone={!canEdit || !verified ? "locked" : undefined}
        role="status"
        aria-live="polite"
      >
        {guidance}
      </p>

      {loading ? (
        <div className="ai-context-loading" role="status">
          <span className="sr-only">Loading brand-voice profile…</span>
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
        </div>
      ) : (
        <>
          {loadError ? (
            <Notice
              tone="danger"
              announcement="assertive"
              className="ai-context-notice"
              action={
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void onLoad()}
                  disabled={loading || saving}
                >
                  Retry load
                </button>
              }
            >
              {loadError}
            </Notice>
          ) : null}

          {saveError ? (
            <Notice
              tone="danger"
              announcement="assertive"
              className="ai-context-notice"
              action={
                !verified ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void onLoad()}
                    disabled={loading || saving}
                  >
                    Reload profile
                  </button>
                ) : null
              }
            >
              {saveError}
            </Notice>
          ) : null}

          <details className="brand-voice-editor">
            <summary>
              <span>
                <strong>Review or edit profile</strong>
                <small>
                  {descriptors.length} descriptor
                  {descriptors.length === 1 ? "" : "s"} · {writingRules.length}{" "}
                  rule{writingRules.length === 1 ? "" : "s"} ·{" "}
                  {sampleSnippets.length} sample
                  {sampleSnippets.length === 1 ? "" : "s"}
                </small>
              </span>
            </summary>
            <form
              className="brand-voice-form"
              onSubmit={(event) => {
                event.preventDefault();
                void onSave();
              }}
            >
              <div className="field">
                <label
                  className="field-label brand-voice-field-label"
                  htmlFor={descriptorId}
                >
                  <span>Descriptors</span>
                  <span className="brand-voice-counter">
                    one per line · {descriptors.length}/{maxDescriptors}
                  </span>
                </label>
                <textarea
                  id={descriptorId}
                  className="input"
                  rows={5}
                  value={descText}
                  onChange={(event) => onDescriptorsChange(event.target.value)}
                  aria-label="Descriptors"
                  readOnly={fieldReadOnly}
                  aria-describedby={`${guidanceId} ${limitsId}`}
                  aria-invalid={
                    descriptors.length > maxDescriptors ||
                    descriptorOversize !== null
                  }
                  maxLength={maxDescriptors * (DESCRIPTOR_BYTES + 1)}
                  placeholder={"warm\nno-jargon\nsecond-person\nhonest-math"}
                />
              </div>

              <div className="field">
                <label
                  className="field-label brand-voice-field-label"
                  htmlFor={rulesId}
                >
                  <span>Writing rules</span>
                  <span className="brand-voice-counter">
                    one per line · {writingRules.length}/{maxRules}
                  </span>
                </label>
                <textarea
                  id={rulesId}
                  className="input"
                  rows={6}
                  value={rulesText}
                  onChange={(event) => onRulesChange(event.target.value)}
                  aria-label="Writing rules"
                  readOnly={fieldReadOnly}
                  aria-describedby={`${guidanceId} ${limitsId}`}
                  aria-invalid={
                    writingRules.length > maxRules || ruleOversize !== null
                  }
                  maxLength={maxRules * (RULE_BYTES + 1)}
                  placeholder={
                    "Never use exclamation marks.\nAlways use serial commas.\nNo more than 14 words per sentence."
                  }
                />
              </div>

              <div className="field">
                <label
                  className="field-label brand-voice-field-label"
                  htmlFor={snippetsId}
                >
                  <span>Sample snippets</span>
                  <span className="brand-voice-counter">
                    blank-line separated · {sampleSnippets.length}/{maxSnippets}
                  </span>
                </label>
                <textarea
                  id={snippetsId}
                  className="input"
                  rows={10}
                  value={snipsText}
                  onChange={(event) => onSnippetsChange(event.target.value)}
                  aria-label="Sample snippets"
                  readOnly={fieldReadOnly}
                  aria-describedby={`${guidanceId} ${limitsId}`}
                  aria-invalid={
                    sampleSnippets.length > maxSnippets ||
                    snippetOversize !== null
                  }
                  maxLength={maxSnippets * (SNIPPET_BYTES + 2)}
                  placeholder="Paste a few approved examples of your real brand voice."
                />
              </div>

              <p id={limitsId} className="ai-context-meta">
                Per item: {DESCRIPTOR_BYTES} bytes for descriptors, {RULE_BYTES}{" "}
                for rules, and {SNIPPET_BYTES.toLocaleString()} for samples. Do
                not paste personal, confidential, or secret data; supported AI
                workflows can send this profile to the configured model
                provider.
              </p>

              <div className="brand-voice-save-row">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving}
                  aria-disabled={
                    !canEdit || !verified || validationError !== null || !dirty
                      ? true
                      : undefined
                  }
                  aria-describedby={guidanceId}
                >
                  {saving ? "Saving…" : "Save profile"}
                </button>
                <div className="brand-voice-timestamps ai-context-meta">
                  {!verified ? (
                    <span>Saved state unavailable</span>
                  ) : profileMeta?.updatedAt ? (
                    <span>Updated {profileMeta.updatedAt}</span>
                  ) : (
                    <span>No saved profile yet</span>
                  )}
                  {verified && profileMeta?.extractedAt ? (
                    <span>Auto-extracted {profileMeta.extractedAt}</span>
                  ) : null}
                </div>
              </div>
            </form>
          </details>
        </>
      )}
    </section>
  );
}

function BrandVoiceIntro(): ReactElement {
  return (
    <header className="brand-voice-intro">
      <span className="ai-context-kicker">Tenant-wide guidance</span>
      <h3 id="brand-voice-title" className="page-title">
        Brand voice
      </h3>
      <p className="ai-context-copy">
        With Auto tone selected, supported AI Compose flows request these
        descriptors, rules, and examples. Pre-send drift uses descriptors and
        rule-derived banned terms; choosing a manual tone can override this
        profile for that draft.
      </p>
    </header>
  );
}
