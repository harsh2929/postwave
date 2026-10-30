import { type ReactElement, useEffect, useState } from "react";

import {
  type InboundWebhookEndpoint,
  previewInboundWebhookTransform,
  updateInboundWebhookEndpoint,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";

interface Props {
  endpoint: InboundWebhookEndpoint | null;
  onClose: () => void;
  onSaved: (endpoint: InboundWebhookEndpoint) => void;
}

const SAMPLE_BODY = `{
  "customer": {
    "email": "ada@example.com",
    "plan": "pro"
  },
  "source": "billing"
}`;

function endpointTransform(endpoint: InboundWebhookEndpoint | null): string {
  return endpoint?.transform_jq ?? "";
}

export function InboundEndpointEditDialog({
  endpoint,
  onClose,
  onSaved,
}: Props): ReactElement | null {
  const [name, setName] = useState("");
  const [transform, setTransform] = useState("");
  const [sample, setSample] = useState(SAMPLE_BODY);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    setName(endpoint.name || endpoint.slug);
    setTransform(endpointTransform(endpoint));
    setSample(SAMPLE_BODY);
    setPreview(null);
    setPreviewError(null);
    setSaveError(null);
    setPreviewing(false);
    setSaving(false);
    setConfirmClose(false);
  }, [endpoint]);

  if (!endpoint) return null;

  const baselineName = endpoint.name || endpoint.slug;
  const baselineTransform = endpointTransform(endpoint);
  const dirty =
    name.trim() !== baselineName.trim() ||
    transform.trim() !== baselineTransform.trim();
  const busy = saving || previewing;

  const close = (): void => {
    if (busy) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const runPreview = async (): Promise<void> => {
    let body: unknown;
    try {
      body = JSON.parse(sample);
    } catch {
      setPreview(null);
      setPreviewError("Sample payload must be valid JSON.");
      return;
    }
    setPreviewing(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const result = await previewInboundWebhookTransform({
        transform_jq: transform.trim(),
        body,
      });
      if (result.error) {
        setPreviewError(sanitizeInspectableText(result.error.message).text);
        return;
      }
      setPreview(JSON.stringify(result.data.body, null, 2));
    } catch (error) {
      setPreviewError(
        sanitizeInspectableText(
          error instanceof Error
            ? error.message
            : "The transform preview request failed.",
        ).text,
      );
    } finally {
      setPreviewing(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!dirty || !name.trim() || saving) return;
    const patch: { name?: string; transform_jq?: string } = {};
    if (name.trim() !== baselineName.trim()) patch.name = name.trim();
    if (transform.trim() !== baselineTransform.trim()) {
      patch.transform_jq = transform.trim();
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateInboundWebhookEndpoint(endpoint.id, patch);
      if (result.error) {
        setSaveError(sanitizeInspectableText(result.error.message).text);
        return;
      }
      toast.success("Inbound endpoint updated");
      onSaved(result.data);
    } catch (error) {
      setSaveError(
        sanitizeInspectableText(
          error instanceof Error
            ? error.message
            : "The endpoint update request failed.",
        ).text,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open
        title="Edit inbound endpoint"
        description="Rename this endpoint or shape verified JSON before Moosewave stores and routes it. The signing secret and public URL stay unchanged."
        onClose={close}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
      >
        <div className="field">
          <label className="field-label" htmlFor="inbound-endpoint-name">
            Endpoint name
          </label>
          <input
            id="inbound-endpoint-name"
            className="input"
            value={name}
            maxLength={200}
            required
            aria-invalid={!name.trim() ? "true" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setSaveError(null);
            }}
          />
          {!name.trim() ? (
            <p className="field-error" role="alert">
              Enter a name that operators can recognise.
            </p>
          ) : null}
        </div>

        <details className="wh-policy-editor" open={Boolean(transform.trim())}>
          <summary>
            <span>
              <strong>Payload transform</strong>
              <small>Optional · bounded jq</small>
            </span>
          </summary>
          <div className="wh-policy-editor-body">
            <div className="notice">
              Transform runs only after signature verification. Imports and
              includes are blocked; execution is time- and size-limited by the
              server.
            </div>
            <div className="field">
              <label className="field-label" htmlFor="inbound-transform-jq">
                jq expression
              </label>
              <textarea
                id="inbound-transform-jq"
                className="textarea mono"
                rows={4}
                placeholder="{ email: .customer.email, plan: .customer.plan }"
                value={transform}
                spellCheck={false}
                onChange={(event) => {
                  setTransform(event.target.value);
                  setPreview(null);
                  setPreviewError(null);
                  setSaveError(null);
                }}
              />
              <p className="field-help">
                Leave empty to retain the original verified JSON body.
              </p>
            </div>
            <div className="wh-policy-preview-grid">
              <div className="field">
                <label className="field-label" htmlFor="inbound-sample-json">
                  Sample JSON
                </label>
                <textarea
                  id="inbound-sample-json"
                  className="textarea mono"
                  rows={8}
                  value={sample}
                  spellCheck={false}
                  onChange={(event) => {
                    setSample(event.target.value);
                    setPreview(null);
                    setPreviewError(null);
                  }}
                />
              </div>
              <div className="field">
                <div className="field-label">Server preview</div>
                <pre
                  className="wh-policy-preview"
                  aria-live="polite"
                  aria-busy={previewing ? "true" : undefined}
                >
                  {previewing
                    ? "Running bounded preview…"
                    : (preview ??
                      "Run preview to validate against the production transform engine.")}
                </pre>
              </div>
            </div>
            {previewError ? (
              <p className="field-error" role="alert">
                Preview failed: {previewError}
              </p>
            ) : null}
            <div className="wh-policy-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void runPreview()}
              >
                {previewing ? "Previewing…" : "Run server preview"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy || (!transform && sample === SAMPLE_BODY)}
                onClick={() => {
                  setTransform("");
                  setSample(SAMPLE_BODY);
                  setPreview(null);
                  setPreviewError(null);
                }}
              >
                Reset transform
              </button>
            </div>
          </div>
        </details>

        {saveError ? (
          <p className="field-error" role="alert">
            Couldn&apos;t save endpoint: {saveError}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !dirty || !name.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save endpoint"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard endpoint changes?"
        description="The unsaved name or payload transform will be cleared. The live endpoint will not change."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onClose={() => setConfirmClose(false)}
      />
    </>
  );
}
