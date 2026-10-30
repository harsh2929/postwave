import { type FormEvent, type ReactElement } from "react";

import { FieldError } from "../components/FormField";
import { Modal, ModalFooter } from "../components/Modal";
import type { PushSuppressionImportState } from "./usePushSuppressionImport";

interface Props {
  state: PushSuppressionImportState;
  authorityCurrent: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}

export function PushSuppressionImportDialog({
  state,
  authorityCurrent,
  onClose,
  onSubmit,
}: Props): ReactElement {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onSubmit();
  };
  const canSubmit =
    authorityCurrent && !state.busy && !state.requestError && state.count > 0;

  return (
    <Modal
      open={state.open}
      onClose={onClose}
      title="Review manual push suppression import"
      description="Confirm the bounded local review before creating exact manual authorities."
      returnFocusRef={state.returnFocusRef}
      closeOnBackdrop={!state.busy}
      closeOnEscape={!state.busy}
      closeDisabled={state.busy}
      size="md"
    >
      <form className="push-import-form" onSubmit={submit}>
        <div className="push-privacy-note" role="note">
          <strong>Raw values hidden.</strong> Device tokens were validated locally
          and are intentionally not rendered in this review. They are cleared
          after submit, failure, or close.
        </div>
        {state.requestError ? (
          <FieldError>{state.requestError}</FieldError>
        ) : (
          <dl className="push-import-facts">
            <div>
              <dt>Reviewed rows</dt>
              <dd className="tabular">{state.count.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Platforms</dt>
              <dd>
                APNs {state.platformCounts.apns.toLocaleString()} · FCM{" "}
                {state.platformCounts.fcm.toLocaleString()} · Web{" "}
                {state.platformCounts.web.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>Manual (fixed)</dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Dashboard manual · reversible with later CAS review</dd>
            </div>
          </dl>
        )}
        <p className="push-import-format">
          Accepted format: header <code>platform,device_token</code>, followed by
          1–100 unique APNs, FCM, or Web rows. Automatic provider feedback is
          not created by this import.
        </p>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={state.busy}
          >
            {state.requestError ? "Close and verify registry" : "Cancel"}
          </button>
          {!state.requestError ? (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSubmit}
              aria-busy={state.busy ? "true" : undefined}
            >
              {state.busy ? "Importing…" : `Import ${state.count} reviewed rows`}
            </button>
          ) : null}
        </ModalFooter>
      </form>
    </Modal>
  );
}
