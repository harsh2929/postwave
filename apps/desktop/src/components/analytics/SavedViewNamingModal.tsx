import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { Modal, ModalFooter } from "../Modal";
import {
  MAX_VIEW_NAME,
  type AnalyticsRange,
} from "./saved-views-storage";

interface Props {
  open: boolean;
  current: { range: AnalyticsRange; vsPrevious: boolean };
  busy: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<string | null>;
}

export function SavedViewNamingModal({
  open,
  current,
  busy,
  onClose,
  onSave,
}: Props): ReactElement {
  const [draftName, setDraftName] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const inputId = useId();
  const inputHelpId = useId();
  const inputErrorId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraftName(
      `${current.range} · ${current.vsPrevious ? "compare" : "absolute"}`,
    );
    setNameErr(null);
  }, [current.range, current.vsPrevious, open]);

  async function commit(): Promise<void> {
    const name = draftName.trim();
    if (!name) {
      setNameErr("Name required.");
      return;
    }
    if (name.length > MAX_VIEW_NAME) {
      setNameErr(`Keep the name under ${MAX_VIEW_NAME} characters.`);
      return;
    }
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    const error = await onSave(name).catch(
      () => "The encrypted saved-view operation ended unexpectedly. Try again.",
    );
    pendingRef.current = false;
    if (!mountedRef.current) return;
    if (error) {
      setNameErr(error);
      return;
    }
    setDraftName("");
    setNameErr(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save current view"
      description={`Encrypts ${current.range} · ${current.vsPrevious ? "compare" : "absolute"} as a one-click recall for this account on this device.`}
    >
      <div className="field">
        <label className="field-label" htmlFor={inputId}>
          Name
        </label>
        <input
          id={inputId}
          type="text"
          className="input"
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
            if (nameErr) setNameErr(null);
          }}
          maxLength={MAX_VIEW_NAME}
          autoComplete="off"
          aria-invalid={nameErr ? "true" : undefined}
          aria-describedby={nameErr ? inputErrorId : inputHelpId}
          aria-errormessage={nameErr ? inputErrorId : undefined}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              void commit();
            }
          }}
        />
        {nameErr ? (
          <div id={inputErrorId} className="field-error" role="alert">
            {nameErr}
          </div>
        ) : (
          <div id={inputHelpId} className="field-help">
            {draftName.length} / {MAX_VIEW_NAME} characters.
          </div>
        )}
      </div>
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!draftName.trim() || busy}
          onClick={() => void commit()}
        >
          {busy ? "Encrypting…" : "Save view"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
