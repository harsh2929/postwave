// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Globe, ShieldCheck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { CopyTextButton } from "@/components/copy-text-button";
import { DomainFilterBar } from "@/components/settings/DomainFilterBar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  CUSTOM_DOMAIN_AUTOMATED_TLS_AVAILABLE,
  CUSTOM_DOMAIN_DEPENDENCY_INVENTORY_AVAILABLE,
  CUSTOM_DOMAIN_PRODUCTION_ROUTING_AVAILABLE,
  CUSTOM_DOMAIN_REGISTRATION_AVAILABLE,
  CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE,
} from "@/lib/custom-domain-operational-availability";
import {
  createCustomDomain,
  getCustomDomainEvidence,
  listCustomDomains,
  type CustomDomain,
  type CustomDomainPurpose,
} from "@/lib/custom-domains-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

const PURPOSE_LABELS: Record<CustomDomainPurpose, string> = {
  forms: "Hosted forms",
  links: "Short links",
  web: "Public archive / site",
  tracking: "Open tracking",
};
const PURPOSES = Object.keys(PURPOSE_LABELS) as CustomDomainPurpose[];

// Desktop parity deliverability-2 (apps/desktop/src/pages/CustomDomains.tsx
// "Register hostname"): the same title desktop attaches to its disabled
// header action, attached here to the disabled submit and its description.
const REGISTRATION_HELD_REASON =
  "Registration is held until automated TLS issuance, dependency inventory, and a production traffic-routing path are qualified.";
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export default function DomainSettingsPage() {
  const queryClient = useQueryClient();
  const [reviewedDomainId, setReviewedDomainId] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [purpose, setPurpose] = useState<CustomDomainPurpose>("forms");
  const [registering, setRegistering] = useState(false);
  const registerReasonId = useId();
  const hostnameId = useId();
  const purposeId = useId();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.data ?? null;
  const tenantId = identity?.tenant_id ?? "identity-pending";
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [, userId, , viewerState] = adminReadIdentityParts(identity);
  const protectedBaseKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "custom-domain-legacy"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const domainsKey = useMemo(
    () => [...protectedBaseKey, "registry"] as const,
    [protectedBaseKey],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);
  const domainsQuery = useQuery({
    queryKey: domainsKey,
    queryFn: ({ signal }) =>
      listCustomDomains({
        signal,
        expectedTenantId: tenantId,
        minimizeDNSEvidence: true,
      }),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
    retry: false,
  });
  const domains = Array.isArray(domainsQuery.data) ? domainsQuery.data : [];
  const hasReviewTarget =
    canAdmin &&
    domainsQuery.isSuccess &&
    reviewedDomainId !== null &&
    domains.some((domain) => domain.id === reviewedDomainId);
  const evidenceKey = [
    ...protectedBaseKey,
    "evidence",
    reviewedDomainId ?? "none",
  ] as const;
  const evidenceQuery = useQuery({
    queryKey: evidenceKey,
    queryFn: ({ signal }) =>
      getCustomDomainEvidence({
        id: reviewedDomainId ?? "",
        expectedTenantId: tenantId,
        signal,
      }),
    enabled: meQuery.isSuccess && canAdmin && hasReviewTarget,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const registrationHeld = !CUSTOM_DOMAIN_REGISTRATION_AVAILABLE;
  const registerDisabledReason = registrationHeld
    ? REGISTRATION_HELD_REASON
    : !canAdmin
      ? ADMIN_READ_ONLY_MESSAGE
      : undefined;
  const canRegister =
    !registrationHeld && canAdmin && !registering && hostname.trim() !== "";

  async function registerHostname() {
    if (!canRegister) return;
    const domain = hostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(domain)) {
      toast.error("Enter a fully qualified hostname such as mail.example.com.");
      return;
    }
    setRegistering(true);
    try {
      await createCustomDomain({ domain, purpose });
      toast.success(`Registered ${domain}`);
      setHostname("");
      await queryClient.invalidateQueries({ queryKey: domainsKey });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Hostname registration failed"));
    } finally {
      setRegistering(false);
    }
  }

  const toggleEvidence = (id: string) => {
    if (!canAdmin) return;
    if (reviewedDomainId) {
      const previousKey = [...protectedBaseKey, "evidence", reviewedDomainId];
      void queryClient
        .cancelQueries({ queryKey: previousKey, exact: true })
        .then(() =>
          queryClient.removeQueries({ queryKey: previousKey, exact: true }),
        );
    }
    setReviewedDomainId((current) => (current === id ? null : id));
  };

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== protectedBaseKey) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
      setReviewedDomainId(null);
    }
    previousKeyRef.current = protectedBaseKey;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    setReviewedDomainId(null);
    void queryClient.cancelQueries({ queryKey: protectedBaseKey });
    queryClient.removeQueries({ queryKey: protectedBaseKey });
  }, [
    canAdmin,
    meQuery.isPending,
    meQuery.isSuccess,
    protectedBaseKey,
    queryClient,
  ]);

  return (
    <div className="max-w-4xl space-y-6">
      <Card className="border-warning/40 bg-warning-subtle/30">
        <CardHeader>
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-warning-emphasis"
              aria-hidden
            />
            <div>
              <CardTitle>Custom-domain operations are release-held</CardTitle>
              <CardDescription className="mt-1 leading-6">
                {CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <ReadinessFact
              label="Automated TLS"
              qualified={CUSTOM_DOMAIN_AUTOMATED_TLS_AVAILABLE}
            />
            <ReadinessFact
              label="Dependency inventory"
              qualified={CUSTOM_DOMAIN_DEPENDENCY_INVENTORY_AVAILABLE}
            />
            <ReadinessFact
              label="Production routing"
              qualified={CUSTOM_DOMAIN_PRODUCTION_ROUTING_AVAILABLE}
            />
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            Registration, DNS re-check, replacement, and removal controls are
            intentionally unavailable. Existing rows below are a read-only
            legacy ownership registry; they do not promise certificate coverage,
            traffic routing, activation, or current DNS health.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Register hostname</CardTitle>
          <CardDescription>
            Add a customer-facing hostname to the ownership registry. A
            successful DNS check confirms control of a hostname; it does not
            mean Moosewave has a certificate for it or serves product traffic
            through it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            aria-label="Register hostname"
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void registerHostname();
            }}
          >
            <div>
              <Label htmlFor={hostnameId}>Hostname</Label>
              <Input
                id={hostnameId}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="mail.example.com"
                maxLength={253}
                value={hostname}
                disabled={registrationHeld || registering}
                onChange={(event) => setHostname(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={purposeId}>Purpose</Label>
              <Select
                id={purposeId}
                value={purpose}
                disabled={registrationHeld || registering}
                onChange={(event) =>
                  setPurpose(event.target.value as CustomDomainPurpose)
                }
              >
                {PURPOSES.map((key) => (
                  <option key={key} value={key}>
                    {PURPOSE_LABELS[key]}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="submit"
              disabled={!canRegister}
              title={registerDisabledReason}
              aria-describedby={
                registerDisabledReason ? registerReasonId : undefined
              }
            >
              {registering ? "Registering…" : "Register hostname"}
            </Button>
          </form>
          {registerDisabledReason ? (
            <p
              id={registerReasonId}
              role="status"
              className="mt-3 text-xs leading-5 text-muted-foreground"
            >
              {registerDisabledReason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="rounded-md border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
        Looking for SPF, DKIM, or DMARC deliverability settings? Those are
        sending identities and remain available on the{" "}
        <Link
          href={asRoute("/app/settings/sender")}
          className="font-medium text-foreground underline underline-offset-2"
        >
          Sender Identity
        </Link>{" "}
        tab. They are separate from this held customer-host routing surface.
      </div>

      <section className="space-y-3" aria-labelledby="legacy-domain-registry">
        <div>
          <h2 id="legacy-domain-registry" className="text-sm font-semibold">
            Legacy ownership registry
          </h2>
          <p className="text-xs text-muted-foreground">
            Authenticated workspace evidence only. Review a row explicitly
            before its DNS token and target are revealed.
          </p>
        </div>

        {meQuery.isPending ? (
          <LoadingRegistry label="Checking workspace access" />
        ) : meQuery.isError ? (
          <LoadFailure
            title="Workspace access could not be verified"
            description="The ownership registry was not requested."
            retrying={meQuery.isFetching}
            onRetry={() => void meQuery.refetch()}
          />
        ) : !canAdmin ? (
          <div className="rounded-md border bg-muted/20 p-4">
            <p className="text-sm font-medium">
              Owner or admin access required
            </p>
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              {ADMIN_READ_ONLY_MESSAGE} No custom-domain ownership or DNS
              evidence was fetched.
            </p>
          </div>
        ) : domainsQuery.isPending ? (
          <LoadingRegistry label="Loading ownership registry" />
        ) : domainsQuery.isError ? (
          <LoadFailure
            title="Ownership registry could not be loaded"
            description={
              domainsQuery.error instanceof Error
                ? domainsQuery.error.message
                : "The registry is unavailable; this is not an empty result."
            }
            retrying={domainsQuery.isFetching}
            onRetry={() => void domainsQuery.refetch()}
          />
        ) : domains.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Globe}
              title="No legacy ownership records"
              description="The authenticated registry returned no custom-domain ownership evidence. Registration remains release-held."
            />
          </div>
        ) : (
          <DomainFilterBar domains={domains}>
            {(visibleDomains) => (
              <div className="grid gap-4 md:grid-cols-2">
                {visibleDomains.map((domain) => (
                  <Card key={domain.id}>
                    <CardHeader className="pb-3">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="break-all font-mono text-base">
                            {domain.domain}
                          </CardTitle>
                          <CardDescription>
                            {PURPOSE_LABELS[domain.purpose]} · stored{" "}
                            {new Date(domain.createdAt).toLocaleDateString()}
                          </CardDescription>
                        </div>
                        <Badge
                          variant={domain.verified ? "success" : "secondary"}
                        >
                          {domain.verified
                            ? "Stored check passed"
                            : "No stored pass"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs leading-5 text-muted-foreground">
                        This historical check is ownership evidence only; it
                        does not assert live DNS, TLS, or routing readiness.
                      </p>
                      {canAdmin ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={reviewedDomainId === domain.id}
                          aria-controls={
                            reviewedDomainId === domain.id
                              ? "legacy-domain-evidence"
                              : undefined
                          }
                          onClick={() => toggleEvidence(domain.id)}
                        >
                          <ShieldCheck aria-hidden />
                          {reviewedDomainId === domain.id
                            ? "Hide ownership evidence"
                            : "Review ownership evidence"}
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Owner or administrator access is required to reveal
                          stored DNS tokens and targets.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </DomainFilterBar>
        )}
      </section>

      {hasReviewTarget ? (
        evidenceQuery.isPending ? (
          <LoadingRegistry label="Loading reviewed ownership evidence" />
        ) : evidenceQuery.isError || !evidenceQuery.data ? (
          <LoadFailure
            title="Ownership evidence could not be loaded"
            description={
              evidenceQuery.error instanceof Error
                ? evidenceQuery.error.message
                : "No ownership evidence was returned."
            }
            retrying={evidenceQuery.isFetching}
            onRetry={() => void evidenceQuery.refetch()}
          />
        ) : (
          <OwnershipEvidenceCard domain={evidenceQuery.data} />
        )
      ) : null}
    </div>
  );
}

function ReadinessFact({
  label,
  qualified,
}: {
  label: string;
  qualified: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/70 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">
        {qualified ? "Qualified" : "Not yet qualified"}
      </dd>
    </div>
  );
}

function LoadingRegistry({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      role="status"
      className="grid gap-4 md:grid-cols-2"
    >
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function LoadFailure({
  title,
  description,
  retrying,
  onRetry,
}: {
  title: string;
  description: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{description}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function OwnershipEvidenceCard({ domain }: { domain: CustomDomain }) {
  return (
    <Card id="legacy-domain-evidence">
      <CardHeader>
        <CardTitle>Stored ownership evidence for {domain.domain}</CardTitle>
        <CardDescription>
          Read-only values from the authenticated legacy registry. Copying a
          value does not initiate verification or activate hosting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {domain.dns_records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This row contains no stored DNS evidence.
          </p>
        ) : (
          <div
            role="region"
            aria-label={`Stored DNS ownership evidence for ${domain.domain}`}
            tabIndex={0}
            className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[42rem] text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Stored value
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Last stored check
                  </th>
                </tr>
              </thead>
              <tbody>
                {domain.dns_records.map((record) => (
                  <tr
                    key={`${record.type}:${record.name}`}
                    className="border-t"
                  >
                    <td className="px-3 py-2 align-top font-mono">
                      {record.type}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <EvidenceValue
                        value={record.name}
                        label={`Copy ${record.type} record name`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <EvidenceValue
                        value={record.value}
                        label={`Copy ${record.type} stored value`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge
                        variant={record.verified ? "success" : "secondary"}
                      >
                        {record.verified ? "Passed" : "Not passed"}
                      </Badge>
                      {record.error ? (
                        <p className="mt-1 max-w-sm break-words text-muted-foreground">
                          Stored result: {record.error}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EvidenceValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="break-all font-mono">{value}</span>
      <CopyTextButton
        value={value}
        label={label}
        copiedLabel="Copied"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0"
        toastOnCopy={false}
      />
    </div>
  );
}
