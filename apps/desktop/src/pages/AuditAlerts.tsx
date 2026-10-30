/**
 * AuditAlerts — composable alert rules over audit_log, with
 * bidirectional SOC ticketing (ServiceNow / Jira / PagerDuty).
 *
 * Layout: list of rules + a per-row "Linked incidents" inline panel
 * that expands to show the audit_alert_incidents rows synced from the
 * external SOC system. New-rule modal carries the operator picker
 * (glob / threshold_window / rate_deviation / outlier) and the
 * channel selector.
 */

import {
  Fragment,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { SectionHeader } from "../components/SectionHeader";
import { toast } from "../components/Toast";
import { AuditAlertIncidents } from "../components/audit/AuditAlertIncidents";
import { AuditAlertRuleForm } from "../components/audit/AuditAlertRuleForm";
import {
  type AuditAlertRule,
  type AuditAlertRuleInput,
  api,
} from "../lib/api-client";
import { useRemoteResource } from "../hooks/useRemoteResource";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { isInitialRemoteLoad } from "../lib/remote-resource";

import "../styles-audit-alerts.css";

export function AuditAlerts(): ReactElement {
  const [showCreate, setShowCreate] = useState<boolean>(false);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  // Pending delete-rule target. The native confirm() was unstyled and
  // skipped in some Tauri webviews. ConfirmModal gives a single, focus-
  // trapped dialog that matches the rest of the admin surface.
  const [pendingDelete, setPendingDelete] = useState<AuditAlertRule | null>(
    null,
  );
  const mountedRef = useRef(true);
  const mutation = useSingleFlightOperation({
    ownerId: "audit-alert-rule-mutation",
    label: "Audit-alert rule operation",
    detail: "Wait for the audit-alert rule request to finish before leaving.",
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const rulesResource = useRemoteResource<AuditAlertRule[]>(
    async () => {
      const res = await api.auditAlertsList();
      if ("error" in res && res.error) {
        return { error: res.error };
      }
      return { data: res.data.rules ?? [] };
    },
    { identity: "audit-alert-rules" },
  );
  const rules = rulesResource.data;
  const initialLoading = isInitialRemoteLoad(rulesResource);

  async function createRule(input: AuditAlertRuleInput): Promise<boolean> {
    const res = await api.auditAlertCreate(input);
    if (res.error) {
      toast.error("Create failed: " + (res.error?.message ?? "unknown"));
      return false;
    }
    toast.success("Rule created");
    if (mountedRef.current) void rulesResource.reload();
    return true;
  }

  async function toggleRule(rule: AuditAlertRule): Promise<void> {
    const request = mutation.run(async () => {
      try {
        const res = await api.auditAlertPatch(rule.id, {
          enabled: !rule.enabled,
        });
        if (res.error) {
          toast.error("Toggle failed: " + (res.error?.message ?? "unknown"));
          return;
        }
        if (mountedRef.current) void rulesResource.reload();
      } catch (error) {
        toast.error(lifecycleOperationError(error, "The rule toggle failed."));
      }
    });
    if (!request) await mutation.wait();
  }

  // notify_slack edit path: existing rules have no edit modal, so the
  // Slack fan-out toggles inline per row via PATCH.
  async function toggleSlack(rule: AuditAlertRule): Promise<void> {
    const request = mutation.run(async () => {
      try {
        const next = !rule.notify_slack;
        const res = await api.auditAlertPatch(rule.id, { notify_slack: next });
        if (res.error) {
          toast.error("Slack toggle failed: " + res.error.message);
          return;
        }
        toast.success(
          next ? "Slack fan-out enabled" : "Slack fan-out disabled",
        );
        if (mountedRef.current) void rulesResource.reload();
      } catch (error) {
        toast.error(lifecycleOperationError(error, "The Slack toggle failed."));
      }
    });
    if (!request) await mutation.wait();
  }

  function deleteRule(rule: AuditAlertRule): void {
    // Stage the rule for the ConfirmModal — actual delete runs in
    // confirmDelete(). Pre-fix this was a native confirm() that skipped
    // in Tauri builds (returned null) and broke the destructive flow.
    setPendingDelete(rule);
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const target = pendingDelete;
    const request = mutation.run(async () => {
      try {
        const res = await api.auditAlertDelete(target.id);
        if (res.error) {
          toast.error("Delete failed: " + (res.error?.message ?? "unknown"));
          return;
        }
        toast.success("Rule deleted");
        if (mountedRef.current) {
          setPendingDelete(null);
          void rulesResource.reload();
        }
      } catch (error) {
        toast.error(lifecycleOperationError(error, "The rule delete failed."));
      }
    });
    if (!request) await mutation.wait();
  }

  return (
    <div className="audit-alerts-page">
      <SectionHeader
        title="Audit alerts"
        description="Match operators + bidirectional SOC ticketing. Rules fire on audit_log events and create linked incidents in ServiceNow, Jira, or PagerDuty."
        actions={
          <button
            type="button"
            onClick={(): void => {
              if (rulesResource.access === "denied") return;
              setShowCreate(true);
            }}
            aria-disabled={rulesResource.access === "denied" || undefined}
            aria-describedby={
              rulesResource.access === "denied"
                ? "audit-alert-create-permission"
                : undefined
            }
          >
            New rule
          </button>
        }
      />

      {rulesResource.access === "denied" ? (
        <p
          id="audit-alert-create-permission"
          className="muted"
          style={{ fontSize: 11, margin: "0 0 8px" }}
        >
          Your current role cannot read or create audit-alert rules.
        </p>
      ) : null}

      <RemoteDataNotice
        resource={rulesResource}
        label="audit-alert rules"
        onRetry={() => void rulesResource.reload()}
      />

      {initialLoading ? (
        <div className="audit-alerts-empty">Loading rules...</div>
      ) : rules === null ? null : rules.length === 0 ? (
        <div className="audit-alerts-empty">
          No alert rules yet. Click <strong>New rule</strong> to create one.
        </div>
      ) : (
        <table className="audit-alerts-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Operator</th>
              <th>Action glob</th>
              <th>Channel</th>
              <th>Fires</th>
              <th>Last fired</th>
              <th>Linked incidents</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              // Keyed Fragment: the key must live on the outermost
              // element returned per item — a bare <> can't carry one,
              // which broke React's list reconciliation here.
              <Fragment key={rule.id}>
                <tr>
                  <td>{rule.name}</td>
                  <td>
                    <code>{rule.operator_kind}</code>
                  </td>
                  <td>
                    <code>{rule.action_glob}</code>
                  </td>
                  <td>
                    {rule.channel_kind}
                    {rule.notify_slack ? (
                      <span
                        className="muted"
                        style={{ fontSize: 11 }}
                        title="Also fans out to the connected Slack workspace when this rule fires"
                      >
                        {" "}
                        + Slack
                      </span>
                    ) : null}
                  </td>
                  <td>{rule.fired_count}</td>
                  <td>{rule.last_fired_at ?? "—"}</td>
                  <td>
                    <button
                      type="button"
                      onClick={(): void =>
                        setExpandedRule(
                          expandedRule === rule.id ? null : rule.id,
                        )
                      }
                    >
                      {expandedRule === rule.id ? "Hide" : "Show"}
                    </button>
                  </td>
                  <td>
                    <span
                      className={
                        rule.enabled
                          ? "audit-alert-rule-on"
                          : "audit-alert-rule-off"
                      }
                    >
                      {rule.enabled ? "enabled" : "disabled"}
                    </span>
                    {rule.last_error ? (
                      <span
                        className="audit-alert-rule-error"
                        title={rule.last_error}
                      >
                        {" "}
                        ⚠ error
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={(): void => void toggleRule(rule)}
                      disabled={mutation.active}
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={(): void => void toggleSlack(rule)}
                      disabled={mutation.active}
                      aria-label={
                        rule.notify_slack
                          ? "Stop fanning this rule out to Slack"
                          : "Also notify the connected Slack workspace when this rule fires (requires the Slack integration — Settings → Slack)"
                      }
                    >
                      {rule.notify_slack ? "Slack: on" : "Slack: off"}
                    </button>
                    <button
                      type="button"
                      onClick={(): void => deleteRule(rule)}
                      disabled={mutation.active}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {expandedRule === rule.id ? (
                  <tr>
                    <td colSpan={9}>
                      <AuditAlertIncidents ruleId={rule.id} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {showCreate ? (
        <AuditAlertRuleForm
          onCancel={(): void => setShowCreate(false)}
          onSubmit={createRule}
        />
      ) : null}

      {/* Delete-rule confirm. Replaces the legacy native confirm() so the
          destructive prompt matches the rest of the admin surface and works
          inside Tauri webviews (where confirm() can silently return null). */}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete alert rule?"
        description={
          pendingDelete
            ? `Delete rule "${pendingDelete.name}"? This also drops linked incidents.`
            : ""
        }
        confirmLabel="Delete rule"
        danger
        busy={mutation.active}
        onConfirm={(): Promise<void> => confirmDelete()}
        onClose={(): void => {
          if (!mutation.active) setPendingDelete(null);
        }}
      />
    </div>
  );
}
