import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { SubjectLabScoredVariant } from "../lib/api-client";
import { useDiscardOnlyDraftLifecycle } from "../hooks/useSettingsDraftLifecycle";
import { SubjectLab } from "./SubjectLab";
import "../styles-postwave-ai-subject.css";

export interface SubjectLabCampaignHandoff {
  subject: string;
  body: string;
  stagedSubjects: readonly string[];
}

interface SubjectLabWorkspaceProps {
  canMutate: boolean;
  onContinueInCampaigns: (
    handoff: SubjectLabCampaignHandoff,
  ) => Promise<boolean>;
}

const EMPTY_OPERATION = null;
const SUBJECT_MAX_CHARACTERS = 200;
const BODY_CONTEXT_MAX_CHARACTERS = 2_000;

/**
 * Moosewave AI adapter for the canonical confidence/baseline Subject Lab.
 * It owns only a local seed draft and an explicit campaign handoff; the
 * canonical SubjectLab remains the sole generator/scorer.
 */
export function SubjectLabWorkspace({
  canMutate,
  onContinueInCampaigns,
}: SubjectLabWorkspaceProps): ReactElement {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [labOpen, setLabOpen] = useState(false);
  const [stagedSubjects, setStagedSubjects] = useState<string[]>([]);
  const [queuedHandoff, setQueuedHandoff] =
    useState<SubjectLabCampaignHandoff | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const operationRef = useRef<Promise<unknown> | null>(EMPTY_OPERATION);
  const radioName = `${useId()}-subject-lab-candidate`;

  const discardDraft = useCallback((): void => {
    setSubject("");
    setBody("");
    setStagedSubjects([]);
    setLabOpen(false);
    setHandoffError(null);
  }, []);
  const dirty =
    queuedHandoff === null &&
    (subject.trim() !== "" || body.trim() !== "" || stagedSubjects.length > 0);

  useDiscardOnlyDraftLifecycle({
    ownerId: "postwave-ai-subject-lab",
    label: "Moosewave AI Subject Lab draft",
    dirty,
    operationRef,
    discard: discardDraft,
    detail:
      "This Subject Lab seed, body context or staged candidate has not been handed to Campaigns.",
  });

  // Queueing lets the lifecycle hook observe a clean render before the parent
  // performs guarded navigation. The handoff cannot accidentally become a
  // campaign create/send operation.
  useEffect(() => {
    if (!queuedHandoff || operationRef.current) return;
    let active = true;
    let operation: Promise<boolean>;
    try {
      operation = Promise.resolve(onContinueInCampaigns(queuedHandoff));
    } catch {
      setHandoffError(
        "Campaigns could not be opened. Your Subject Lab draft is still here; retry when ready.",
      );
      setQueuedHandoff(null);
      return;
    }
    operationRef.current = operation;
    void operation
      .then((proceeded) => {
        if (!active) return;
        if (proceeded) discardDraft();
      })
      .catch(() => {
        if (active) {
          setHandoffError(
            "Campaigns could not be opened. Your Subject Lab draft is still here; retry when ready.",
          );
        }
      })
      .finally(() => {
        if (operationRef.current === operation) operationRef.current = null;
        if (active) setQueuedHandoff(null);
      });
    return () => {
      active = false;
    };
  }, [discardDraft, onContinueInCampaigns, queuedHandoff]);

  const stageBanditCandidates = (
    candidates: SubjectLabScoredVariant[],
  ): void => {
    const subjects = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate.text.trim())
          .filter(Boolean)
          .map((candidate) => candidate.slice(0, SUBJECT_MAX_CHARACTERS)),
      ),
    ).slice(0, 3);
    setStagedSubjects(subjects);
    if (subjects[0]) setSubject(subjects[0]);
    setLabOpen(false);
    setHandoffError(null);
  };

  const queueCampaignHandoff = (): void => {
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) return;
    setHandoffError(null);
    const payload: SubjectLabCampaignHandoff = {
      subject: trimmedSubject,
      body,
      stagedSubjects:
        stagedSubjects.length > 0 ? stagedSubjects : [trimmedSubject],
    };
    setQueuedHandoff(payload);
  };

  return (
    <div className="card ai-subject-workspace">
      <header className="ai-subject-header">
        <div>
          <span className="ai-subject-kicker">Evidence-led ideation</span>
          <div className="section-title">Subject Lab</div>
        </div>
        <p className="muted ai-subject-intro">
          Generate axis-conditioned variants and compare confidence intervals
          with this workspace&apos;s 180-day open-rate baseline.
        </p>
      </header>

      <ol className="ai-subject-steps" aria-label="Subject Lab workflow">
        <li data-active={stagedSubjects.length === 0 ? "true" : undefined}>
          <span aria-hidden="true">01</span>
          <div>
            <strong>Seed</strong>
            <small>Start with a real campaign idea.</small>
          </div>
        </li>
        <li data-active={labOpen ? "true" : undefined}>
          <span aria-hidden="true">02</span>
          <div>
            <strong>Compare</strong>
            <small>Inspect confidence and baseline evidence.</small>
          </div>
        </li>
        <li data-active={stagedSubjects.length > 0 ? "true" : undefined}>
          <span aria-hidden="true">03</span>
          <div>
            <strong>Stage</strong>
            <small>Choose one candidate for human review.</small>
          </div>
        </li>
      </ol>

      <div className="ai-subject-input-grid">
        <label className="field ai-subject-field">
          <span className="label">Seed subject</span>
          <input
            type="text"
            value={subject}
            maxLength={SUBJECT_MAX_CHARACTERS}
            onChange={(event) => {
              setSubject(event.target.value);
              setStagedSubjects([]);
              setHandoffError(null);
            }}
            placeholder="Type at least 10 characters"
          />
          <small>
            {subject.length}/{SUBJECT_MAX_CHARACTERS} characters
          </small>
        </label>
        <label className="field ai-subject-field">
          <span className="label">Campaign body context (optional)</span>
          <textarea
            rows={5}
            value={body}
            maxLength={BODY_CONTEXT_MAX_CHARACTERS}
            onChange={(event) => {
              setBody(event.target.value);
              setHandoffError(null);
            }}
            placeholder="Paste a short body excerpt to ground the variants."
          />
          <small>
            {body.length}/{BODY_CONTEXT_MAX_CHARACTERS} characters · use an
            excerpt, not a subscriber record
          </small>
        </label>
      </div>

      {!canMutate ? (
        <div className="notice ai-subject-permission" role="status">
          Your role can review this workspace, but only editors and admins can
          generate variants or hand a draft to Campaigns.
        </div>
      ) : null}

      {handoffError ? (
        <div className="ai-subject-error" role="alert">
          <strong>Handoff did not complete</strong>
          <span>{handoffError}</span>
        </div>
      ) : null}

      {stagedSubjects.length > 0 ? (
        <section
          className="ai-subject-candidates"
          aria-labelledby={`${radioName}-heading`}
        >
          <div className="ai-subject-candidates-header">
            <div>
              <span className="badge accent">AI-generated</span>
              <strong id={`${radioName}-heading`}>
                Top candidates staged for review
              </strong>
            </div>
            <span className="badge neutral">Nothing created</span>
          </div>
          <p className="muted">
            Choose the subject that should seed the Campaigns draft. Nothing is
            created or sent from this workspace.
          </p>
          <div className="ai-subject-candidate-list">
            {stagedSubjects.map((candidate) => (
              <label
                key={candidate}
                data-selected={subject === candidate ? "true" : undefined}
              >
                <input
                  type="radio"
                  name={radioName}
                  checked={subject === candidate}
                  onChange={() => {
                    setSubject(candidate);
                    setHandoffError(null);
                  }}
                />
                <span>{candidate}</span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      <div className="ai-subject-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            queuedHandoff !== null || !canMutate || subject.trim().length < 10
          }
          onClick={() => setLabOpen(true)}
        >
          Open confidence lab
        </button>
        <button
          type="button"
          className="btn"
          disabled={
            queuedHandoff !== null || !canMutate || subject.trim() === ""
          }
          onClick={queueCampaignHandoff}
        >
          {queuedHandoff ? "Opening Campaigns…" : "Continue in Campaigns"}
        </button>
        <span className="ai-subject-action-note">
          Lab results are advisory. Campaigns remains the review and authoring
          surface.
        </span>
      </div>

      <SubjectLab
        open={labOpen}
        onClose={() => setLabOpen(false)}
        seedSubject={subject}
        bodyExcerpt={body.slice(0, BODY_CONTEXT_MAX_CHARACTERS)}
        canMutate={canMutate}
        onPickVariant={(text) => setSubject(text)}
        onRunBandit={stageBanditCandidates}
        banditActionLabel="Stage top 3 for campaign review"
        workflowDescription="Generate axis-conditioned variants, score them against the last 180 days, then stage candidates for explicit campaign review."
      />
    </div>
  );
}
