import { type ReactElement } from "react";

import type { BrandVoiceProfile, CampaignTemplate } from "../../lib/api-client";
import type {
  CampaignTemplateDesignOutput,
  CampaignTemplateDesignValidation,
  CampaignTemplateDesignWarning,
} from "../../lib/api/campaign-template-designs";
import { campaignTemplatePreviewUrl } from "../../lib/campaign-template-previews";
import {
  type PreviewDevice,
  TemplatePreview,
  TemplatePreviewToolbar,
} from "../TemplatePreview";
import {
  REVIEWED_TEMPLATE_NAME_MAX_BYTES,
  REVIEWED_TEMPLATE_PREVIEW_MAX_RUNES,
  REVIEWED_TEMPLATE_SUBJECT_MAX_RUNES,
  TEMPLATE_FIDELITY_OPTIONS,
  TEMPLATE_GEN_BRIEF_MAX,
  TEMPLATE_GEN_KINDS,
  TEMPLATE_GEN_TONE_MAX,
  type TemplateFidelity,
  type TemplateGenKind,
  reviewGeneratedTemplateDraft,
} from "./template-ai";

export type BrandChoice = "profile" | "default";
export type TemplateWizardStage = "direction" | "generating" | "review";
export type FinishMode = "template" | "campaign" | null;

export interface RetainedTemplateVersion {
  draft: CampaignTemplateDesignOutput;
  name: string;
  revision: number;
  outputHash: string;
  validation: CampaignTemplateDesignValidation;
  warnings: CampaignTemplateDesignWarning[];
}

export function TemplateWizardProgress({
  stage,
  version,
}: {
  stage: TemplateWizardStage;
  version: number;
}): ReactElement {
  const currentIndex =
    stage === "direction" ? 0 : stage === "generating" ? 1 : 2;
  const status =
    stage === "direction"
      ? "Step 1 of 3: choose the creative direction."
      : stage === "generating"
        ? `Step 2 of 3: creating version ${version}.`
        : "Step 3 of 3: review this unsaved version.";
  const labels = ["Direction", "Create", "Review"];
  return (
    <div style={{ marginBottom: 14 }}>
      <ol
        aria-label="Template creation progress"
        className="row"
        style={{
          gap: 8,
          listStyle: "none",
          margin: 0,
          padding: 0,
          flexWrap: "wrap",
        }}
      >
        {labels.map((label, index) => (
          <li
            key={label}
            className={`badge${index === currentIndex ? " accent" : ""}`}
            aria-current={index === currentIndex ? "step" : undefined}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <p
        className="muted"
        role="status"
        aria-live="polite"
        style={{ fontSize: 12, margin: "6px 0 0" }}
      >
        {status}
      </p>
    </div>
  );
}

function SourceCapability({
  source,
}: {
  source: CampaignTemplate;
}): ReactElement {
  const capabilities = source.capabilities;
  const capability = capabilities?.has_source_html
    ? "The server confirms a governed HTML source is available for a safe, network-blocked comparison."
    : capabilities?.has_desktop_preview || capabilities?.has_mobile_preview
      ? "The server confirms a hosted visual preview is available. Remote source pages are never loaded in this wizard."
      : "The server reports metadata-only inspiration, so the result is guided by its recorded style and layout.";
  return (
    <div className="notice" role="note">
      <div>
        <strong>How closely can Moosewave follow it?</strong>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {capability} The result is an original, editable interpretation—not a
          pixel-perfect copy. Mobile previews simulate a 375px viewport rather
          than a physical device.
        </p>
      </div>
    </div>
  );
}

interface TemplateBriefStepProps {
  adaptSource: CampaignTemplate | null;
  audience: string;
  brief: string;
  brandChoice: BrandChoice;
  brandError: string | null;
  brandLoading: boolean;
  brandProfile: BrandVoiceProfile | null;
  closeDisabled: boolean;
  cta: string;
  error: string | null;
  fidelity: TemplateFidelity;
  generating: boolean;
  keySections: string;
  kind: TemplateGenKind;
  tone: string;
  onAudienceChange: (value: string) => void;
  onBrandChoiceChange: (value: BrandChoice) => void;
  onBriefChange: (value: string) => void;
  onClose: () => void;
  onCtaChange: (value: string) => void;
  onFidelityChange: (value: TemplateFidelity) => void;
  onGenerate: () => void;
  onKeySectionsChange: (value: string) => void;
  onKindChange: (value: TemplateGenKind) => void;
  onToneChange: (value: string) => void;
}

export function TemplateBriefStep({
  adaptSource,
  audience,
  brief,
  brandChoice,
  brandError,
  brandLoading,
  brandProfile,
  closeDisabled,
  cta,
  error,
  fidelity,
  generating,
  keySections,
  kind,
  tone,
  onAudienceChange,
  onBrandChoiceChange,
  onBriefChange,
  onClose,
  onCtaChange,
  onFidelityChange,
  onGenerate,
  onKeySectionsChange,
  onKindChange,
  onToneChange,
}: TemplateBriefStepProps): ReactElement {
  const unavailable = generating || brandLoading;
  return (
    <>
      {adaptSource ? <SourceCapability source={adaptSource} /> : null}
      {adaptSource ? (
        <fieldset className="field" disabled={generating}>
          <legend className="field-label">What should stay familiar?</legend>
          <div style={{ display: "grid", gap: 6 }}>
            {TEMPLATE_FIDELITY_OPTIONS.map((option) => (
              <label
                key={option.id}
                className="row"
                htmlFor={`tpl-ai-fidelity-${option.id}`}
                aria-label={`${option.label}: ${option.hint}`}
                style={{
                  alignItems: "center",
                  cursor: generating ? "not-allowed" : "pointer",
                  gap: 8,
                  minHeight: 44,
                }}
              >
                <input
                  id={`tpl-ai-fidelity-${option.id}`}
                  type="radio"
                  name="tpl-ai-fidelity"
                  value={option.id}
                  checked={fidelity === option.id}
                  aria-describedby={`tpl-ai-fidelity-${option.id}-hint`}
                  onChange={() => onFidelityChange(option.id)}
                />
                <span>
                  <span style={{ display: "block", fontWeight: 600 }}>
                    {option.label}
                  </span>
                  <span
                    id={`tpl-ai-fidelity-${option.id}-hint`}
                    className="muted"
                    style={{ display: "block", fontSize: 11 }}
                  >
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-brief">
          {adaptSource ? "What should change?" : "What should this email do?"}
        </label>
        <textarea
          id="tpl-ai-brief"
          className="input"
          rows={4}
          maxLength={TEMPLATE_GEN_BRIEF_MAX}
          placeholder={
            adaptSource
              ? "e.g. Turn this into our July product roundup with a calmer editorial tone."
              : "e.g. A monthly product newsletter for indie coffee roasters."
          }
          value={brief}
          disabled={generating}
          onChange={(event) => onBriefChange(event.target.value)}
          style={{ height: "auto", padding: 8, lineHeight: 1.45 }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-audience">
          Audience
        </label>
        <input
          id="tpl-ai-audience"
          className="input"
          placeholder="e.g. Existing customers who use the starter plan"
          value={audience}
          disabled={generating}
          onChange={(event) => onAudienceChange(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-sections">
          Key sections
        </label>
        <textarea
          id="tpl-ai-sections"
          className="input"
          rows={3}
          placeholder="One section per line: opening note, three updates, customer story"
          value={keySections}
          disabled={generating}
          onChange={(event) => onKeySectionsChange(event.target.value)}
          style={{ height: "auto", padding: 8 }}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-cta">
          Primary call to action
        </label>
        <input
          id="tpl-ai-cta"
          className="input"
          placeholder="e.g. Explore the July release"
          value={cta}
          disabled={generating}
          onChange={(event) => onCtaChange(event.target.value)}
        />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label" htmlFor="tpl-ai-kind">
            Template type
          </label>
          <select
            id="tpl-ai-kind"
            className="input"
            value={kind}
            disabled={generating}
            onChange={(event) =>
              onKindChange(event.target.value as TemplateGenKind)
            }
          >
            {TEMPLATE_GEN_KINDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label className="field-label" htmlFor="tpl-ai-tone">
            Tone <span className="muted">(optional)</span>
          </label>
          <input
            id="tpl-ai-tone"
            className="input"
            maxLength={TEMPLATE_GEN_TONE_MAX}
            placeholder="e.g. Warm, plain-spoken, no exclamation marks"
            value={tone}
            disabled={generating}
            onChange={(event) => onToneChange(event.target.value)}
          />
        </div>
      </div>
      <fieldset className="field" disabled={unavailable}>
        <legend className="field-label">Brand direction</legend>
        {brandLoading ? (
          <p className="muted" role="status" style={{ margin: 0 }}>
            Checking for a workspace brand profile…
          </p>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            <label
              className="row"
              htmlFor="tpl-ai-brand-profile"
              aria-label="Workspace brand profile"
              style={{
                alignItems: "center",
                cursor: brandProfile ? "pointer" : "not-allowed",
                gap: 8,
                minHeight: 44,
              }}
            >
              <input
                id="tpl-ai-brand-profile"
                type="radio"
                name="tpl-ai-brand"
                value="profile"
                checked={brandChoice === "profile"}
                disabled={!brandProfile}
                aria-describedby="tpl-ai-brand-profile-hint"
                onChange={() => onBrandChoiceChange("profile")}
              />
              <span>
                <span style={{ display: "block", fontWeight: 600 }}>
                  Workspace brand profile
                </span>
                <span
                  id="tpl-ai-brand-profile-hint"
                  className="muted"
                  style={{ display: "block", fontSize: 11 }}
                >
                  {brandProfile
                    ? brandProfile.descriptors.slice(0, 4).join(" · ") ||
                      "Active profile"
                    : "No active profile is available."}
                </span>
              </span>
            </label>
            <label
              className="row"
              htmlFor="tpl-ai-brand-default"
              aria-label="Default brand direction"
              style={{
                alignItems: "center",
                cursor: "pointer",
                gap: 8,
                minHeight: 44,
              }}
            >
              <input
                id="tpl-ai-brand-default"
                type="radio"
                name="tpl-ai-brand"
                value="default"
                checked={brandChoice === "default"}
                aria-describedby="tpl-ai-brand-default-hint"
                onChange={() => onBrandChoiceChange("default")}
              />
              <span>
                <span style={{ display: "block", fontWeight: 600 }}>
                  Default brand direction
                </span>
                <span
                  id="tpl-ai-brand-default-hint"
                  className="muted"
                  style={{ display: "block", fontSize: 11 }}
                >
                  Use a neutral, accessible marketing style for this draft.
                </span>
              </span>
            </label>
          </div>
        )}
        {brandError ? (
          <p className="muted" role="status" style={{ fontSize: 11 }}>
            {brandError} Default brand direction remains available.
          </p>
        ) : null}
      </fieldset>
      <p className="muted" style={{ fontSize: 12 }}>
        Generation creates an unsaved version for review. Nothing reaches My
        templates or Campaigns until you choose a finish action.
      </p>
      {error ? (
        <div className="field-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={closeDisabled}
        >
          Cancel
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onGenerate}
          disabled={unavailable || !brief.trim()}
        >
          {generating
            ? "Creating…"
            : adaptSource
              ? "Create my version"
              : "Generate draft"}
        </button>
      </div>
    </>
  );
}

function OriginalSourcePanel({
  source,
  device,
  dark,
}: {
  source: CampaignTemplate;
  device: PreviewDevice;
  dark: boolean;
}): ReactElement {
  const hasStoredHtml = Boolean(source.body_html?.trim());
  const hostedPreview = campaignTemplatePreviewUrl(
    source,
    device === "mobile"
      ? ["mobile", "desktop", "card"]
      : ["desktop", "card", "mobile"],
  );
  return (
    <section aria-labelledby="tpl-ai-original-heading">
      <h3 id="tpl-ai-original-heading" style={{ fontSize: 13 }}>
        Original inspiration
      </h3>
      {hasStoredHtml ? (
        <TemplatePreview
          html={source.body_html ?? ""}
          {...(source.body_mjml ? { mjml: source.body_mjml } : {})}
          device={device}
          dark={dark}
          height={300}
        />
      ) : hostedPreview ? (
        <figure style={{ margin: 0 }}>
          <div
            style={{
              height: 300,
              overflow: "auto",
              border: "1px solid var(--pw-border)",
              borderRadius: 8,
              background: "var(--pw-bg-elev-2)",
            }}
          >
            <img
              src={hostedPreview}
              alt={`Hosted ${device} preview of ${source.name}`}
              decoding="async"
              referrerPolicy="no-referrer"
              style={{ display: "block", width: "100%", height: "auto" }}
            />
          </div>
          <figcaption className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            Sanitized Moosewave-hosted capture. The provider page is never
            loaded, and dark mode does not recolor this stored screenshot.
          </figcaption>
        </figure>
      ) : (
        <div className="card" style={{ minHeight: 180 }}>
          <strong>{source.name}</strong>
          <dl className="tpl-metadata-list">
            <div>
              <dt>Source</dt>
              <dd>
                {source.source_brand || source.source_provider || "Catalog"}
              </dd>
            </div>
            <div>
              <dt>Style</dt>
              <dd>{source.style || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Layout</dt>
              <dd>{source.layout || "Not recorded"}</dd>
            </div>
          </dl>
          <p className="muted" style={{ fontSize: 11 }}>
            Metadata comparison only. No remote screenshot or source page is
            loaded.
          </p>
        </div>
      )}
    </section>
  );
}

function ReviewList({
  title,
  items,
  clearText,
}: {
  title: string;
  items: string[];
  clearText: string;
}): ReactElement {
  return (
    <section>
      <h4 style={{ fontSize: 12, marginBottom: 4 }}>{title}</h4>
      {items.length > 0 ? (
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {clearText}
        </p>
      )}
    </section>
  );
}

interface TemplateReviewStepProps {
  adaptSource: CampaignTemplate | null;
  campaignRetryUnsafe: boolean;
  dark: boolean;
  device: PreviewDevice;
  canCreateCampaign: boolean;
  canRefine: boolean;
  canSave: boolean;
  currentRevision: number;
  draft: CampaignTemplateDesignOutput;
  draftName: string;
  error: string | null;
  finishMode: FinishMode;
  generating: boolean;
  previousVersions: RetainedTemplateVersion[];
  refinement: string;
  savedTemplateName: string | null;
  saving: boolean;
  serverValidation: CampaignTemplateDesignValidation;
  serverWarnings: CampaignTemplateDesignWarning[];
  viewedRevision: number;
  onClose: () => void;
  onDarkChange: (value: boolean) => void;
  onDeviceChange: (value: PreviewDevice) => void;
  onNameChange: (value: string) => void;
  onOpenCampaigns: () => void;
  onPreviewTextChange: (value: string) => void;
  onRefinementChange: (value: string) => void;
  onRestoreVersion: (index: number) => void;
  onSave: () => void;
  onStartOver: () => void;
  onSubjectChange: (value: string) => void;
  onTryAnother: () => void;
  onUseInCampaign: () => void;
}

export function TemplateReviewStep({
  adaptSource,
  campaignRetryUnsafe,
  canCreateCampaign,
  canRefine,
  canSave,
  currentRevision,
  dark,
  device,
  draft,
  draftName,
  error,
  finishMode,
  generating,
  previousVersions,
  refinement,
  savedTemplateName,
  saving,
  serverValidation,
  serverWarnings,
  viewedRevision,
  onClose,
  onDarkChange,
  onDeviceChange,
  onNameChange,
  onOpenCampaigns,
  onPreviewTextChange,
  onRefinementChange,
  onRestoreVersion,
  onSave,
  onStartOver,
  onSubjectChange,
  onTryAnother,
  onUseInCampaign,
}: TemplateReviewStepProps): ReactElement {
  const operationActive = generating || saving;
  const persisted = savedTemplateName !== null;
  const campaignCreated = campaignRetryUnsafe;
  const committed = persisted || campaignCreated;
  const viewingLatest = viewedRevision === currentRevision;
  const reviewChecks = reviewGeneratedTemplateDraft(draft);
  return (
    <>
      {adaptSource ? <SourceCapability source={adaptSource} /> : null}
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-name">
          Name
        </label>
        <input
          id="tpl-ai-name"
          className="input"
          value={draftName}
          maxLength={REVIEWED_TEMPLATE_NAME_MAX_BYTES}
          disabled={operationActive || committed || !viewingLatest}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-subject">
          Subject
        </label>
        <input
          id="tpl-ai-subject"
          className="input"
          value={draft.subject}
          maxLength={REVIEWED_TEMPLATE_SUBJECT_MAX_RUNES}
          disabled={operationActive || committed || !viewingLatest}
          onChange={(event) => onSubjectChange(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-preview-text">
          Preview text <span className="muted">(optional)</span>
        </label>
        <input
          id="tpl-ai-preview-text"
          className="input"
          value={draft.preview_text ?? ""}
          maxLength={REVIEWED_TEMPLATE_PREVIEW_MAX_RUNES}
          disabled={operationActive || committed || !viewingLatest}
          onChange={(event) => onPreviewTextChange(event.target.value)}
        />
      </div>
      <div className="field">
        <span className="field-label">
          {adaptSource ? "Original and result" : "Result preview"}
        </span>
        <TemplatePreviewToolbar
          device={device}
          onDeviceChange={onDeviceChange}
          dark={dark}
          onDarkChange={onDarkChange}
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: adaptSource
              ? "repeat(auto-fit, minmax(280px, 1fr))"
              : "1fr",
            gap: 12,
          }}
        >
          {adaptSource ? (
            <OriginalSourcePanel
              source={adaptSource}
              device={device}
              dark={dark}
            />
          ) : null}
          <section aria-labelledby="tpl-ai-result-heading">
            <h3 id="tpl-ai-result-heading" style={{ fontSize: 13 }}>
              Editable result
            </h3>
            <TemplatePreview
              html={draft.body_html}
              {...(draft.body_mjml ? { mjml: draft.body_mjml } : {})}
              device={device}
              dark={dark}
              height={300}
            />
          </section>
        </div>
        {device === "mobile" ? (
          <p className="muted" role="status" style={{ fontSize: 11 }}>
            Mobile is a simulated 375px preview. Check a real device in the
            campaign editor before sending.
          </p>
        ) : null}
      </div>

      <section className="notice" aria-labelledby="tpl-ai-review-heading">
        <div>
          <strong id="tpl-ai-review-heading">Review before finishing</strong>
          <p className="muted" style={{ margin: "4px 0 8px" }}>
            These are local hints, not a send approval. The campaign editor
            still runs authoritative pre-send and compliance checks.
          </p>
          <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
            <ReviewList
              title="Accessibility"
              items={reviewChecks.accessibility}
              clearText="No obvious image-alt or heading issue was detected."
            />
            <ReviewList
              title="Merge tags"
              items={reviewChecks.mergeTags}
              clearText="No unresolved or unregistered merge tags were detected."
            />
            <ReviewList
              title="Compliance reminders"
              items={reviewChecks.compliance}
              clearText="Basic footer markers were detected; verify the final campaign settings."
            />
          </div>
        </div>
      </section>

      <section
        className="notice"
        aria-labelledby="tpl-ai-server-review-heading"
      >
        <div>
          <strong id="tpl-ai-server-review-heading">
            Server validation · {serverValidation.status}
          </strong>
          <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
            {serverValidation.checks.map((check) => (
              <li key={`${check.code}-${check.message}`}>
                <strong>{check.status.toUpperCase()}</strong> · {check.message}
                {check.repaired ? " (repaired)" : ""}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {draft.warnings.length > 0 || serverWarnings.length > 0 ? (
        <div className="notice" role="status">
          <div>
            <strong>Generator review notes</strong>
            <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
              {draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {serverWarnings.map((warning) => (
                <li key={`${warning.code}-${warning.message}`}>
                  {warning.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {!viewingLatest ? (
        <div className="notice" role="status">
          <div>
            <strong>Viewing immutable version {viewedRevision}</strong>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              The server only accepts saves, campaign handoffs, and refinements
              against the latest version {currentRevision}. Return to it before
              continuing.
            </p>
          </div>
        </div>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="tpl-ai-refinement">
          What should the next version improve?
        </label>
        <textarea
          id="tpl-ai-refinement"
          className="input"
          rows={3}
          placeholder="e.g. Make the opening shorter and give the CTA more contrast."
          value={refinement}
          disabled={operationActive || committed || !viewingLatest}
          onChange={(event) => onRefinementChange(event.target.value)}
          style={{ height: "auto", padding: 8 }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>
            Refinement creates an immutable server revision from explicit base
            version {viewedRevision}. It is never saved automatically.
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={onTryAnother}
            disabled={
              operationActive ||
              committed ||
              !refinement.trim() ||
              !viewingLatest ||
              !canRefine
            }
          >
            {generating ? "Creating another…" : "Try another version"}
          </button>
        </div>
      </div>

      {previousVersions.length > 0 ? (
        <div className="field">
          <span className="field-label">Server revision history</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {previousVersions.map((version, index) => (
              <button
                key={`${version.revision}-${version.outputHash}`}
                type="button"
                className="btn btn-sm"
                disabled={operationActive || committed}
                aria-pressed={version.revision === viewedRevision}
                onClick={() => onRestoreVersion(index)}
              >
                {version.revision === viewedRevision ? "Viewing" : "View"}{" "}
                version {version.revision}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p id="tpl-ai-finish-guidance" className="muted" style={{ fontSize: 12 }}>
        {persisted && campaignCreated
          ? `“${savedTemplateName}” and a campaign draft now point to this exact immutable design revision. Open either outcome when you're ready.`
          : persisted
            ? `“${savedTemplateName}” is saved in My templates. The creative fields are locked; campaign creation still uses this exact immutable design revision without duplicating the template.`
            : campaignCreated
              ? "A campaign draft now points to this exact immutable design revision. Creative fields are locked, but you can still save the same revision and hash to My templates."
              : "Save as template commits this exact server revision and hash to My templates. Use in campaign creates a draft directly from that same immutable revision."}
      </p>
      {saving ? (
        <p role="status" aria-live="polite">
          {finishMode === "campaign"
            ? "Creating a campaign from the exact reviewed revision…"
            : "Saving the reviewed version to My templates…"}
        </p>
      ) : null}
      {error ? (
        <div className="field-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 16, gap: 6, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          onClick={onStartOver}
          disabled={operationActive || committed}
        >
          Change direction
        </button>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={operationActive}
        >
          {committed ? "Close" : "Discard"}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={onSave}
          disabled={
            operationActive || !viewingLatest || (!persisted && !canSave)
          }
          aria-describedby="tpl-ai-finish-guidance"
        >
          {finishMode === "template" && saving
            ? "Saving…"
            : persisted
              ? "Open saved template"
              : "Save as template"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={campaignRetryUnsafe ? onOpenCampaigns : onUseInCampaign}
          disabled={
            operationActive ||
            (!campaignRetryUnsafe && (!viewingLatest || !canCreateCampaign))
          }
          aria-describedby="tpl-ai-finish-guidance"
        >
          {finishMode === "campaign" && saving
            ? "Creating campaign…"
            : campaignRetryUnsafe
              ? "Check Campaigns"
              : "Use in campaign"}
        </button>
      </div>
    </>
  );
}
