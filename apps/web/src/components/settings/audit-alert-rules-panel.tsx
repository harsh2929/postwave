// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellRing,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { OperationsSection } from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createAuditAlertRule,
  deleteAuditAlertRule,
  getAuditAuthority,
  listAuditAlertFires,
  listAuditAlertIncidents,
  listAuditAlertRules,
  patchAuditAlertRule,
  verifyAuditAlertChannel,
  type AuditAlertChannelKind,
  type AuditAlertIncident,
  type AuditAlertOperatorKind,
  type AuditAlertRule,
} from "@/lib/audit-operations-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

interface AuditAlertRulesPanelProps {
  tenantId: string;
  userId: string;
  role: string | null;
  identityReady: boolean;
}

interface RuleForm {
  name: string;
  actionGlob: string;
  actorType: string;
  actorLabelGlob: string;
  resourceType: string;
  operatorKind: AuditAlertOperatorKind;
  thresholdCount: string;
  thresholdWindow: string;
  deviationPercent: string;
  baselineDays: string;
  outlierKind: "impossible_travel" | "escalation_chain" | "off_hours";
  channelKind: AuditAlertChannelKind;
  destination: string;
  secondary: string;
  username: string;
  secret: string;
  serviceNowBasic: boolean;
  notifySlack: boolean;
}

interface RuleFieldIds {
  name: string;
  action: string;
  actor: string;
  actorLabel: string;
  resource: string;
  operator: string;
  thresholdCount: string;
  thresholdWindow: string;
  deviation: string;
  baseline: string;
  outlier: string;
  channel: string;
  destination: string;
  secondary: string;
  username: string;
  secret: string;
}

const EMPTY_RULE: RuleForm = {
  name: "",
  actionGlob: "",
  actorType: "",
  actorLabelGlob: "",
  resourceType: "",
  operatorKind: "glob",
  thresholdCount: "",
  thresholdWindow: "",
  deviationPercent: "",
  baselineDays: "",
  outlierKind: "impossible_travel",
  channelKind: "email",
  destination: "",
  secondary: "",
  username: "",
  secret: "",
  serviceNowBasic: false,
  notifySlack: false,
};

export function AuditAlertRulesPanel({
  tenantId,
  userId,
  role,
  identityReady,
}: AuditAlertRulesPanelProps) {
  const queryClient = useQueryClient();
  const reactInstanceId = useId();
  const fieldIds = useMemo<RuleFieldIds>(() => {
    const prefix = `audit-alert-${reactInstanceId.replaceAll(":", "")}`;
    return {
      name: `${prefix}-name`,
      action: `${prefix}-action`,
      actor: `${prefix}-actor`,
      actorLabel: `${prefix}-actor-label`,
      resource: `${prefix}-resource`,
      operator: `${prefix}-operator`,
      thresholdCount: `${prefix}-threshold-count`,
      thresholdWindow: `${prefix}-threshold-window`,
      deviation: `${prefix}-deviation`,
      baseline: `${prefix}-baseline`,
      outlier: `${prefix}-outlier`,
      channel: `${prefix}-channel`,
      destination: `${prefix}-destination`,
      secondary: `${prefix}-secondary`,
      username: `${prefix}-username`,
      secret: `${prefix}-secret`,
    };
  }, [reactInstanceId]);
  const [active, setActive] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [verifiedChannel, setVerifiedChannel] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(
    null,
  );
  const errorRef = useRef<HTMLDivElement>(null);
  const baseKey = useMemo(
    () => qk.settings(tenantId, role, "audit-alert-rules"),
    [role, tenantId],
  );
  const authorityQuery = useQuery({
    queryKey: [...baseKey, "authority"],
    queryFn: ({ signal }) => getAuditAuthority({ signal }),
    enabled: active && identityReady,
    staleTime: 0,
    retry: false,
  });
  const canRead =
    authorityQuery.data?.auditScopes?.includes("audit:read") === true;
  const canConfigure =
    authorityQuery.data?.auditScopes?.includes("audit:configure_sinks") === true;
  const rulesQuery = useQuery({
    queryKey: [...baseKey, "inventory"],
    queryFn: ({ signal }) => listAuditAlertRules({ signal }),
    enabled: active && authorityQuery.isSuccess && canRead,
    staleTime: STALE.list,
    retry: false,
  });
  const rules = Array.isArray(rulesQuery.data) ? rulesQuery.data : [];

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: baseKey, exact: false });
  }

  async function run(
    label: string,
    action: () => Promise<string>,
  ): Promise<void> {
    if (busy) return;
    setBusy(label);
    setFailure(null);
    setReceipt(null);
    try {
      const result = await action();
      setReceipt(result);
      await refresh();
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : "The alert operation did not complete.",
      );
      queueMicrotask(() => errorRef.current?.focus());
    } finally {
      setBusy(null);
    }
  }

  async function reauthorize(expectedRule?: AuditAlertRule): Promise<void> {
    const [freshIdentity, authority, freshRules] = await Promise.all([
      whoami(),
      getAuditAuthority({ cache: "no-store" }),
      expectedRule
        ? listAuditAlertRules({ cache: "no-store" })
        : Promise.resolve([]),
    ]);
    if (
      freshIdentity.tenant_id !== tenantId ||
      freshIdentity.user_id !== userId ||
      effectiveAuthRole(freshIdentity) !== role ||
      !authority.auditScopes.includes("audit:configure_sinks")
    ) {
      throw new Error(
        "Workspace identity or alert authority changed. Reload before trying again.",
      );
    }
    if (expectedRule) {
      const current = freshRules.find((rule) => rule.id === expectedRule.id);
      if (
        !current ||
        ruleFingerprint(current) !== ruleFingerprint(expectedRule)
      ) {
        throw new Error(
          "The alert rule changed after this view loaded. Refresh and review its current state.",
        );
      }
    }
  }

  async function submitRule(): Promise<string> {
    const validation = validateRuleForm(form);
    if (validation) throw new Error(validation);
    if (
      requiresChannelVerification(form.channelKind) &&
      verifiedChannel !== channelVerificationFingerprint(form)
    ) {
      throw new Error(
        "Verify the current provider origin and credential before creating this rule.",
      );
    }
    await reauthorize();
    const receiptValue = await createAuditAlertRule(buildRuleInput(form));
    setForm(EMPTY_RULE);
    setVerifiedChannel(null);
    setVerificationError(null);
    setCreateOpen(false);
    return `Rule ${receiptValue.id} was created from the verified form. Channel credentials were cleared and were not returned.`;
  }

  async function verifyChannel(): Promise<void> {
    const channelKind = form.channelKind;
    if (busy || !requiresChannelVerification(channelKind)) return;
    const validation = validateRuleForm(form);
    if (validation) {
      setVerificationError(validation);
      return;
    }
    setBusy("Channel verification");
    setVerificationError(null);
    setVerifiedChannel(null);
    try {
      await reauthorize();
      const input = buildRuleInput(form);
      await verifyAuditAlertChannel(channelKind, input.channel_config);
      setVerifiedChannel(channelVerificationFingerprint(form));
    } catch {
      setVerificationError(
        "Connection verification did not complete. Recheck the public HTTPS origin and write-only credential.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <OperationsSection
      id="audit-alert-rules"
      title="Audit alert rules"
      description="Turn audit evidence into bounded email, Slack, webhook, Jira, ServiceNow, or PagerDuty notifications. Rule responses are decoded without retaining channel credentials or provider error bodies."
      aside={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!identityReady || busy !== null}
          onClick={() => {
            if (active) void refresh();
            else setActive(true);
          }}
        >
          <RefreshCw aria-hidden />
          {active ? "Refresh rules" : "Load alert rules"}
        </Button>
      }
    >
      <div className="space-y-4">
        {!active ? (
          <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Alert inventory is loaded only after you request it and remains
            bound to the current workspace identity.
          </div>
        ) : authorityQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Verifying audit-alert authority…
          </p>
        ) : authorityQuery.isError ? (
          <Failure
            title="Audit-alert authority could not be verified"
            detail="No rule inventory or mutation has been requested."
            onRetry={() => void authorityQuery.refetch()}
          />
        ) : !canRead ? (
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertTitle>Audit alert inventory is held</AlertTitle>
            <AlertDescription>
              This session does not hold <code>audit:read</code>. Direct route
              access does not unlock the rules.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {failure ? (
              <Alert ref={errorRef} tabIndex={-1} variant="destructive">
                <AlertTriangle aria-hidden />
                <AlertTitle>Alert operation did not complete</AlertTitle>
                <AlertDescription className="break-words">
                  {failure}
                </AlertDescription>
              </Alert>
            ) : null}
            {receipt ? (
              <Alert>
                <BellRing aria-hidden />
                <AlertTitle>Server receipt verified</AlertTitle>
                <AlertDescription aria-live="polite">
                  {receipt}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Reads require audit:read. Every create, state change, Slack
                fan-out change, and delete requires audit:configure_sinks and a
                fresh inventory check.
              </p>
              {canConfigure ? (
                <Button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setCreateOpen(true)}
                >
                  New alert rule
                </Button>
              ) : null}
            </div>
            {!canConfigure ? (
              <Alert>
                <ShieldAlert aria-hidden />
                <AlertTitle>Rule changes are held</AlertTitle>
                <AlertDescription>
                  This session can inspect rules but does not hold{" "}
                  <code>audit:configure_sinks</code>.
                </AlertDescription>
              </Alert>
            ) : null}
            {rulesQuery.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading alert rules…
              </p>
            ) : rulesQuery.isError ? (
              <Failure
                title="Alert rules could not be loaded"
                detail="A failed inventory request is not presented as an empty rule set."
                onRetry={() => void rulesQuery.refetch()}
              />
            ) : rules.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                Verified empty: the server reports no audit alert rules.
              </div>
            ) : (
              <TableContainer>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rule</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Delivery</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div className="font-medium">{rule.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {rule.operatorKind} · {rule.firedCount} fire
                            {rule.firedCount === 1 ? "" : "s"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="break-all text-xs">
                            {rule.actionGlob}
                          </code>
                          {rule.resourceType ? (
                            <div className="text-xs text-muted-foreground">
                              resource: {rule.resourceType}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {rule.channelKind}
                          {rule.notifySlack ? " + managed Slack" : ""}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={rule.enabled ? "success" : "secondary"}
                          >
                            {rule.enabled ? "enabled" : "paused"}
                          </Badge>
                          {rule.hasDeliveryError ? (
                            <div className="mt-1 text-xs text-destructive-emphasis">
                              latest delivery failed · details withheld
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setExpandedRuleId((current) =>
                                  current === rule.id ? null : rule.id,
                                )
                              }
                            >
                              {expandedRuleId === rule.id
                                ? "Hide evidence"
                                : "View evidence"}
                            </Button>
                            {canConfigure ? (
                              <>
                                <ConfirmDialog
                                  title={
                                    rule.enabled
                                      ? "Pause this alert rule?"
                                      : "Resume this alert rule?"
                                  }
                                  description={
                                    rule.enabled
                                      ? "New matching audit rows will not trigger this rule until it is resumed."
                                      : "New matching audit rows will again trigger the configured channel."
                                  }
                                  confirmLabel={
                                    rule.enabled ? "Pause rule" : "Resume rule"
                                  }
                                  onConfirm={() =>
                                    run(
                                      rule.enabled
                                        ? "Rule paused"
                                        : "Rule resumed",
                                      async () => {
                                        await reauthorize(rule);
                                        await patchAuditAlertRule(rule.id, {
                                          enabled: !rule.enabled,
                                        });
                                        return `The server confirmed ${rule.name} is ${rule.enabled ? "paused" : "enabled"}.`;
                                      },
                                    )
                                  }
                                  trigger={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy !== null}
                                    >
                                      {rule.enabled ? "Pause" : "Resume"}
                                    </Button>
                                  }
                                />
                                <ConfirmDialog
                                  title={
                                    rule.notifySlack
                                      ? "Stop managed Slack fan-out?"
                                      : "Add managed Slack fan-out?"
                                  }
                                  description="This changes only the managed workspace Slack fan-out. The rule's primary channel remains unchanged."
                                  confirmLabel={
                                    rule.notifySlack
                                      ? "Stop Slack fan-out"
                                      : "Add Slack fan-out"
                                  }
                                  confirmVariant="default"
                                  onConfirm={() =>
                                    run("Slack fan-out updated", async () => {
                                      await reauthorize(rule);
                                      await patchAuditAlertRule(rule.id, {
                                        notify_slack: !rule.notifySlack,
                                      });
                                      return `The server confirmed managed Slack fan-out is ${rule.notifySlack ? "off" : "on"}.`;
                                    })
                                  }
                                  trigger={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy !== null}
                                    >
                                      {rule.notifySlack
                                        ? "Slack off"
                                        : "Slack on"}
                                    </Button>
                                  }
                                />
                                <ConfirmDialog
                                  title="Delete this alert rule?"
                                  description={`Rule “${rule.name}” and its linked incident records will be deleted. This cannot be undone.`}
                                  confirmLabel="Delete rule"
                                  confirmationToken="DELETE"
                                  onConfirm={() =>
                                    run("Rule deleted", async () => {
                                      await reauthorize(rule);
                                      await deleteAuditAlertRule(rule.id);
                                      if (expandedRuleId === rule.id)
                                        setExpandedRuleId(null);
                                      return `The server confirmed rule ${rule.id} was deleted.`;
                                    })
                                  }
                                  trigger={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      disabled={busy !== null}
                                    >
                                      Delete
                                    </Button>
                                  }
                                />
                              </>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
            {expandedRuleId ? (
              <AuditAlertEvidence
                key={expandedRuleId}
                rule={rules.find((rule) => rule.id === expandedRuleId) ?? null}
                queryKey={[...baseKey, "evidence", expandedRuleId]}
              />
            ) : null}
          </>
        )}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && busy) return;
          setCreateOpen(open);
          if (!open) {
            setForm(EMPTY_RULE);
            setFailure(null);
            setVerifiedChannel(null);
            setVerificationError(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[90vh] max-w-2xl overflow-y-auto"
          aria-busy={busy !== null}
        >
          <DialogHeader>
            <DialogTitle>Create audit alert rule</DialogTitle>
            <DialogDescription>
              Secrets are write-only, cleared after a successful request, and
              never rendered from rule inventory responses.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void run("Rule created", submitRule);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Rule name" htmlFor={fieldIds.name}>
                <Input
                  id={fieldIds.name}
                  maxLength={256}
                  value={form.name}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "name", event.target.value)
                  }
                  required
                />
              </Field>
              <Field label="Action glob" htmlFor={fieldIds.action}>
                <Input
                  id={fieldIds.action}
                  maxLength={256}
                  value={form.actionGlob}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "actionGlob", event.target.value)
                  }
                  placeholder="subscriber.*"
                  required
                />
              </Field>
              <Field label="Actor type (optional)" htmlFor={fieldIds.actor}>
                <Select
                  id={fieldIds.actor}
                  value={form.actorType}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "actorType", event.target.value)
                  }
                >
                  <option value="">Any actor</option>
                  <option value="human">Human</option>
                  <option value="agent">Agent</option>
                  <option value="system">System</option>
                  <option value="platform_operator">Platform operator</option>
                </Select>
              </Field>
              <Field
                label="Actor label glob (optional)"
                htmlFor={fieldIds.actorLabel}
              >
                <Input
                  id={fieldIds.actorLabel}
                  maxLength={256}
                  value={form.actorLabelGlob}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "actorLabelGlob", event.target.value)
                  }
                />
              </Field>
              <Field
                label="Resource type (optional)"
                htmlFor={fieldIds.resource}
              >
                <Input
                  id={fieldIds.resource}
                  maxLength={128}
                  value={form.resourceType}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "resourceType", event.target.value)
                  }
                />
              </Field>
              <Field label="Match operator" htmlFor={fieldIds.operator}>
                <Select
                  id={fieldIds.operator}
                  value={form.operatorKind}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(
                      setForm,
                      "operatorKind",
                      event.target.value as AuditAlertOperatorKind,
                    )
                  }
                >
                  <option value="glob">Every matching event</option>
                  <option value="threshold_window">Threshold in window</option>
                  <option value="rate_deviation">Rate deviation</option>
                  <option value="outlier">Outlier detector</option>
                </Select>
              </Field>
            </div>
            <OperatorFields
              form={form}
              setForm={setForm}
              disabled={busy !== null}
              ids={fieldIds}
            />
            <div className="border-t pt-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Primary channel" htmlFor={fieldIds.channel}>
                  <Select
                    id={fieldIds.channel}
                    value={form.channelKind}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...EMPTY_RULE,
                        name: current.name,
                        actionGlob: current.actionGlob,
                        actorType: current.actorType,
                        actorLabelGlob: current.actorLabelGlob,
                        resourceType: current.resourceType,
                        operatorKind: current.operatorKind,
                        thresholdCount: current.thresholdCount,
                        thresholdWindow: current.thresholdWindow,
                        deviationPercent: current.deviationPercent,
                        baselineDays: current.baselineDays,
                        outlierKind: current.outlierKind,
                        channelKind: event.target
                          .value as AuditAlertChannelKind,
                      }))
                    }
                  >
                    <option value="email">Email</option>
                    <option value="slack">Slack webhook</option>
                    <option value="webhook">HTTPS webhook</option>
                    <option value="pagerduty">PagerDuty</option>
                    <option value="jira">Jira</option>
                    <option value="servicenow">ServiceNow</option>
                  </Select>
                </Field>
                <ChannelFields
                  form={form}
                  setForm={setForm}
                  disabled={busy !== null}
                  ids={fieldIds}
                />
                {requiresChannelVerification(form.channelKind) ? (
                  <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
                    <Button
                      type="button"
                      variant="outline"
                      loading={busy === "Channel verification"}
                      disabled={busy !== null}
                      onClick={() => void verifyChannel()}
                    >
                      {form.channelKind === "pagerduty"
                        ? "Check routing key"
                        : "Verify provider connection"}
                    </Button>
                    {verifiedChannel ===
                    channelVerificationFingerprint(form) ? (
                      <p
                        role="status"
                        className="text-sm text-success-emphasis"
                      >
                        The server accepted the current provider credential. Any
                        channel edit requires a new verification.
                      </p>
                    ) : verificationError ? (
                      <p
                        role="alert"
                        className="text-sm text-destructive-emphasis"
                      >
                        {verificationError}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Verification is online-only. Secrets remain write-only
                        and are cleared when the dialog closes.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.notifySlack}
                  disabled={busy !== null}
                  onChange={(event) =>
                    setFormValue(setForm, "notifySlack", event.target.checked)
                  }
                />
                <span>
                  Also fan out through the managed workspace Slack integration.
                </span>
              </label>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={busy !== null}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                loading={busy === "Rule created"}
                disabled={busy !== null}
              >
                {busy === "Rule created" ? "Creating…" : "Create rule"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </OperationsSection>
  );
}

function AuditAlertEvidence({
  rule,
  queryKey,
}: {
  rule: AuditAlertRule | null;
  queryKey: readonly unknown[];
}) {
  const evidenceTitleId = `${useId().replaceAll(":", "")}-audit-alert-evidence-title`;
  const [incidents, setIncidents] = useState<AuditAlertIncident[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const firesQuery = useQuery({
    queryKey: [...queryKey, "fires"],
    queryFn: ({ signal }) => listAuditAlertFires(rule?.id ?? "", { signal }),
    enabled: Boolean(rule),
    staleTime: STALE.list,
    retry: false,
  });
  const incidentsQuery = useQuery({
    queryKey: [...queryKey, "incidents"],
    queryFn: ({ signal }) =>
      listAuditAlertIncidents(rule?.id ?? "", { limit: 50, signal }),
    enabled: Boolean(rule),
    staleTime: STALE.list,
    retry: false,
  });
  const fetchedIncidents = Array.isArray(incidentsQuery.data?.incidents)
    ? incidentsQuery.data.incidents
    : [];
  const visibleIncidents = incidents.length > 0 ? incidents : fetchedIncidents;
  const nextCursor = cursor ?? incidentsQuery.data?.nextCursor;
  if (!rule)
    return (
      <Alert variant="destructive">
        <AlertTitle>Rule inventory changed</AlertTitle>
        <AlertDescription>
          Close this evidence panel and refresh the current rule list.
        </AlertDescription>
      </Alert>
    );
  return (
    <section
      aria-labelledby={evidenceTitleId}
      className="rounded-lg border p-4"
    >
      <h3 id={evidenceTitleId} className="font-medium">
        Evidence for {rule.name}
      </h3>
      <p className="text-sm text-muted-foreground">
        Recent fires are capped at 100. Linked incidents use bounded 50-row
        cursor pages.
      </p>
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <EvidenceList
          title="Recent fires"
          pending={firesQuery.isPending}
          failed={firesQuery.isError}
          empty={firesQuery.data?.length === 0}
          retry={() => void firesQuery.refetch()}
        >
          {firesQuery.data?.map((fire) => (
            <li key={fire.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>Audit #{fire.auditId}</span>
                <Badge variant={fire.delivered ? "success" : "destructive"}>
                  {fire.delivered ? "delivered" : "failed"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatTime(fire.firedAt)}
                {fire.hasDeliveryError ? " · provider details withheld" : ""}
              </p>
            </li>
          ))}
        </EvidenceList>
        <EvidenceList
          title="Linked incidents"
          pending={incidentsQuery.isPending}
          failed={incidentsQuery.isError}
          empty={visibleIncidents.length === 0}
          retry={() => void incidentsQuery.refetch()}
        >
          {visibleIncidents.map((incident) => (
            <li key={incident.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {incident.externalSystem} · {incident.externalIncidentId}
                </span>
                <Badge variant="secondary">
                  {incident.status || "unknown"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Updated {formatTime(incident.updatedAt)}
              </p>
              {incident.url ? (
                <a
                  href={incident.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs underline"
                >
                  Open provider incident{" "}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </li>
          ))}
          {nextCursor ? (
            <li>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={loadingMore}
                onClick={async () => {
                  if (!nextCursor || loadingMore) return;
                  setLoadingMore(true);
                  try {
                    const page = await listAuditAlertIncidents(rule.id, {
                      cursor: nextCursor,
                      limit: 50,
                    });
                    setIncidents((current) => [
                      ...(current.length ? current : fetchedIncidents),
                      ...page.incidents,
                    ]);
                    setCursor(page.nextCursor);
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                Load more incidents
              </Button>
            </li>
          ) : null}
        </EvidenceList>
      </div>
    </section>
  );
}

function EvidenceList({
  title,
  pending,
  failed,
  empty,
  retry,
  children,
}: {
  title: string;
  pending: boolean;
  failed: boolean;
  empty: boolean;
  retry: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">{title}</h4>
      {pending ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : failed ? (
        <div className="mt-2">
          <Failure
            title={`${title} could not be loaded`}
            detail="No empty-state claim is made."
            onRetry={retry}
          />
        </div>
      ) : empty ? (
        <p className="mt-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Verified empty: no records were returned.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">{children}</ul>
      )}
    </div>
  );
}

function OperatorFields({
  form,
  setForm,
  disabled,
  ids,
}: {
  form: RuleForm;
  setForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  disabled: boolean;
  ids: RuleFieldIds;
}) {
  if (form.operatorKind === "glob") return null;
  if (form.operatorKind === "threshold_window")
    return (
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
        <Field label="Event count" htmlFor={ids.thresholdCount}>
          <Input
            id={ids.thresholdCount}
            type="number"
            min={1}
            step={1}
            value={form.thresholdCount}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "thresholdCount", event.target.value)
            }
            required
          />
        </Field>
        <Field label="Window (minutes, max 1440)" htmlFor={ids.thresholdWindow}>
          <Input
            id={ids.thresholdWindow}
            type="number"
            min={1}
            max={1440}
            step={1}
            value={form.thresholdWindow}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "thresholdWindow", event.target.value)
            }
            required
          />
        </Field>
      </div>
    );
  if (form.operatorKind === "rate_deviation")
    return (
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
        <Field label="Deviation percent" htmlFor={ids.deviation}>
          <Input
            id={ids.deviation}
            type="number"
            min={0.01}
            step="any"
            value={form.deviationPercent}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "deviationPercent", event.target.value)
            }
            required
          />
        </Field>
        <Field label="Baseline days (max 90)" htmlFor={ids.baseline}>
          <Input
            id={ids.baseline}
            type="number"
            min={1}
            max={90}
            step={1}
            value={form.baselineDays}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "baselineDays", event.target.value)
            }
            required
          />
        </Field>
      </div>
    );
  return (
    <div className="rounded-lg border p-4">
      <Field label="Outlier detector" htmlFor={ids.outlier}>
        <Select
          id={ids.outlier}
          value={form.outlierKind}
          disabled={disabled}
          onChange={(event) =>
            setFormValue(
              setForm,
              "outlierKind",
              event.target.value as RuleForm["outlierKind"],
            )
          }
        >
          <option value="impossible_travel">Impossible travel</option>
          <option value="escalation_chain">Escalation chain</option>
          <option value="off_hours">Off-hours activity</option>
        </Select>
      </Field>
    </div>
  );
}

function ChannelFields({
  form,
  setForm,
  disabled,
  ids,
}: {
  form: RuleForm;
  setForm: React.Dispatch<React.SetStateAction<RuleForm>>;
  disabled: boolean;
  ids: RuleFieldIds;
}) {
  switch (form.channelKind) {
    case "email":
      return (
        <Field label="Recipient email" htmlFor={ids.destination}>
          <Input
            id={ids.destination}
            type="email"
            autoComplete="email"
            value={form.destination}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "destination", event.target.value)
            }
            required
          />
        </Field>
      );
    case "slack":
      return (
        <Field label="Slack webhook URL" htmlFor={ids.destination}>
          <Input
            id={ids.destination}
            type="url"
            pattern="https://hooks\.slack\.com/.*"
            autoComplete="off"
            value={form.destination}
            disabled={disabled}
            onChange={(event) =>
              setFormValue(setForm, "destination", event.target.value)
            }
            required
          />
        </Field>
      );
    case "webhook":
      return (
        <>
          <Field label="Webhook URL" htmlFor={ids.destination}>
            <Input
              id={ids.destination}
              type="url"
              pattern="https://.*"
              autoComplete="url"
              value={form.destination}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "destination", event.target.value)
              }
              required
            />
          </Field>
          <SecretField
            label="Optional HMAC secret"
            id={ids.secret}
            value={form.secret}
            disabled={disabled}
            onChange={(value) => setFormValue(setForm, "secret", value)}
            required={false}
          />
        </>
      );
    case "pagerduty":
      return (
        <SecretField
          label="PagerDuty routing key"
          id={ids.secret}
          value={form.secret}
          disabled={disabled}
          onChange={(value) => setFormValue(setForm, "secret", value)}
        />
      );
    case "jira":
      return (
        <>
          <Field label="Jira site URL" htmlFor={ids.destination}>
            <Input
              id={ids.destination}
              type="url"
              pattern="https://.*"
              value={form.destination}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "destination", event.target.value)
              }
              required
            />
          </Field>
          <Field label="Project key" htmlFor={ids.secondary}>
            <Input
              id={ids.secondary}
              maxLength={64}
              value={form.secondary}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "secondary", event.target.value)
              }
              required
            />
          </Field>
          <Field label="Account email" htmlFor={ids.username}>
            <Input
              id={ids.username}
              type="email"
              autoComplete="username"
              value={form.username}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "username", event.target.value)
              }
              required
            />
          </Field>
          <SecretField
            label="API token"
            id={ids.secret}
            value={form.secret}
            disabled={disabled}
            onChange={(value) => setFormValue(setForm, "secret", value)}
          />
        </>
      );
    case "servicenow":
      return (
        <>
          <Field label="ServiceNow instance URL" htmlFor={ids.destination}>
            <Input
              id={ids.destination}
              type="url"
              pattern="https://.*"
              value={form.destination}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "destination", event.target.value)
              }
              required
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.serviceNowBasic}
              disabled={disabled}
              onChange={(event) =>
                setFormValue(setForm, "serviceNowBasic", event.target.checked)
              }
            />
            Use username and password
          </label>
          {form.serviceNowBasic ? (
            <>
              <Field label="Username" htmlFor={ids.username}>
                <Input
                  id={ids.username}
                  autoComplete="username"
                  value={form.username}
                  disabled={disabled}
                  onChange={(event) =>
                    setFormValue(setForm, "username", event.target.value)
                  }
                  required
                />
              </Field>
              <SecretField
                label="Password"
                id={ids.secret}
                value={form.secret}
                disabled={disabled}
                onChange={(value) => setFormValue(setForm, "secret", value)}
              />
            </>
          ) : (
            <SecretField
              label="Bearer token"
              id={ids.secret}
              value={form.secret}
              disabled={disabled}
              onChange={(value) => setFormValue(setForm, "secret", value)}
            />
          )}
        </>
      );
  }
}

function SecretField({
  label,
  id,
  value,
  disabled,
  onChange,
  required = true,
}: {
  label: string;
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </Field>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function Failure({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{detail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function setFormValue<K extends keyof RuleForm>(
  setForm: React.Dispatch<React.SetStateAction<RuleForm>>,
  key: K,
  value: RuleForm[K],
): void {
  setForm((current) => ({ ...current, [key]: value }));
}

function validateRuleForm(form: RuleForm): string | null {
  if (!form.name.trim() || !form.actionGlob.trim())
    return "Rule name and action glob are required.";
  if (
    form.operatorKind === "threshold_window" &&
    (!positiveInt(form.thresholdCount) ||
      !positiveInt(form.thresholdWindow) ||
      Number(form.thresholdWindow) > 1440)
  )
    return "Threshold count and a 1–1440 minute window are required.";
  if (
    form.operatorKind === "rate_deviation" &&
    (!(Number(form.deviationPercent) > 0) ||
      !positiveInt(form.baselineDays) ||
      Number(form.baselineDays) > 90)
  )
    return "A positive deviation and a 1–90 day baseline are required.";
  if (!form.destination.trim() && !["pagerduty"].includes(form.channelKind))
    return "Complete the channel destination.";
  if (
    ["pagerduty", "jira", "servicenow"].includes(form.channelKind) &&
    !form.secret
  )
    return "Complete the write-only channel credential.";
  if (
    form.channelKind === "jira" &&
    (!form.secondary.trim() || !form.username.trim())
  )
    return "Jira project key and account email are required.";
  if (
    form.channelKind === "servicenow" &&
    form.serviceNowBasic &&
    !form.username.trim()
  )
    return "ServiceNow username is required for basic authentication.";
  return null;
}

function buildRuleInput(form: RuleForm) {
  const operator_config: Record<string, unknown> =
    form.operatorKind === "threshold_window"
      ? {
          count: Number(form.thresholdCount),
          window_min: Number(form.thresholdWindow),
        }
      : form.operatorKind === "rate_deviation"
        ? {
            deviation_pct: Number(form.deviationPercent),
            baseline_days: Number(form.baselineDays),
          }
        : form.operatorKind === "outlier"
          ? { kind: form.outlierKind }
          : {};
  let channel_config: Record<string, unknown>;
  switch (form.channelKind) {
    case "email":
      channel_config = { to: form.destination.trim() };
      break;
    case "slack":
      channel_config = { webhook_url: form.destination.trim() };
      break;
    case "webhook":
      channel_config = {
        url: form.destination.trim(),
        ...(form.secret ? { hmac_secret: form.secret } : {}),
      };
      break;
    case "pagerduty":
      channel_config = { routing_key: form.secret };
      break;
    case "jira":
      channel_config = {
        site_url: form.destination.trim(),
        project_key: form.secondary.trim(),
        email: form.username.trim(),
        api_token: form.secret,
      };
      break;
    case "servicenow":
      channel_config = form.serviceNowBasic
        ? {
            instance_url: form.destination.trim(),
            username: form.username.trim(),
            password: form.secret,
          }
        : { instance_url: form.destination.trim(), bearer_token: form.secret };
      break;
  }
  return {
    name: form.name.trim(),
    action_glob: form.actionGlob.trim(),
    ...(form.actorType ? { actor_type: form.actorType } : {}),
    ...(form.actorLabelGlob.trim()
      ? { actor_label_glob: form.actorLabelGlob.trim() }
      : {}),
    ...(form.resourceType.trim()
      ? { resource_type: form.resourceType.trim() }
      : {}),
    operator_kind: form.operatorKind,
    operator_config,
    channel_kind: form.channelKind,
    channel_config,
    notify_slack: form.notifySlack,
  };
}

function positiveInt(value: string): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function requiresChannelVerification(
  kind: AuditAlertChannelKind,
): kind is "servicenow" | "jira" | "pagerduty" {
  return kind === "servicenow" || kind === "jira" || kind === "pagerduty";
}

function channelVerificationFingerprint(form: RuleForm): string {
  const value = JSON.stringify([
    form.channelKind,
    form.destination,
    form.secondary,
    form.username,
    form.secret,
    form.serviceNowBasic,
  ]);
  // Keep only a change detector in state, never a second copy of the secret.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${value.length}:${first.toString(16)}:${second.toString(16)}`;
}

function ruleFingerprint(rule: AuditAlertRule): string {
  return JSON.stringify([
    rule.id,
    rule.name,
    rule.enabled,
    rule.actionGlob,
    rule.actorType ?? "",
    rule.actorLabelGlob ?? "",
    rule.resourceType ?? "",
    rule.operatorKind,
    rule.channelKind,
    rule.notifySlack,
    rule.firedCount,
    rule.lastFiredAt ?? "",
    rule.createdAt,
    rule.hasDeliveryError,
  ]);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}
