/**
 * Audit-alert create/edit form. The complete rule, delivery configuration,
 * optional Slack fan-out, validation request, and save request share one
 * lifecycle owner so a child verifier cannot race or outlive its parent task.
 */

import { type ReactElement, useState } from "react";

import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  type AuditAlertChannelKind,
  type AuditAlertOperatorKind,
  type AuditAlertRuleInput,
  api,
} from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";

import { AuditAlertChannelConfig } from "./AuditAlertChannelConfig";

interface Props {
  initial?: Partial<AuditAlertRuleInput>;
  onSubmit: (input: AuditAlertRuleInput) => Promise<boolean>;
  onCancel: () => void;
}

interface AuditAlertDraft {
  name: string;
  actionGlob: string;
  actorType: string;
  actorLabelGlob: string;
  resourceType: string;
  operatorKind: AuditAlertOperatorKind;
  operatorConfig: Record<string, unknown>;
  channelKind: AuditAlertChannelKind;
  channelConfig: Record<string, unknown>;
  notifySlack: boolean;
}

const CHANNEL_SECRET_KEYS: Partial<
  Record<AuditAlertChannelKind, readonly string[]>
> = {
  slack: ["webhook_url"],
  webhook: ["hmac_secret"],
  servicenow: ["password", "inbound_secret"],
  jira: ["api_token", "inbound_secret"],
  pagerduty: ["routing_key", "inbound_secret"],
};

function sameRecordValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

function ruleDraftIsDirty(
  draft: AuditAlertDraft,
  baseline: AuditAlertDraft,
): boolean {
  return (
    draft.name !== baseline.name ||
    draft.actionGlob !== baseline.actionGlob ||
    draft.actorType !== baseline.actorType ||
    draft.actorLabelGlob !== baseline.actorLabelGlob ||
    draft.resourceType !== baseline.resourceType ||
    draft.operatorKind !== baseline.operatorKind ||
    !sameRecordValues(draft.operatorConfig, baseline.operatorConfig) ||
    draft.channelKind !== baseline.channelKind ||
    !sameRecordValues(draft.channelConfig, baseline.channelConfig) ||
    draft.notifySlack !== baseline.notifySlack
  );
}

function clearSensitiveChannelConfig(
  kind: AuditAlertChannelKind,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const cleared = { ...config };
  for (const key of CHANNEL_SECRET_KEYS[kind] ?? []) delete cleared[key];
  return cleared;
}

function eraseSensitiveChannelValues(
  kind: AuditAlertChannelKind,
  config: Record<string, unknown>,
): void {
  for (const key of CHANNEL_SECRET_KEYS[kind] ?? []) delete config[key];
}

function clearSensitiveRuleDraft(draft: AuditAlertDraft): AuditAlertDraft {
  return {
    ...draft,
    channelConfig: clearSensitiveChannelConfig(
      draft.channelKind,
      draft.channelConfig,
    ),
  };
}

function ruleDraftFrom(
  initial?: Partial<AuditAlertRuleInput>,
): AuditAlertDraft {
  return {
    name: initial?.name ?? "",
    actionGlob: initial?.action_glob ?? "",
    actorType: initial?.actor_type ?? "",
    actorLabelGlob: initial?.actor_label_glob ?? "",
    resourceType: initial?.resource_type ?? "",
    operatorKind: initial?.operator_kind ?? "glob",
    operatorConfig: { ...(initial?.operator_config ?? {}) },
    channelKind: initial?.channel_kind ?? "slack",
    channelConfig: { ...(initial?.channel_config ?? {}) },
    notifySlack: initial?.notify_slack ?? false,
  };
}

export function AuditAlertRuleForm({
  initial,
  onSubmit,
  onCancel,
}: Props): ReactElement {
  const baseline = ruleDraftFrom(initial);
  const [draft, setDraft] = useState<AuditAlertDraft>(() => baseline);
  const [pendingChannelKind, setPendingChannelKind] =
    useState<AuditAlertChannelKind | null>(null);
  const [pendingOperatorKind, setPendingOperatorKind] =
    useState<AuditAlertOperatorKind | null>(null);
  const patch = (next: Partial<AuditAlertDraft>): void =>
    setDraft((current) => ({ ...current, ...next }));

  const requestChannelChange = (channelKind: AuditAlertChannelKind): void => {
    if (channelKind === draft.channelKind) return;
    if (Object.keys(draft.channelConfig).length > 0) {
      setPendingChannelKind(channelKind);
      return;
    }
    patch({ channelKind, channelConfig: {} });
  };

  const requestOperatorChange = (operatorKind: AuditAlertOperatorKind): void => {
    if (operatorKind === draft.operatorKind) return;
    if (Object.keys(draft.operatorConfig).length > 0) {
      setPendingOperatorKind(operatorKind);
      return;
    }
    patch({ operatorKind, operatorConfig: {} });
  };

  const save = async (): Promise<boolean> => {
    if (!draft.name.trim() || !draft.actionGlob.trim()) return false;
    const input: AuditAlertRuleInput = {
      name: draft.name.trim(),
      action_glob: draft.actionGlob.trim(),
      actor_type: draft.actorType.trim() || undefined,
      actor_label_glob: draft.actorLabelGlob.trim() || undefined,
      resource_type: draft.resourceType.trim() || undefined,
      operator_kind: draft.operatorKind,
      operator_config: { ...draft.operatorConfig },
      channel_kind: draft.channelKind,
      channel_config: { ...draft.channelConfig },
      notify_slack: draft.notifySlack,
    };
    let saved: boolean;
    try {
      saved = await onSubmit(input);
    } finally {
      eraseSensitiveChannelValues(draft.channelKind, input.channel_config);
    }
    if (saved) {
      setDraft(clearSensitiveRuleDraft(ruleDraftFrom(initial)));
      setPendingChannelKind(null);
      setPendingOperatorKind(null);
      onCancel();
    }
    return saved;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: initial ? "audit-alert-rule-edit" : "audit-alert-rule-create",
    label: initial ? "Audit-alert rule changes" : "New audit-alert rule draft",
    mode: initial ? "edit" : "create",
    enabled: true,
    dirty: ruleDraftIsDirty(draft, baseline),
    save,
    discard: () => {
      setDraft(clearSensitiveRuleDraft(baseline));
      setPendingChannelKind(null);
      setPendingOperatorKind(null);
    },
    close: onCancel,
    detail: initial
      ? "These audit-alert rule changes have not been saved."
      : "This audit-alert rule has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the audit-alert rule request to finish before leaving Moosewave.",
    onError: (error) =>
      toast.error(
        lifecycleOperationError(error, "The audit-alert rule couldn't be saved."),
      ),
  });

  const verify = (): void => {
    const request = lifecycle.runOperation(async () => {
      const verificationConfig = { ...draft.channelConfig };
      try {
        const result =
          draft.channelKind === "servicenow"
            ? await api.auditAlertVerifyServiceNow(verificationConfig)
            : draft.channelKind === "jira"
              ? await api.auditAlertVerifyJira(verificationConfig)
              : await api.auditAlertVerifyPagerDuty(verificationConfig);
        if (result.error) {
          toast.error(`Verification failed: ${result.error.message}`);
          return;
        }
        toast.success("Connection verified");
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The connection check failed."),
        );
      } finally {
        eraseSensitiveChannelValues(draft.channelKind, verificationConfig);
      }
    });
    if (request) void request;
  };

  return (
    <Modal
      open
      onClose={lifecycle.requestClose}
      closeOnBackdrop={!lifecycle.active}
      closeOnEscape={!lifecycle.active}
      closeDisabled={lifecycle.active}
      title={initial ? "Edit audit-alert rule" : "New audit-alert rule"}
      description="Operator + channel + optional Slack fan-out and SOC linkage."
    >
      <AuditAlertRuleFields
        draft={draft}
        disabled={lifecycle.active}
        onPatch={patch}
        onVerify={verify}
        onChannelKindChange={requestChannelChange}
        onOperatorKindChange={requestOperatorChange}
      />
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={lifecycle.requestClose}
          disabled={lifecycle.active}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void lifecycle.submit()}
          disabled={
            lifecycle.active || !draft.name.trim() || !draft.actionGlob.trim()
          }
        >
          {lifecycle.active ? "Working…" : initial ? "Save rule" : "Create rule"}
        </button>
      </ModalFooter>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title={initial ? "Discard rule changes?" : "Discard rule draft?"}
        description={
          initial
            ? "Your changes will be restored to the loaded rule."
            : "The audit-alert rule has not been created."
        }
        confirmLabel="Discard"
        danger
        busy={lifecycle.active}
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
      <ConfirmModal
        open={pendingChannelKind !== null}
        title="Replace delivery-channel configuration?"
        description="Changing the delivery channel clears the configuration and any credentials entered for the current channel."
        confirmLabel="Replace channel"
        danger
        busy={lifecycle.active}
        onConfirm={() => {
          if (pendingChannelKind) {
            patch({ channelKind: pendingChannelKind, channelConfig: {} });
          }
          setPendingChannelKind(null);
        }}
        onClose={() => setPendingChannelKind(null)}
      />
      <ConfirmModal
        open={pendingOperatorKind !== null}
        title="Replace operator configuration?"
        description="Changing the operator clears the values entered for the current match kind."
        confirmLabel="Replace operator"
        danger
        busy={lifecycle.active}
        onConfirm={() => {
          if (pendingOperatorKind) {
            patch({ operatorKind: pendingOperatorKind, operatorConfig: {} });
          }
          setPendingOperatorKind(null);
        }}
        onClose={() => setPendingOperatorKind(null)}
      />
    </Modal>
  );
}

function AuditAlertRuleFields({
  draft,
  disabled,
  onPatch,
  onVerify,
  onChannelKindChange,
  onOperatorKindChange,
}: {
  draft: AuditAlertDraft;
  disabled: boolean;
  onPatch: (next: Partial<AuditAlertDraft>) => void;
  onVerify: () => void;
  onChannelKindChange: (kind: AuditAlertChannelKind) => void;
  onOperatorKindChange: (kind: AuditAlertOperatorKind) => void;
}): ReactElement {
  const setOperatorField = (key: string, value: unknown): void =>
    onPatch({ operatorConfig: { ...draft.operatorConfig, [key]: value } });
  const operatorString = (key: string): string => {
    const value = draft.operatorConfig[key];
    return typeof value === "string" ? value : "";
  };
  const operatorNumber = (key: string): string => {
    const value = draft.operatorConfig[key];
    return typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  };

  return (
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0 }}>
      <label>
        <span>Rule name</span>
        <input
          type="text"
          value={draft.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          placeholder="Off-hours admin export"
        />
      </label>
      <label>
        <span>Action glob</span>
        <input
          type="text"
          value={draft.actionGlob}
          onChange={(event) => onPatch({ actionGlob: event.target.value })}
          placeholder="impersonation.* or *.deleted"
        />
      </label>
      <div className="audit-alert-rule-form-row">
        <label>
          <span>Actor type (optional)</span>
          <input
            type="text"
            value={draft.actorType}
            onChange={(event) => onPatch({ actorType: event.target.value })}
            placeholder="user / api-key / service"
          />
        </label>
        <label>
          <span>Actor label glob (optional)</span>
          <input
            type="text"
            value={draft.actorLabelGlob}
            onChange={(event) => onPatch({ actorLabelGlob: event.target.value })}
            placeholder="root@*"
          />
        </label>
        <label>
          <span>Resource type (optional)</span>
          <input
            type="text"
            value={draft.resourceType}
            onChange={(event) => onPatch({ resourceType: event.target.value })}
            placeholder="campaign / subscriber"
          />
        </label>
      </div>

      <fieldset className="audit-alert-operator">
        <legend>Operator</legend>
        <label>
          <span>Match kind</span>
          <select
            value={draft.operatorKind}
            onChange={(event) =>
              onOperatorKindChange(
                event.target.value as AuditAlertOperatorKind,
              )
            }
          >
            <option value="glob">Glob (one event)</option>
            <option value="threshold_window">Threshold over time window</option>
            <option value="rate_deviation">Rate deviation from baseline</option>
            <option value="outlier">Outlier / UEBA</option>
          </select>
        </label>
        {draft.operatorKind === "threshold_window" ? (
          <div className="audit-alert-rule-form-row">
            <label>
              <span>Count</span>
              <input
                type="number"
                min={1}
                value={operatorNumber("count")}
                onChange={(event) =>
                  setOperatorField("count", Number(event.target.value || 0))
                }
              />
            </label>
            <label>
              <span>Window (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={operatorNumber("window_min")}
                onChange={(event) =>
                  setOperatorField(
                    "window_min",
                    Number(event.target.value || 0),
                  )
                }
              />
            </label>
            <label>
              <span>Group by</span>
              <select
                value={operatorString("group_by")}
                onChange={(event) =>
                  setOperatorField("group_by", event.target.value)
                }
              >
                <option value="">none (all events)</option>
                <option value="actor_label">actor_label</option>
              </select>
            </label>
          </div>
        ) : null}
        {draft.operatorKind === "rate_deviation" ? (
          <div className="audit-alert-rule-form-row">
            <label>
              <span>Deviation %</span>
              <input
                type="number"
                min={1}
                value={operatorNumber("deviation_pct")}
                onChange={(event) =>
                  setOperatorField(
                    "deviation_pct",
                    Number(event.target.value || 0),
                  )
                }
              />
            </label>
            <label>
              <span>Baseline (days)</span>
              <input
                type="number"
                min={1}
                max={90}
                value={operatorNumber("baseline_days")}
                onChange={(event) =>
                  setOperatorField(
                    "baseline_days",
                    Number(event.target.value || 0),
                  )
                }
              />
            </label>
          </div>
        ) : null}
        {draft.operatorKind === "outlier" ? (
          <label>
            <span>Outlier kind</span>
            <select
              value={operatorString("kind")}
              onChange={(event) =>
                setOperatorField("kind", event.target.value)
              }
            >
              <option value="">— pick one —</option>
              <option value="impossible_travel">impossible_travel</option>
              <option value="escalation_chain">escalation_chain</option>
              <option value="off_hours">off_hours</option>
            </select>
          </label>
        ) : null}
      </fieldset>

      <fieldset className="audit-alert-channel">
        <legend>Channel</legend>
        <label>
          <span>Delivery</span>
          <select
            value={draft.channelKind}
            onChange={(event) =>
              onChannelKindChange(
                event.target.value as AuditAlertChannelKind,
              )
            }
          >
            <option value="email">Email</option>
            <option value="slack">Slack</option>
            <option value="webhook">Webhook</option>
            <option value="servicenow">ServiceNow (bidirectional)</option>
            <option value="jira">Jira (bidirectional)</option>
            <option value="pagerduty">PagerDuty (bidirectional)</option>
          </select>
        </label>
        <AuditAlertChannelConfig
          kind={draft.channelKind}
          config={draft.channelConfig}
          onChange={(channelConfig) => onPatch({ channelConfig })}
          onVerify={onVerify}
          verifying={disabled}
        />
      </fieldset>

      <label
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
      >
        <input
          type="checkbox"
          checked={draft.notifySlack}
          onChange={(event) => onPatch({ notifySlack: event.target.checked })}
        />
        Also notify Slack when this rule fires
      </label>
      <span className="muted" style={{ display: "block", fontSize: 11 }}>
        Requires the tenant Slack integration; this fan-out is additional to
        the delivery channel above.
      </span>
    </fieldset>
  );
}
