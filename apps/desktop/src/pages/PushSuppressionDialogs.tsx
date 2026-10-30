import {
  type FormEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { FieldError, FormField } from "../components/FormField";
import { Modal, ModalFooter } from "../components/Modal";
import { SlideoverShell } from "../components/SlideoverShell";
import {
  PUSH_PLATFORMS,
  type PushSuppressionPlatform,
  type PushSuppressionRow,
} from "../lib/api/push-suppressions";
import {
  clipboardAnnouncement,
  writeClipboardText,
} from "../lib/clipboard";
import {
  platformLabel,
  lockedReasonLabel,
  reasonLabel,
  rowAuthorityLabel,
  sourceLabel,
} from "./push-suppression-model";

interface AddDialogProps {
  open: boolean;
  platform: PushSuppressionPlatform;
  token: string;
  tokenError: string | null;
  requestError: string | null;
  busy: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onPlatformChange: (value: PushSuppressionPlatform) => void;
  onTokenChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}

export function PushSuppressionAddDialog({
  open,
  platform,
  token,
  tokenError,
  requestError,
  busy,
  returnFocusRef,
  onPlatformChange,
  onTokenChange,
  onClose,
  onSubmit,
}: AddDialogProps): ReactElement {
  const tokenRef = useRef<HTMLTextAreaElement | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onSubmit();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a manual push suppression"
      description="The raw token is used once to create an authority fact. It is never returned by this registry."
      initialFocusRef={tokenRef}
      returnFocusRef={returnFocusRef}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      size="md"
    >
      <form className="push-add-form" onSubmit={submit} noValidate>
        <div className="push-privacy-note" role="note">
          <strong>Private input.</strong> Paste only a customer device token.
          Password managers, spelling tools, and autocomplete are disabled. The
          value stays inside this dialog until you submit or close it.
        </div>
        <FormField
          label="Platform"
          required
          help={
            platform === "web"
              ? "Web entries are registry-only; customer Web dispatch is not enabled."
              : "Choose the service that issued this exact token."
          }
        >
          <select
            value={platform}
            onChange={(event) =>
              onPlatformChange(event.currentTarget.value as PushSuppressionPlatform)
            }
            disabled={busy}
          >
            {PUSH_PLATFORMS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Raw device token"
          required
          help={
            platform === "apns"
              ? "APNs requires the canonical 64-character hexadecimal token."
              : "Paste the canonical token exactly, without leading, trailing, or internal whitespace."
          }
          error={tokenError}
        >
          <textarea
            ref={tokenRef}
            rows={5}
            value={token}
            onChange={(event) => onTokenChange(event.currentTarget.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
          />
        </FormField>
        <dl className="push-add-facts">
          <div>
            <dt>Reason</dt>
            <dd>Manual (fixed)</dd>
          </div>
          <div>
            <dt>Authority</dt>
            <dd>Reversible by an exact admin with CAS review</dd>
          </div>
        </dl>
        {requestError ? <FieldError>{requestError}</FieldError> : null}
        <ModalFooter>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || token.length === 0}
            aria-busy={busy ? "true" : undefined}
          >
            {busy ? "Adding…" : "Add to registry"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function exactTime(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "long",
      })
    : value;
}

interface DetailProps {
  row: PushSuppressionRow | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function PushSuppressionDetail({
  row,
  returnFocusRef,
  onClose,
}: DetailProps): ReactElement | null {
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => setCopyStatus(""), [row?.id]);
  if (!row) return null;
  const copyFingerprint = async (): Promise<void> => {
    const result = await writeClipboardText(row.device_token_hash, {
      contentClass: "personal",
      label: "Push token fingerprint",
    });
    setCopyStatus(clipboardAnnouncement(result, "Fingerprint"));
  };
  return (
    <SlideoverShell
      open
      onClose={onClose}
      size="md"
      eyebrow="Push suppression authority"
      title={<span className="tabular">{row.device_token_hash}</span>}
      subtitle="Privacy-safe fingerprint; the raw token is not available"
      returnFocusRef={returnFocusRef}
      className="push-detail-panel"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close details
        </button>
      }
    >
      <div className="push-detail-copy">
        <code>{row.device_token_hash}</code>
        <button type="button" className="btn" onClick={() => void copyFingerprint()}>
          Copy fingerprint
        </button>
      </div>
      <p className="sr-only" aria-live="polite">
        {copyStatus}
      </p>
      <dl className="push-detail-facts">
        <div>
          <dt>Platform</dt>
          <dd>{platformLabel(row.platform)}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{reasonLabel(row.reason)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel(row.source)}</dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{rowAuthorityLabel(row)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={row.created_at}>{exactTime(row.created_at)}</time>
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={row.updated_at}>{exactTime(row.updated_at)}</time>
          </dd>
        </div>
        <div>
          <dt>CAS version</dt>
          <dd className="tabular">{row.version}</dd>
        </div>
        <div>
          <dt>Removal</dt>
          <dd>
            {row.reversible
              ? "Reversible"
              : row.locked_reason
                ? lockedReasonLabel(row.locked_reason)
                : "Locked"}
          </dd>
        </div>
      </dl>
    </SlideoverShell>
  );
}

interface RemoveDialogProps {
  target: PushSuppressionRow | null;
  error: string | null;
  busy: boolean;
  authorityCurrent: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function PushSuppressionRemoveDialog({
  target,
  error,
  busy,
  authorityCurrent,
  returnFocusRef,
  onClose,
  onConfirm,
}: RemoveDialogProps): ReactElement | null {
  if (!target) return null;
  return (
    <ConfirmModal
      open
      title="Remove manual suppression authority?"
      description="This CAS-protected action removes only the reviewed authority row. Another independent authority may keep the token suppressed."
      confirmLabel="Remove reviewed authority"
      danger
      typeToConfirm={target.device_token_hash}
      onConfirm={onConfirm}
      onClose={onClose}
      busy={busy}
      confirmDisabled={!authorityCurrent || Boolean(error)}
      returnFocusRef={returnFocusRef}
    >
      <dl className="push-remove-review">
        <div>
          <dt>Fingerprint</dt>
          <dd className="tabular">{target.device_token_hash}</dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{rowAuthorityLabel(target)}</dd>
        </div>
        <div>
          <dt>Expected version</dt>
          <dd className="tabular">{target.version}</dd>
        </div>
      </dl>
      {error ? <FieldError>{error}</FieldError> : null}
    </ConfirmModal>
  );
}
