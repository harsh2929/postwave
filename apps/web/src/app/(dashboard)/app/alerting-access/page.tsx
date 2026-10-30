// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  RotateCw,
  ShieldCheck,
} from "lucide-react";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  authenticateAlertProvider,
  mintStreamToken,
  rotateInboundEndpoint,
  type AlertProvider,
  type RotatedInboundEndpoint,
  type StreamToken,
} from "@/lib/alerting-access-api";
import {
  domainNotRequested,
  getArchiveDomain,
  type ArchiveDomain,
} from "@/lib/archive-admin-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { canReadAdminData } from "@/lib/admin-read-authority";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE } from "@/lib/custom-domain-operational-availability";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";

const AuditAlertRulesPanel = dynamic(
  () =>
    import("@/components/settings/audit-alert-rules-panel").then(
      (module) => module.AuditAlertRulesPanel,
    ),
  { ssr: false, loading: () => <AuditAlertRulesLoading /> },
);

const PROVIDERS: Array<{ value: AlertProvider; label: string }> = [
  { value: "pagerduty", label: "PagerDuty" },
  { value: "jira", label: "Jira" },
  { value: "servicenow", label: "ServiceNow" },
];

type ServiceNowMode = "bearer" | "basic";
type ProviderForm = {
  routingKey: string;
  jiraSiteUrl: string;
  jiraEmail: string;
  jiraToken: string;
  serviceNowUrl: string;
  serviceNowMode: ServiceNowMode;
  serviceNowBearer: string;
  serviceNowUsername: string;
  serviceNowPassword: string;
};

const EMPTY_PROVIDER_FORM: ProviderForm = {
  routingKey: "",
  jiraSiteUrl: "",
  jiraEmail: "",
  jiraToken: "",
  serviceNowUrl: "",
  serviceNowMode: "bearer",
  serviceNowBearer: "",
  serviceNowUsername: "",
  serviceNowPassword: "",
};

type Result = {
  id: number;
  label: string;
  text: string;
  tone: "success" | "warning" | "error";
  at: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request did not complete.";
}

export default function AlertingAccessPage() {
  const queryClient = useQueryClient();
  const resultSequence = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canWrite = Boolean(meQuery.isSuccess && canReadAdminData(meQuery.data));
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const archiveKey = useMemo(
    () =>
      [
        ...qk.settings(
          tenantId,
          effectiveRole,
          "archive-domain-legacy-evidence",
        ),
        userId,
        viewerState,
      ] as const,
    [effectiveRole, tenantId, userId, viewerState],
  );
  const archiveQuery = useQuery({
    queryKey: archiveKey,
    queryFn: ({ signal }) => getArchiveDomain(signal),
    enabled: canWrite,
    staleTime: STALE.reference,
    retry: false,
  });

  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<AlertProvider>("pagerduty");
  const [providerForm, setProviderForm] =
    useState<ProviderForm>(EMPTY_PROVIDER_FORM);
  const [token, setToken] = useState<StreamToken | null>(null);
  const [rotatedEndpoint, setRotatedEndpoint] =
    useState<RotatedInboundEndpoint | null>(null);
  const [confirmRotate, setConfirmRotate] = useState("");

  useEffect(() => {
    if (canWrite) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    busyRef.current = false;
    setBusy(null);
    setProviderForm(EMPTY_PROVIDER_FORM);
    setToken(null);
    setRotatedEndpoint(null);
    setConfirmRotate("");
    setResults([]);
    void queryClient.cancelQueries({ queryKey: archiveKey });
    queryClient.removeQueries({ queryKey: archiveKey });
  }, [archiveKey, canWrite, queryClient]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const record = (
    label: string,
    text: string,
    tone: Result["tone"] = "success",
  ) => {
    resultSequence.current += 1;
    setResults((previous) =>
      [
        {
          id: resultSequence.current,
          label,
          text,
          tone,
          at: new Date().toISOString(),
        },
        ...previous,
      ].slice(0, 12),
    );
  };

  async function run(
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
    // Local-only actions skip the fresh-authority round-trip. Re-checking
    // authority before a WRITE is right; doing it before a clipboard copy is
    // not. `verifyFreshAdminAuthority` performs a real GET /api/v1/auth/me, and
    // awaiting it pushes `navigator.clipboard.writeText` outside the click's
    // transient user activation, which Safari and Firefox reject — so the copy
    // buttons silently failed for the value already rendered on screen. Copying
    // a displayed secret grants no capability the page has not already given.
    { verifyAuthority = true }: { verifyAuthority?: boolean } = {},
  ) {
    if (busyRef.current || !canWrite || !meQuery.data) return;
    busyRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(label);
    try {
      if (verifyAuthority) {
        await verifyFreshAdminAuthority(meQuery.data, controller.signal);
      }
      await action(controller.signal);
    } catch (error) {
      record(label, errorMessage(error), "error");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      busyRef.current = false;
      setBusy(null);
    }
  }

  const providerLabel =
    PROVIDERS.find((candidate) => candidate.value === provider)?.label ??
    provider;
  const providerReady = providerFormReady(provider, providerForm);
  const controlsDisabled = meQuery.isPending || !canWrite || busy !== null;

  async function verifyProvider(signal: AbortSignal) {
    switch (provider) {
      case "pagerduty":
        await authenticateAlertProvider(
          "pagerduty",
          {
            routing_key: providerForm.routingKey.trim(),
          },
          { signal, requireOnline: true, maxAttempts: 1 },
        );
        break;
      case "jira":
        await authenticateAlertProvider(
          "jira",
          {
            site_url: providerForm.jiraSiteUrl.trim(),
            email: providerForm.jiraEmail.trim(),
            api_token: providerForm.jiraToken.trim(),
          },
          { signal, requireOnline: true, maxAttempts: 1 },
        );
        break;
      case "servicenow":
        if (providerForm.serviceNowMode === "bearer") {
          await authenticateAlertProvider(
            "servicenow",
            {
              instance_url: providerForm.serviceNowUrl.trim(),
              bearer_token: providerForm.serviceNowBearer.trim(),
            },
            { signal, requireOnline: true, maxAttempts: 1 },
          );
        } else {
          await authenticateAlertProvider(
            "servicenow",
            {
              instance_url: providerForm.serviceNowUrl.trim(),
              username: providerForm.serviceNowUsername.trim(),
              password: providerForm.serviceNowPassword,
            },
            { signal, requireOnline: true, maxAttempts: 1 },
          );
        }
        break;
    }
    record(
      `Verify ${providerLabel}`,
      provider === "pagerduty"
        ? "The routing key passed a local length check. PagerDuty delivery remains unverified because this endpoint does not send an event. The credential was not stored."
        : `${providerLabel} authenticated the verification request. The supplied credentials were not stored.`,
      provider === "pagerduty" ? "warning" : "success",
    );
    setProviderForm(EMPTY_PROVIDER_FORM);
  }

  return (
    <OperationsShell className="max-w-5xl">
      <OperationsHeader
        icon={ShieldCheck}
        eyebrow="Operations · Restricted"
        title="Alerting and access"
        description="Verify incident-provider credentials, issue short-lived stream access, and rotate signing material. Credentials are used only for the verification request and are not stored by this page."
      />

      {meQuery.isPending ? (
        <Alert>
          <AlertTitle>Checking workspace access</AlertTitle>
          <AlertDescription role="status">
            Actions remain locked until your current role is verified.
          </AlertDescription>
        </Alert>
      ) : meQuery.isError ? (
        <OperationsFailure
          title="Workspace access could not be verified"
          description="No credential, token, domain, or rotation request has been sent."
          onRetry={() => void meQuery.refetch()}
          retrying={meQuery.isFetching}
        />
      ) : !canWrite ? (
        <Alert>
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            Only workspace owners and admins can verify credentials, mint a
            stream token, verify archive DNS, or rotate an inbound signing
            secret.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <OperationsSection
          id="alerting-provider"
          title="Incident-provider verification"
          description="Jira and ServiceNow perform a bounded provider identity check. PagerDuty only checks the routing-key length; no alert is delivered."
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!providerReady) return;
              void run(`Verify ${providerLabel}`, verifyProvider);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="aa-provider">Provider</Label>
              <select
                id="aa-provider"
                value={provider}
                disabled={controlsDisabled}
                onChange={(event) => {
                  setProvider(event.target.value as AlertProvider);
                  setProviderForm(EMPTY_PROVIDER_FORM);
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PROVIDERS.map((candidate) => (
                  <option key={candidate.value} value={candidate.value}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </div>

            {provider === "pagerduty" ? (
              <Field label="Routing key" htmlFor="aa-pagerduty-routing-key">
                <Input
                  id="aa-pagerduty-routing-key"
                  type="password"
                  autoComplete="off"
                  minLength={8}
                  spellCheck={false}
                  value={providerForm.routingKey}
                  disabled={controlsDisabled}
                  onChange={(event) =>
                    setProviderForm((current) => ({
                      ...current,
                      routingKey: event.target.value,
                    }))
                  }
                  placeholder="Paste the PagerDuty routing key"
                  required
                />
              </Field>
            ) : provider === "jira" ? (
              <>
                <Field label="Jira site URL" htmlFor="aa-jira-url">
                  <Input
                    id="aa-jira-url"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    pattern="https://.*"
                    value={providerForm.jiraSiteUrl}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setProviderForm((current) => ({
                        ...current,
                        jiraSiteUrl: event.target.value,
                      }))
                    }
                    placeholder="https://workspace.atlassian.net"
                    required
                  />
                </Field>
                <Field label="Jira account email" htmlFor="aa-jira-email">
                  <Input
                    id="aa-jira-email"
                    type="email"
                    autoComplete="username"
                    value={providerForm.jiraEmail}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setProviderForm((current) => ({
                        ...current,
                        jiraEmail: event.target.value,
                      }))
                    }
                    required
                  />
                </Field>
                <Field label="Jira API token" htmlFor="aa-jira-api-token">
                  <Input
                    id="aa-jira-api-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={providerForm.jiraToken}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setProviderForm((current) => ({
                        ...current,
                        jiraToken: event.target.value,
                      }))
                    }
                    required
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label="ServiceNow instance URL"
                  htmlFor="aa-servicenow-url"
                >
                  <Input
                    id="aa-servicenow-url"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    pattern="https://.*"
                    value={providerForm.serviceNowUrl}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setProviderForm((current) => ({
                        ...current,
                        serviceNowUrl: event.target.value,
                      }))
                    }
                    placeholder="https://instance.service-now.com"
                    required
                  />
                </Field>
                <Field label="Authentication method" htmlFor="aa-sn-mode">
                  <select
                    id="aa-sn-mode"
                    value={providerForm.serviceNowMode}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      setProviderForm((current) => ({
                        ...EMPTY_PROVIDER_FORM,
                        serviceNowUrl: current.serviceNowUrl,
                        serviceNowMode: event.target.value as ServiceNowMode,
                      }))
                    }
                    className="w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="bearer">Bearer token</option>
                    <option value="basic">Username and password</option>
                  </select>
                </Field>
                {providerForm.serviceNowMode === "bearer" ? (
                  <Field
                    label="Bearer token"
                    htmlFor="aa-servicenow-bearer-token"
                  >
                    <Input
                      id="aa-servicenow-bearer-token"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={providerForm.serviceNowBearer}
                      disabled={controlsDisabled}
                      onChange={(event) =>
                        setProviderForm((current) => ({
                          ...current,
                          serviceNowBearer: event.target.value,
                        }))
                      }
                      required
                    />
                  </Field>
                ) : (
                  <>
                    <Field label="Username" htmlFor="aa-sn-username">
                      <Input
                        id="aa-sn-username"
                        autoComplete="username"
                        value={providerForm.serviceNowUsername}
                        disabled={controlsDisabled}
                        onChange={(event) =>
                          setProviderForm((current) => ({
                            ...current,
                            serviceNowUsername: event.target.value,
                          }))
                        }
                        required
                      />
                    </Field>
                    <Field label="Password" htmlFor="aa-servicenow-password">
                      <Input
                        id="aa-servicenow-password"
                        type="password"
                        autoComplete="off"
                        value={providerForm.serviceNowPassword}
                        disabled={controlsDisabled}
                        onChange={(event) =>
                          setProviderForm((current) => ({
                            ...current,
                            serviceNowPassword: event.target.value,
                          }))
                        }
                        required
                      />
                    </Field>
                  </>
                )}
              </>
            )}

            <p className="text-xs leading-5 text-muted-foreground">
              Values are sent once to the selected provider verification
              endpoint. They are not saved to an alert rule or retained by this
              screen.
            </p>
            <Button
              type="submit"
              className="w-full sm:w-auto"
              loading={busy === `Verify ${providerLabel}`}
              disabled={controlsDisabled || !providerReady}
            >
              Verify {providerLabel}
            </Button>
          </form>
        </OperationsSection>

        <OperationsSection
          id="stream-token"
          title="Stream token"
          description="Mint a short-lived bearer credential for the event stream. Its payload is decodable, so treat the entire value like a password."
        >
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            loading={busy === "Mint stream token"}
            disabled={controlsDisabled || token !== null}
            onClick={() =>
              void run("Mint stream token", async (signal) => {
                const minted = await mintStreamToken({
                  signal,
                  requireOnline: true,
                  maxAttempts: 1,
                });
                setToken(minted);
                record(
                  "Mint stream token",
                  `A short-lived token was minted for ${formatDuration(minted.ttlSeconds)}. Copy it before hiding or leaving this page.`,
                  "warning",
                );
              })
            }
          >
            <KeyRound aria-hidden />
            Mint token
          </Button>
          {token ? (
            <SecretReveal
              title="Copy now — this stream token will not be shown again"
              label="Stream token"
              value={token.token}
              metadata={
                <>
                  Expires {formatWireTimestamp(token.expiresAt, "soon")} ·{" "}
                  {formatDuration(token.ttlSeconds)} lifetime
                </>
              }
              copying={busy === "Copy stream token"}
              onCopy={() =>
                void run(
                  "Copy stream token",
                  async () => {
                    await copyValue(token.token);
                    record(
                      "Copy stream token",
                      "Token copied to the clipboard.",
                    );
                  },
                  { verifyAuthority: false },
                )
              }
              onHide={() => setToken(null)}
            />
          ) : null}
        </OperationsSection>
      </div>

      <OperationsSection
        id="rotate-inbound"
        title="Rotate inbound signing secret"
        description="The inbound endpoint slug stays the same. Rotation immediately invalidates signatures made with the previous secret, and the replacement plaintext is revealed exactly once."
        className="border-destructive/30"
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="aa-confirm">
              Type <span className="font-mono font-semibold">rotate</span> to
              confirm
            </Label>
            <Input
              id="aa-confirm"
              autoComplete="off"
              spellCheck={false}
              value={confirmRotate}
              disabled={controlsDisabled || rotatedEndpoint !== null}
              onChange={(event) => setConfirmRotate(event.target.value)}
              className="max-w-sm"
            />
          </div>
          <Button
            type="button"
            variant="destructive"
            className="w-full lg:w-auto"
            loading={busy === "Rotate signing secret"}
            disabled={
              controlsDisabled ||
              rotatedEndpoint !== null ||
              confirmRotate.trim() !== "rotate"
            }
            onClick={() =>
              void run("Rotate signing secret", async (signal) => {
                const rotated = await rotateInboundEndpoint({
                  signal,
                  requireOnline: true,
                  maxAttempts: 1,
                });
                setConfirmRotate("");
                setRotatedEndpoint(rotated);
                record(
                  "Rotate signing secret",
                  `Signing secret rotated for endpoint slug “${rotated.slug}”. The address did not change; update every signature producer before hiding the new secret.`,
                  "warning",
                );
              })
            }
          >
            <RotateCw aria-hidden />
            Rotate signing secret
          </Button>
        </div>
        {rotatedEndpoint ? (
          <SecretReveal
            title="Copy now — this signing secret cannot be retrieved later"
            label="Inbound signing secret"
            value={rotatedEndpoint.secret}
            metadata={
              <>
                Endpoint slug: <bdi>{rotatedEndpoint.slug}</bdi>
                {rotatedEndpoint.secretRotatedAt
                  ? ` · Rotated ${formatWireTimestamp(
                      rotatedEndpoint.secretRotatedAt,
                      "just now",
                    )}`
                  : ""}
              </>
            }
            copying={busy === "Copy signing secret"}
            onCopy={() =>
              void run(
                "Copy signing secret",
                async () => {
                  await copyValue(rotatedEndpoint.secret);
                  record(
                    "Copy signing secret",
                    "Signing secret copied to the clipboard.",
                  );
                },
                { verifyAuthority: false },
              )
            }
            onHide={() => setRotatedEndpoint(null)}
            hideConfirm={{
              title: "Hide the new signing secret?",
              description:
                "This plaintext is not stored anywhere and cannot be shown again. Rotation already invalidated the previous secret, so every signature producer you have not updated yet will keep failing, and the only way to get a usable secret back is another rotation — which invalidates this one too.",
            }}
          />
        ) : null}
      </OperationsSection>

      <OperationsSection
        id="archive-domain"
        title="Archive-domain legacy evidence"
        description="This authenticated read shows the last stored DNS and certificate evidence only. It does not assert current routing or availability."
      >
        {!canWrite ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Domain evidence remains hidden until owner or admin access is
              verified.
            </p>
          </div>
        ) : archiveQuery.isPending ? (
          <OperationsLoading label="Loading archive-domain status" rows={2} />
        ) : archiveQuery.isError || !archiveQuery.data ? (
          <OperationsFailure
            title="Archive-domain status could not be loaded"
            description={errorMessage(archiveQuery.error)}
            onRetry={() => void archiveQuery.refetch()}
            retrying={archiveQuery.isFetching}
          />
        ) : (
          <ArchiveDomainPanel domain={archiveQuery.data} />
        )}
      </OperationsSection>

      <AuditAlertRulesPanel
        tenantId={tenantId}
        userId={meQuery.data?.user_id ?? ""}
        role={effectiveRole}
        identityReady={meQuery.isSuccess}
      />

      <OperationsSection
        id="alerting-results"
        title="Session results"
        description="Only actions taken in this browser session appear here. Credential, token, and signing-secret values are deliberately never written to this history."
        aside={
          results.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canWrite || busy !== null}
              onClick={() => setResults([])}
            >
              Clear
            </Button>
          ) : null
        }
      >
        <div aria-live="polite" aria-busy={busy !== null}>
          {results.length === 0 ? (
            <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No action has run in this session.
            </div>
          ) : (
            <ol className="space-y-2">
              {results.map((result) => {
                const Icon =
                  result.tone === "success" ? CheckCircle2 : AlertTriangle;
                return (
                  <li
                    key={result.id}
                    className={`flex min-w-0 gap-3 rounded-lg border p-3 text-sm ${
                      result.tone === "error"
                        ? "border-destructive/30 bg-destructive/5 text-destructive-emphasis"
                        : result.tone === "warning"
                          ? "border-warning/40 bg-warning-subtle text-warning-emphasis"
                          : "border-success/30 bg-success/10"
                    }`}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <div className="min-w-0">
                      <p className="font-medium">{result.label}</p>
                      <p className="mt-0.5 break-words opacity-90">
                        {result.text}
                      </p>
                      <time
                        className="mt-1 block text-xs opacity-70"
                        dateTime={result.at}
                      >
                        {new Date(result.at).toLocaleTimeString()}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </OperationsSection>
    </OperationsShell>
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

function AuditAlertRulesLoading() {
  return (
    <OperationsSection
      id="audit-alert-rules-loading"
      title="Audit alert rules"
      description="Loading the secondary audit-alert controls."
    >
      <div
        className="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
        role="status"
        aria-label="Loading audit alert rules"
      />
    </OperationsSection>
  );
}

function SecretReveal({
  title,
  label,
  value,
  metadata,
  copying,
  onCopy,
  onHide,
  hideConfirm,
}: {
  title: string;
  label: string;
  value: string;
  metadata: ReactNode;
  copying: boolean;
  onCopy: () => void;
  onHide: () => void;
  /**
   * Set where the revealed plaintext is genuinely unrecoverable. Hide sits a
   * thumb's width from Copy, so a mis-tap must not be the last thing that ever
   * happens to a secret whose predecessor is already dead server-side. Omit it
   * for values that can simply be issued again.
   */
  hideConfirm?: { title: string; description: ReactNode };
}) {
  return (
    <div className="mt-4 min-w-0 rounded-lg border border-warning/40 bg-warning-subtle p-3">
      <p className="text-sm font-medium text-warning-emphasis">{title}</p>
      <p className="mt-1 break-words text-xs text-warning-emphasis/90">
        {metadata}
      </p>
      <code
        tabIndex={0}
        aria-label={label}
        className="mt-2 block max-w-full whitespace-pre-wrap break-all rounded-md bg-background p-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value}
      </code>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
        <Button type="button" size="sm" loading={copying} onClick={onCopy}>
          <Copy aria-hidden />
          Copy
        </Button>
        {hideConfirm ? (
          <ConfirmDialog
            title={hideConfirm.title}
            description={hideConfirm.description}
            confirmLabel="Hide it"
            cancelLabel="Keep it visible"
            trigger={
              <Button type="button" size="sm" variant="ghost">
                Hide
              </Button>
            }
            onConfirm={onHide}
          />
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={onHide}>
            Hide
          </Button>
        )}
      </div>
    </div>
  );
}

function ArchiveDomainPanel({ domain }: { domain: ArchiveDomain }) {
  if (domainNotRequested(domain)) {
    return (
      <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
        No legacy custom archive-domain ownership record is configured.
        Registration remains release-held.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <DomainFact label="Domain" value={domain.domain} />
        <DomainFact
          label="CNAME target"
          value={domain.cname_target || "Not returned"}
        />
        <div>
          <dt className="text-xs text-muted-foreground">DNS verification</dt>
          <dd className="mt-1">
            <Badge variant={archiveStatusVariant(domain.status)}>
              {domain.status || "unknown"}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Managed certificate</dt>
          <dd className="mt-1">
            <Badge variant={archiveStatusVariant(domain.ssl_status)}>
              {domain.ssl_status || "unknown"}
            </Badge>
          </dd>
        </div>
        {domain.last_checked_at ? (
          <DomainFact
            label="Last DNS check"
            value={formatWireTimestamp(domain.last_checked_at, "unknown")}
          />
        ) : null}
        {domain.verified_at ? (
          <DomainFact
            label="First verified"
            value={formatWireTimestamp(domain.verified_at, "unknown")}
          />
        ) : null}
      </dl>
      {domain.last_error ? (
        <Alert variant="destructive">
          <AlertTitle>Latest DNS check failed</AlertTitle>
          <AlertDescription className="break-words">
            {domain.last_error}
          </AlertDescription>
        </Alert>
      ) : null}
      {domain.ssl_last_error ? (
        <Alert variant="destructive">
          <AlertTitle>Latest certificate check failed</AlertTitle>
          <AlertDescription className="break-words">
            {domain.ssl_last_error}
          </AlertDescription>
        </Alert>
      ) : null}
      <Alert>
        <AlertTitle>DNS re-check is release-held</AlertTitle>
        <AlertDescription>
          {CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE}
        </AlertDescription>
      </Alert>
    </div>
  );
}

function DomainFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all font-medium">{value}</dd>
    </div>
  );
}

function providerFormReady(
  provider: AlertProvider,
  form: ProviderForm,
): boolean {
  if (provider === "pagerduty") return form.routingKey.trim().length >= 8;
  if (provider === "jira") {
    return Boolean(
      form.jiraSiteUrl.trim() && form.jiraEmail.trim() && form.jiraToken.trim(),
    );
  }
  return Boolean(
    form.serviceNowUrl.trim() &&
    (form.serviceNowMode === "bearer"
      ? form.serviceNowBearer.trim()
      : form.serviceNowUsername.trim() && form.serviceNowPassword),
  );
}

function archiveStatusVariant(
  status: string,
): "success" | "destructive" | "warning" | "secondary" {
  if (status === "verified" || status === "issued") return "success";
  if (status === "failed") return "destructive";
  if (status === "pending" || status === "issuing") return "warning";
  return "secondary";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds % 3600 === 0)
    return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

async function copyValue(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error(
      "Clipboard access is unavailable. Select and copy the value manually.",
    );
  }
  await navigator.clipboard.writeText(value);
}
