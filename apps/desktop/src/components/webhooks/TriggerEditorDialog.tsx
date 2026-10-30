import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import {
  type InboundTrigger,
  type TriggerAction,
  type TriggerOperator,
  api,
  createInboundTrigger,
  listTagsWithQuery,
  updateInboundTrigger,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";
import { JSONPathPreview } from "./JSONPathPreview";
import {
  EMPTY_TRIGGER_DRAFT,
  TRIGGER_ACTIONS,
  TRIGGER_OPERATORS,
  draftFromTrigger,
  isTriggerTargetUUID,
  triggerInput,
  triggerTargetRecords,
  type TriggerDraft,
  type TriggerTargetOption,
  validateTriggerDraft,
} from "./trigger-editor-model";

interface Props {
  open: boolean;
  trigger: InboundTrigger | null;
  webhookId: string;
  sampleBody: string;
  onClose: () => void;
  onSaved: (trigger: InboundTrigger) => void;
}

const TARGET_OPTION_LIMIT = 200;

function useTriggerTargetOptions(
  actionType: TriggerAction,
  open: boolean,
): {
  options: TriggerTargetOption[];
  loading: boolean;
  error: string | null;
} {
  const [options, setOptions] = useState<TriggerTargetOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    const sequence = ++sequenceRef.current;
    setOptions([]);
    setError(null);
    if (actionType === "start_automation") {
      setLoading(false);
      setError(
        "Automation discovery is withheld because the available API returns unbounded full journey graphs, not bounded target summaries. Copy the UUID from Automations.",
      );
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const result =
          actionType === "add_to_sequence"
            ? await api.listSequences()
            : await listTagsWithQuery();
        if (sequence !== sequenceRef.current) return;
        if (result.error) {
          setError(
            `Catalog unavailable: ${sanitizeInspectableText(result.error.message).text}. You can still enter a validated target manually.`,
          );
          return;
        }
        const records = triggerTargetRecords(result.data);
        const eligible = records
          .map((item): TriggerTargetOption | null => {
            const { id, name } = item;
            if (
              (typeof id !== "string" && typeof id !== "number") ||
              typeof name !== "string" ||
              !name.trim()
            ) {
              return null;
            }
            if (actionType === "add_to_sequence") {
              const value = String(id);
              return isTriggerTargetUUID(value)
                ? { value, label: name.trim() }
                : null;
            }
            return { value: name.trim(), label: name.trim() };
          })
          .filter((item): item is TriggerTargetOption => item !== null);
        const deduplicated = Array.from(
          new Map(eligible.map((item) => [item.value, item])).values(),
        );
        const next = deduplicated.slice(0, TARGET_OPTION_LIMIT);
        setOptions(next);
        const invalidOrDuplicate = records.length - deduplicated.length;
        const overLimit = Math.max(
          0,
          deduplicated.length - TARGET_OPTION_LIMIT,
        );
        if (invalidOrDuplicate > 0 || overLimit > 0) {
          const exclusions = [
            invalidOrDuplicate > 0
              ? `${invalidOrDuplicate} malformed, duplicate, or ${
                  actionType === "add_to_sequence"
                    ? "non-UUID sequence"
                    : "invalid tag"
                } record${invalidOrDuplicate === 1 ? "" : "s"} excluded`
              : "",
            overLimit > 0
              ? `${overLimit} additional target${overLimit === 1 ? "" : "s"} omitted by the ${TARGET_OPTION_LIMIT}-option UI cap`
              : "",
          ].filter(Boolean);
          setError(`${exclusions.join("; ")}.`);
        }
      } catch (caught) {
        if (sequence === sequenceRef.current) {
          const message =
            caught instanceof Error
              ? caught.message
              : "Target catalog request failed.";
          setError(
            `${sanitizeInspectableText(message).text} You can still enter a validated target manually.`,
          );
        }
      } finally {
        if (sequence === sequenceRef.current) setLoading(false);
      }
    })();
    return () => {
      sequenceRef.current += 1;
    };
  }, [actionType, open]);
  return { options, loading, error };
}

function TriggerConditionFields({
  draft,
  errors,
  sampleBody,
  update,
  setOperator,
}: {
  draft: TriggerDraft;
  errors: Record<string, string>;
  sampleBody: string;
  update: <Key extends keyof TriggerDraft>(
    key: Key,
    value: TriggerDraft[Key],
  ) => void;
  setOperator: (operator: TriggerOperator) => void;
}): ReactElement {
  return (
    <>
      <fieldset className="wh-trigger-condition-grid">
        <legend>Event condition</legend>
        <div>
          <label className="field-label" htmlFor="trig-jp">
            Match JSONPath
          </label>
          <input
            id="trig-jp"
            className="input mono"
            value={draft.matchJsonpath}
            aria-invalid={errors.matchJsonpath ? "true" : undefined}
            onChange={(event) => update("matchJsonpath", event.target.value)}
            placeholder="$.event"
          />
          {errors.matchJsonpath ? (
            <p className="field-error" role="alert">
              {errors.matchJsonpath}
            </p>
          ) : null}
        </div>
        <div>
          <label className="field-label" htmlFor="trig-op">
            Operator
          </label>
          <select
            id="trig-op"
            className="select"
            value={draft.operator}
            onChange={(event) =>
              setOperator(event.target.value as TriggerOperator)
            }
          >
            {TRIGGER_OPERATORS.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="trig-val">
            Comparison value
          </label>
          <input
            id="trig-val"
            className="input"
            value={draft.matchValue}
            disabled={draft.operator === "exists"}
            aria-invalid={errors.matchValue ? "true" : undefined}
            onChange={(event) => update("matchValue", event.target.value)}
            placeholder={
              draft.operator === "exists"
                ? "Not used"
                : draft.operator === "regex"
                  ? "^customer\\."
                  : "customer.created"
            }
          />
          {errors.matchValue ? (
            <p className="field-error" role="alert">
              {errors.matchValue}
            </p>
          ) : null}
        </div>
      </fieldset>
      <JSONPathPreview
        sampleJSON={sampleBody}
        jsonpath={draft.matchJsonpath}
        operator={draft.operator}
        expected={draft.operator === "exists" ? null : draft.matchValue}
      />
    </>
  );
}

function TriggerActionFields({
  draft,
  errors,
  options,
  targetsLoading,
  targetsError,
  update,
}: {
  draft: TriggerDraft;
  errors: Record<string, string>;
  options: TriggerTargetOption[];
  targetsLoading: boolean;
  targetsError: string | null;
  update: <Key extends keyof TriggerDraft>(
    key: Key,
    value: TriggerDraft[Key],
  ) => void;
}): ReactElement {
  const action =
    TRIGGER_ACTIONS.find((candidate) => candidate.value === draft.actionType) ??
    TRIGGER_ACTIONS[0];
  return (
    <fieldset className="wh-trigger-action-grid">
      <legend>Action</legend>
      <div>
        <label className="field-label" htmlFor="trig-action">
          When matched
        </label>
        <select
          id="trig-action"
          className="select"
          value={draft.actionType}
          onChange={(event) => {
            update("actionType", event.target.value as TriggerAction);
            update("actionTargetId", "");
          }}
        >
          {TRIGGER_ACTIONS.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>
              {candidate.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="field-label" htmlFor="trig-target">
          {action.targetLabel}
        </label>
        <input
          id="trig-target"
          className="input mono"
          list="trig-target-options"
          value={draft.actionTargetId}
          aria-invalid={errors.actionTargetId ? "true" : undefined}
          onChange={(event) => update("actionTargetId", event.target.value)}
          placeholder={
            draft.actionType === "add_tag" || draft.actionType === "remove_tag"
              ? "paid-customer"
              : "00000000-0000-0000-0000-000000000000"
          }
        />
        <datalist id="trig-target-options">
          {options.map((option) => (
            <option
              key={`${option.value}:${option.label}`}
              value={option.value}
            >
              {option.label}
            </option>
          ))}
        </datalist>
        <p className="field-help">
          {targetsLoading
            ? "Loading available targets…"
            : options.length > 0
              ? `${options.length} available target${options.length === 1 ? "" : "s"} loaded. Start typing to choose one.`
              : action.targetHelp}
        </p>
        <p className="field-help">
          Manual values are checked for syntax only. This dialog does not prove
          that the target still exists; the server may reject it or execution
          may fail if it was removed.
        </p>
        {targetsError ? (
          <p className="field-help" role="status">
            {targetsError}
          </p>
        ) : null}
        {errors.actionTargetId ? (
          <p className="field-error" role="alert">
            {errors.actionTargetId}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

export function TriggerEditorDialog({
  open,
  trigger,
  webhookId,
  sampleBody,
  onClose,
  onSaved,
}: Props): ReactElement {
  const [draft, setDraft] = useState<TriggerDraft>(EMPTY_TRIGGER_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const mountedRef = useRef(true);
  const currentWebhookRef = useRef(webhookId);
  const openRef = useRef(open);
  const submitTokenRef = useRef<symbol | null>(null);
  currentWebhookRef.current = webhookId;
  openRef.current = open;
  const baseline = useMemo(() => draftFromTrigger(trigger), [trigger]);
  const targets = useTriggerTargetOptions(draft.actionType, open);

  useEffect(() => {
    if (!open) return;
    submitTokenRef.current = null;
    setDraft(draftFromTrigger(trigger));
    setErrors({});
    setSubmitError(null);
    setSubmitting(false);
    setConfirmClose(false);
  }, [open, trigger]);
  useEffect(() => {
    submitTokenRef.current = null;
    setSubmitting(false);
    setSubmitError(null);
  }, [webhookId]);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const update = <Key extends keyof TriggerDraft>(
    key: Key,
    value: TriggerDraft[Key],
  ): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setSubmitError(null);
  };
  const requestClose = (): void => {
    if (submitting) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const submit = async (): Promise<void> => {
    const nextErrors = validateTriggerDraft(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const ownerWebhookId = webhookId;
    const token = Symbol("trigger-save");
    submitTokenRef.current = token;
    try {
      const input = triggerInput(draft);
      const result = trigger
        ? await updateInboundTrigger(webhookId, trigger.id, input)
        : await createInboundTrigger(webhookId, input);
      if (
        !mountedRef.current ||
        !openRef.current ||
        currentWebhookRef.current !== ownerWebhookId ||
        submitTokenRef.current !== token
      ) {
        return;
      }
      if (result.error) {
        setSubmitError(sanitizeInspectableText(result.error.message).text);
        return;
      }
      toast.success(trigger ? "Trigger updated" : "Trigger created");
      onSaved(result.data);
    } catch (caught) {
      if (
        mountedRef.current &&
        openRef.current &&
        currentWebhookRef.current === ownerWebhookId &&
        submitTokenRef.current === token
      ) {
        const message =
          caught instanceof Error
            ? caught.message
            : "The trigger request failed.";
        setSubmitError(sanitizeInspectableText(message).text);
      }
    } finally {
      if (
        mountedRef.current &&
        openRef.current &&
        currentWebhookRef.current === ownerWebhookId &&
        submitTokenRef.current === token
      ) {
        submitTokenRef.current = null;
        setSubmitting(false);
      }
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        closeOnBackdrop={!submitting}
        closeOnEscape={!submitting}
        title={trigger ? "Edit trigger" : "Add trigger"}
        description="Define one bounded condition, resolve the subscriber email, then choose the exact action target."
      >
        <div className="field">
          <label className="field-label" htmlFor="trig-name">
            Trigger name
          </label>
          <input
            id="trig-name"
            className="input"
            value={draft.name}
            maxLength={256}
            aria-invalid={errors.name ? "true" : undefined}
            onChange={(event) => update("name", event.target.value)}
            placeholder="Paid customer → onboarding"
          />
          {errors.name ? (
            <p className="field-error" role="alert">
              {errors.name}
            </p>
          ) : null}
        </div>
        <TriggerConditionFields
          draft={draft}
          errors={errors}
          sampleBody={sampleBody}
          update={update}
          setOperator={(operator) => {
            setDraft((current) => ({
              ...current,
              operator,
              matchValue: operator === "exists" ? "" : current.matchValue,
            }));
            setErrors({});
          }}
        />
        <div className="field">
          <label className="field-label" htmlFor="trig-email">
            Subscriber email JSONPath
          </label>
          <input
            id="trig-email"
            className="input mono"
            value={draft.emailJsonpath}
            aria-invalid={errors.emailJsonpath ? "true" : undefined}
            onChange={(event) => update("emailJsonpath", event.target.value)}
            placeholder="$.customer.email"
          />
          <p className="field-help">
            Must resolve to the subscriber email used by the selected action.
          </p>
          {errors.emailJsonpath ? (
            <p className="field-error" role="alert">
              {errors.emailJsonpath}
            </p>
          ) : null}
        </div>
        <TriggerActionFields
          draft={draft}
          errors={errors}
          options={targets.options}
          targetsLoading={targets.loading}
          targetsError={targets.error}
          update={update}
        />
        {submitError ? (
          <p className="field-error" role="alert">
            Couldn&apos;t save trigger: {submitError}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={requestClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting || !dirty}
            onClick={() => void submit()}
          >
            {submitting
              ? "Saving…"
              : trigger
                ? "Save trigger"
                : "Create trigger"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={confirmClose}
        title="Discard trigger changes?"
        description="The unsaved condition and action target will be cleared. The live trigger will not change."
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
