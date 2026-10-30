/**
 * CopilotRail — the campaign editor's unified AI copilot panel.
 *
 * Composes the previously-scattered AI surfaces into ONE stacked panel
 * with collapsible sections inside CampaignDetailSlideover:
 *
 *   1. Pre-send verdict — POST /api/v1/presend/verdict on demand
 *      (same machinery as ai/PresendCheckPanel, fed from the saved
 *      campaign instead of a paste box);
 *   2. Subject Lab — opens the existing SubjectLab modal seeded with
 *      the campaign subject/body;
 *   3. Voice drift — mounts the existing VoiceDriftBanner;
 *   4. Inbox reality — mounts the existing InboxRealityBanner; its
 *      Continue button hands off to the parent's send-confirm flow
 *      ("Send…" — the audience confirm still happens next).
 *
 * Composition/UX only — NO new data sources. The voice + inbox
 * sections lazy-mount on expand so opening the slideover doesn't fan
 * out to the voice/predictor services until the operator asks.
 *
 * Inputs are the SAVED campaign fields (not in-flight editor
 * keystrokes). When those saved fields change the pre-send verdict is
 * cleared (it described the old content); the operator re-runs it on
 * demand — the check is LLM-cost so it never auto-fires.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  api,
  featureFlagsApi,
  type PresendVerdictResponse,
  type SubjectLabScoredVariant,
} from "../../lib/api-client";
import { InboxRealityBanner } from "../InboxRealityBanner";
import { SubjectLab } from "../SubjectLab";
import { VoiceDriftBanner } from "../VoiceDriftBanner";
import { AIInteractionDisclosure } from "../ai/AIInteractionDisclosure";
import { getLatestCampaignAssurance } from "../../lib/api/campaign-assurance";
import {
  RAIL_SECTIONS,
  SUBJECT_LAB_MIN_SEED,
  componentDisplayName,
  formatComponentScore,
  presendStatusColor,
  presendStatusLabel,
  subjectLabSeedReady,
  verdictReadiness,
  type RailSectionId,
} from "./copilot-rail-helpers";

interface Props {
  campaignId: string;
  /** Saved campaign fields — the rail never sees unsaved keystrokes. */
  subject: string;
  fromEmail: string;
  bodyHtml: string;
  /** Editor + admin gate for Subject Lab's Use / Run buttons. */
  canMutate: boolean;
  /** Parent is mid-send — disables the inbox-reality Send button. */
  busy?: boolean;
  /** Subject Lab "Use" handoff — parent persists the new subject. */
  onPickSubject: (text: string) => void;
  /** Subject Lab "Run top 3 as A/B" handoff. */
  onRunBandit: (top3: SubjectLabScoredVariant[]) => void;
  /** Inbox-reality Continue → opens the parent's send-confirm modal. */
  onRequestSend: () => void;
}

interface VerdictState {
  loading: boolean;
  err: string | null;
  data: PresendVerdictResponse | null;
}

export function CopilotRail({
  campaignId,
  subject,
  fromEmail,
  bodyHtml,
  canMutate,
  busy,
  onPickSubject,
  onRunBandit,
  onRequestSend,
}: Props): ReactElement {
  const [openSections, setOpenSections] = useState<
    Record<RailSectionId, boolean>
  >({ verdict: true, subject: false, voice: false, inbox: false });
  const [labOpen, setLabOpen] = useState(false);
  const [verdict, setVerdict] = useState<VerdictState>({
    loading: false,
    err: null,
    data: null,
  });
  // G11: Subject Lab is opt-in (the /variants endpoint is LLM-cost).
  // Resolve the subject_lab flag once on mount; null = still loading so
  // we don't flash the button before we know. Tenant override wins over
  // the platform default, mirroring the backend feature_flags.IsEnabled.
  const [labEnabled, setLabEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    // GAP-3#4: resolve subject_lab through the backend resolver (the same
    // path as feature_flags.IsEnabled) instead of reading a flag row's
    // `enabled` column. `enabled` is the row-active flag, not the resolved
    // boolean — a tenant row value "false" (row enabled) must read as OFF,
    // and a disabled tenant row must fall through to the platform default.
    // A fetch error leaves labEnabled null (unknown) rather than asserting
    // the feature is off.
    void featureFlagsApi.resolve("subject_lab").then((res) => {
      if (!live) return;
      if (res.error || !res.data) return; // unknown — leave loading/null
      const v = res.data.value.trim().toLowerCase();
      setLabEnabled(["true", "on", "1", "yes", "enabled"].includes(v));
    });
    return () => {
      live = false;
    };
  }, []);

  // GAP-3#14: the verdict is computed against the SAVED campaign fields;
  // when those change (a fresh save), the prior verdict describes content
  // that no longer exists, so clear it rather than leave a stale PASS/WARN.
  useEffect(() => {
    setVerdict({ loading: false, err: null, data: null });
  }, [campaignId, subject, fromEmail, bodyHtml]);

  const toggle = (id: RailSectionId): void =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const readiness = verdictReadiness(subject, fromEmail, bodyHtml);

  const runVerdict = async (): Promise<void> => {
    if (!readiness.ok) return;
    setVerdict({ loading: true, err: null, data: null });
    const latest = await getLatestCampaignAssurance(campaignId).catch(
      () => null,
    );
    const run = latest?.data?.data.detail.run;
    const assuranceIdentity = run
      ? {
          campaign_id: campaignId,
          content_revision_id: run.content_revision_id,
          source_hash: run.source_hash,
        }
      : { campaign_id: campaignId };
    const res = await api.presendVerdict({
      subject,
      from: fromEmail,
      html: bodyHtml,
      text: bodyHtml,
      ...assuranceIdentity,
    });
    if (res.error) {
      setVerdict({ loading: false, err: res.error.message, data: null });
      return;
    }
    setVerdict({ loading: false, err: null, data: res.data ?? null });
  };

  const renderSectionHeader = (id: RailSectionId): ReactElement => {
    const meta = RAIL_SECTIONS.find((s) => s.id === id)!;
    return (
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => toggle(id)}
        aria-expanded={openSections[id]}
        aria-controls={`copilot-rail-${id}`}
        aria-label={`${meta.title}: ${meta.blurb}`}
        style={{
          fontWeight: 600,
          fontSize: 12,
          width: "100%",
          justifyContent: "flex-start",
          textAlign: "left",
        }}
      >
        {openSections[id] ? "▾" : "▸"} {meta.title}
      </button>
    );
  };

  const verdictColor = presendStatusColor(verdict.data?.verdict);

  return (
    <div className="card" data-testid="copilot-rail" style={{ padding: 12 }}>
      <AIInteractionDisclosure style={{ marginBottom: 10 }} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span className="ai-banner-icon" aria-hidden="true">
          ✦
        </span>
        <span className="label" style={{ marginBottom: 0 }}>
          AI copilot
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          Advisory only — never blocks a send.
        </span>
      </div>

      {/* 1 — Pre-send verdict */}
      <div>
        {renderSectionHeader("verdict")}
        {openSections.verdict ? (
          <div id="copilot-rail-verdict" style={{ padding: "4px 8px 8px" }}>
            {!readiness.ok ? (
              <div className="muted" style={{ fontSize: 12 }}>
                {readiness.reason}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void runVerdict()}
                  disabled={verdict.loading}
                >
                  {verdict.loading
                    ? "Running checks…"
                    : verdict.data || verdict.err
                      ? "Re-run checks"
                      : "Run pre-send check"}
                </button>
                {verdict.err ? (
                  <div className="notice" style={{ marginTop: 8 }}>
                    <span>Couldn&apos;t run the check: {verdict.err}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void runVerdict()}
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
                {verdict.data ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      marginTop: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        border: `1px solid color-mix(in srgb, ${verdictColor} 24%, transparent)`,
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    >
                      <span
                        style={{
                          color: verdictColor,
                          textTransform: "uppercase",
                          letterSpacing: 0.4,
                          fontWeight: 700,
                          fontSize: 10,
                        }}
                      >
                        {presendStatusLabel(verdict.data.verdict)}
                      </span>
                      <span>{verdict.data.summary}</span>
                    </div>
                    {(verdict.data.components ?? []).map((c, i) => (
                      <div
                        key={`${c.name}-${i}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "90px 36px 1fr 70px",
                          gap: 8,
                          alignItems: "center",
                          padding: "4px 10px",
                          borderLeft: `2px solid ${presendStatusColor(c.status)}`,
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontWeight: 500 }}>
                          {componentDisplayName(c.name)}
                        </span>
                        <span
                          className="tabular"
                          style={{
                            color: presendStatusColor(c.status),
                            fontWeight: 600,
                          }}
                        >
                          {formatComponentScore(c.score)}
                        </span>
                        <span className="muted">
                          {c.error || c.message || ""}
                        </span>
                        <span
                          style={{
                            color: presendStatusColor(c.status),
                            textTransform: "uppercase",
                            letterSpacing: 0.4,
                            fontWeight: 700,
                            fontSize: 10,
                            textAlign: "right",
                          }}
                        >
                          {presendStatusLabel(c.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* 2 — Subject Lab access */}
      <div>
        {renderSectionHeader("subject")}
        {openSections.subject ? (
          <div id="copilot-rail-subject" style={{ padding: "4px 8px 8px" }}>
            {labEnabled === false ? (
              <div className="muted" style={{ fontSize: 12 }}>
                Subject Lab is off for this workspace. An admin can enable it
                under Settings → Feature flags (key <code>subject_lab</code>).
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setLabOpen(true)}
                  disabled={labEnabled === null}
                >
                  Open Subject Lab
                </button>
                {!subjectLabSeedReady(subject) ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    The Lab needs at least {SUBJECT_LAB_MIN_SEED} characters of
                    subject to generate variants.
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* 3 — Voice drift (lazy: the banner fetches on mount) */}
      <div>
        {renderSectionHeader("voice")}
        {openSections.voice ? (
          <div id="copilot-rail-voice" style={{ padding: "4px 8px 8px" }}>
            <VoiceDriftBanner bodyHtml={bodyHtml} />
          </div>
        ) : null}
      </div>

      {/* 4 — Inbox reality (lazy: the banner fetches on mount). Its
          Continue button is the rail's path INTO the send-confirm
          modal — labelled "Send…" because confirmation still follows. */}
      <div>
        {renderSectionHeader("inbox")}
        {openSections.inbox ? (
          <div id="copilot-rail-inbox" style={{ padding: "4px 8px 8px" }}>
            <InboxRealityBanner
              subject={subject}
              bodyHtml={bodyHtml}
              onContinue={onRequestSend}
              onCancel={() =>
                setOpenSections((prev) => ({ ...prev, inbox: false }))
              }
              onImproveSubject={() => setLabOpen(true)}
              busy={busy}
              continueLabel="Send…"
            />
          </div>
        ) : null}
      </div>

      <SubjectLab
        open={labOpen}
        onClose={() => setLabOpen(false)}
        seedSubject={subject}
        bodyExcerpt={bodyHtml.slice(0, 800)}
        canMutate={canMutate}
        onPickVariant={(text) => {
          onPickSubject(text);
          setLabOpen(false);
        }}
        onRunBandit={(top3) => {
          setLabOpen(false);
          onRunBandit(top3);
        }}
      />
    </div>
  );
}
