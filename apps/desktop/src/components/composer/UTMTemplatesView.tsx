import { type ReactElement, useId } from "react";

import type { UTMTemplate } from "../../lib/api-client";
import { Modal } from "../Modal";
import { Notice } from "../Notice";
import { Skeleton } from "../Skeleton";
import {
  MAX_UTM_PREVIEW_URL_CHARS,
  MAX_UTM_VALUE_CHARS,
  templateSummary,
  UTM_PARAM_FIELDS,
} from "./utm-template-helpers";
import type { UTMTemplatesController } from "./useUTMTemplatesController";

function TemplatesTable({
  campaignId,
  controller,
  permissionReasonId,
}: {
  campaignId: string | number;
  controller: UTMTemplatesController;
  permissionReasonId: string;
}): ReactElement {
  if (controller.loading && controller.templates === null) {
    return <Skeleton lines={2} aria-label="Loading UTM templates" />;
  }
  if (controller.loadError && controller.templates === null) {
    return (
      <Notice
        tone="danger"
        title="Couldn't load UTM templates"
        action={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void controller.load()}
          >
            Retry
          </button>
        }
      >
        {controller.loadError}
      </Notice>
    );
  }
  if (!controller.templates?.length) {
    return (
      <>
        {controller.loadError ? (
          <Notice
            tone="danger"
            title="Couldn't refresh UTM templates"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void controller.load()}
              >
                Retry
              </button>
            }
          >
            {controller.loadError}
          </Notice>
        ) : null}
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          No saved UTM templates yet — links go out untagged. Enter at least one
          parameter below, then save a tenant default or campaign override.
        </div>
      </>
    );
  }
  return (
    <>
      {controller.loadError ? (
        <Notice
          tone="danger"
          title="Couldn't refresh UTM templates"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void controller.load()}
            >
              Retry
            </button>
          }
        >
          {controller.loadError} The last verified templates remain visible.
        </Notice>
      ) : controller.loading ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Refreshing UTM templates; showing the last verified rows.
        </div>
      ) : null}
      <div style={{ overflowX: "auto", marginBottom: 8 }}>
        <table className="link-table">
          <caption className="visually-hidden">Saved UTM templates</caption>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">Parameters</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {controller.templates.map((template) => (
              <TemplateRow
                key={template.id}
                campaignId={campaignId}
                controller={controller}
                permissionReasonId={permissionReasonId}
                template={template}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TemplateRow({
  campaignId,
  controller,
  template,
  permissionReasonId,
}: {
  campaignId: string | number;
  controller: UTMTemplatesController;
  template: UTMTemplate;
  permissionReasonId: string;
}): ReactElement {
  const isThisCampaign =
    template.campaign_id != null &&
    String(template.campaign_id) === String(campaignId);
  return (
    <tr>
      <td style={{ whiteSpace: "nowrap" }}>
        {template.is_default ? (
          <span className="badge">Default</span>
        ) : isThisCampaign ? (
          <span className="badge accent">This campaign</span>
        ) : template.campaign_id != null ? (
          <span className="badge">Campaign {String(template.campaign_id)}</span>
        ) : (
          <span className="badge warning">Unscoped template</span>
        )}
        {!template.enabled ? (
          <span className="badge warning" style={{ marginLeft: 4 }}>
            Disabled
          </span>
        ) : null}
      </td>
      <td className="muted" style={{ fontSize: 11, overflowWrap: "anywhere" }}>
        {templateSummary(template)}
      </td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => controller.loadTemplate(template)}
          disabled={controller.operationActive}
        >
          Load
        </button>{" "}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => {
            if (controller.canEditTemplates && !controller.operationActive) {
              controller.selectDelete(template);
            }
          }}
          disabled={controller.operationActive}
          aria-disabled={
            !controller.canEditTemplates || controller.operationActive
          }
          aria-label={`Delete ${
            template.is_default
              ? "tenant default"
              : template.campaign_id != null
                ? `campaign ${String(template.campaign_id)}`
                : "unscoped"
          } UTM template`}
          aria-describedby={
            !controller.canEditTemplates ? permissionReasonId : undefined
          }
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

function TemplateEditor({
  controller,
  editorReasonId,
}: {
  controller: UTMTemplatesController;
  editorReasonId: string;
}): ReactElement {
  const busy = controller.operationActive;
  return (
    <>
      <div className="label" style={{ marginTop: 12 }}>
        Edit template
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
          gap: 8,
        }}
      >
        {UTM_PARAM_FIELDS.map((field) => (
          <div className="field" key={field.key} style={{ margin: 0 }}>
            <label className="field-label" htmlFor={`utm-${field.key}`}>
              {field.label}
            </label>
            <input
              id={`utm-${field.key}`}
              type="text"
              className="input mono"
              maxLength={MAX_UTM_VALUE_CHARS}
              value={controller.form[field.key]}
              onChange={(event) =>
                controller.setFormValue(field.key, event.target.value)
              }
              placeholder={field.placeholder}
              disabled={!controller.canMutate || busy}
              aria-describedby={editorReasonId}
            />
          </div>
        ))}
      </div>
      <p
        id={editorReasonId}
        className="muted"
        role={!controller.canEditTemplates ? "status" : undefined}
        style={{ fontSize: 12, margin: "8px 0 0" }}
      >
        {busy
          ? "A UTM template request is in progress. Editing and actions resume when it finishes."
          : !controller.canEditTemplates
            ? `${controller.templatesGateTitle}. You can still load a saved template and preview how it rewrites a URL.`
            : !controller.formHasValue
              ? "Enter at least one UTM parameter to enable saving or applying this template. Blank fields are omitted."
              : "Tenant defaults apply broadly; a campaign override applies only to this campaign and takes precedence."}
      </p>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 8,
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (
              controller.canEditTemplates &&
              controller.formHasValue &&
              !busy
            ) {
              void controller.saveDefault();
            }
          }}
          disabled={busy}
          aria-disabled={
            !controller.canEditTemplates || !controller.formHasValue || busy
          }
          aria-describedby={editorReasonId}
        >
          {controller.mutation === "default"
            ? "Saving…"
            : "Save as tenant default"}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            if (
              controller.canEditTemplates &&
              controller.formHasValue &&
              !busy
            ) {
              void controller.applyToCampaign();
            }
          }}
          disabled={busy}
          aria-disabled={
            !controller.canEditTemplates || !controller.formHasValue || busy
          }
          aria-describedby={editorReasonId}
        >
          {controller.mutation === "campaign"
            ? "Applying…"
            : "Apply to this campaign"}
        </button>
      </div>
    </>
  );
}

function PreviewPanel({
  controller,
}: {
  controller: UTMTemplatesController;
}): ReactElement {
  const previewReasonId = useId();
  const previewReady = controller.previewUrl.trim() !== "";
  return (
    <>
      <div className="label" style={{ marginTop: 12 }}>
        Preview
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <input
          type="url"
          className="input mono"
          aria-label="URL to preview"
          maxLength={MAX_UTM_PREVIEW_URL_CHARS}
          value={controller.previewUrl}
          onChange={(event) => controller.setPreviewUrl(event.target.value)}
          style={{ flex: 1, minWidth: "min(100%, 14rem)" }}
          disabled={controller.operationActive}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (previewReady && !controller.operationActive) {
              void controller.runPreview();
            }
          }}
          disabled={controller.operationActive}
          aria-disabled={controller.operationActive || !previewReady}
          aria-describedby={!previewReady ? previewReasonId : undefined}
        >
          {controller.previewing ? "Previewing…" : "Preview"}
        </button>
      </div>
      <p
        id={previewReasonId}
        className="muted"
        style={{ fontSize: 12, margin: "6px 0 0" }}
      >
        {previewReady
          ? "Preview is read-only and does not save or send anything."
          : "Enter a complete URL to enable preview."}
      </p>
      {controller.previewError ? (
        <Notice
          tone="danger"
          title="Preview failed"
          style={{ marginTop: 8 }}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void controller.runPreview()}
              disabled={controller.operationActive}
            >
              Retry
            </button>
          }
        >
          {controller.previewError}
        </Notice>
      ) : null}
      {controller.preview ? (
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            {!controller.preview.template.id
              ? "No UTM template applies — links go out untagged."
              : `Using the ${
                  controller.preview.template.campaign_id
                    ? "campaign override"
                    : "tenant default"
                } template:`}
          </div>
          <dl style={{ margin: 0, display: "grid", gap: 8 }}>
            <div>
              <dt className="muted" style={{ fontSize: 11 }}>
                Original URL
              </dt>
              <dd
                className="mono"
                style={{ margin: 0, fontSize: 11, wordBreak: "break-all" }}
              >
                {controller.preview.original}
              </dd>
            </div>
            <div>
              <dt className="muted" style={{ fontSize: 11 }}>
                Rewritten URL
              </dt>
              <dd
                className="mono"
                style={{
                  margin: 0,
                  fontSize: 11,
                  wordBreak: "break-all",
                  fontWeight: 600,
                }}
              >
                {controller.preview.rewritten}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </>
  );
}

export function UTMTemplatesView({
  campaignId,
  controller,
  onClose,
  open,
}: {
  campaignId: string | number;
  controller: UTMTemplatesController;
  onClose: () => void;
  open: boolean;
}): ReactElement {
  const editorReasonId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="UTM templates"
      description="Auto-tag every link in outgoing campaigns. A per-campaign template overrides the tenant default."
      size="lg"
    >
      <div className="label">Templates</div>
      <TemplatesTable
        campaignId={campaignId}
        controller={controller}
        permissionReasonId={editorReasonId}
      />
      <TemplateEditor controller={controller} editorReasonId={editorReasonId} />
      <PreviewPanel controller={controller} />
    </Modal>
  );
}
