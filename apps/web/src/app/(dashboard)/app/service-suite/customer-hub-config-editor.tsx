// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Customer Hub configuration form: record status plus the five feature
 * toggles, saved as a complete, version-guarded PUT replacement.
 *
 * Parity with desktop CustomerHubConfig: "Active" and Customer Agent
 * enablement stay release-held client-side (the server refuses them too), the
 * object-shaped fields are carried forward verbatim rather than edited, and a
 * write whose outcome is unknown retires the verified version — nothing is
 * retried until an administrator refreshes the record.
 */
import { useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage, isApiError } from "@/lib/api";
import type { ServiceSuiteIdentity } from "@/lib/service-suite-access";
import {
  CUSTOMER_HUB_EDITABLE_STATUSES,
  CUSTOMER_HUB_RELEASE_HOLD_MESSAGE,
  replaceServiceSuiteConfig,
  ServiceSuiteContractError,
  type CustomerHubDraft,
  type ServiceSuiteConfig,
} from "@/lib/service-suite-api";

type ToggleKey = Exclude<keyof CustomerHubDraft, "status">;

const TOGGLES: ReadonlyArray<{ key: ToggleKey; label: string; hint: string }> =
  [
    {
      key: "orderHistoryEnabled",
      label: "Order history",
      hint: "Stores the order-history intent; no storefront runtime is connected.",
    },
    {
      key: "favoritesEnabled",
      label: "Favorites",
      hint: "Stores the favorites intent; this does not publish a customer feature.",
    },
    {
      key: "couponsEnabled",
      label: "Coupons",
      hint: "Stores the coupons intent; customer visibility remains release-held.",
    },
    {
      key: "recommendationsEnabled",
      label: "Recommendations",
      hint: "Stores the recommendations intent without claiming runtime personalization.",
    },
    {
      key: "customerAgentEnabled",
      label: "Customer agent",
      hint: "Release-held: it can be turned off, never on. No authenticated storefront or provider-backed agent runtime exists.",
    },
  ];

function toDraft(config: ServiceSuiteConfig): CustomerHubDraft {
  return {
    status: config.status,
    orderHistoryEnabled: config.orderHistoryEnabled,
    favoritesEnabled: config.favoritesEnabled,
    couponsEnabled: config.couponsEnabled,
    recommendationsEnabled: config.recommendationsEnabled,
    customerAgentEnabled: config.customerAgentEnabled,
  };
}

function sameDraft(a: CustomerHubDraft, b: CustomerHubDraft): boolean {
  return (
    a.status === b.status &&
    TOGGLES.every((toggle) => a[toggle.key] === b[toggle.key])
  );
}

/** An outcome after which the verified version can no longer be trusted. */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof ServiceSuiteContractError) return true;
  if (!isApiError(error)) return true;
  // "offline" never left the browser (requireOnline refuses to queue it), so
  // the verified version is still the current one.
  if (error.kind === "offline") return false;
  return (
    error.kind !== "http" ||
    error.status === 412 ||
    error.status === 428 ||
    error.status >= 500
  );
}

export function CustomerHubConfigEditor({
  identity,
  config,
  verifiedAt,
  onRefresh,
  refreshing,
}: {
  identity: ServiceSuiteIdentity;
  config: ServiceSuiteConfig;
  /** When the verified record was last fetched; a refresh clears staleness. */
  verifiedAt: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const queryClient = useQueryClient();
  const statusId = useId();
  const [draft, setDraft] = useState<CustomerHubDraft>(() => toDraft(config));
  const [synced, setSynced] = useState({
    version: config.version,
    verifiedAt,
  });
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // A freshly verified record ends any staleness. It replaces the draft only
  // when the stored version moved (or the draft was built on a stale record),
  // so a background refetch of the same version never discards typing.
  if (synced.version !== config.version || synced.verifiedAt !== verifiedAt) {
    const versionMoved = synced.version !== config.version;
    setSynced({ version: config.version, verifiedAt });
    if (versionMoved || stale) setDraft(toDraft(config));
    setStale(false);
  }

  const mutation = useMutation({
    mutationFn: (next: CustomerHubDraft) =>
      replaceServiceSuiteConfig({
        expectedTenantId: identity.tenantId,
        current: config,
        draft: next,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData([...identity.queryBase, "config"], next);
      setError(null);
      setReceipt(
        `Configuration record replaced at version ${next.version}. Storefront and channel runtimes remain release-held.`,
      );
    },
    onError: (cause) => {
      setReceipt(null);
      if (outcomeUnknown(cause)) setStale(true);
      setError(
        apiErrorMessage(cause, "The Customer Hub configuration was not saved."),
      );
    },
  });

  const baseline = toDraft(config);
  const dirty = !sameDraft(draft, baseline);
  const releaseBlocked =
    draft.status === "active" || draft.customerAgentEnabled;
  const carryMissing = !config.replacementCarry;
  const saving = mutation.isPending;
  const controlsDisabled = saving || stale || carryMissing;
  const blockedReason = carryMissing
    ? "The stored advanced configuration could not be verified, so no complete replacement can be built. Saving is withheld."
    : stale
      ? "Refresh the verified configuration before replacing it. No stale write is retried automatically."
      : releaseBlocked
        ? "Change status away from Active and turn off Customer agent before replacing this release-held record."
        : !dirty
          ? "No unsaved changes."
          : null;
  const recordedStatusIsEditable = (
    CUSTOMER_HUB_EDITABLE_STATUSES as readonly string[]
  ).includes(draft.status);

  return (
    <form
      aria-label="Customer Hub configuration"
      className="mt-4 space-y-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (blockedReason || saving) return;
        setError(null);
        setReceipt(null);
        mutation.mutate(draft);
      }}
    >
      <div>
        <h3 className="font-medium">Replace configuration record</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Saving sends the complete record, guarded by version{" "}
          <span className="font-mono text-xs">{config.version}</span>. These
          values record intent only; they do not publish a storefront feature.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Configuration not confirmed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {receipt ? (
        <Alert role="status">
          <AlertTitle>Server receipt</AlertTitle>
          <AlertDescription>{receipt}</AlertDescription>
        </Alert>
      ) : null}
      {stale ? (
        <Alert variant="warning" role="status">
          <AlertTitle>Verified record retired</AlertTitle>
          <AlertDescription>
            The last write may or may not have been applied. Refresh before
            another replacement.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onRefresh}
              loading={refreshing}
            >
              <RefreshCw aria-hidden /> Refresh verified config
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="max-w-xs">
        <Label htmlFor={statusId}>Record status</Label>
        <Select
          id={statusId}
          className="mt-2"
          value={draft.status}
          disabled={controlsDisabled}
          aria-describedby={`${statusId}-hint`}
          onChange={(event) =>
            setDraft((current) => ({ ...current, status: event.target.value }))
          }
        >
          {!recordedStatusIsEditable && draft.status !== "active" ? (
            <option value={draft.status}>
              {humanize(draft.status)} (recorded)
            </option>
          ) : null}
          {CUSTOMER_HUB_EDITABLE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {humanize(value)}
            </option>
          ))}
          <option value="active" disabled={draft.status !== "active"}>
            Active — publication release held
          </option>
        </Select>
        <p id={`${statusId}-hint`} className="mt-1 text-xs text-muted-foreground">
          Record lifecycle only. Active cannot be chosen because no
          authenticated customer runtime exists.
        </p>
      </div>

      <ul className="divide-y overflow-hidden rounded-lg border">
        {TOGGLES.map((toggle) => {
          const checked = draft[toggle.key];
          const inputId = `${statusId}-${toggle.key}`;
          return (
            <li key={toggle.key} className="flex items-start gap-3 p-3">
              <Checkbox
                id={inputId}
                role="switch"
                aria-checked={checked}
                className="mt-1"
                checked={checked}
                disabled={
                  controlsDisabled ||
                  (toggle.key === "customerAgentEnabled" && !checked)
                }
                aria-describedby={`${inputId}-hint`}
                onChange={(event) => {
                  const value = event.currentTarget.checked;
                  setDraft((current) => ({ ...current, [toggle.key]: value }));
                }}
              />
              <div className="min-w-0">
                <Label htmlFor={inputId} className="font-medium">
                  {toggle.label}
                </Label>
                <p
                  id={`${inputId}-hint`}
                  className="text-xs text-muted-foreground"
                >
                  {toggle.hint}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
        Advanced configuration — storefronts, content blocks, personalization
        rules, support settings, styling, and metadata — is not edited here.
        Its verified values are carried forward unchanged in the replacement;
        this form never sends a partial record.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={saving}
          disabled={Boolean(blockedReason)}
          aria-describedby={blockedReason ? `${statusId}-save-hint` : undefined}
        >
          Save configuration
        </Button>
        {blockedReason ? (
          <span
            id={`${statusId}-save-hint`}
            className="text-xs text-muted-foreground"
          >
            {releaseBlocked && !stale && !carryMissing
              ? `${CUSTOMER_HUB_RELEASE_HOLD_MESSAGE} ${blockedReason}`
              : blockedReason}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
