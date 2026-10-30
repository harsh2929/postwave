import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type EmailValidationBatchResponse,
  type List,
} from "../../lib/api-client";
import {
  BULK_CONSENT_CATEGORIES,
  BULK_MERGE_FIELDS,
  type BulkActionUiState,
  type BulkBusy,
  type BulkListLoadStatus,
  type BulkOutcome,
  type BulkProgress,
  unwrapBulkLists,
} from "./bulk-action-types";
import { emptyConsentEvidenceDraft } from "./consent-evidence";

export function useBulkActionState(): BulkActionUiState {
  const [busy, setBusy] = useState<BulkBusy>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const operationRef = useRef<{
    kind: Exclude<BulkBusy, null>;
    controller: AbortController;
  } | null>(null);
  const [showTag, setShowTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showSuppress, setShowSuppress] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [validationResult, setValidationResult] =
    useState<EmailValidationBatchResponse | null>(null);
  const [validationSkipped, setValidationSkipped] = useState(0);
  const [showValidation, setShowValidation] = useState(false);
  const [showLookalike, setShowLookalike] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showResubscribe, setShowResubscribe] = useState(false);
  const [showAddToList, setShowAddToList] = useState(false);
  const [lists, setLists] = useState<List[]>([]);
  const [listLoadStatus, setListLoadStatus] =
    useState<BulkListLoadStatus>("idle");
  const [listLoadError, setListLoadError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const listLoadingRef = useRef(false);
  const [listId, setListId] = useState("");
  const [showCustomField, setShowCustomField] = useState(false);
  const [cfKey, setCfKey] = useState("");
  const [cfValue, setCfValue] = useState("");
  const [showMergeField, setShowMergeField] = useState(false);
  const [mfKey, setMfKey] = useState<string>(BULK_MERGE_FIELDS[0]);
  const [mfValue, setMfValue] = useState("");
  const [showConsent, setShowConsent] = useState<null | "grant" | "revoke">(
    null,
  );
  const [consentCategory, setConsentCategory] = useState(
    BULK_CONSENT_CATEGORIES[0]!.value,
  );
  const [consentEvidence, setConsentEvidence] = useState(
    emptyConsentEvidenceDraft,
  );

  const beginOperation = useCallback(
    (
      kind: Exclude<BulkBusy, null>,
      initialProgress: BulkProgress,
    ): AbortSignal | null => {
      if (operationRef.current) return null;
      const controller = new AbortController();
      operationRef.current = { kind, controller };
      setOutcome(null);
      setBusy(kind);
      setProgress(initialProgress);
      return controller.signal;
    },
    [],
  );

  const finishOperation = useCallback((signal: AbortSignal): void => {
    if (operationRef.current?.controller.signal !== signal) return;
    operationRef.current = null;
    setBusy(null);
    setProgress(null);
  }, []);

  const cancelRetry = useCallback((): void => {
    operationRef.current?.controller.abort();
  }, []);

  const reloadLists = useCallback((): void => {
    if (listLoadingRef.current) return;
    listLoadingRef.current = true;
    const requestId = ++listRequestRef.current;
    setListLoadStatus("loading");
    setListLoadError(null);
    void api.listLists().then((result) => {
      if (requestId !== listRequestRef.current) return;
      listLoadingRef.current = false;
      if (result.error) {
        setLists([]);
        setListId("");
        setListLoadStatus("error");
        setListLoadError(
          "Moosewave couldn't load lists. No list selection was assumed.",
        );
        return;
      }
      const nextLists = unwrapBulkLists(result.data);
      setLists(nextLists);
      setListId(nextLists[0]?.id == null ? "" : String(nextLists[0].id));
      setListLoadStatus("ready");
    });
  }, []);

  useEffect(() => {
    if (showAddToList && listLoadStatus === "idle") reloadLists();
  }, [listLoadStatus, reloadLists, showAddToList]);

  useEffect(
    () => () => {
      operationRef.current?.controller.abort();
      listRequestRef.current += 1;
      listLoadingRef.current = false;
    },
    [],
  );

  return {
    busy,
    progress,
    setProgress,
    outcome,
    setOutcome,
    beginOperation,
    finishOperation,
    cancelRetry,
    showTag,
    setShowTag,
    tagInput,
    setTagInput,
    showSuppress,
    setShowSuppress,
    showDelete,
    setShowDelete,
    validationResult,
    setValidationResult,
    validationSkipped,
    setValidationSkipped,
    showValidation,
    setShowValidation,
    showLookalike,
    setShowLookalike,
    showMore,
    setShowMore,
    showResubscribe,
    setShowResubscribe,
    showAddToList,
    setShowAddToList,
    lists,
    setLists,
    listLoadStatus,
    listLoadError,
    reloadLists,
    listId,
    setListId,
    showCustomField,
    setShowCustomField,
    cfKey,
    setCfKey,
    cfValue,
    setCfValue,
    showMergeField,
    setShowMergeField,
    mfKey,
    setMfKey,
    mfValue,
    setMfValue,
    showConsent,
    setShowConsent,
    consentCategory,
    setConsentCategory,
    consentEvidence,
    setConsentEvidence,
  };
}
