import type { ReactElement } from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { FieldError } from "../components/FormField";
import type { PushSuppressionBulkRemoveState } from "./usePushSuppressionBulkRemove";

interface Props {
  state: PushSuppressionBulkRemoveState;
  authorityCurrent: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function PushSuppressionBulkRemoveDialog({
  state,
  authorityCurrent,
  onClose,
  onConfirm,
}: Props): ReactElement | null {
  if (!state.open) return null;
  const confirmation = `REMOVE ${state.reviewedRows.length}`;
  return (
    <ConfirmModal
      open
      title="Remove selected manual authorities?"
      description="This CAS-protected action removes only the exact reviewed rows. Independent provider or customer authorities can keep a token suppressed."
      confirmLabel={`Remove ${state.reviewedRows.length} authorities`}
      danger
      typeToConfirm={confirmation}
      onConfirm={onConfirm}
      onClose={onClose}
      busy={state.busy}
      confirmDisabled={!authorityCurrent || Boolean(state.error)}
      returnFocusRef={state.returnFocusRef}
    >
      <div className="push-bulk-review">
        <p>
          Review {state.reviewedRows.length.toLocaleString()} current-page
          fingerprints and their exact CAS versions:
        </p>
        <ul>
          {state.reviewedRows.map((row) => (
            <li key={row.id}>
              <code>{row.device_token_hash}</code>
              <span className="tabular">v{row.version}</span>
            </li>
          ))}
        </ul>
      </div>
      {state.error ? <FieldError>{state.error}</FieldError> : null}
    </ConfirmModal>
  );
}
