import { Suspense, lazy, type ReactElement } from "react";

import { CrossClientPreview } from "../../components/CrossClientPreview";
import { EmailPreviewTabs } from "../../components/EmailPreviewTabs";
import { FieldError, FormField } from "../../components/FormField";
import {
  InboxRowPreview,
  readingMinutes,
} from "../../components/InboxRowPreview";
import { Modal, ModalFooter } from "../../components/Modal";
import { SubjectLineAssistant } from "../../components/SubjectLineAssistant";
import { SubjectLineSuggestions } from "../../components/SubjectLineSuggestions";
import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import { setSection } from "../../lib/store";
import type { CampaignsControllerProps } from "./campaigns-page-types";
import { CAMPAIGN_DRAFT_FIELD_LIMITS } from "./campaign-draft-storage";

const SubjectLab = lazy(() =>
  import("../../components/SubjectLab").then((module) => ({
    default: module.SubjectLab,
  })),
);

function CampaignSubjectField({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <FormField
      label="Subject line"
      required
      htmlFor="cam-subject"
      error={state.errors.get("subject")}
    >
      <input
        id="cam-subject"
        type="text"
        className="input"
        placeholder="What's new this month"
        value={state.draft.subject}
        maxLength={CAMPAIGN_DRAFT_FIELD_LIMITS.subject}
        disabled={!controller.canMutate}
        aria-describedby={
          !controller.canMutate ? "campaign-create-role-unavailable" : undefined
        }
        onChange={(event) =>
          state.setDraft({ ...state.draft, subject: event.target.value })
        }
      />
      {controller.canMutate && state.draft.subject.trim().length >= 10 ? (
        <SubjectLineSuggestions
          currentSubject={state.draft.subject}
          onPickVariant={(text) =>
            state.setDraft((draft) => ({ ...draft, subject: text }))
          }
          onOpenLab={() => state.setLabOpen(true)}
          onTestAll={
            controller.canMutate
              ? (variants) =>
                  controller.creation.runAbTestFromVariants(
                    variants,
                    "subject_suggestions",
                  )
              : undefined
          }
        />
      ) : null}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!controller.canMutate}
          aria-describedby={
            !controller.canMutate
              ? "campaign-create-role-unavailable"
              : undefined
          }
          onClick={() => state.setAssistantOpen((open) => !open)}
          aria-expanded={state.assistantOpen}
        >
          {state.assistantOpen
            ? "Hide brief assistant"
            : "✦ Start from a brief"}
        </button>
      </div>
      {state.assistantOpen && controller.canMutate ? (
        <SubjectLineAssistant
          onPickSubject={(text) =>
            state.setDraft((draft) => ({ ...draft, subject: text }))
          }
          onAutoPopulateAB={
            controller.canMutate
              ? (variants) =>
                  controller.creation.runAbTestFromVariants(
                    variants,
                    "subject_assistant",
                  )
              : undefined
          }
          onClose={() => state.setAssistantOpen(false)}
        />
      ) : null}
    </FormField>
  );
}

function CampaignPreviewTextField({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <FormField label="Preview text" htmlFor="cam-preview-text">
      <input
        id="cam-preview-text"
        type="text"
        className="input"
        placeholder="The line shown after the subject in the inbox"
        value={state.draft.previewText}
        maxLength={CAMPAIGN_DRAFT_FIELD_LIMITS.previewText}
        disabled={!controller.canMutate}
        aria-describedby={
          !controller.canMutate ? "campaign-create-role-unavailable" : undefined
        }
        onChange={(event) =>
          state.setDraft({ ...state.draft, previewText: event.target.value })
        }
      />
      <div className="field-v2-help" style={{ marginBottom: 8 }}>
        {state.draft.previewText.length}/200 — controls the gray snippet after
        the subject. Left blank, inboxes use the start of your body.
      </div>
      <InboxRowPreview
        sender={state.draft.fromEmail}
        subject={state.draft.subject}
        previewText={state.draft.previewText}
      />
    </FormField>
  );
}

function CampaignFromAddressField({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <FormField
      label="From address"
      required
      htmlFor="cam-from"
      error={state.errors.get("fromEmail")}
    >
      <input
        id="cam-from"
        type="email"
        className="input"
        placeholder="hello@your-domain.com"
        value={state.draft.fromEmail}
        maxLength={CAMPAIGN_DRAFT_FIELD_LIMITS.fromEmail}
        aria-describedby={
          controller.canMutate
            ? "cam-from-help"
            : "cam-from-help campaign-create-role-unavailable"
        }
        aria-invalid={state.errors.get("fromEmail") ? true : undefined}
        disabled={!controller.canMutate}
        onChange={(event) => {
          state.setDraft({ ...state.draft, fromEmail: event.target.value });
          if (state.errors.get("fromEmail")) state.errors.clear("fromEmail");
        }}
        onBlur={(event) => {
          const value = event.target.value.trim();
          if (!value) return;
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            state.errors.set("fromEmail", "Enter a valid From address.");
          }
        }}
      />
      <div id="cam-from-help" className="field-v2-help">
        Use a verified sending domain.{" "}
        <button
          type="button"
          className="link-button"
          disabled={!controller.canMutate}
          onClick={() => {
            state.setCreateOpen(false);
            setSection("domains");
          }}
        >
          Manage domains →
        </button>
      </div>
    </FormField>
  );
}

function CampaignBodyField({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  const minutes = readingMinutes(state.draft.body);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: state.bodyTab,
    items: [{ value: "edit" }, { value: "preview" }] as const,
    onChange: state.setBodyTab,
  });
  return (
    <FormField
      label={minutes > 0 ? `Body (HTML) · ${minutes} min read` : "Body (HTML)"}
      htmlFor="cam-body"
    >
      <div
        ref={tabs.listRef}
        className="tabs"
        {...tabs.listProps}
        aria-label="Campaign body view"
        style={{ marginBottom: 8 }}
      >
        <button
          type="button"
          {...tabs.getTabProps("edit")}
          className={`tab${state.bodyTab === "edit" ? " is-active" : ""}`}
        >
          Edit
        </button>
        <button
          type="button"
          {...tabs.getTabProps("preview")}
          className={`tab${state.bodyTab === "preview" ? " is-active" : ""}`}
        >
          Preview
        </button>
      </div>
      <section
        {...tabs.getPanelProps(state.bodyTab === "edit" ? "preview" : "edit")}
      />
      <div {...tabs.getPanelProps(state.bodyTab)}>
        {state.bodyTab === "edit" ? (
          <textarea
            id="cam-body"
            className="input"
            rows={4}
            placeholder="<h1>Hello</h1><p>Body…</p>"
            value={state.draft.body}
            maxLength={CAMPAIGN_DRAFT_FIELD_LIMITS.body}
            disabled={!controller.canMutate}
            aria-describedby={
              !controller.canMutate
                ? "campaign-create-role-unavailable"
                : undefined
            }
            onChange={(event) =>
              state.setDraft({ ...state.draft, body: event.target.value })
            }
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              resize: "vertical",
            }}
          />
        ) : (
          <>
            <EmailPreviewTabs body={state.draft.body} />
            <CrossClientPreview body={state.draft.body} />
          </>
        )}
      </div>
    </FormField>
  );
}

function CampaignCreateModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <Modal
      open={state.createOpen}
      onClose={controller.creation.closeCreate}
      title="New campaign"
      description="Save as draft. You can edit + send from the campaign view next."
    >
      <FormField
        label="Name"
        required
        htmlFor="cam-name"
        error={state.errors.get("name")}
      >
        <input
          id="cam-name"
          type="text"
          className="input"
          placeholder="Q3 newsletter"
          value={state.draft.name}
          maxLength={CAMPAIGN_DRAFT_FIELD_LIMITS.name}
          disabled={!controller.canMutate}
          aria-describedby={
            !controller.canMutate
              ? "campaign-create-role-unavailable"
              : undefined
          }
          onChange={(event) =>
            state.setDraft({ ...state.draft, name: event.target.value })
          }
        />
      </FormField>
      <CampaignSubjectField controller={controller} />
      <CampaignPreviewTextField controller={controller} />
      <FormField
        label="A/B from-name variants (optional)"
        htmlFor="cam-ab-fromnames"
      >
        <textarea
          id="cam-ab-fromnames"
          className="input"
          rows={2}
          placeholder={
            "One from-name per line — multivariate axis\nAcme Team\nJane at Acme"
          }
          value={state.abFromNames}
          disabled={!controller.canMutate}
          aria-describedby={
            !controller.canMutate
              ? "campaign-create-role-unavailable"
              : undefined
          }
          onChange={(event) => state.setAbFromNames(event.target.value)}
          style={{ resize: "vertical" }}
        />
        <div className="field-v2-help">
          When you run &ldquo;A/B test all subjects&rdquo; with 2+ from-names
          here, variants are the cross-product of subjects × from-names (capped
          at 8 combinations).
        </div>
      </FormField>
      <CampaignFromAddressField controller={controller} />
      <CampaignBodyField controller={controller} />
      {!controller.canMutate ? (
        <div id="campaign-create-role-unavailable" className="field-error">
          Ask a workspace editor or admin for campaign creation access.
        </div>
      ) : state.errors.get("_form") ? (
        <FieldError>{state.errors.get("_form")}</FieldError>
      ) : state.submitErr ? (
        <div className="field-error">{state.submitErr}</div>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={controller.creation.closeCreate}
          disabled={state.submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void controller.creation.submitCreate()}
          disabled={state.submitting || !controller.canMutate}
          aria-describedby={
            !controller.canMutate
              ? "campaign-create-role-unavailable"
              : undefined
          }
        >
          {state.submitting ? "Creating…" : "Create draft"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function CampaignSubjectLab({
  controller,
}: CampaignsControllerProps): ReactElement | null {
  const { state } = controller;
  if (!state.labOpen || !controller.canMutate) return null;
  return (
    <Suspense fallback={null}>
      <SubjectLab
        open
        onClose={() => state.setLabOpen(false)}
        seedSubject={state.draft.subject}
        bodyExcerpt={state.draft.body.slice(0, 800)}
        canMutate={controller.canMutate}
        onPickVariant={(text) =>
          state.setDraft((draft) => ({ ...draft, subject: text }))
        }
        onRunBandit={controller.creation.runBandit}
      />
    </Suspense>
  );
}

export function CampaignCreateOverlays({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      <CampaignCreateModal controller={controller} />
      <CampaignSubjectLab controller={controller} />
    </>
  );
}
