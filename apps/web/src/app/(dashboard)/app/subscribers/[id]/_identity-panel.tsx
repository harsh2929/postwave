// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getEmailHealthBatch, type EmailHealth } from "@/lib/email-health-api";
import {
  createSubscriberAccount,
  createSubscriberFederationLink,
  deleteSubscriberFederationLink,
  getSubscriberCatalogAttributes,
  listSubscriberAccounts,
  listSubscriberFederationLinks,
  setSubscriberAccountLink,
  type FederationMatchType,
  type SubscriberAccount,
  type SubscriberCatalogAttributes,
  type SubscriberFederationLink,
} from "@/lib/subscriber-associations-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  addSubscriberAlias,
  addSubscriberEmail,
  deleteSubscriberAlias,
  deleteSubscriberEmail,
  getSubscriberLifecycle,
  listSubscriberAliases,
  listSubscriberEmails,
  listSubscriberTraits,
  setSubscriberEmailSuppression,
  SUBSCRIBER_LIFECYCLE_STAGES,
  updateSubscriberEmailConsent,
  updateSubscriberLifecycle,
  type EditableSubscriberAliasType,
  type SubscriberComputedTrait,
  type SubscriberEmailAddress,
  type SubscriberLifecycleStage,
} from "@/lib/subscriber-identity-api";
import type { Subscriber } from "@/lib/subscribers-api";
import { absoluteTime, timeAgo } from "@/lib/relative-time";

type WriteContext = { signal: AbortSignal; idempotencyKey: string };

class AccountCreatedButNotLinkedError extends Error {
  constructor() {
    super(
      "The account was created, but the subscriber link was not confirmed. The account directory was reloaded so you can safely retry the link.",
    );
    this.name = "AccountCreatedButNotLinkedError";
  }
}

const aliasTypes: Array<{
  value: EditableSubscriberAliasType;
  label: string;
}> = [
  { value: "external_id", label: "External ID" },
  { value: "anonymous_id", label: "Anonymous ID" },
  { value: "device_token", label: "Device token" },
  { value: "push_token", label: "Push token" },
  { value: "custom", label: "Custom identity" },
];

function mutationIdentity(): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `subscriber-profile:${suffix}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AccountCreatedButNotLinkedError) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    (Number((error as { status?: unknown }).status) === 409 ||
      Number((error as { status?: unknown }).status) === 412 ||
      Number((error as { status?: unknown }).status) === 428)
  ) {
    return "This profile changed while you were reviewing it. Reload the latest profile and try again.";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The request was cancelled because the profile changed.";
  }
  return "The change could not be confirmed. Reload before trying again.";
}

function versionOrder(value: string | undefined): bigint {
  const match = /:v([0-9]+)"$/u.exec(value ?? "");
  try {
    return BigInt(match?.[1] ?? "0");
  } catch {
    return 0n;
  }
}

function latestVersion(values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>(
    (best, candidate) =>
      versionOrder(candidate) > versionOrder(best) ? candidate : best,
    undefined,
  );
}

function traitValue(trait: SubscriberComputedTrait): string {
  if (typeof trait.value === "string") return trait.value;
  try {
    const encoded = JSON.stringify(trait.value);
    return encoded.length > 300 ? `${encoded.slice(0, 300)}…` : encoded;
  } catch {
    return "Unavailable";
  }
}

export function SubscriberIdentityPanel({
  enabled,
  id,
  subscriber,
  tenantId,
  role,
  authority,
  onAggregateChanged,
}: {
  enabled: boolean;
  id: string;
  subscriber: Subscriber;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  onAggregateChanged: () => void | Promise<void>;
}) {
  const addressesHeadingId = useId();
  const aliasesHeadingId = useId();
  const traitsHeadingId = useId();
  const identityKey = [
    "subscriber-identity-profile",
    tenantId,
    role ?? "viewer",
    id,
  ] as const;
  const aliases = useQuery({
    queryKey: [...identityKey, "aliases"],
    queryFn: ({ signal }) => listSubscriberAliases(id, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const emails = useQuery({
    queryKey: [...identityKey, "emails"],
    queryFn: ({ signal }) => listSubscriberEmails(id, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const lifecycle = useQuery({
    queryKey: [...identityKey, "lifecycle"],
    queryFn: ({ signal }) => getSubscriberLifecycle(id, tenantId, signal),
    enabled: enabled && tenantId !== "anon",
    staleTime: 30_000,
    retry: false,
  });
  const traits = useQuery({
    queryKey: [...identityKey, "traits"],
    queryFn: ({ signal }) => listSubscriberTraits(id, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const accounts = useQuery({
    queryKey: [...identityKey, "accounts"],
    queryFn: ({ signal }) => listSubscriberAccounts(tenantId, signal),
    enabled: enabled && tenantId !== "anon",
    staleTime: 30_000,
    retry: false,
  });
  const catalog = useQuery({
    queryKey: [...identityKey, "catalog-attributes"],
    queryFn: ({ signal }) => getSubscriberCatalogAttributes(id, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const federation = useQuery({
    queryKey: [...identityKey, "federated-links"],
    queryFn: ({ signal }) => listSubscriberFederationLinks(id, signal),
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const emailItems = Array.isArray(emails.data) ? emails.data : [];
  const aliasItems = Array.isArray(aliases.data?.items)
    ? aliases.data.items
    : [];
  const traitItems = Array.isArray(traits.data) ? traits.data : [];
  const accountItems = Array.isArray(accounts.data) ? accounts.data : [];
  const federationItems = Array.isArray(federation.data?.items)
    ? federation.data.items
    : [];

  const emailRevisionKey = emailItems
    .map((address) => `${address.id}:${address.version}`)
    .join("|");
  const health = useQuery({
    queryKey: [...identityKey, "email-health", emailRevisionKey],
    queryFn: ({ signal }) =>
      getEmailHealthBatch(
        emailItems.map((item) => item.email),
        signal,
      ),
    enabled: enabled && emailItems.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const healthByEmail = useMemo(() => {
    const healthItems = Array.isArray(health.data?.results)
      ? health.data.results
      : [];
    return new Map(healthItems.map((item) => [item.email, item] as const));
  }, [health.data]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setBusy(null);
    setError(null);
  }, [id, authority?.tenantId, authority?.userId, authority?.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const refresh = async () => {
    await Promise.allSettled([
      aliases.refetch(),
      emails.refetch(),
      lifecycle.refetch(),
      traits.refetch(),
      accounts.refetch(),
      catalog.refetch(),
      federation.refetch(),
      onAggregateChanged(),
    ]);
  };

  const runWrite = async <T,>(
    label: string,
    success: string,
    operation: (context: WriteContext) => Promise<T>,
  ): Promise<boolean> => {
    if (!authority || busyRef.current) return false;
    busyRef.current = true;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(label);
    setError(null);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority);
      await operation({
        signal: controller.signal,
        idempotencyKey: mutationIdentity(),
      });
      committed = true;
      await reauthorizeSubscriberMutation(authority);
      if (generation !== generationRef.current) return false;
      await refresh();
      toast.success(success);
      return true;
    } catch (writeError) {
      if (generation !== generationRef.current) return false;
      if (writeError instanceof AccountCreatedButNotLinkedError) {
        await refresh();
      }
      if (committed) {
        await refresh();
        const message =
          "The change saved, but your workspace access changed afterward. The profile was reloaded.";
        setError(message);
        toast.info(message);
        return true;
      }
      const message = safeErrorMessage(writeError);
      setError(message);
      toast.error(message);
      return false;
    } finally {
      if (generation === generationRef.current) {
        busyRef.current = false;
        abortRef.current = null;
        setBusy(null);
      }
    }
  };

  const parentVersion = latestVersion([
    aliases.data?.subscriber_version,
    lifecycle.data?.subscriber_version,
    federation.data?.subscriber_version,
    subscriber.version,
  ]);

  const loading =
    aliases.isPending ||
    emails.isPending ||
    traits.isPending ||
    lifecycle.isPending;
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6" aria-busy={busy !== null}>
      {!authority ? (
        <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          You can review identity and consent state. Editing requires an editor
          role or higher and is unavailable while viewing as another role.
        </p>
      ) : null}
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}

      <ProfileIdentitySummary subscriber={subscriber} />

      <SubscriberAccountSection
        key={`account-${id}`}
        accounts={accountItems}
        loading={accounts.isPending}
        error={Boolean(accounts.error)}
        accountId={subscriber.account_id ?? null}
        disabled={busy !== null}
        canMutate={Boolean(authority && parentVersion)}
        onRetry={() => void accounts.refetch()}
        onLink={(accountId) => {
          if (!parentVersion) return Promise.resolve(false);
          return runWrite("account-link", "Account link updated.", (context) =>
            setSubscriberAccountLink(id, accountId, parentVersion, context),
          );
        }}
        onCreateAndLink={(name, industry) => {
          if (!parentVersion || !authority) return Promise.resolve(false);
          return runWrite(
            "account-create-link",
            "Account created and linked.",
            async (context) => {
              const created = await createSubscriberAccount(
                tenantId,
                { name, industry },
                {
                  ...context,
                  idempotencyKey: `${context.idempotencyKey}:account`,
                },
              );
              try {
                await reauthorizeSubscriberMutation(authority);
                await setSubscriberAccountLink(id, created.id, parentVersion, {
                  ...context,
                  idempotencyKey: `${context.idempotencyKey}:link`,
                });
              } catch {
                throw new AccountCreatedButNotLinkedError();
              }
            },
          );
        }}
      />

      <CatalogAttributesSection
        data={catalog.data}
        loading={catalog.isPending}
        error={Boolean(catalog.error)}
        onRetry={() => void catalog.refetch()}
      />

      <FederatedIdentitySection
        key={`federation-${id}`}
        links={federationItems}
        version={federation.data?.subscriber_version}
        loading={federation.isPending}
        error={Boolean(federation.error)}
        disabled={busy !== null}
        canMutate={Boolean(authority)}
        onRetry={() => void federation.refetch()}
        onAdd={(input) => {
          const version = federation.data?.subscriber_version;
          if (!version) return Promise.resolve(false);
          return runWrite(
            "federation-add",
            "Federated identity linked.",
            (context) =>
              createSubscriberFederationLink(id, input, version, context),
          );
        }}
        onDelete={(masterSubscriberId) => {
          const version = federation.data?.subscriber_version;
          if (!version) return Promise.resolve(false);
          return runWrite(
            `federation-delete:${masterSubscriberId}`,
            "Federated identity unlinked.",
            (context) =>
              deleteSubscriberFederationLink(
                id,
                masterSubscriberId,
                version,
                context,
              ),
          );
        }}
      />

      <section aria-labelledby={addressesHeadingId} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id={addressesHeadingId} className="text-sm font-medium">
              Email identities
            </h3>
            <p className="text-xs text-muted-foreground">
              Consent, suppression, engagement, and health are tracked per
              address.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {emailItems.length} / 5 addresses
          </span>
        </div>
        {emails.error ? (
          <PanelReadError
            label="email identities"
            onRetry={() => void emails.refetch()}
          />
        ) : emailItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No address rows are available. The canonical profile email remains{" "}
            {subscriber.email}.
          </p>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {emailItems.map((address) => (
              <EmailAddressRow
                key={address.id}
                address={address}
                health={healthByEmail.get(address.email)}
                canMutate={Boolean(authority)}
                disabled={busy !== null}
                onConsent={(next) =>
                  runWrite(
                    `email-consent:${address.id}`,
                    "Address consent recorded.",
                    (context) =>
                      updateSubscriberEmailConsent(id, address, next, context),
                  )
                }
                onSuppression={(input) =>
                  runWrite(
                    `email-suppression:${address.id}`,
                    input.suppressed
                      ? "Address suppressed."
                      : "Address suppression removed.",
                    (context) =>
                      setSubscriberEmailSuppression(
                        id,
                        address,
                        input,
                        context,
                      ),
                  )
                }
                onDelete={() =>
                  runWrite(
                    `email-delete:${address.id}`,
                    "Secondary address removed.",
                    (context) => deleteSubscriberEmail(id, address, context),
                  )
                }
              />
            ))}
          </ul>
        )}
        {health.error && emailItems.length > 0 ? (
          <p role="alert" className="text-xs text-muted-foreground">
            Address health could not be verified, so no health recommendation is
            shown.
          </p>
        ) : null}
        {authority && emailItems.length < 5 && parentVersion ? (
          <AddEmailForm
            disabled={busy !== null}
            onAdd={(email) =>
              runWrite(
                "email-add",
                "Secondary address added without granting consent.",
                (context) =>
                  addSubscriberEmail(id, email, parentVersion, context),
              )
            }
          />
        ) : null}
      </section>

      <section aria-labelledby={aliasesHeadingId} className="space-y-3">
        <div>
          <h3 id={aliasesHeadingId} className="text-sm font-medium">
            Linked identities
          </h3>
          <p className="text-xs text-muted-foreground">
            Email and phone aliases are system-owned. Other exact identifiers
            can be reviewed here.
          </p>
        </div>
        {aliases.error ? (
          <PanelReadError
            label="linked identities"
            onRetry={() => void aliases.refetch()}
          />
        ) : aliasItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No aliases linked.</p>
        ) : (
          <ul className="divide-y rounded-md border bg-card text-sm">
            {aliasItems.map((alias) => {
              const editable = !["email", "phone"].includes(alias.alias_type);
              return (
                <li
                  key={alias.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <div className="break-all font-mono text-xs">
                      {alias.alias_value}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {alias.alias_type.replaceAll("_", " ")} · {alias.source} ·
                      last seen {timeAgo(alias.last_seen_at)}
                    </div>
                  </div>
                  {authority && editable && aliases.data?.subscriber_version ? (
                    <ConfirmDialog
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={busy !== null}
                          aria-label={`Unlink ${alias.alias_value}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      }
                      title="Unlink this identity?"
                      description="Future identify calls using this value will no longer resolve through this alias."
                      confirmLabel="Unlink identity"
                      onConfirm={async () => {
                        await runWrite(
                          `alias-delete:${alias.id}`,
                          "Identity unlinked.",
                          (context) =>
                            deleteSubscriberAlias(
                              id,
                              alias.id,
                              aliases.data!.subscriber_version,
                              context,
                            ),
                        );
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {authority && aliases.data?.subscriber_version ? (
          <AddAliasForm
            disabled={busy !== null}
            onAdd={(aliasType, aliasValue) =>
              runWrite("alias-add", "Identity linked.", (context) =>
                addSubscriberAlias(
                  id,
                  { alias_type: aliasType, alias_value: aliasValue },
                  aliases.data!.subscriber_version,
                  context,
                ),
              )
            }
          />
        ) : null}
      </section>

      <LifecycleSection
        lifecycle={lifecycle.data}
        error={Boolean(lifecycle.error)}
        canMutate={Boolean(authority)}
        disabled={busy !== null}
        onRetry={() => void lifecycle.refetch()}
        onSave={(stage, score, reason) => {
          if (!lifecycle.data || !authority) return Promise.resolve(false);
          return runWrite("lifecycle", "Lifecycle updated.", (context) =>
            updateSubscriberLifecycle(
              id,
              authority.tenantId,
              { stage, score, reason },
              lifecycle.data!.subscriber_version,
              context,
            ),
          );
        }}
      />

      <section aria-labelledby={traitsHeadingId} className="space-y-3">
        <div>
          <h3 id={traitsHeadingId} className="text-sm font-medium">
            Computed traits
          </h3>
          <p className="text-xs text-muted-foreground">
            Read-only model and warehouse outputs. Change their source, not the
            projection.
          </p>
        </div>
        {traits.error ? (
          <PanelReadError
            label="computed traits"
            onRetry={() => void traits.refetch()}
          />
        ) : traitItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No computed traits.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {traitItems.map((trait) => (
              <li
                key={trait.id}
                className="min-w-0 rounded-md border bg-card p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs">{trait.key}</span>
                  <Badge variant="outline">{trait.source}</Badge>
                </div>
                <div className="mt-2 break-words text-sm">
                  {traitValue(trait)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {trait.model_version ? `model ${trait.model_version} · ` : ""}
                  {trait.updated_at
                    ? `updated ${timeAgo(trait.updated_at)}`
                    : trait.value_type}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProfileIdentitySummary({ subscriber }: { subscriber: Subscriber }) {
  const headingId = useId();
  const rows = [
    ["Profile ID", subscriber.profile_id],
    ["External ID", subscriber.external_id],
    ["Display name", subscriber.display_name],
    ["Full name", subscriber.full_name],
    ["Locale", subscriber.locale],
    ["Language", subscriber.language],
    [
      "Country / region",
      [subscriber.country, subscriber.region].filter(Boolean).join(" / "),
    ],
    ["Signup source", subscriber.signup_source],
    ["Data region", subscriber.data_region],
    ["Account", subscriber.account_id],
    ["Federated master", subscriber.federated_master_id],
  ].filter(
    (row): row is [string, string] =>
      typeof row[1] === "string" && row[1] !== "",
  );
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Profile identity
        </h3>
        <p className="text-xs text-muted-foreground">
          Stable identifiers and localization currently stored on this profile.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No additional identity attributes.
        </p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 rounded-md border bg-card p-3 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function SubscriberAccountSection({
  accounts,
  loading,
  error,
  accountId,
  disabled,
  canMutate,
  onRetry,
  onLink,
  onCreateAndLink,
}: {
  accounts: SubscriberAccount[];
  loading: boolean;
  error: boolean;
  accountId: string | null;
  disabled: boolean;
  canMutate: boolean;
  onRetry: () => void;
  onLink: (accountId: string | null) => Promise<boolean>;
  onCreateAndLink: (name: string, industry: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const selectId = useId();
  const nameId = useId();
  const industryId = useId();
  const [selected, setSelected] = useState(accountId ?? "");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(accountId ?? ""), [accountId]);

  const linked = accounts.find((account) => account.id === accountId);
  const pending = disabled || saving;
  const submitLink = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !canMutate || selected === (accountId ?? "")) return;
    setSaving(true);
    try {
      await onLink(selected || null);
    } finally {
      setSaving(false);
    }
  };
  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !canMutate || !name.trim()) return;
    setSaving(true);
    try {
      if (await onCreateAndLink(name, industry)) {
        setName("");
        setIndustry("");
        setCreating(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Account
        </h3>
        <p className="text-xs text-muted-foreground">
          Canonical company link for this profile. Company text in custom fields
          remains independent.
        </p>
      </div>
      {loading ? <Skeleton className="h-20 w-full" /> : null}
      {!loading && error ? (
        <PanelReadError label="account directory" onRetry={onRetry} />
      ) : null}
      {!loading && !error ? (
        <>
          <div className="rounded-md border bg-card p-3 text-sm">
            {linked ? (
              <>
                <div className="font-medium">{linked.name}</div>
                <div className="text-xs text-muted-foreground">
                  {[linked.industry, linked.country]
                    .filter(Boolean)
                    .join(" · ") || "No industry or country recorded"}
                </div>
              </>
            ) : accountId ? (
              <div role="status">
                Linked account{" "}
                <code className="break-all text-xs">{accountId}</code> is not
                present in the current directory snapshot.
              </div>
            ) : (
              <span className="text-muted-foreground">No account linked.</span>
            )}
          </div>
          {canMutate ? (
            <form
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              onSubmit={submitLink}
            >
              <div className="grid gap-1.5">
                <Label htmlFor={selectId}>Existing account</Label>
                <Select
                  id={selectId}
                  value={selected}
                  disabled={pending}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">No account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                      {account.industry ? ` — ${account.industry}` : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={pending || selected === (accountId ?? "")}
              >
                {saving ? "Saving…" : selected ? "Link account" : "Unlink"}
              </Button>
            </form>
          ) : null}
          {canMutate && !creating ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setCreating(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Create and link
              account
            </Button>
          ) : null}
          {canMutate && creating ? (
            <form
              className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2"
              onSubmit={submitCreate}
            >
              <div className="grid gap-1.5">
                <Label htmlFor={nameId}>Account name</Label>
                <Input
                  id={nameId}
                  value={name}
                  maxLength={200}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={industryId}>Industry (optional)</Label>
                <Input
                  id={industryId}
                  value={industry}
                  maxLength={120}
                  disabled={pending}
                  onChange={(event) => setIndustry(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Button type="submit" disabled={pending || !name.trim()}>
                  {saving ? "Creating…" : "Create and link"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function catalogBars(
  data: SubscriberCatalogAttributes | undefined,
): Array<{ category: string; count: number }> {
  const favorite = data?.favorite_category;
  if (!favorite) return [];
  if (favorite.top?.length) return favorite.top.slice(0, 3);
  if (favorite.category) {
    return [{ category: favorite.category, count: favorite.count ?? 0 }];
  }
  return [];
}

function CatalogAttributesSection({
  data,
  loading,
  error,
  onRetry,
}: {
  data: SubscriberCatalogAttributes | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const headingId = useId();
  const bars = catalogBars(data);
  const max = Math.max(1, ...bars.map((bar) => bar.count));
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Catalog attributes
        </h3>
        <p className="text-xs text-muted-foreground">
          Read-only commerce signals computed from observed catalog activity.
        </p>
      </div>
      {loading ? <Skeleton className="h-20 w-full" /> : null}
      {!loading && error ? (
        <PanelReadError label="catalog attributes" onRetry={onRetry} />
      ) : null}
      {!loading && !error && bars.length === 0 && !data?.last_viewed_sku ? (
        <p className="text-sm text-muted-foreground">
          No catalog activity yet.
        </p>
      ) : null}
      {!loading && !error && (bars.length > 0 || data?.last_viewed_sku) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-md border bg-card p-3">
            <div className="text-xs font-medium">Favorite categories</div>
            {bars.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                Not computed
              </span>
            ) : (
              bars.map((bar) => (
                <div key={bar.category} className="text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="truncate" title={bar.category}>
                      {bar.category}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {bar.count}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary"
                      style={{
                        width: `${Math.max(4, (bar.count / max) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="rounded-md border bg-card p-3 text-sm">
            <div className="text-xs font-medium">Last viewed SKU</div>
            <div className="mt-2 break-all font-mono text-xs">
              {data?.last_viewed_sku || "Not computed"}
            </div>
            {data?.computed_at ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Computed {timeAgo(data.computed_at)}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FederatedIdentitySection({
  links,
  version,
  loading,
  error,
  disabled,
  canMutate,
  onRetry,
  onAdd,
  onDelete,
}: {
  links: SubscriberFederationLink[];
  version: string | undefined;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  canMutate: boolean;
  onRetry: () => void;
  onAdd: (input: {
    parent_tenant_id: string;
    master_subscriber_id: string;
    match_type: FederationMatchType;
    match_key: string;
  }) => Promise<boolean>;
  onDelete: (masterSubscriberId: string) => Promise<boolean>;
}) {
  const headingId = useId();
  const parentId = useId();
  const masterId = useId();
  const matchTypeId = useId();
  const evidenceId = useId();
  const [showForm, setShowForm] = useState(false);
  const [parentTenantId, setParentTenantId] = useState("");
  const [masterSubscriberId, setMasterSubscriberId] = useState("");
  const [matchType, setMatchType] = useState<FederationMatchType>("manual");
  const [matchKey, setMatchKey] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = disabled || saving;
  const complete =
    parentTenantId.trim().length === 36 &&
    masterSubscriberId.trim().length === 36 &&
    matchKey.trim().length > 0 &&
    reviewed;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || pending || !version) return;
    setSaving(true);
    try {
      if (
        await onAdd({
          parent_tenant_id: parentTenantId,
          master_subscriber_id: masterSubscriberId,
          match_type: matchType,
          match_key: matchKey,
        })
      ) {
        setParentTenantId("");
        setMasterSubscriberId("");
        setMatchType("manual");
        setMatchKey("");
        setReviewed(false);
        setShowForm(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-sm font-medium">
            Federated identity
          </h3>
          <p className="text-xs text-muted-foreground">
            Verified links to a master profile in this workspace&apos;s agency
            parent. Parent profile details stay private.
          </p>
        </div>
        {canMutate && version && !showForm && !error ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setShowForm(true)}
          >
            Link parent identity
          </Button>
        ) : null}
      </div>
      {loading ? <Skeleton className="h-20 w-full" /> : null}
      {!loading && error ? (
        <PanelReadError label="federated identities" onRetry={onRetry} />
      ) : null}
      {!loading && !error && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No federated identity links.
        </p>
      ) : null}
      {!loading && !error && links.length > 0 ? (
        <ul className="divide-y rounded-md border bg-card text-sm">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex flex-col justify-between gap-3 p-3 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 space-y-1">
                <div className="font-medium">
                  {link.match_type.replaceAll("_", " ")} match
                </div>
                <div className="break-all text-xs text-muted-foreground">
                  Master {link.master_subscriber_id}
                </div>
                <div className="break-all text-xs text-muted-foreground">
                  Parent workspace {link.parent_tenant_id}
                </div>
                {link.match_key ? (
                  <div className="break-words text-xs text-muted-foreground">
                    Evidence: {link.match_key}
                  </div>
                ) : null}
                <div className="text-xs text-muted-foreground">
                  Linked {timeAgo(link.created_at)}
                </div>
              </div>
              {canMutate && version ? (
                <ConfirmDialog
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                    >
                      Unlink
                    </Button>
                  }
                  title="Unlink federated identity?"
                  description="This removes only the reviewed cross-workspace identity link. Neither subscriber profile is deleted."
                  confirmationToken={link.master_subscriber_id}
                  confirmLabel="Unlink identity"
                  onConfirm={async () => {
                    await onDelete(link.master_subscriber_id);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canMutate && version && showForm ? (
        <form
          className="grid gap-3 rounded-md border bg-muted/20 p-3 sm:grid-cols-2"
          onSubmit={submit}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={parentId}>Parent workspace UUID</Label>
            <Input
              id={parentId}
              value={parentTenantId}
              maxLength={36}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setParentTenantId(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={masterId}>Master subscriber UUID</Label>
            <Input
              id={masterId}
              value={masterSubscriberId}
              maxLength={36}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onChange={(event) => setMasterSubscriberId(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={matchTypeId}>Match type</Label>
            <Select
              id={matchTypeId}
              value={matchType}
              disabled={pending}
              onChange={(event) =>
                setMatchType(event.target.value as FederationMatchType)
              }
            >
              <option value="manual">Manual</option>
              <option value="email">Email</option>
              <option value="external_id">External ID</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={evidenceId}>Reviewed match evidence</Label>
            <Input
              id={evidenceId}
              value={matchKey}
              maxLength={2048}
              disabled={pending}
              onChange={(event) => setMatchKey(event.target.value)}
              placeholder="Exact value, ticket, or durable review reference"
            />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={reviewed}
              disabled={pending}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              I verified both exact workspace identities and the recorded match
              evidence.
            </span>
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={pending || !complete}>
              {saving ? "Linking…" : "Link identity"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => setShowForm(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function AddEmailForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (email: string) => Promise<boolean>;
}) {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(email)) setEmail("");
  };
  return (
    <form
      onSubmit={submit}
      className="max-w-xl space-y-2 rounded-md border bg-muted/20 p-3"
    >
      <Label htmlFor={emailId}>Add secondary email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={emailId}
          type="email"
          autoComplete="off"
          maxLength={320}
          value={email}
          disabled={disabled}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="secondary@example.com"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || !email.trim()}
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        New addresses start without marketing consent. Record reviewed evidence
        separately before sending.
      </p>
    </form>
  );
}

function AddAliasForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (type: EditableSubscriberAliasType, value: string) => Promise<boolean>;
}) {
  const typeId = useId();
  const valueId = useId();
  const [type, setType] = useState<EditableSubscriberAliasType>("external_id");
  const [value, setValue] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(type, value)) setValue("");
  };
  return (
    <form
      onSubmit={submit}
      className="grid max-w-2xl gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[11rem_1fr_auto] sm:items-end"
    >
      <div className="grid gap-1.5">
        <Label htmlFor={typeId}>Identity type</Label>
        <Select
          id={typeId}
          value={type}
          disabled={disabled}
          onChange={(event) =>
            setType(event.target.value as EditableSubscriberAliasType)
          }
        >
          {aliasTypes.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={valueId}>Exact value</Label>
        <Input
          id={valueId}
          value={value}
          maxLength={512}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        variant="outline"
        disabled={disabled || !value.trim()}
      >
        <Plus className="h-4 w-4" aria-hidden="true" /> Link
      </Button>
    </form>
  );
}

function EmailAddressRow({
  address,
  health,
  canMutate,
  disabled,
  onConsent,
  onSuppression,
  onDelete,
}: {
  address: SubscriberEmailAddress;
  health: EmailHealth | undefined;
  canMutate: boolean;
  disabled: boolean;
  onConsent: Parameters<typeof updateSubscriberEmailConsent>[2] extends infer T
    ? (input: T) => Promise<boolean>
    : never;
  onSuppression: (input: AddressSuppressionInput) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [consentOpen, setConsentOpen] = useState(false);
  const [suppressionOpen, setSuppressionOpen] = useState(false);
  return (
    <li className="space-y-3 p-3">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all text-sm font-medium">
              {address.email}
            </span>
            {address.is_primary ? (
              <Badge variant="outline">Primary</Badge>
            ) : null}
            <Badge
              variant={
                address.consent_status === "subscribed"
                  ? "success"
                  : address.consent_status === "unsubscribed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {address.consent_status.replaceAll("_", " ")}
            </Badge>
            {address.suppressed ? (
              <Badge variant="destructive">Suppressed</Badge>
            ) : null}
            {health ? (
              <Badge variant={health.send_eligible ? "success" : "warning"}>
                Health {health.grade}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {address.last_engaged_at
              ? `Last engaged ${timeAgo(address.last_engaged_at)} · `
              : ""}
            Updated {absoluteTime(address.updated_at)}
          </p>
          {health ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {health.evidence_complete
                ? health.send_eligible
                  ? "Current evidence permits sending."
                  : "Current evidence does not permit sending."
                : "Health evidence is incomplete; sending remains fail-closed."}
            </p>
          ) : null}
        </div>
        {canMutate ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setConsentOpen(true)}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Record
              consent
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setSuppressionOpen(true)}
            >
              {address.suppressed ? "Review removal" : "Suppress"}
            </Button>
            {!address.is_primary ? (
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Delete ${address.email}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                }
                title="Delete secondary address?"
                description="The address is removed from this profile. Its immutable consent evidence remains for audit and privacy purposes."
                confirmationToken={address.email}
                confirmLabel="Delete address"
                onConfirm={async () => {
                  await onDelete();
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <AddressConsentDialog
        open={consentOpen}
        onOpenChange={setConsentOpen}
        address={address}
        disabled={disabled}
        onSave={onConsent}
      />
      <AddressSuppressionDialog
        open={suppressionOpen}
        onOpenChange={setSuppressionOpen}
        address={address}
        disabled={disabled}
        onSave={onSuppression}
      />
    </li>
  );
}

type AddressSuppressionInput = {
  suppressed: boolean;
  reason: string;
  evidence: string;
};

function AddressSuppressionDialog({
  open,
  onOpenChange,
  address,
  disabled,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: SubscriberEmailAddress;
  disabled: boolean;
  onSave: (input: AddressSuppressionInput) => Promise<boolean>;
}) {
  const nextSuppressed = !address.suppressed;
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setEvidence("");
    setConfirmation("");
    setReviewed(false);
  }, [address.id, address.suppressed, open]);

  const pending = saving || disabled;
  const complete =
    reviewed &&
    reason.trim().length > 0 &&
    evidence.trim().length > 0 &&
    confirmation === address.email;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || pending) return;
    setSaving(true);
    try {
      const saved = await onSave({
        suppressed: nextSuppressed,
        reason,
        evidence,
      });
      if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-lg" aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>
            {nextSuppressed
              ? "Suppress this address"
              : "Review suppression removal"}
          </DialogTitle>
          <DialogDescription>
            {nextSuppressed
              ? "This exact address becomes ineligible for sending. Record the reviewed reason and supporting evidence."
              : "Only the operator-owned address suppression can be removed. Complaint, bounce, erasure, consent, and profile-status holds remain authoritative."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-suppression-reason-${address.id}`}>
              Reviewed reason
            </Label>
            <Textarea
              id={`address-suppression-reason-${address.id}`}
              value={reason}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                nextSuppressed
                  ? "Why sending to this address must stop"
                  : "Why the operator-owned suppression is no longer applicable"
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-suppression-evidence-${address.id}`}>
              Evidence
            </Label>
            <Textarea
              id={`address-suppression-evidence-${address.id}`}
              value={evidence}
              maxLength={2048}
              disabled={pending}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder="Ticket, provider trace, reviewed request, or other durable evidence"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-suppression-confirm-${address.id}`}>
              Type {address.email} to confirm
            </Label>
            <Input
              id={`address-suppression-confirm-${address.id}`}
              value={confirmation}
              autoComplete="off"
              disabled={pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={reviewed}
              disabled={pending}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              I reviewed this exact address, decision, and supporting evidence.
            </span>
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={nextSuppressed ? "destructive" : "default"}
              disabled={pending || !complete}
            >
              {saving
                ? "Saving…"
                : nextSuppressed
                  ? "Suppress address"
                  : "Remove reviewed suppression"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type AddressConsentInput = Parameters<typeof updateSubscriberEmailConsent>[2];

function AddressConsentDialog({
  open,
  onOpenChange,
  address,
  disabled,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: SubscriberEmailAddress;
  disabled: boolean;
  onSave: (input: AddressConsentInput) => Promise<boolean>;
}) {
  const [status, setStatus] =
    useState<AddressConsentInput["consent_status"]>("subscribed");
  const [source, setSource] =
    useState<AddressConsentInput["source"]>("direct_request");
  const [channel, setChannel] = useState<AddressConsentInput["channel"]>("api");
  const [legalBasis, setLegalBasis] =
    useState<AddressConsentInput["legal_basis"]>("consent");
  const [occurredAt, setOccurredAt] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus(
      address.consent_status === "unsubscribed" ? "unsubscribed" : "subscribed",
    );
    setSource("direct_request");
    setChannel("api");
    setLegalBasis("consent");
    setOccurredAt(new Date().toISOString().slice(0, 16));
    setJurisdiction("");
    setEvidence("");
    setReason("");
    setPolicyVersion("");
    setReviewed(false);
  }, [address.consent_status, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await onSave({
        consent_status: status,
        source,
        channel,
        legal_basis: legalBasis,
        occurred_at: new Date(occurredAt).toISOString(),
        jurisdiction,
        evidence,
        reason,
        policy_version: policyVersion,
      });
      if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const pending = saving || disabled;
  const complete =
    reviewed &&
    occurredAt &&
    jurisdiction.trim() &&
    evidence.trim() &&
    reason.trim() &&
    policyVersion.trim();
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90vh] max-w-xl overflow-y-auto"
        aria-busy={pending}
      >
        <DialogHeader>
          <DialogTitle>Record address consent evidence</DialogTitle>
          <DialogDescription>
            This updates send eligibility for {address.email}. Record what the
            person actually decided. Unknown and never-subscribed remain
            read-only absence-of-evidence states; pending still requires proof.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldSelect
              label="Decision"
              value={status}
              disabled={pending}
              onChange={(value) =>
                setStatus(value as AddressConsentInput["consent_status"])
              }
              options={["subscribed", "unsubscribed", "pending"]}
            />
            <FieldSelect
              label="Evidence source"
              value={source}
              disabled={pending}
              onChange={(value) =>
                setSource(value as AddressConsentInput["source"])
              }
              options={[
                "direct_request",
                "double_optin",
                "single_optin",
                "preference_center",
                "signed_form",
              ]}
            />
            <FieldSelect
              label="Evidence channel"
              value={channel}
              disabled={pending}
              onChange={(value) =>
                setChannel(value as AddressConsentInput["channel"])
              }
              options={["api", "email", "web", "mobile", "desktop", "import"]}
            />
            <FieldSelect
              label="Legal basis"
              value={legalBasis}
              disabled={pending}
              onChange={(value) =>
                setLegalBasis(value as AddressConsentInput["legal_basis"])
              }
              options={[
                "consent",
                "contract",
                "legitimate_interest",
                "legal_obligation",
              ]}
            />
            <div className="grid gap-1.5">
              <Label htmlFor={`address-consent-at-${address.id}`}>
                Occurred at
              </Label>
              <Input
                id={`address-consent-at-${address.id}`}
                type="datetime-local"
                value={occurredAt}
                disabled={pending}
                max={new Date(Date.now() + 5 * 60_000)
                  .toISOString()
                  .slice(0, 16)}
                onChange={(event) => setOccurredAt(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`address-consent-jurisdiction-${address.id}`}>
                Jurisdiction
              </Label>
              <Input
                id={`address-consent-jurisdiction-${address.id}`}
                value={jurisdiction}
                maxLength={32}
                disabled={pending}
                placeholder="US, IN, EU, or UNSPECIFIED"
                onChange={(event) => setJurisdiction(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-consent-evidence-${address.id}`}>
              Evidence
            </Label>
            <Textarea
              id={`address-consent-evidence-${address.id}`}
              value={evidence}
              maxLength={2048}
              disabled={pending}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder="Where the reviewed proof is stored, or the captured statement."
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-consent-reason-${address.id}`}>
              Reason
            </Label>
            <Textarea
              id={`address-consent-reason-${address.id}`}
              value={reason}
              maxLength={500}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`address-consent-policy-${address.id}`}>
              Policy version
            </Label>
            <Input
              id={`address-consent-policy-${address.id}`}
              value={policyVersion}
              maxLength={100}
              disabled={pending}
              placeholder="privacy-2026-08"
              onChange={(event) => setPolicyVersion(event.target.value)}
            />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={reviewed}
              disabled={pending}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              I reviewed the source evidence and confirm this exact address and
              decision.
            </span>
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !complete}>
              {saving ? "Recording…" : "Record evidence"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldSelect({
  label,
  value,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  options: string[];
}) {
  const id = `identity-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll("_", " ")}
          </option>
        ))}
      </Select>
    </div>
  );
}

function LifecycleSection({
  lifecycle,
  error,
  canMutate,
  disabled,
  onRetry,
  onSave,
}: {
  lifecycle: Awaited<ReturnType<typeof getSubscriberLifecycle>> | undefined;
  error: boolean;
  canMutate: boolean;
  disabled: boolean;
  onRetry: () => void;
  onSave: (
    stage: SubscriberLifecycleStage,
    score: number,
    reason: string,
  ) => Promise<boolean>;
}) {
  const headingId = useId();
  const stageId = useId();
  const scoreId = useId();
  const reasonId = useId();
  const [stage, setStage] = useState<SubscriberLifecycleStage>("subscriber");
  const [score, setScore] = useState(3);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (lifecycle) {
      setStage(lifecycle.stage);
      setScore(lifecycle.score);
      setReason("");
    }
  }, [lifecycle]);
  if (error)
    return (
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="mb-2 text-sm font-medium">
          Lifecycle
        </h3>
        <PanelReadError label="lifecycle" onRetry={onRetry} />
      </section>
    );
  if (!lifecycle) return null;
  const unchanged = stage === lifecycle.stage && score === lifecycle.score;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-medium">
          Lifecycle
        </h3>
        <p className="text-xs text-muted-foreground">
          Stage transitions are revision-bound and recorded in the activity
          history.
        </p>
      </div>
      <form
        className="grid max-w-2xl gap-3 rounded-md border bg-card p-3 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onSave(stage, score, reason)) setReason("");
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={stageId}>Stage</Label>
          <Select
            id={stageId}
            value={stage}
            disabled={disabled || !canMutate}
            onChange={(event) =>
              setStage(event.target.value as SubscriberLifecycleStage)
            }
          >
            {SUBSCRIBER_LIFECYCLE_STAGES.map((item) => (
              <option key={item} value={item}>
                {item.toUpperCase()}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={scoreId}>Score (1–5)</Label>
          <Input
            id={scoreId}
            type="number"
            min={1}
            max={5}
            step={1}
            value={score}
            disabled={disabled || !canMutate}
            onChange={(event) => setScore(Number(event.target.value))}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={reasonId}>Reviewed reason</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            disabled={disabled || !canMutate}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this stage or score changed"
          />
        </div>
        <div className="text-xs text-muted-foreground sm:col-span-2">
          Sequence {lifecycle.transition_sequence} · updated{" "}
          {absoluteTime(lifecycle.updated_at)}
        </div>
        {canMutate ? (
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={disabled || unchanged || !reason.trim()}
            >
              Save lifecycle
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function PanelReadError({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center"
    >
      <span>Could not verify {label}. No editable state is inferred.</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
