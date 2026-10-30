/**
 * ScoringRulesCard — collapsed <details> section on the Subscribers
 * page for the lead-scoring surface (full-surface wiring #18):
 *
 *   - version-bound rules list + inline editor (event_type / weight / note),
 *     saved through a reviewed whole-set diff;
 *   - the server's default weights (applied when no rules exist),
 *     rendered from the GET response verbatim;
 *   - a truthful automatic-computation state. The unsafe synchronous manual
 *     recompute is not exposed; the production worker refreshes changed scores
 *     every fifteen minutes.
 *
 * Every route is ScopeAdmin server-side (scoring.go MountRoutes), so
 * all controls gate on admin and the data loads lazily on first
 * expand — eager-fetching would 403-spam non-admin sessions.
 */

import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  leadScoringApi,
  type ScoringEventCatalogItem,
} from "../../lib/api-client";
import { useExistingSettingLifecycle } from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { FieldError } from "../FormField";
import { toast } from "../Toast";
import {
  SCORING_NOTE_MAX_CHARACTERS,
  SCORING_WEIGHT_MAX,
  SCORING_WEIGHT_MIN,
  type ScoringDefaultRow,
  type ScoringRuleDraft,
  diffScoringDrafts,
  draftFromScoringRule,
  draftsToScoringRules,
  emptyScoringDraft,
  normalizeScoringDefaults,
  parseScoringRulesResponse,
  parseScoringSaveResponse,
  scoringDraftsEqual,
  validateScoringDrafts,
} from "./scoring-rules-helpers";

interface Props {
  canMutate: boolean;
  /** Every scoring route is ScopeAdmin server-side. */
  canAdmin: boolean;
}

const ROW_COLS = "repeat(auto-fit, minmax(min(140px, 100%), 1fr))";
const VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function cloneDrafts(drafts: ScoringRuleDraft[]): ScoringRuleDraft[] {
  return drafts.map((draft) => ({ ...draft }));
}

export function ScoringRulesCard({ canMutate, canAdmin }: Props): ReactElement {
  // All scoring routes are admin-scoped; write role alone isn't enough.
  const canManage = canMutate && canAdmin;
  const manageGateReason = !canMutate
    ? "Viewer role can't manage scoring rules"
    : "Lead-scoring rules need an admin role";
  const manageReasonId = useId();
  const rulesHelpId = useId();
  const automationHelpId = useId();

  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ScoringRuleDraft[]>([]);
  const [baselineDrafts, setBaselineDrafts] = useState<ScoringRuleDraft[]>([]);
  const [defaults, setDefaults] = useState<ScoringDefaultRow[]>([]);
  const [eventCatalog, setEventCatalog] = useState<ScoringEventCatalogItem[]>(
    [],
  );
  const [version, setVersion] = useState("");
  const [windowDays, setWindowDays] = useState(90);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [conflict, setConflict] = useState(false);
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [refreshReviewOpen, setRefreshReviewOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const loadingRef = useRef(false);
  const savingRef = useRef(false);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const dirty = loaded && !scoringDraftsEqual(baselineDrafts, drafts);
  const allowedEventTypes = useMemo(
    () => new Set(eventCatalog.map((item) => item.event_type)),
    [eventCatalog],
  );
  const diff = useMemo(
    () => diffScoringDrafts(baselineDrafts, drafts),
    [baselineDrafts, drafts],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
    };
  }, []);

  const load = async (options?: {
    preserveLocalDraft?: boolean;
  }): Promise<void> => {
    if (loadingRef.current || savingRef.current) return;
    loadingRef.current = true;
    const request = ++loadRequestRef.current;
    setLoading(true);
    setErr(null);
    let res: Awaited<ReturnType<typeof leadScoringApi.rules>>;
    try {
      res = await leadScoringApi.rules();
    } catch {
      if (mountedRef.current && loadRequestRef.current === request) {
        setLoading(false);
        setLoaded(true);
        setErr("Couldn't load scoring rules. Check your connection and retry.");
      }
      loadingRef.current = false;
      return;
    }
    loadingRef.current = false;
    if (!mountedRef.current || loadRequestRef.current !== request) return;
    setLoading(false);
    setLoaded(true);
    if (res.error) {
      setErr(
        res.error.kind === "http" && res.error.status === 403
          ? "Lead-scoring rules need an admin-scoped key."
          : res.error.message,
      );
      return;
    }
    const parsed = parseScoringRulesResponse(res.data as unknown);
    if (!parsed) {
      setErr(
        "The scoring-rules response didn't match the required versioned contract. No draft was changed.",
      );
      return;
    }
    const nextDrafts = parsed.rules.map(draftFromScoringRule);
    if (!options?.preserveLocalDraft) setDrafts(cloneDrafts(nextDrafts));
    setBaselineDrafts(cloneDrafts(nextDrafts));
    setDefaults(normalizeScoringDefaults(parsed.defaults));
    setEventCatalog(parsed.event_catalog.map((item) => ({ ...item })));
    setVersion(parsed.version);
    setWindowDays(parsed.window_days);
    setRowErrors({});
    setConflict(false);
  };

  const onToggleSection = (open: boolean): void => {
    if (open && !loaded && !loadingRef.current) void load();
  };

  const setDraft = (i: number, patch: Partial<ScoringRuleDraft>): void => {
    if (!canManage || savingRef.current) return;
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    setRowErrors((current) => {
      if (!(i in current)) return current;
      const next = { ...current };
      delete next[i];
      return next;
    });
    setConflict(false);
  };

  const save = async (): Promise<boolean> => {
    if (!canManage || savingRef.current || loadingRef.current) {
      return false;
    }
    if (!dirty) return true;
    const errors = validateScoringDrafts(drafts, allowedEventTypes);
    setRowErrors(errors);
    if (Object.keys(errors).length > 0) return false;
    if (!VERSION_PATTERN.test(version)) {
      setErr("Refresh scoring rules to obtain a valid save version.");
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    const submittedDrafts = cloneDrafts(drafts);
    const request = (async (): Promise<boolean> => {
      let res: Awaited<ReturnType<typeof leadScoringApi.putRules>>;
      try {
        res = await leadScoringApi.putRules(
          draftsToScoringRules(submittedDrafts),
          version,
        );
      } catch {
        if (mountedRef.current) {
          toast.error(
            "Couldn't save scoring rules. Check your connection and retry.",
          );
        }
        return false;
      }
      if (!mountedRef.current) return false;
      if (res.error) {
        if (res.error.kind === "http" && res.error.status === 409) {
          setConflict(true);
          setErr(
            "These rules changed elsewhere after this draft loaded. Refresh the server baseline while keeping this draft, then review the recalculated diff.",
          );
        } else {
          toast.error(`Couldn't save scoring rules: ${res.error.message}`);
        }
        return false;
      }
      const receipt = parseScoringSaveResponse(
        res.data as unknown,
        submittedDrafts.length,
      );
      if (!receipt) {
        setErr(
          "The save response didn't match the required versioned receipt. Keep this draft and refresh before another change.",
        );
        return false;
      }
      setVersion(receipt.version);
      setBaselineDrafts(cloneDrafts(submittedDrafts));
      setConflict(false);
      setErr(null);
      setSaveReviewOpen(false);
      toast.success(
        `Saved ${receipt.saved.toLocaleString()} scoring rule${receipt.saved === 1 ? "" : "s"}. Changed scores refresh automatically within 15 minutes.`,
      );
      return true;
    })();
    savePromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (savePromiseRef.current === request) savePromiseRef.current = null;
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const discard = (): void => {
    if (savingRef.current) return;
    setDrafts(cloneDrafts(baselineDrafts));
    setRowErrors({});
    setConflict(false);
    setErr(null);
  };

  useExistingSettingLifecycle({
    ownerId: "subscriber-scoring-rules",
    label: "Lead-scoring rule changes",
    dirty,
    operationRef: savePromiseRef,
    save,
    discard,
    detail:
      "The lead-scoring rule set has unsaved changes that affect the whole workspace.",
    enabled: loaded && canManage,
  });

  return (
    <details
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 16px",
        marginBottom: 12,
        background: "var(--pw-bg-elev)",
      }}
      onToggle={(e) => onToggleSection((e.target as HTMLDetailsElement).open)}
    >
      <summary
        style={{
          cursor: "pointer",
          padding: "6px 0",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Lead scoring
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {" "}
          — per-event weights behind subscribers&apos; engagement score
        </span>
        {dirty ? (
          <span className="badge" style={{ marginLeft: 8, fontSize: 10 }}>
            Unsaved changes
          </span>
        ) : null}
      </summary>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "6px 0 10px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span id={rulesHelpId} className="muted" style={{ fontSize: 12 }}>
            Each event in the last {windowDays.toLocaleString()} days adds its
            weight to the subscriber&apos;s engagement score. Saving replaces
            the whole rule set after a reviewed diff and version check.
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (dirty) setRefreshReviewOpen(true);
              else void load();
            }}
            disabled={loading}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div
          id={automationHelpId}
          className="notice"
          role="note"
          style={{ fontSize: 11, lineHeight: 1.45 }}
        >
          <strong>Automatic score refresh</strong>
          <span className="muted">
            {" "}
            Changed scores are recomputed by the production worker every 15
            minutes. Manual workspace-wide recompute is withheld until it has
            preview, progress, cancellation, and a durable receipt.
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
          {!canManage ? (
            <span id={manageReasonId} role="status">
              {manageGateReason}.{" "}
            </span>
          ) : null}
          Open and click signals use the server&apos;s canonical event catalog;
          automated mailbox opens are excluded during scoring.
        </div>

        {err ? (
          <div className="notice" role="alert" style={{ fontSize: 12 }}>
            {err}
          </div>
        ) : null}

        {loading && !loaded ? (
          <div className="muted" style={{ fontSize: 12 }} role="status">
            Loading scoring rules…
          </div>
        ) : loaded && eventCatalog.length > 0 ? (
          <ScoringRulesEditor
            drafts={drafts}
            defaults={defaults}
            eventCatalog={eventCatalog}
            rowErrors={rowErrors}
            saving={saving}
            dirty={dirty}
            conflict={conflict}
            canManage={canManage}
            manageReasonId={manageReasonId}
            rulesHelpId={rulesHelpId}
            onDraftChange={setDraft}
            onRemove={(index) =>
              !savingRef.current &&
              setDrafts((current) => {
                setRowErrors({});
                setConflict(false);
                return current.filter(
                  (_, currentIndex) => currentIndex !== index,
                );
              })
            }
            onAdd={() =>
              !savingRef.current &&
              setDrafts((current) => {
                setRowErrors({});
                setConflict(false);
                return [...current, emptyScoringDraft()];
              })
            }
            onDiscard={discard}
            onSaveReview={() => {
              const errors = validateScoringDrafts(drafts, allowedEventTypes);
              setRowErrors(errors);
              if (Object.keys(errors).length === 0 && dirty) {
                setSaveReviewOpen(true);
              }
            }}
          />
        ) : null}
      </div>
      <ConfirmModal
        open={saveReviewOpen}
        title="Replace the workspace scoring rules?"
        description={`This version-bound save adds ${diff.added}, changes ${diff.changed}, and removes ${diff.removed} rule${diff.removed === 1 ? "" : "s"}. ${diff.switchesToDefaults ? "Removing every custom rule switches the workspace back to the published default weights." : "Unchanged rules remain semantically identical."}`}
        confirmLabel="Save reviewed rule set"
        busy={saving}
        onConfirm={() => void save()}
        onClose={() => {
          if (!savingRef.current) setSaveReviewOpen(false);
        }}
      >
        <div className="muted" style={{ fontSize: 12 }}>
          The server will reject this save if another administrator changed the
          rule-set version after you loaded it. Scores refresh automatically;
          this confirmation does not run a synchronous workspace sweep.
        </div>
      </ConfirmModal>
      <ConfirmModal
        open={refreshReviewOpen}
        title="Refresh the scoring baseline?"
        description="This loads the current server version while preserving your local draft. Review the recalculated diff before saving; use Discard changes separately if you want to remove your edits."
        confirmLabel="Keep draft and refresh"
        busy={loading}
        onConfirm={() => {
          setRefreshReviewOpen(false);
          void load({ preserveLocalDraft: true });
        }}
        onClose={() => {
          if (!loadingRef.current) setRefreshReviewOpen(false);
        }}
      />
    </details>
  );
}

function ScoringRulesEditor({
  drafts,
  defaults,
  eventCatalog,
  rowErrors,
  saving,
  dirty,
  conflict,
  canManage,
  manageReasonId,
  rulesHelpId,
  onDraftChange,
  onRemove,
  onAdd,
  onDiscard,
  onSaveReview,
}: {
  drafts: ScoringRuleDraft[];
  defaults: ScoringDefaultRow[];
  eventCatalog: ScoringEventCatalogItem[];
  rowErrors: Record<number, string>;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  canManage: boolean;
  manageReasonId: string;
  rulesHelpId: string;
  onDraftChange: (index: number, patch: Partial<ScoringRuleDraft>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onDiscard: () => void;
  onSaveReview: () => void;
}): ReactElement {
  const permissionDescription = `${!canManage ? `${manageReasonId} ` : ""}${rulesHelpId}`;
  const selectedEventTypes = new Set(
    drafts.map((draft) => draft.event_type.trim()).filter(Boolean),
  );
  return (
    <>
      {drafts.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No custom rules — the engine is using the default weights below. Add a
          rule to override them (custom rules replace the defaults entirely).
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              gridTemplateColumns: ROW_COLS,
              gap: 8,
              padding: "0 8px",
              fontSize: 11,
              color: "var(--pw-fg-subtle)",
            }}
          >
            <span>Event type</span>
            <span>Weight</span>
            <span>Note</span>
            <span />
          </div>
          {drafts.map((draft, index) => {
            const rowErrorId = `${rulesHelpId}-rule-${index}-error`;
            const describedBy = `${permissionDescription}${
              rowErrors[index] ? ` ${rowErrorId}` : ""
            }`;
            return (
              <div key={draft.id || index} style={{ display: "grid", gap: 2 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: ROW_COLS,
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <select
                    className="input mono"
                    aria-label={`Rule ${index + 1} event type`}
                    value={draft.event_type}
                    onChange={(event) =>
                      onDraftChange(index, { event_type: event.target.value })
                    }
                    disabled={saving || !canManage}
                    aria-disabled={!canManage || undefined}
                    aria-describedby={describedBy}
                    aria-invalid={rowErrors[index] ? "true" : undefined}
                  >
                    <option value="" disabled>
                      Choose an event…
                    </option>
                    {!eventCatalog.some(
                      (item) => item.event_type === draft.event_type,
                    ) && draft.event_type !== "" ? (
                      <option value={draft.event_type} disabled>
                        Unsupported legacy event: {draft.event_type}
                      </option>
                    ) : null}
                    {eventCatalog.map((item) => (
                      <option
                        key={item.event_type}
                        value={item.event_type}
                        disabled={
                          item.event_type !== draft.event_type &&
                          selectedEventTypes.has(item.event_type)
                        }
                      >
                        {item.label} · {item.event_type}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className="input"
                    aria-label={`Rule ${index + 1} weight`}
                    value={draft.weight}
                    min={SCORING_WEIGHT_MIN}
                    max={SCORING_WEIGHT_MAX}
                    step={1}
                    onChange={(event) =>
                      onDraftChange(index, { weight: event.target.value })
                    }
                    disabled={saving || !canManage}
                    aria-disabled={!canManage || undefined}
                    aria-describedby={describedBy}
                    aria-invalid={rowErrors[index] ? "true" : undefined}
                  />
                  <input
                    type="text"
                    className="input"
                    aria-label={`Rule ${index + 1} note`}
                    value={draft.note}
                    onChange={(event) =>
                      onDraftChange(index, { note: event.target.value })
                    }
                    placeholder="Note (optional)"
                    maxLength={SCORING_NOTE_MAX_CHARACTERS}
                    disabled={saving || !canManage}
                    aria-disabled={!canManage || undefined}
                    aria-describedby={describedBy}
                    aria-invalid={rowErrors[index] ? "true" : undefined}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (canManage) onRemove(index);
                    }}
                    disabled={saving || !canManage}
                    aria-disabled={!canManage || undefined}
                    aria-describedby={describedBy}
                    aria-label={`Remove rule ${index + 1}`}
                  >
                    ✕
                  </button>
                </div>
                {rowErrors[index] ? (
                  <div id={rowErrorId}>
                    <FieldError>{rowErrors[index]}</FieldError>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          disabled={
            saving || !canManage || drafts.length >= eventCatalog.length
          }
          aria-disabled={
            !canManage || drafts.length >= eventCatalog.length || undefined
          }
          aria-describedby={permissionDescription}
          onClick={() => {
            if (canManage && drafts.length < eventCatalog.length) onAdd();
          }}
        >
          + Add rule
        </button>
        {dirty ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onDiscard}
            disabled={saving}
          >
            Discard changes
          </button>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onSaveReview}
          disabled={saving || !dirty || !canManage}
          aria-disabled={!canManage || undefined}
          aria-describedby={permissionDescription}
        >
          {saving ? "Saving…" : "Review changes"}
        </button>
      </div>
      {conflict ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          Save blocked by a newer server version. Refresh keeps this draft,
          loads the current baseline, and recalculates the review diff before
          you save again.
        </div>
      ) : null}
      {defaults.length > 0 ? (
        <div style={{ borderTop: "1px solid var(--pw-border)", paddingTop: 8 }}>
          <div className="label" style={{ fontSize: 11 }}>
            Default weights
            <span className="muted" style={{ fontWeight: 400 }}>
              {" "}
              — applied only while no custom rules are saved
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {defaults.map((row) => (
              <span key={row.event_type} className="badge">
                <span className="mono">{row.event_type}</span>{" "}
                <strong className="tabular">
                  {row.weight > 0 ? `+${row.weight}` : row.weight}
                </strong>{" "}
                <span className="muted">default</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
