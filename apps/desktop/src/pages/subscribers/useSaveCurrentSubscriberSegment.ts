import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import { usePersistentLifecycleOperation } from "../../hooks/usePersistentLifecycleOperation";
import { useDiscardOnlyDraftLifecycle } from "../../hooks/useSettingsDraftLifecycle";
import {
  type SavedSegment,
  type SavedSegmentScope,
  createSavedSegment,
} from "../../lib/api-client";
import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";

const SAVED_SEGMENT_NAME_MAX = 120;

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function savedCreateFailureMessage(
  error: RemoteApiError,
  maximum: number,
): string {
  switch (error.code) {
    case "name_taken":
      return "A saved segment with this name already exists. Choose a different name.";
    case "saved_segment_limit_reached":
      return `This workspace has reached its ${maximum.toLocaleString()} saved-segment limit.`;
    case "name_too_long":
      return `Use ${SAVED_SEGMENT_NAME_MAX} characters or fewer.`;
    case "invalid_text":
      return "Remove control characters from the saved-segment name.";
    case "personal_scope_requires_user":
      return "Personal segments require a signed-in user identity. Sign in again or choose Workspace sharing.";
    default:
      return remoteFailureFromError(error).message;
  }
}

export function useSaveCurrentSubscriberSegment(input: {
  identityScope: string | null;
  segments: SavedSegment[];
  total: number;
  maximum: number;
  scopePending: boolean;
  predicate: unknown;
  closeMenu: () => void;
  onSaved: () => Promise<void>;
}) {
  const mountedRef = useRef(true);
  const identityRef = useRef(input.identityScope);
  identityRef.current = input.identityScope;
  const [open, setOpenState] = useState(false);
  const [name, setNameState] = useState("");
  const [scope, setScopeState] = useState<SavedSegmentScope>("personal");
  const [serverError, setServerError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const operation = usePersistentLifecycleOperation({
    ownerId: "subscriber-save-current-segment",
    label: "Saved segment creation",
  });
  const duplicate = input.segments.some(
    (segment) => normalizedName(segment.name) === normalizedName(name),
  );
  const atLimit = input.total >= input.maximum;
  const nameLength = Array.from(name).length;
  const nameError =
    nameLength > SAVED_SEGMENT_NAME_MAX
      ? `Use ${SAVED_SEGMENT_NAME_MAX} characters or fewer.`
      : normalizedName(name) && duplicate
        ? "A saved segment with this name already exists in the workspace."
        : atLimit
          ? `This workspace has reached its ${input.maximum.toLocaleString()} saved-segment limit.`
          : null;
  const dirty = name !== "" || scope !== "personal";

  const discard = useCallback((): void => {
    setNameState("");
    setScopeState("personal");
    setServerError(null);
    setOpenState(false);
    setDiscardConfirmOpen(false);
  }, []);

  useDiscardOnlyDraftLifecycle({
    ownerId: "subscriber-save-current-segment",
    label: "Save current subscriber segment draft",
    dirty,
    operationRef: operation.promiseRef,
    discard,
    enabled: open || dirty,
    detail:
      "This saved-segment name, sharing scope, and current subscriber view have not been created. Return to them or explicitly discard the draft.",
  });

  useEffect(() => discard(), [input.identityScope, discard]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (
      !trimmedName ||
      input.scopePending ||
      nameError ||
      !identityRef.current
    ) {
      return;
    }
    setServerError(null);
    const ownerIdentity = identityRef.current;
    const submittedScope = scope;
    const pending = operation.run(() =>
      createSavedSegment({
        name: trimmedName,
        predicate_json: input.predicate,
        visibility_scope: submittedScope,
      }),
    );
    if (!pending) return;
    try {
      const response = await pending;
      if (!mountedRef.current || ownerIdentity !== identityRef.current) return;
      if (response.error) {
        const message = savedCreateFailureMessage(
          response.error,
          input.maximum,
        );
        setServerError(message);
        toast.error(`Couldn't save: ${message}`);
        return;
      }
      discard();
      toast.success(`Saved ${submittedScope} segment "${trimmedName}"`);
      await input.onSaved();
    } catch {
      if (mountedRef.current && ownerIdentity === identityRef.current) {
        const message =
          "The saved-segment request failed. Check the connection and try again.";
        setServerError(message);
        toast.error(`Couldn't save: ${message}`);
      }
    }
  };

  const show = (): void => {
    if (atLimit) {
      toast.error(
        `This workspace has reached its ${input.maximum.toLocaleString()} saved-segment limit. Delete an unused segment before saving another.`,
      );
      return;
    }
    input.closeMenu();
    setNameState("");
    setScopeState("personal");
    setServerError(null);
    setDiscardConfirmOpen(false);
    setOpenState(true);
  };
  const requestClose = (): void => {
    if (operation.promiseRef.current) return;
    if (dirty) setDiscardConfirmOpen(true);
    else setOpenState(false);
  };

  return {
    open,
    setOpen: (next: boolean): void =>
      next ? setOpenState(true) : requestClose(),
    name,
    nameLength,
    setName: (next: string): void => {
      setNameState(next);
      setServerError(null);
    },
    scope,
    setScope: (next: SavedSegmentScope): void => {
      setScopeState(next);
      setServerError(null);
    },
    nameError,
    serverError,
    atLimit,
    busy: operation.active,
    scopePending: input.scopePending,
    discardConfirmOpen,
    setDiscardConfirmOpen,
    discard: (): void => {
      if (!operation.promiseRef.current) discard();
    },
    submit,
    show,
  };
}
