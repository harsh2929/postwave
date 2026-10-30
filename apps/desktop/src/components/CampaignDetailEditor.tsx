import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from "react";

import { type Campaign, type EmailBlockInstance } from "../lib/api-client";
import { CAMPAIGN_CONTENT_AST_V2_ENABLED } from "../lib/config";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { ChoiceGroup } from "./ChoiceGroup";
import { BlockEditor } from "./composer/BlockEditor";
import { CrossClientPreview } from "./CrossClientPreview";
import { CursorOverlay } from "./CursorOverlay";
import { EmailPreviewTabs } from "./EmailPreviewTabs";
import { FromNameSuggestions } from "./composer/FromNameSuggestions";
import { InboxRowPreview } from "./InboxRowPreview";
import { PreviewAsSubscriber } from "./PreviewAsSubscriber";
import { toast } from "./Toast";

export type CampaignBodyTab = "edit" | "preview";
export type CampaignEditorMode = "html" | "blocks";

export interface CampaignEditorDraft {
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  body: string;
  previewText: string;
  goalEvent: string;
  goalWindowHours: number;
  audienceMode: string;
  sourceMode?: "semantic" | "legacy_html";
  contentSchemaVersion?: number;
  semanticNodesJSON?: string;
  factContractJSON?: string;
}

interface CampaignEditorFieldsProps {
  id: Campaign["id"];
  draft: CampaignEditorDraft;
  setDraft: Dispatch<SetStateAction<CampaignEditorDraft>>;
  savedFromEmail: string;
  saving: boolean;
  freezingAudience: boolean;
  canMutate: boolean;
  onFreezeAudience: () => Promise<void>;
}

function CampaignEditorFields({
  id,
  draft,
  setDraft,
  savedFromEmail,
  saving,
  freezingAudience,
  canMutate,
  onFreezeAudience,
}: CampaignEditorFieldsProps): ReactElement {
  const fieldsDisabled = saving || freezingAudience || !canMutate;
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-name">
          Name
        </label>
        <input
          id="cam-edit-name"
          type="text"
          className="input"
          value={draft.name}
          disabled={fieldsDisabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              name: event.target.value,
            }))
          }
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-subject">
          Subject
        </label>
        <input
          id="cam-edit-subject"
          type="text"
          className="input"
          value={draft.subject}
          disabled={fieldsDisabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              subject: event.target.value,
            }))
          }
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-preview-text">
          Preview text
        </label>
        <input
          id="cam-edit-preview-text"
          type="text"
          className="input"
          maxLength={200}
          value={draft.previewText}
          disabled={fieldsDisabled}
          placeholder="The line shown after the subject in the inbox"
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              previewText: event.target.value,
            }))
          }
        />
        <div style={{ marginTop: 8 }}>
          <InboxRowPreview
            sender={draft.fromEmail || savedFromEmail}
            subject={draft.subject}
            previewText={draft.previewText}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-audience-mode">
          Audience mode
        </label>
        <select
          id="cam-edit-audience-mode"
          className="input"
          value={draft.audienceMode}
          disabled={fieldsDisabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              audienceMode: event.target.value,
            }))
          }
        >
          <option value="dynamic">Dynamic — re-evaluate at send time</option>
          <option value="static">Static — snapshot now</option>
        </select>
        <div id="campaign-audience-mode-help" className="field-v2-help">
          Dynamic recomputes the audience when the campaign sends; static
          freezes today&rsquo;s membership.
        </div>
        {draft.audienceMode === "static" && id != null ? (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 6 }}
            disabled={fieldsDisabled}
            aria-describedby="campaign-audience-mode-help"
            onClick={() => {
              if (fieldsDisabled) return;
              void onFreezeAudience();
            }}
          >
            {freezingAudience ? "Freezing audience…" : "Freeze audience now"}
          </button>
        ) : null}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-goal-event">
          Conversion goal
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="cam-edit-goal-event"
            type="text"
            className="input"
            style={{ flex: 2 }}
            value={draft.goalEvent}
            disabled={fieldsDisabled}
            placeholder="Tracked event, e.g. checkout.complete"
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                goalEvent: event.target.value,
              }))
            }
          />
          <select
            className="input"
            style={{ flex: 1 }}
            aria-label="Attribution window"
            value={draft.goalWindowHours || 24}
            disabled={fieldsDisabled || !draft.goalEvent.trim()}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                goalWindowHours: Number(event.target.value),
              }))
            }
          >
            <option value={1}>1 hour</option>
            <option value={24}>24 hours</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
        </div>
        <div className="field-v2-help">
          Conversions of this event attributed to the campaign within the window
          show as conversion rate + revenue in the report.
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-from-name">
          From name
        </label>
        <input
          id="cam-edit-from-name"
          type="text"
          className="input"
          value={draft.fromName}
          disabled={fieldsDisabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              fromName: event.target.value,
            }))
          }
          placeholder="Acme Newsletter"
        />
        <FromNameSuggestions
          onApply={(name) =>
            setDraft((current) => ({ ...current, fromName: name }))
          }
          disabled={fieldsDisabled}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-edit-from">
          From address
        </label>
        <input
          id="cam-edit-from"
          type="email"
          className="input"
          value={draft.fromEmail}
          disabled={fieldsDisabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              fromEmail: event.target.value,
            }))
          }
        />
      </div>
    </>
  );
}

interface CampaignBodyEditorProps {
  id: Campaign["id"];
  draft: CampaignEditorDraft;
  setDraft: Dispatch<SetStateAction<CampaignEditorDraft>>;
  editorMode: CampaignEditorMode;
  setEditorMode: Dispatch<SetStateAction<CampaignEditorMode>>;
  blockInstances: EmailBlockInstance[];
  setBlockInstances: Dispatch<SetStateAction<EmailBlockInstance[]>>;
  setLastComposedMjml: Dispatch<SetStateAction<string>>;
  setConfirmModeSwitch: Dispatch<SetStateAction<boolean>>;
  bodyTab: CampaignBodyTab;
  setBodyTab: Dispatch<SetStateAction<CampaignBodyTab>>;
  editorWrapRef: RefObject<HTMLDivElement | null>;
  canMutate: boolean;
}

function CampaignBodyEditor({
  id,
  draft,
  setDraft,
  editorMode,
  setEditorMode,
  blockInstances,
  setBlockInstances,
  setLastComposedMjml,
  setConfirmModeSwitch,
  bodyTab,
  setBodyTab,
  editorWrapRef,
  canMutate,
}: CampaignBodyEditorProps): ReactElement {
  const tabs = useTabsInteraction({
    activation: "manual",
    value: bodyTab,
    items: [{ value: "edit" }, { value: "preview" }] as const,
    onChange: setBodyTab,
  });
  if (draft.sourceMode === "semantic") {
    const semanticMutable = canMutate && CAMPAIGN_CONTENT_AST_V2_ENABLED;
    return (
      <div className="field">
        <div className="field-label">Semantic source · AST v2</div>
        <div className="field-v2-help" style={{ marginBottom: 10 }}>
          This exact node array and Fact Contract are authoritative. HTML,
          semantic plain text, structured data, and MIME are server projections.
        </div>
        <div
          className="notice"
          role="note"
          style={{ marginBottom: 10, fontSize: 11 }}
        >
          Structured-data claim boundary: this JSON can be deterministically
          valid, while sender eligibility and emission remain predicted until
          the frozen server compile. Provider display is observed only from
          controlled inbox evidence; valid markup does not prove display or a
          comprehension benefit.
        </div>
        {!CAMPAIGN_CONTENT_AST_V2_ENABLED ? (
          <div className="notice" role="status" style={{ marginBottom: 10 }}>
            Semantic editing is read-only until{" "}
            <code>VITE_ENABLE_CAMPAIGN_CONTENT_AST_V2=1</code> is enabled.
          </div>
        ) : null}
        <label className="field-label" htmlFor="cam-edit-semantic-nodes">
          Semantic node array
        </label>
        <textarea
          id="cam-edit-semantic-nodes"
          className="input"
          rows={16}
          spellCheck={false}
          readOnly={!semanticMutable}
          value={draft.semanticNodesJSON ?? "[]"}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              semanticNodesJSON: event.target.value,
            }))
          }
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            resize: "vertical",
            minHeight: 260,
          }}
        />
        <label
          className="field-label"
          htmlFor="cam-edit-fact-contract"
          style={{ marginTop: 12 }}
        >
          Fact Contract v1
        </label>
        <textarea
          id="cam-edit-fact-contract"
          className="input"
          rows={10}
          spellCheck={false}
          readOnly={!semanticMutable}
          value={draft.factContractJSON ?? "{}"}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              factContractJSON: event.target.value,
            }))
          }
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            resize: "vertical",
            minHeight: 180,
          }}
        />
      </div>
    );
  }
  const changeEditorMode = (mode: CampaignEditorMode): void => {
    if (mode === editorMode) return;
    if (mode === "html" && blockInstances.length > 0) {
      setConfirmModeSwitch(true);
      return;
    }
    setEditorMode(mode);
  };
  return (
    <div className="field">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <label
          className="field-label"
          htmlFor="cam-edit-body"
          style={{ marginBottom: 0 }}
        >
          Body
        </label>
        <ChoiceGroup
          legend="Body editing mode"
          value={editorMode}
          onChange={changeEditorMode}
          optionClassName="btn btn-sm"
          disabled={!canMutate}
          style={{ display: "inline-flex", gap: 4 }}
          options={(["html", "blocks"] as const).map((mode) => ({
            value: mode,
            label: mode === "html" ? "HTML" : "Blocks",
            className: editorMode === mode ? "btn-primary" : undefined,
          }))}
        />
      </div>
      {editorMode === "blocks" ? (
        canMutate ? (
          <BlockEditor
            instances={blockInstances}
            onInstancesChange={setBlockInstances}
            subject={draft.subject}
            onComposed={setLastComposedMjml}
            onApply={(mjml) => {
              if (!canMutate) return;
              setDraft((current) => ({ ...current, body: mjml }));
              toast.success("Composed blocks written to the body");
            }}
            canMutate
          />
        ) : (
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Block structure is preserved, but block editing and composition
              are unavailable while this local draft is read-only.
            </div>
            <EmailPreviewTabs body={draft.body} />
          </div>
        )
      ) : (
        <>
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
              className={`tab${bodyTab === "edit" ? " is-active" : ""}`}
            >
              Edit
            </button>
            <button
              type="button"
              {...tabs.getTabProps("preview")}
              className={`tab${bodyTab === "preview" ? " is-active" : ""}`}
            >
              Preview
            </button>
          </div>
          <section
            {...tabs.getPanelProps(bodyTab === "edit" ? "preview" : "edit")}
          />
          <div
            ref={editorWrapRef}
            {...tabs.getPanelProps(bodyTab)}
            className="campaign-body-editor-wrap"
            style={{ position: "relative" }}
          >
            {bodyTab === "edit" ? (
              <textarea
                id="cam-edit-body"
                className="input"
                rows={8}
                value={draft.body}
                disabled={!canMutate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    body: event.target.value,
                  }))
                }
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  resize: "vertical",
                  minHeight: 120,
                }}
              />
            ) : (
              <EmailPreviewTabs body={draft.body} />
            )}
            {bodyTab === "preview" ? (
              <CrossClientPreview body={draft.body} />
            ) : null}
            {bodyTab === "preview" && id != null ? (
              <PreviewAsSubscriber campaignId={id} />
            ) : null}
            {id != null ? (
              <CursorOverlay campaignId={id} editorRef={editorWrapRef} />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

interface CampaignDetailEditorProps {
  id: Campaign["id"];
  draft: CampaignEditorDraft;
  setDraft: Dispatch<SetStateAction<CampaignEditorDraft>>;
  savedFromEmail: string;
  editorMode: CampaignEditorMode;
  setEditorMode: Dispatch<SetStateAction<CampaignEditorMode>>;
  blockInstances: EmailBlockInstance[];
  setBlockInstances: Dispatch<SetStateAction<EmailBlockInstance[]>>;
  setLastComposedMjml: Dispatch<SetStateAction<string>>;
  setConfirmModeSwitch: Dispatch<SetStateAction<boolean>>;
  bodyTab: CampaignBodyTab;
  setBodyTab: Dispatch<SetStateAction<CampaignBodyTab>>;
  editorWrapRef: RefObject<HTMLDivElement | null>;
  saving: boolean;
  freezingAudience: boolean;
  saveErr: string | null;
  canMutate: boolean;
  onCancel: () => void;
  onSave: () => Promise<void>;
  onFreezeAudience: () => Promise<void>;
}

export function CampaignDetailEditor({
  id,
  draft,
  setDraft,
  savedFromEmail,
  editorMode,
  setEditorMode,
  blockInstances,
  setBlockInstances,
  setLastComposedMjml,
  setConfirmModeSwitch,
  bodyTab,
  setBodyTab,
  editorWrapRef,
  saving,
  freezingAudience,
  saveErr,
  canMutate,
  onCancel,
  onSave,
  onFreezeAudience,
}: CampaignDetailEditorProps): ReactElement {
  const mutationBusy = saving || freezingAudience;
  return (
    <div className="card">
      {!canMutate ? (
        <div className="notice" role="status" style={{ marginBottom: 12 }}>
          <strong>Local draft is read-only</strong>
          <div className="muted" style={{ marginTop: 4 }}>
            Your role changed while this editor was open. Your text is kept so
            you can copy it or cancel the draft, but it cannot be changed or
            saved with the current role.
          </div>
        </div>
      ) : null}
      <CampaignEditorFields
        id={id}
        draft={draft}
        setDraft={setDraft}
        savedFromEmail={savedFromEmail}
        saving={saving}
        freezingAudience={freezingAudience}
        canMutate={canMutate}
        onFreezeAudience={onFreezeAudience}
      />
      <CampaignBodyEditor
        id={id}
        draft={draft}
        setDraft={setDraft}
        editorMode={editorMode}
        setEditorMode={setEditorMode}
        blockInstances={blockInstances}
        setBlockInstances={setBlockInstances}
        setLastComposedMjml={setLastComposedMjml}
        setConfirmModeSwitch={setConfirmModeSwitch}
        bodyTab={bodyTab}
        setBodyTab={setBodyTab}
        editorWrapRef={editorWrapRef}
        canMutate={canMutate && !mutationBusy}
      />
      {saveErr ? <div className="field-error">{saveErr}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={mutationBusy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onSave()}
          disabled={mutationBusy || !canMutate}
        >
          {saving
            ? "Saving…"
            : freezingAudience
              ? "Freezing audience…"
              : "Save changes"}
        </button>
      </div>
    </div>
  );
}
