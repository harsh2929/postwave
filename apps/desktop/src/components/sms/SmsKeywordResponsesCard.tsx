/**
 * SmsKeywordResponsesCard — stored tenant keyword state-rule editor
 * (GAP-LS-146 / GAP-LS-147). Hosted auto-response dispatch is held.
 *
 * Backend (verified against apps/api/internal/sms/keyword_responses.go):
 *   GET    /api/v1/sms/keyword-responses        → {tenantId,items}
 *   POST   /api/v1/sms/keyword-responses        → 201 row | 422
 *   PATCH  /api/v1/sms/keyword-responses/{id}   → CAS row | 409 policy_changed
 *   DELETE /api/v1/sms/keyword-responses/{id}   → CAS {ok,tenantId,id}
 *
 * Custom keyword authority is limited to opt-out state changes. Reply-only
 * rows are display-only while automatic confirmation dispatch is source-held.
 *
 * Carrier compliance keywords (STOP / STOPALL / UNSUBSCRIBE / CANCEL /
 * END / START / UNSTOP / HELP) stay hardcoded server-side — the API
 * rejects them with 422 code `reserved_keyword`, and this card both
 * pre-validates and explains that error. The read-only table of those
 * built-in behaviors lives in a collapsed reference section below the
 * list.
 *
 * Mutations require the admin scope server-side, so the buttons gate
 * on useCanAdmin.
 */

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FieldError, FormField, useFormErrors } from "../FormField";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import { smsKeywordResponsesApi } from "../../lib/api/sms-keyword-responses";
import { useCanAdmin, useMe } from "../../lib/store";
import {
  RESERVED_SMS_KEYWORDS,
  canMutateSmsKeywordAction,
  isReservedSmsKeyword,
  isValidSmsKeywordInput,
  isValidSmsKeywordToken,
  keywordActionMeta,
  normalizeSmsKeyword,
  parseSmsPolicyDeleteReceipt,
  parseSmsKeywordResponseRows,
  smsKeywordHasWhitespace,
  type SmsKeywordDispatchRow,
} from "./sms-settings-helpers";

/** Copy shown whenever a reserved keyword is attempted (client or 422). */
const RESERVED_COPY =
  "Carrier-reserved compliance keyword — STOP/HELP-class words stay " +
  "hardcoded server-side so opt-out handling can never be overridden. " +
  "See the built-in behaviors below.";
const AUTO_REPLY_HELD_COPY =
  "sms_auto_reply_dispatch_release_held: custom and HELP automatic confirmations are unavailable; no outbound reply effect will be created or enabled.";
const OPT_OUT_RESPONSE_BODY =
  "You are unsubscribed from SMS marketing messages from this sender.";

/**
 * The keyword pipeline compiled into the server
 * (apps/api/internal/sms/phone.go ClassifyInbound). Read-only — these
 * run BEFORE tenant rows are consulted and can't be changed here.
 */
const BUILT_IN_KEYWORDS: ReadonlyArray<{
  keywords: string;
  effect: string;
  badge: "danger" | "success" | "warning";
  badgeLabel: string;
}> = [
  {
    keywords:
      "STOP · STOPALL · UNSUBSCRIBE · CANCEL · END · QUIT · REVOKE · OPTOUT",
    effect:
      "On a verified provider event, the source semantics would record revoked consent and a suppression. Hosted callbacks are release-held.",
    badge: "danger",
    badgeLabel: "Opt out",
  },
  {
    keywords: "START · UNSTOP",
    effect:
      "On a verified same-provider event, source semantics would record grant evidence and clear only a proven matching provider STOP. Preserved manual holds and legacy or cross-authority ambiguity remain held; hosted callbacks are release-held.",
    badge: "success",
    badgeLabel: "Opt in",
  },
  {
    keywords: "HELP",
    effect:
      "On a verified provider event, the source semantics would mark a help request. Hosted callbacks and automatic HELP confirmation are release-held.",
    badge: "warning",
    badgeLabel: "Help",
  },
];

interface Draft {
  keyword: string;
  response_body: string;
  action: "opt_out";
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  keyword: "",
  response_body: OPT_OUT_RESPONSE_BODY,
  action: "opt_out",
  enabled: true,
};

function safeKeywordFailure(
  operation: "load" | "save" | "toggle" | "delete",
  status?: number,
): string {
  if (status === 401 || status === 403) {
    return "Admin authorization for stored keyword policy is no longer available.";
  }
  if (status === 400 || status === 409 || status === 422) {
    return operation === "load"
      ? "The keyword-policy service rejected this request. Retry from a current workspace session."
      : "The keyword-policy service rejected this stored rule change. Review the current row and form values, then retry.";
  }
  if (status === 404 || status === 405) {
    return operation === "load"
      ? "Stored keyword policy is unavailable on this deployment."
      : "This keyword rule or policy route is no longer available. Refresh before making another change.";
  }
  return operation === "load"
    ? "Stored keyword policy could not be loaded."
    : "The keyword-policy change outcome is unverified. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.";
}

function useSmsKeywordRows(expectedTenantId: string) {
  const [rows, setRows] = useState<SmsKeywordDispatchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const activeRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = async (): Promise<void> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setErr(null);
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await smsKeywordResponsesApi.list({
          signal: controller.signal,
        });
        if (!activeRef.current || requestId !== loadSequenceRef.current) return;
        if (res.error) {
          setErr(safeKeywordFailure("load", res.error.status));
          return;
        }
        const parsed = parseSmsKeywordResponseRows(res.data, expectedTenantId);
        if (!parsed) {
          setErr(
            "The keyword-policy response failed its private tenant and row contract. No unverified rows were shown.",
          );
          setRows(null);
          return;
        }
        setRows(parsed);
      } catch {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setErr(safeKeywordFailure("load"));
        }
      } finally {
        if (activeRef.current && requestId === loadSequenceRef.current) {
          setLoading(false);
        }
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
          loadFlightRef.current = null;
        }
      }
    })();
    loadFlightRef.current = request;
    return request;
  };

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadSequenceRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      loadFlightRef.current = null;
    };
  }, []);

  return { activeRef, err, load, loading, rows, setRows };
}

function useSmsKeywordResponsesController(expectedTenantId: string) {
  const canMutate = useCanAdmin();
  const { activeRef, err, load, loading, rows, setRows } =
    useSmsKeywordRows(expectedTenantId);
  const authorityCurrent =
    canMutate && rows !== null && !loading && err === null;

  /* Editor modal (create when editTarget is null). */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SmsKeywordDispatchRow | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [editorConflict, setEditorConflict] = useState(false);
  const errors = useFormErrors();
  const editorBaselineRef = useRef<Draft>(EMPTY_DRAFT);
  const [discardEditorOpen, setDiscardEditorOpen] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<SmsKeywordDispatchRow | null>(null);
  const [disableTarget, setDisableTarget] =
    useState<SmsKeywordDispatchRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [mutationErr, setMutationErr] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const editorFlightRef = useRef<Promise<void> | null>(null);
  const toggleFlightRef = useRef<Promise<boolean> | null>(null);
  const deleteFlightRef = useRef<Promise<void> | null>(null);
  const editorAbortRef = useRef<AbortController | null>(null);
  const toggleAbortRef = useRef<AbortController | null>(null);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const disableReturnFocusRef = useRef<HTMLInputElement | null>(null);
  const permissionReasonId = useId();

  const operationActive =
    saving ||
    togglingId !== null ||
    deleting ||
    editorFlightRef.current !== null ||
    toggleFlightRef.current !== null ||
    deleteFlightRef.current !== null;
  const dialogActive =
    editorOpen ||
    discardEditorOpen ||
    deleteTarget !== null ||
    disableTarget !== null;
  const interactionLocked = operationActive || dialogActive;

  useEffect(() => {
    return () => {
      editorAbortRef.current?.abort();
      toggleAbortRef.current?.abort();
      deleteAbortRef.current?.abort();
      editorAbortRef.current = null;
      toggleAbortRef.current = null;
      deleteAbortRef.current = null;
      editorFlightRef.current = null;
      toggleFlightRef.current = null;
      deleteFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!canMutate && !deleting && !deleteFlightRef.current) {
      setDeleteTarget(null);
      setDeleteErr(null);
      setDisableTarget(null);
    }
  }, [canMutate, deleting]);

  const openCreate = (): void => {
    if (
      !authorityCurrent ||
      editorFlightRef.current ||
      toggleFlightRef.current ||
      deleteFlightRef.current ||
      dialogActive
    )
      return;
    setEditTarget(null);
    setDraft(EMPTY_DRAFT);
    editorBaselineRef.current = EMPTY_DRAFT;
    setEditorConflict(false);
    errors.clear();
    setMutationErr(null);
    setEditorOpen(true);
  };

  const openEdit = (row: SmsKeywordDispatchRow): void => {
    if (
      !authorityCurrent ||
      editorFlightRef.current ||
      toggleFlightRef.current ||
      deleteFlightRef.current ||
      dialogActive
    )
      return;
    if (!canMutateSmsKeywordAction(row.action)) {
      setMutationErr(AUTO_REPLY_HELD_COPY);
      return;
    }
    const next = {
      keyword: row.keyword,
      response_body: row.response_body || row.response_text || "",
      action: "opt_out" as const,
      enabled: row.enabled,
    };
    setEditTarget(row);
    setDraft(next);
    editorBaselineRef.current = next;
    setEditorConflict(false);
    errors.clear();
    setMutationErr(null);
    setEditorOpen(true);
  };

  const closeEditor = (): void => {
    if (editorFlightRef.current) return;
    if (JSON.stringify(draft) !== JSON.stringify(editorBaselineRef.current)) {
      setEditorOpen(false);
      setDiscardEditorOpen(true);
      return;
    }
    setEditorOpen(false);
  };

  const submitEditor = async (): Promise<void> => {
    if (!authorityCurrent || editorFlightRef.current || editorConflict) return;
    errors.clear();
    const asciiTrimmedKeyword = draft.keyword.replace(/^ +| +$/gu, "");
    const keyword = normalizeSmsKeyword(asciiTrimmedKeyword);
    const body = OPT_OUT_RESPONSE_BODY;
    let bad = false;
    if (!keyword) {
      errors.set("keyword", "Keyword is required.");
      bad = true;
    } else if (smsKeywordHasWhitespace(draft.keyword)) {
      errors.set(
        "keyword",
        "Keyword must be a single word — inbound matching uses the first word of the message.",
      );
      bad = true;
    } else if (
      asciiTrimmedKeyword !== draft.keyword.trim() ||
      !isValidSmsKeywordInput(asciiTrimmedKeyword) ||
      !isValidSmsKeywordToken(keyword)
    ) {
      errors.set(
        "keyword",
        "Use 1–80 uppercase ASCII letters, numbers, underscore, period, colon, or hyphen. Controls, bidi marks, and Unicode aliases are rejected.",
      );
      bad = true;
    } else if (isReservedSmsKeyword(keyword)) {
      errors.set("keyword", RESERVED_COPY);
      bad = true;
    }
    if (bad) return;

    setSaving(true);
    setMutationErr(null);
    const input = {
      keyword,
      response_body: body,
      action: draft.action,
      enabled: draft.enabled,
    };
    const target = editTarget;
    const controller = new AbortController();
    editorAbortRef.current = controller;
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = target
          ? await smsKeywordResponsesApi.update(
              target.id,
              { ...input, expected_updated_at: target.updated_at },
              {
                signal: controller.signal,
              },
            )
          : await smsKeywordResponsesApi.create(input, {
              signal: controller.signal,
            });
        if (!activeRef.current) return;
        if (res.error) {
          // The server backstops the client check: 422 `reserved_keyword`
          // means a carrier compliance keyword slipped through — explain
          // instead of echoing a bare error string.
          if (res.error.code === "identity_changed") {
            errors.set(
              "_form",
              "Workspace identity changed while this rule save was in flight. Its server outcome is unknown; return to the original workspace and verify the row before retrying. Your draft is not proof that the save failed.",
            );
          } else if (
            target &&
            res.error.status === 409 &&
            res.error.code === "policy_changed"
          ) {
            setEditorConflict(true);
            errors.set(
              "_form",
              "This keyword rule changed after you opened it. Nothing was overwritten. Your draft is preserved for copying; close it and reopen the refreshed row before saving.",
            );
            await load();
          } else if (
            !target &&
            res.error.status === 409 &&
            res.error.code === "keyword_response_exists"
          ) {
            errors.set(
              "_form",
              "That keyword already exists. The service did not overwrite it. Refresh the verified list, then edit the existing row.",
            );
            await load();
          } else if (res.error.code === "reserved_keyword") {
            errors.set("keyword", RESERVED_COPY);
          } else {
            errors.set("_form", safeKeywordFailure("save", res.error.status));
          }
          return;
        }
        const confirmed = parseSmsKeywordResponseRows(
          { tenantId: expectedTenantId, items: [res.data] },
          expectedTenantId,
        )?.[0];
        if (
          !confirmed ||
          confirmed.keyword !== input.keyword ||
          confirmed.action !== input.action ||
          confirmed.enabled !== input.enabled ||
          confirmed.response_body !== input.response_body ||
          (target !== null &&
            (confirmed.id !== target.id ||
              confirmed.updated_at === target.updated_at))
        ) {
          errors.set(
            "_form",
            "The keyword-response service returned an unverified mutation receipt. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.",
          );
          return;
        }
        editorBaselineRef.current = { ...draft };
        setEditorOpen(false);
        toast.success(
          target
            ? `${keyword} opt-out rule updated`
            : `${keyword} opt-out rule added`,
        );
        void load();
      } catch {
        if (activeRef.current && !controller.signal.aborted) {
          errors.set("_form", safeKeywordFailure("save"));
        }
      } finally {
        if (activeRef.current) setSaving(false);
        if (editorAbortRef.current === controller) {
          editorAbortRef.current = null;
        }
        editorFlightRef.current = null;
      }
    })();
    editorFlightRef.current = request;
    return request;
  };

  const toggleEnabled = async (
    row: SmsKeywordDispatchRow,
  ): Promise<boolean> => {
    if (!authorityCurrent || toggleFlightRef.current) return false;
    if (!canMutateSmsKeywordAction(row.action)) {
      setMutationErr(AUTO_REPLY_HELD_COPY);
      return false;
    }
    setTogglingId(row.id);
    setMutationErr(null);
    const controller = new AbortController();
    toggleAbortRef.current = controller;
    const request = (async (): Promise<boolean> => {
      await Promise.resolve();
      try {
        const res = await smsKeywordResponsesApi.update(
          row.id,
          {
            action: "opt_out",
            enabled: !row.enabled,
            expected_updated_at: row.updated_at,
          },
          { signal: controller.signal },
        );
        if (!activeRef.current) return false;
        if (res.error) {
          if (res.error.code === "identity_changed") {
            setMutationErr(
              "Workspace identity changed while the rule update was in flight. Its server outcome is unknown; return to the original workspace and verify the current row before retrying.",
            );
            setDisableTarget(null);
            return false;
          }
          if (res.error.status === 409 && res.error.code === "policy_changed") {
            setMutationErr(
              "This keyword rule changed since it was loaded. Nothing was overwritten; the current rows were refreshed for review.",
            );
            setDisableTarget(null);
            await load();
            return false;
          }
          setMutationErr(safeKeywordFailure("toggle", res.error.status));
          return false;
        }
        const updated = parseSmsKeywordResponseRows(
          { tenantId: expectedTenantId, items: [res.data] },
          expectedTenantId,
        )?.[0];
        if (
          !updated ||
          updated.id !== row.id ||
          updated.keyword !== row.keyword ||
          updated.updated_at === row.updated_at ||
          updated.enabled !== !row.enabled
        ) {
          setMutationErr(
            `The service returned an unverified update receipt for ${row.keyword}. Refresh that exact row before retrying; do not assume nothing changed.`,
          );
          return false;
        }
        setRows((prev) =>
          (prev ?? []).map((item) => (item.id === row.id ? updated : item)),
        );
        return true;
      } catch {
        if (activeRef.current && !controller.signal.aborted) {
          setMutationErr(safeKeywordFailure("toggle"));
        }
        return false;
      } finally {
        if (activeRef.current) setTogglingId(null);
        if (toggleAbortRef.current === controller) {
          toggleAbortRef.current = null;
        }
        toggleFlightRef.current = null;
      }
    })();
    toggleFlightRef.current = request;
    return request;
  };

  const confirmDelete = async (): Promise<void> => {
    if (!authorityCurrent || !deleteTarget || deleteFlightRef.current) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteErr(null);
    const controller = new AbortController();
    deleteAbortRef.current = controller;
    const request = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        const res = await smsKeywordResponsesApi.remove(
          target.id,
          { expected_updated_at: target.updated_at },
          {
            signal: controller.signal,
          },
        );
        if (!activeRef.current) return;
        if (res.error?.code === "identity_changed") {
          setMutationErr(
            "Workspace identity changed while deletion was in flight. Its server outcome is unknown; return to the original workspace and verify the current row before retrying.",
          );
          setDeleteTarget(null);
          return;
        }
        if (res.error?.status === 409 && res.error.code === "policy_changed") {
          setMutationErr(
            "This keyword rule changed since the confirmation opened. Nothing was deleted; the current rows were refreshed for review.",
          );
          setDeleteTarget(null);
          await load();
          return;
        }
        if (res.error) {
          setDeleteErr(safeKeywordFailure("delete", res.error.status));
          return;
        }
        if (
          !parseSmsPolicyDeleteReceipt(res.data, expectedTenantId, target.id)
        ) {
          setDeleteErr(
            "The service returned an unverified deletion receipt. Refresh this exact row before retrying; do not assume it remains or was deleted.",
          );
          return;
        }
        toast.success(`${target.keyword} deleted`);
        setRows((prev) => (prev ?? []).filter((r) => r.id !== target.id));
        deleteReturnFocusRef.current = addButtonRef.current;
        setDeleteTarget(null);
      } catch {
        if (activeRef.current && !controller.signal.aborted) {
          setDeleteErr(safeKeywordFailure("delete"));
        }
      } finally {
        if (activeRef.current) setDeleting(false);
        if (deleteAbortRef.current === controller) {
          deleteAbortRef.current = null;
        }
        deleteFlightRef.current = null;
      }
    })();
    deleteFlightRef.current = request;
    return request;
  };

  const requestToggle = (
    row: SmsKeywordDispatchRow,
    trigger: HTMLInputElement,
  ): void => {
    if (!authorityCurrent || interactionLocked) return;
    if (row.enabled) {
      disableReturnFocusRef.current = trigger;
      setDisableTarget(row);
      return;
    }
    void toggleEnabled(row);
  };

  const requestDelete = (
    row: SmsKeywordDispatchRow,
    trigger: HTMLButtonElement,
  ): void => {
    if (!authorityCurrent || interactionLocked) return;
    deleteReturnFocusRef.current = trigger;
    setDeleteErr(null);
    setDeleteTarget(row);
  };

  return {
    authorityCurrent,
    canMutate,
    closeEditor,
    confirmDelete,
    deleteErr,
    deleteFlightRef,
    deleteTarget,
    deleting,
    disableReturnFocusRef,
    disableTarget,
    discardEditorOpen,
    draft,
    editTarget,
    editorConflict,
    editorFlightRef,
    editorOpen,
    err,
    errors,
    load,
    loading,
    interactionLocked,
    mutationErr,
    openCreate,
    openEdit,
    permissionReasonId,
    rows,
    addButtonRef,
    deleteReturnFocusRef,
    requestDelete,
    requestToggle,
    saving,
    setDeleteErr,
    setDeleteTarget,
    setDisableTarget,
    setDiscardEditorOpen,
    setDraft,
    setEditorOpen,
    submitEditor,
    toggleEnabled,
    toggleFlightRef,
    togglingId,
  };
}

type SmsKeywordResponsesController = ReturnType<
  typeof useSmsKeywordResponsesController
>;

function SmsKeywordEditorModal({
  controller,
}: {
  controller: SmsKeywordResponsesController;
}): ReactElement {
  const {
    authorityCurrent,
    canMutate,
    closeEditor,
    draft,
    editTarget,
    editorConflict,
    editorFlightRef,
    editorOpen,
    errors,
    saving,
    setDraft,
    submitEditor,
  } = controller;
  return (
    <Modal
      open={editorOpen}
      onClose={closeEditor}
      title={
        editTarget ? `Edit ${editTarget.keyword}` : "Add keyword opt-out rule"
      }
      description="A verified ingested provider event would apply an opt-out state change when its first word matches. Hosted callbacks and automatic confirmation dispatch remain release-held."
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (
            authorityCurrent &&
            !saving &&
            !editorConflict &&
            !editorFlightRef.current
          )
            void submitEditor();
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          ) {
            event.preventDefault();
          }
        }}
      >
        {!canMutate ? (
          <Notice tone="neutral" announcement="polite">
            Your role changed to read-only. Copy any unsaved values before
            closing; an admin must save this keyword response.
          </Notice>
        ) : null}
        <FormField
          label="Keyword"
          required
          htmlFor="kw-keyword"
          error={errors.get("keyword")}
          help={
            editTarget
              ? "Keyword is this row's identity. Delete and re-add the row to rename it."
              : "Single word, matched case-insensitively and stored uppercase."
          }
        >
          <input
            id="kw-keyword"
            className="input tabular"
            placeholder="PRICING"
            value={draft.keyword}
            onChange={(event) => {
              setDraft({ ...draft, keyword: event.target.value });
              errors.clear("keyword");
              errors.clear("_form");
            }}
            disabled={!!editTarget || saving || !authorityCurrent}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <Notice tone="warning" announcement="polite">
          {AUTO_REPLY_HELD_COPY} This editor changes only the opt-out state
          rule; stored confirmation text is not carrier or delivery evidence.
        </Notice>
        {editTarget ? (
          <Notice tone="neutral" announcement="polite">
            Status is unchanged in this editor. Use the row status control so an
            enabled rule cannot be disabled without its separate confirmation.
          </Notice>
        ) : (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              aria-label="Create keyword opt-out rule enabled"
              checked={draft.enabled}
              disabled={saving || !authorityCurrent}
              onChange={(event) => {
                errors.clear("_form");
                setDraft({ ...draft, enabled: event.target.checked });
              }}
            />
            <span>
              Create enabled — a verified ingested provider event would apply
              the opt-out state change. Hosted callbacks and automatic
              confirmation remain release-held.
            </span>
          </label>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Reserved: {RESERVED_SMS_KEYWORDS.join(", ")} — these stay hardcoded
          server-side and can&apos;t be customized.
        </div>
        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={closeEditor}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || editorConflict || !authorityCurrent}
          >
            {saving
              ? "Saving…"
              : editorConflict
                ? "Reopen refreshed rule"
                : editTarget
                  ? "Save opt-out rule"
                  : "Add opt-out keyword"}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function SmsKeywordConfirmations({
  controller,
}: {
  controller: SmsKeywordResponsesController;
}): ReactElement {
  const {
    authorityCurrent,
    confirmDelete,
    deleteErr,
    deleteFlightRef,
    deleteReturnFocusRef,
    deleteTarget,
    deleting,
    disableReturnFocusRef,
    disableTarget,
    discardEditorOpen,
    setDeleteErr,
    setDeleteTarget,
    setDisableTarget,
    setDiscardEditorOpen,
    setEditorOpen,
    toggleEnabled,
    togglingId,
  } = controller;
  return (
    <>
      <ConfirmModal
        open={disableTarget != null}
        title="Disable keyword opt-out rule?"
        description={
          disableTarget
            ? `Disable the stored ${disableTarget.keyword} rule? A verified ingested provider event would no longer apply this custom opt-out state change. Hosted callbacks and automatic confirmation remain release-held.`
            : ""
        }
        confirmLabel="Disable opt-out rule"
        danger
        busy={togglingId === disableTarget?.id}
        confirmDisabled={!authorityCurrent}
        returnFocusRef={disableReturnFocusRef}
        onClose={() => {
          if (!controller.toggleFlightRef.current) setDisableTarget(null);
        }}
        onConfirm={async () => {
          const target = disableTarget;
          if (target && (await toggleEnabled(target))) setDisableTarget(null);
        }}
      />
      <ConfirmModal
        open={deleteTarget != null}
        title="Delete keyword rule?"
        description={
          deleteTarget
            ? deleteTarget.action === "opt_out"
              ? `A verified ingested provider event for "${deleteTarget.keyword}" would no longer apply this custom opt-out state rule. Built-in STOP source semantics are unaffected; hosted callbacks remain release-held.`
              : `Delete stored held configuration for "${deleteTarget.keyword}"? No outbound auto-reply is currently dispatched.`
            : ""
        }
        confirmLabel="Delete keyword"
        danger
        typeToConfirm={deleteTarget?.keyword}
        busy={deleting}
        confirmDisabled={!authorityCurrent}
        returnFocusRef={deleteReturnFocusRef}
        onClose={() => {
          if (!deleteFlightRef.current) {
            setDeleteTarget(null);
            setDeleteErr(null);
          }
        }}
        onConfirm={confirmDelete}
      >
        {deleteErr ? (
          <FieldError>
            Couldn&apos;t delete this keyword: {deleteErr}
          </FieldError>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={discardEditorOpen}
        title="Discard keyword-response changes?"
        description="The keyword, opt-out state rule, or enabled state has not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          setDiscardEditorOpen(false);
        }}
        onClose={() => {
          setDiscardEditorOpen(false);
          setEditorOpen(true);
        }}
      />
    </>
  );
}

function SmsKeywordResponsesSurface({
  controller,
}: {
  controller: SmsKeywordResponsesController;
}): ReactElement {
  const {
    addButtonRef,
    authorityCurrent,
    canMutate,
    err,
    interactionLocked,
    load,
    loading,
    mutationErr,
    openCreate,
    openEdit,
    permissionReasonId,
    rows,
    requestDelete,
    requestToggle,
    togglingId,
  } = controller;

  return (
    <div className="card">
      <div className="card-header">
        <div className="sms-policy-card-header">
          <div>
            <div className="card-title">SMS keyword state rules</div>
            <div className="card-subtitle muted">
              These rows store first-word match semantics. A configured row is
              not proof that a carrier message reaches Moosewave: hosted provider
              callbacks and all automatic confirmations are release-held. A
              verified same-provider START / UNSTOP event would clear only a
              proven matching provider STOP; manual and ambiguous holds remain.
            </div>
          </div>
          <button
            ref={addButtonRef}
            type="button"
            className="btn btn-sm btn-primary"
            onClick={openCreate}
            disabled={!authorityCurrent || interactionLocked}
            aria-describedby={!canMutate ? permissionReasonId : undefined}
          >
            Add opt-out keyword
          </button>
        </div>
      </div>
      <div className="card-body">
        {!canMutate ? (
          <div id={permissionReasonId}>
            <Notice
              tone="neutral"
              announcement="polite"
              style={{ marginBottom: 10 }}
            >
              Viewer access is read-only. An admin can add, edit, enable,
              disable, or delete custom opt-out state rules.
            </Notice>
          </div>
        ) : null}
        {canMutate && !authorityCurrent && rows !== null ? (
          <Notice tone="neutral" announcement="polite">
            The last verified keyword rows are loading or stale. Changes remain
            locked until a current tenant response is verified.
          </Notice>
        ) : null}
        {mutationErr ? (
          <div className="field-error" role="alert" style={{ marginBottom: 8 }}>
            {mutationErr}
          </div>
        ) : null}
        {err ? (
          <Notice
            tone="danger"
            announcement="assertive"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void load()}
              >
                Retry
              </button>
            }
          >
            {err}
          </Notice>
        ) : null}
        {loading && rows === null ? (
          <div role="status" aria-label="Loading SMS keyword responses">
            <div className="skel-row" />
            <div className="skel-row" />
          </div>
        ) : rows === null ? null : rows.length === 0 ? (
          <div
            className="muted"
            style={{ padding: 20, textAlign: "center", fontSize: 13 }}
          >
            No custom keyword state rules are configured. Built-in source
            semantics still require a verified hosted provider event; callback
            ingestion and automatic HELP confirmation are release-held.
          </div>
        ) : (
          <div>
            <table className="link-table sms-keyword-table sms-keyword-policy-table">
              <caption className="visually-hidden">
                Custom SMS keyword state rules
              </caption>
              <thead>
                <tr>
                  <th scope="col">Keyword</th>
                  <th scope="col">Action</th>
                  <th scope="col">Stored response text</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const meta = keywordActionMeta(row.action);
                  const actionMutable = canMutateSmsKeywordAction(row.action);
                  const response =
                    row.response_body || row.response_text || "No response";
                  const statusId = `${permissionReasonId}-${row.id}-status`;
                  return (
                    <tr key={row.id}>
                      <th scope="row" className="tabular" data-label="Keyword">
                        {row.keyword}
                      </th>
                      <td data-label="Action">
                        <span className={meta.badgeClass}>{meta.label}</span>
                      </td>
                      <td
                        className="muted"
                        data-label="Stored text"
                        style={{
                          fontSize: 12,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          minWidth: 220,
                        }}
                      >
                        <bdi dir="auto" style={{ unicodeBidi: "isolate" }}>
                          {response}
                        </bdi>
                        <div style={{ fontSize: 11, marginTop: 2 }}>
                          Stored text only; automatic confirmation dispatch is
                          release-held.
                        </div>
                      </td>
                      <td data-label="Status">
                        <label
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            disabled={
                              !authorityCurrent ||
                              !actionMutable ||
                              interactionLocked
                            }
                            aria-disabled={
                              !canMutate || !actionMutable || interactionLocked
                            }
                            aria-describedby={
                              !canMutate ? permissionReasonId : statusId
                            }
                            onChange={(event) => {
                              if (
                                authorityCurrent &&
                                actionMutable &&
                                !interactionLocked
                              ) {
                                requestToggle(row, event.currentTarget);
                              }
                            }}
                          />
                          <span>
                            {!actionMutable
                              ? "Held / off"
                              : row.enabled
                                ? "Opt-out matching on"
                                : "Opt-out matching off"}
                          </span>
                        </label>
                        <div
                          id={statusId}
                          className="muted"
                          style={{ fontSize: 11, marginTop: 2 }}
                        >
                          {!actionMutable
                            ? "No outbound effect: sms_auto_reply_dispatch_release_held"
                            : togglingId === row.id
                              ? "Updating status…"
                              : row.enabled
                                ? "A verified provider event would apply the stored opt-out state rule; callback ingestion and confirmation dispatch are held"
                                : "A verified provider event would not apply this disabled custom opt-out rule"}
                        </div>
                      </td>
                      <td data-label="Actions">
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            justifyContent: "flex-end",
                            gap: 4,
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => openEdit(row)}
                            disabled={
                              !authorityCurrent ||
                              !actionMutable ||
                              interactionLocked
                            }
                            aria-disabled={
                              !canMutate || !actionMutable || interactionLocked
                            }
                            aria-describedby={
                              !canMutate ? permissionReasonId : undefined
                            }
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={(event) =>
                              requestDelete(row, event.currentTarget)
                            }
                            disabled={!authorityCurrent || interactionLocked}
                            aria-disabled={!canMutate || interactionLocked}
                            aria-describedby={
                              !canMutate ? permissionReasonId : undefined
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {loading && rows !== null ? (
          <div className="muted" role="status" style={{ fontSize: 12 }}>
            Refreshing keyword responses; showing the last verified rows.
          </div>
        ) : null}

        <details style={{ marginTop: 14 }}>
          <summary
            className="muted"
            style={{ cursor: "pointer", fontSize: 13 }}
          >
            Built-in carrier keyword state (not editable)
          </summary>
          <div style={{ marginTop: 8 }}>
            <table className="link-table sms-keyword-table">
              <caption className="visually-hidden">
                Built-in carrier keyword behaviors
              </caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Keywords</th>
                  <th scope="col">Built-in behavior</th>
                </tr>
              </thead>
              <tbody>
                {BUILT_IN_KEYWORDS.map((keyword) => (
                  <tr key={keyword.badgeLabel}>
                    <th scope="row" data-label="Action">
                      <span className={`badge ${keyword.badge}`}>
                        {keyword.badgeLabel}
                      </span>
                    </th>
                    <td
                      className="tabular"
                      style={{ fontSize: 12 }}
                      data-label="Keywords"
                    >
                      {keyword.keywords}
                    </td>
                    <td
                      className="muted"
                      style={{ fontSize: 12 }}
                      data-label="Source semantics"
                    >
                      {keyword.effect}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            These source semantics cannot be overridden. A verified provider
            callback would be required before any state change; hosted callback
            execution remains release-held.
          </div>
        </details>
      </div>

      <SmsKeywordEditorModal controller={controller} />
      <SmsKeywordConfirmations controller={controller} />
    </div>
  );
}

function SmsKeywordResponsesCardIdentity({
  expectedTenantId,
}: {
  expectedTenantId: string;
}): ReactElement {
  const controller = useSmsKeywordResponsesController(expectedTenantId);
  return <SmsKeywordResponsesSurface controller={controller} />;
}

export function SmsKeywordResponsesCard(): ReactElement {
  const me = useMe();
  if (!me) {
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">SMS keyword state rules</div>
        </div>
        <div className="card-body">
          <div className="notice" role="status">
            Resolve a canonical workspace identity before loading private
            keyword policy.
          </div>
        </div>
      </div>
    );
  }
  const identityScope = `${me.user}\u0000${me.tenant}\u0000${me.effectiveRole}`;
  return (
    <SmsKeywordResponsesCardIdentity
      key={identityScope}
      expectedTenantId={me.tenant}
    />
  );
}
