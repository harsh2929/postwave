// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Fingerprint,
  MapPinned,
  Palette,
  Plus,
  ShieldBan,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  effectiveAuthRole,
  type AuthRole,
  type MeResponse,
  whoami,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { preferredContrastingTextColor } from "@/lib/preference-branding-security";
import {
  cancelDoubleOptIn,
  createPrivacyRegion,
  deletePrivacyRegion,
  extendDoubleOptInWindow,
  getDoubleOptInPending,
  getPreferenceCentreBranding,
  getPrivacyPortal,
  isSafePreferenceLogoURL,
  mergeDoubleOptInPendingPages,
  savePreferenceCentreBranding,
  type DoubleOptInPendingRow,
  type PreferenceCentreBranding,
  type PreferenceCentreBrandingInput,
  type PrivacyFramework,
  type PrivacyPortal,
  type PrivacyRegion,
  type PrivacyRegionInput,
} from "@/lib/privacy-portal-api";
import { qk, STALE } from "@/lib/query-keys";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

// The KPI/chart dashboard carries its own CSV export and chart tables; loading
// it on demand keeps the privacy-portal route inside the bundle budget.
const PortalDashboard = dynamic(
  () =>
    import("@/components/privacy/PortalDashboard").then(
      (module) => module.PortalDashboard,
    ),
  {
    loading: () => (
      <GovernanceLoading label="Loading privacy snapshot…" rows={5} />
    ),
  },
);

const FRAMEWORKS: ReadonlyArray<{
  value: PrivacyFramework;
  label: string;
}> = [
  { value: "gdpr", label: "GDPR — European Union" },
  { value: "ccpa", label: "CCPA/CPRA — California" },
  { value: "lgpd", label: "LGPD — Brazil" },
  { value: "pipeda", label: "PIPEDA — Canada" },
  { value: "apo", label: "APO" },
  { value: "other", label: "Other / organization-defined" },
];
const REGION_CODE = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,8})*$/u;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;
const UNSAFE_MULTILINE =
  /[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const DEFAULT_BRANDING: PreferenceCentreBrandingInput = {
  logo_url: "",
  primary_color: "#5B6CFF",
  footer_text: "You're receiving this because you subscribed.",
  show_postwave_badge: true,
};
const EMPTY_REGION: PrivacyRegionInput = {
  region_code: "",
  framework: "gdpr",
  requires_double_optin: false,
  requires_explicit_consent: false,
  do_not_sell_default: false,
  gpc_honored: true,
};

type MutationScope =
  | "region-create"
  | "region-delete"
  | "pending-extend"
  | "pending-cancel"
  | "branding-save";

interface ActiveMutation {
  scope: MutationScope;
  id?: string;
}

export function PrivacyPortalAdmin({
  me,
  role,
}: {
  me: MeResponse;
  role: AuthRole;
}) {
  const queryClient = useQueryClient();
  const identityKey = useMemo(
    () => ["privacy-portal-admin", me.tenant_id, me.user_id, role] as const,
    [me.tenant_id, me.user_id, role],
  );
  const portalKey = useMemo(
    () => [...identityKey, "summary"] as const,
    [identityKey],
  );
  const pendingKey = useMemo(
    () => [...identityKey, "double-optin"] as const,
    [identityKey],
  );
  const brandingKey = useMemo(
    () => [...identityKey, "branding"] as const,
    [identityKey],
  );
  const lifecycle = useRef(0);
  const writes = useRef(new Set<AbortController>());
  const mutationRef = useRef(false);
  const operationTriggerRef = useRef<HTMLElement | null>(null);
  const regionCodeRef = useRef<HTMLInputElement | null>(null);
  const pendingRefreshRef = useRef<HTMLButtonElement | null>(null);

  const [activeMutation, setActiveMutation] = useState<ActiveMutation | null>(
    null,
  );
  const [regionDraft, setRegionDraft] =
    useState<PrivacyRegionInput>(EMPTY_REGION);
  const [regionError, setRegionError] = useState<string | null>(null);
  const [deleteRegionTarget, setDeleteRegionTarget] =
    useState<PrivacyRegion | null>(null);
  const [cancelPendingTarget, setCancelPendingTarget] =
    useState<DoubleOptInPendingRow | null>(null);
  const [brandingDraft, setBrandingDraft] =
    useState<PreferenceCentreBrandingInput | null>(null);
  const [brandingBaseline, setBrandingBaseline] =
    useState<PreferenceCentreBrandingInput | null>(null);
  const [brandingError, setBrandingError] = useState<string | null>(null);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    lifecycle.current += 1;
    const generation = lifecycle.current;
    const ownedWrites = writes.current;
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
      for (const controller of ownedWrites) controller.abort();
      ownedWrites.clear();
      mutationRef.current = false;
      void queryClient.cancelQueries({ queryKey: identityKey });
      queryClient.removeQueries({ queryKey: identityKey });
    };
  }, [identityKey, queryClient]);

  const portal = useQuery({
    queryKey: portalKey,
    queryFn: ({ signal }) => getPrivacyPortal(me.tenant_id, { signal }),
    staleTime: STALE.dashboard,
  });
  const pending = useInfiniteQuery({
    queryKey: pendingKey,
    queryFn: ({ pageParam, signal }) =>
      getDoubleOptInPending({
        tenantId: me.tenant_id,
        ...(typeof pageParam === "string" ? { cursor: pageParam } : {}),
        limit: 50,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    staleTime: STALE.list,
  });
  const branding = useQuery({
    queryKey: brandingKey,
    queryFn: ({ signal }) =>
      getPreferenceCentreBranding(me.tenant_id, { signal }),
    staleTime: STALE.reference,
  });

  const regionDirty = !sameRegionInput(regionDraft, EMPTY_REGION);
  const brandingDirty = Boolean(
    brandingDraft &&
    brandingBaseline &&
    !sameBranding(brandingDraft, brandingBaseline),
  );
  useUnsavedChangesGuard(regionDirty || brandingDirty);

  useEffect(() => {
    if (!branding.data || brandingDirty) return;
    const next = brandingInput(branding.data);
    setBrandingDraft(next);
    setBrandingBaseline(next);
    setBrandingError(null);
  }, [branding.data, brandingDirty]);

  useEffect(() => {
    setLogoFailed(false);
  }, [brandingDraft?.logo_url]);

  const mergedPending = useMemo(() => {
    try {
      return {
        rows: mergeDoubleOptInPendingPages(
          pending.data?.pages ?? [],
          me.tenant_id,
        ),
        error: null as Error | null,
      };
    } catch (error) {
      return {
        rows: [] as DoubleOptInPendingRow[],
        error: error instanceof Error ? error : new Error("Invalid queue"),
      };
    }
  }, [me.tenant_id, pending.data?.pages]);

  const portalVerified =
    portal.isSuccess && !portal.isError && !portal.isFetching && !!portal.data;
  const pendingVerified =
    pending.isSuccess &&
    !pending.isError &&
    !pending.isFetching &&
    !pending.isFetchingNextPage &&
    mergedPending.error === null;
  const brandingVerified =
    branding.isSuccess &&
    !branding.isError &&
    !branding.isFetching &&
    !!branding.data;

  const assertCurrent = useCallback((generation: number) => {
    if (lifecycle.current !== generation) {
      throw new DOMException("Privacy-portal operation retired", "AbortError");
    }
  }, []);

  const reauthorize = useCallback(
    async (generation: number) => {
      assertCurrent(generation);
      const current = await whoami();
      assertCurrent(generation);
      queryClient.setQueryData(qk.authMe(), current);
      const currentRole = effectiveAuthRole(current);
      if (
        current.tenant_id !== me.tenant_id ||
        current.user_id !== me.user_id ||
        current.viewer_mode === true ||
        (currentRole !== "owner" && currentRole !== "admin")
      ) {
        throw new Error(
          "Your workspace identity or administrator access changed before this operation.",
        );
      }
    },
    [assertCurrent, me.tenant_id, me.user_id, queryClient],
  );

  const retireView = useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: identityKey });
    queryClient.removeQueries({ queryKey: identityKey });
    await queryClient.invalidateQueries({ queryKey: qk.authMe() });
  }, [identityKey, queryClient]);

  const runAuthorized = useCallback(
    async <T,>(
      scope: MutationScope,
      id: string | undefined,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ value: T; retired: boolean }> => {
      if (mutationRef.current) {
        throw new Error("Wait for the current privacy operation to finish.");
      }
      mutationRef.current = true;
      setActiveMutation({ scope, ...(id ? { id } : {}) });
      const generation = lifecycle.current;
      const controller = new AbortController();
      writes.current.add(controller);
      try {
        await reauthorize(generation);
        assertCurrent(generation);
        const value = await run(controller.signal);
        assertCurrent(generation);
        try {
          await reauthorize(generation);
        } catch {
          await retireView();
          toast.error("Privacy change confirmed; this view was retired", {
            description:
              "The server receipt is valid, but identity could not be reverified afterward. Reload the original workspace before relying on displayed state.",
          });
          return { value, retired: true };
        }
        return { value, retired: false };
      } finally {
        writes.current.delete(controller);
        if (lifecycle.current === generation) {
          mutationRef.current = false;
          setActiveMutation(null);
        }
      }
    },
    [assertCurrent, reauthorize, retireView],
  );

  const resetRegionDraft = () => {
    setRegionDraft(EMPTY_REGION);
    setRegionError(null);
  };

  const regionValidation = validateRegionDraft(
    regionDraft,
    portal.data?.regions ?? [],
  );
  const brandingValidation = validateBranding(brandingDraft);

  async function createRegion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!portalVerified) {
      setRegionError(
        "Reload a verified current region inventory before adding a policy.",
      );
      return;
    }
    if (regionValidation) {
      setRegionError(regionValidation);
      regionCodeRef.current?.focus();
      return;
    }
    setRegionError(null);
    try {
      const result = await runAuthorized("region-create", undefined, (signal) =>
        createPrivacyRegion(regionDraft, me.tenant_id, signal),
      );
      if (result.retired) return;
      queryClient.setQueryData<PrivacyPortal>(portalKey, (current) =>
        current
          ? {
              ...current,
              regions: [...current.regions, result.value].sort((a, b) =>
                a.region_code.localeCompare(b.region_code),
              ),
            }
          : current,
      );
      resetRegionDraft();
      toast.success(`${result.value.region_code} privacy policy added`);
      void queryClient.invalidateQueries({ queryKey: portalKey, exact: true });
    } catch (error) {
      if (isAbort(error)) return;
      const message =
        "The privacy region could not be added. The draft remains available for retry.";
      setRegionError(message);
      toast.error("Could not add privacy region", { description: message });
    }
  }

  async function removeRegion() {
    const target = deleteRegionTarget;
    if (
      !target ||
      !portalVerified ||
      !portal.data.regions.some((row) => row.id === target.id)
    ) {
      throw new Error(
        "Reload the verified current region inventory before removing this policy.",
      );
    }
    const result = await runAuthorized("region-delete", target.id, (signal) =>
      deletePrivacyRegion(target.id, me.tenant_id, signal),
    ).catch(() => {
      throw new Error(
        "The privacy region could not be removed. No server change was confirmed; reload and retry.",
      );
    });
    if (result.retired) return;
    queryClient.setQueryData<PrivacyPortal>(portalKey, (current) =>
      current
        ? {
            ...current,
            regions: current.regions.filter((row) => row.id !== target.id),
          }
        : current,
    );
    toast.success(`${target.region_code} privacy policy removed`, {
      description:
        "Historical consent evidence is retained; future eligibility no longer applies this region.",
    });
    void queryClient.invalidateQueries({ queryKey: portalKey, exact: true });
  }

  async function extendPending(row: DoubleOptInPendingRow) {
    if (
      !pendingVerified ||
      !mergedPending.rows.some((candidate) => candidate.id === row.id)
    ) {
      toast.error("Reload the current pending-confirmation queue first");
      return;
    }
    try {
      const result = await runAuthorized("pending-extend", row.id, (signal) =>
        extendDoubleOptInWindow(row.id, me.tenant_id, signal),
      );
      if (result.retired) return;
      toast.success(`Extended ${row.email}'s deadline by 60 days`, {
        description:
          "No email was sent. The existing pending token remains the confirmation path.",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pendingKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: portalKey, exact: true }),
      ]);
    } catch (error) {
      if (isAbort(error)) return;
      toast.error("Could not extend the confirmation deadline", {
        description: "No server change was confirmed. Reload and retry.",
      });
    }
  }

  async function cancelPending() {
    const target = cancelPendingTarget;
    if (
      !target ||
      !pendingVerified ||
      !mergedPending.rows.some((row) => row.id === target.id)
    ) {
      throw new Error(
        "Reload the verified current queue before cancelling this confirmation.",
      );
    }
    const result = await runAuthorized("pending-cancel", target.id, (signal) =>
      cancelDoubleOptIn(target.id, me.tenant_id, signal),
    ).catch(() => {
      throw new Error(
        "The pending confirmation could not be cancelled. No server change was confirmed; reload and retry.",
      );
    });
    if (result.retired) return;
    toast.success(`Cancelled the pending confirmation for ${target.email}`, {
      description:
        "That address must start double opt-in again before it can become eligible.",
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: pendingKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: portalKey, exact: true }),
    ]);
  }

  async function saveBranding() {
    if (!brandingDraft || !brandingVerified) {
      setBrandingError(
        "Reload the verified saved theme before applying customization.",
      );
      return;
    }
    if (brandingValidation) {
      setBrandingError(brandingValidation);
      return;
    }
    setBrandingError(null);
    try {
      const result = await runAuthorized("branding-save", undefined, (signal) =>
        savePreferenceCentreBranding(brandingDraft, me.tenant_id, signal),
      );
      if (result.retired) return;
      const next = brandingInput(result.value);
      queryClient.setQueryData(brandingKey, result.value);
      setBrandingDraft(next);
      setBrandingBaseline(next);
      toast.success("Preference-center theme saved", {
        description:
          "The public token page now consumes this acknowledged branding.",
      });
      void queryClient.invalidateQueries({
        queryKey: brandingKey,
        exact: true,
      });
    } catch (error) {
      if (isAbort(error)) return;
      const message =
        "The theme could not be saved. The draft remains available for retry.";
      setBrandingError(message);
      toast.error("Could not save preference-center theme", {
        description: message,
      });
    }
  }

  function refreshAll() {
    if (mutationRef.current) return;
    if (
      (regionDirty || brandingDirty) &&
      typeof window !== "undefined" &&
      !window.confirm("Discard unsaved privacy-portal changes and refresh?")
    ) {
      return;
    }
    resetRegionDraft();
    if (brandingBaseline) setBrandingDraft({ ...brandingBaseline });
    setBrandingError(null);
    void Promise.all([portal.refetch(), pending.refetch(), branding.refetch()]);
  }

  const refreshing =
    portal.isFetching ||
    pending.isFetching ||
    branding.isFetching ||
    activeMutation !== null;
  const mutationBusy = activeMutation !== null;
  const snapshot = portal.data;

  return (
    <PageShell className="max-w-7xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={Fingerprint}
        title="Privacy portal"
        description="Consent evidence, statutory requests, regional policy, pending confirmation operations, and the subscriber-facing preference center."
        refreshLabel="Refresh privacy data"
        refreshing={refreshing}
        onRefresh={refreshAll}
      />

      <Alert variant="warning">
        <ShieldCheck aria-hidden />
        <AlertTitle>Administrator-only compliance surface</AlertTitle>
        <AlertDescription>
          Reads are tenant-bound and fail closed. Writes require a current
          verified inventory, an online request, and identity checks before and
          after the server receipt.
        </AlertDescription>
      </Alert>

      <GovernanceSection
        icon={Fingerprint}
        title="Compliance snapshot"
        description="A point-in-time workspace read; failed responses are never represented as clean zeroes."
      >
        {portal.isPending ? (
          <GovernanceLoading label="Loading privacy snapshot…" rows={5} />
        ) : portal.isError || !snapshot ? (
          <GovernanceError
            message="Could not verify the privacy snapshot. Request counts, subscriber signals, and regional policies remain unknown."
            retrying={portal.isFetching}
            onRetry={() => void portal.refetch()}
          />
        ) : (
          <div className="space-y-5">
            <PortalDashboard summary={snapshot} />
            <p className="text-xs leading-5 text-muted-foreground">
              Snapshot{" "}
              {formatWireTimestamp(snapshot.generated_at, "time unknown")}.
            </p>
          </div>
        )}
      </GovernanceSection>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <CountList
          title="Consent evidence"
          description="Receipt counts grouped by the source that recorded them."
          icon={ShieldCheck}
          rows={snapshot?.consent_proof_summary}
          keyName="source"
          loading={portal.isPending}
          failed={portal.isError}
        />
        <CountList
          title="Suppression reasons"
          description="Why people are currently excluded from delivery."
          icon={ShieldBan}
          rows={snapshot?.suppression_breakdown}
          keyName="reason"
          loading={portal.isPending}
          failed={portal.isError}
        />
      </div>

      <GovernanceSection
        icon={MapPinned}
        title="Privacy regions"
        description="Policies affect future eligibility checks; deleting one never rewrites historical consent evidence."
      >
        {portal.isPending ? (
          <GovernanceLoading label="Loading privacy regions…" rows={4} />
        ) : portal.isError || !snapshot ? (
          <GovernanceError
            message="Could not verify the configured privacy regions. Add and remove controls remain locked."
            retrying={portal.isFetching}
            onRetry={() => void portal.refetch()}
          />
        ) : (
          <div className="space-y-5">
            {snapshot.regions.length === 0 ? (
              <GovernanceEmpty>
                No privacy regions are configured. Add one so eligibility can
                apply a named framework and consent policy.
              </GovernanceEmpty>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {snapshot.regions.map((region) => (
                  <li key={region.id} className="min-w-0 rounded-xl border p-4">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{region.region_code}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {frameworkLabel(region.framework)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!portalVerified || mutationBusy}
                        onClick={(event) => {
                          operationTriggerRef.current = event.currentTarget;
                          setDeleteRegionTarget(region);
                        }}
                        aria-label={`Remove privacy region ${region.region_code}`}
                      >
                        <Trash2 aria-hidden /> Remove
                      </Button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <PolicyBadge active={region.requires_double_optin}>
                        Double opt-in
                      </PolicyBadge>
                      <PolicyBadge active={region.requires_explicit_consent}>
                        Explicit consent
                      </PolicyBadge>
                      <PolicyBadge active={region.do_not_sell_default}>
                        Do-not-sell default
                      </PolicyBadge>
                      <PolicyBadge active={region.gpc_honored}>
                        GPC honored
                      </PolicyBadge>
                    </div>
                    <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                      {region.id}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Updated{" "}
                      {formatWireTimestamp(region.updated_at, "time unknown")}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <form
              className="space-y-4 rounded-xl border bg-muted/15 p-4"
              onSubmit={(event) => void createRegion(event)}
              noValidate
            >
              <div>
                <h3 className="font-semibold">Add a privacy region</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  The full draft is sent atomically after administrator
                  reauthorization.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="privacy-region-code">Region code</Label>
                  <Input
                    ref={regionCodeRef}
                    id="privacy-region-code"
                    value={regionDraft.region_code}
                    maxLength={44}
                    placeholder="EU / US-CA / BR"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!portalVerified || mutationBusy}
                    aria-invalid={Boolean(regionError && regionValidation)}
                    onChange={(event) => {
                      setRegionDraft((current) => ({
                        ...current,
                        region_code: event.target.value.toUpperCase(),
                      }));
                      setRegionError(null);
                    }}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    2–8 uppercase letters or numbers per hyphen-delimited
                    segment.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="privacy-framework">Framework</Label>
                  <Select
                    id="privacy-framework"
                    value={regionDraft.framework}
                    disabled={!portalVerified || mutationBusy}
                    onChange={(event) =>
                      setRegionDraft((current) => ({
                        ...current,
                        framework: event.target.value as PrivacyFramework,
                      }))
                    }
                  >
                    {FRAMEWORKS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <fieldset
                className="grid gap-3 sm:grid-cols-2"
                disabled={!portalVerified || mutationBusy}
              >
                <legend className="mb-2 text-sm font-medium">
                  Consent requirements and defaults
                </legend>
                <RegionToggle
                  label="Require double opt-in"
                  detail="A confirmed opt-in is required before eligible sends."
                  checked={regionDraft.requires_double_optin}
                  onChange={(checked) =>
                    setRegionDraft((current) => ({
                      ...current,
                      requires_double_optin: checked,
                    }))
                  }
                />
                <RegionToggle
                  label="Require explicit consent"
                  detail="Eligibility requires an explicit consent record."
                  checked={regionDraft.requires_explicit_consent}
                  onChange={(checked) =>
                    setRegionDraft((current) => ({
                      ...current,
                      requires_explicit_consent: checked,
                    }))
                  }
                />
                <RegionToggle
                  label="Enable do-not-sell by default"
                  detail="New regional preferences begin with the restriction."
                  checked={regionDraft.do_not_sell_default}
                  onChange={(checked) =>
                    setRegionDraft((current) => ({
                      ...current,
                      do_not_sell_default: checked,
                    }))
                  }
                />
                <RegionToggle
                  label="Honor Global Privacy Control"
                  detail="Apply recorded browser GPC signals."
                  checked={regionDraft.gpc_honored}
                  onChange={(checked) =>
                    setRegionDraft((current) => ({
                      ...current,
                      gpc_honored: checked,
                    }))
                  }
                />
              </fieldset>
              {regionError ? (
                <p role="alert" className="text-sm text-destructive-emphasis">
                  {regionError}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!regionDirty || mutationBusy}
                  onClick={resetRegionDraft}
                >
                  Reset draft
                </Button>
                <Button
                  type="submit"
                  disabled={!portalVerified || mutationBusy}
                  loading={activeMutation?.scope === "region-create"}
                >
                  <Plus aria-hidden /> Add region
                </Button>
              </div>
            </form>
          </div>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={UserRoundCheck}
        title="Pending double opt-in confirmations"
        description="Extending changes only the existing token deadline; it does not send another email."
      >
        {pending.isPending ? (
          <GovernanceLoading label="Loading pending confirmations…" rows={5} />
        ) : pending.isError || mergedPending.error ? (
          <GovernanceError
            message="Could not verify the pending-confirmation queue. No row actions are available."
            retrying={pending.isFetching}
            onRetry={() => void pending.refetch()}
          />
        ) : mergedPending.rows.length === 0 ? (
          <GovernanceEmpty>No pending confirmations.</GovernanceEmpty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-muted-foreground">
                {mergedPending.rows.length.toLocaleString()} loaded
                {snapshot
                  ? ` · summary reports ${snapshot.double_optin_pending.toLocaleString()}`
                  : ""}
              </p>
              <Button
                ref={pendingRefreshRef}
                type="button"
                variant="outline"
                size="sm"
                disabled={mutationBusy || pending.isFetching}
                onClick={() => void pending.refetch()}
              >
                Refresh queue
              </Button>
            </div>
            <div
              className="overflow-x-auto rounded-xl border"
              role="region"
              aria-label="Pending double opt-in confirmations table"
              tabIndex={0}
            >
              <table className="w-full min-w-[880px] text-left text-sm">
                <caption className="sr-only">
                  Pending double opt-in confirmations and operator actions
                </caption>
                <thead className="bg-muted/45 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Subscriber
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Window started
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Deadline
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      List
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2.5 text-right font-medium"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mergedPending.rows.map((row) => {
                    const rowBusy = activeMutation?.id === row.id;
                    return (
                      <tr key={row.id}>
                        <th
                          scope="row"
                          className="max-w-[20rem] break-all px-3 py-3 font-medium"
                        >
                          {row.email}
                          <span className="mt-1 block font-mono text-[10px] font-normal text-muted-foreground">
                            {row.id}
                          </span>
                        </th>
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          {formatWireTimestamp(row.sent_at, "time unknown")}
                        </td>
                        <td className="px-3 py-3 text-xs text-muted-foreground">
                          {formatWireTimestamp(row.expires_at, "time unknown")}
                        </td>
                        <td className="max-w-[12rem] break-all px-3 py-3 font-mono text-[11px] text-muted-foreground">
                          {row.list_id ?? "Not list-scoped"}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!pendingVerified || mutationBusy}
                              loading={
                                rowBusy &&
                                activeMutation?.scope === "pending-extend"
                              }
                              onClick={() => void extendPending(row)}
                            >
                              Extend 60 days
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={!pendingVerified || mutationBusy}
                              onClick={(event) => {
                                operationTriggerRef.current =
                                  event.currentTarget;
                                setCancelPendingTarget(row);
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pending.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={mutationBusy || pending.isFetchingNextPage}
                loading={pending.isFetchingNextPage}
                onClick={() =>
                  void loadNextQueryPage(pending, pending.isEnabled)
                }
              >
                Load more confirmations
              </Button>
            ) : (
              <p className="text-center text-xs text-muted-foreground">
                End of the verified queue.
              </p>
            )}
          </div>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={Palette}
        title="Preference-center theme"
        description="This saved theme is consumed by the public token page; the preview uses the same logo, accent, footer, and badge decisions."
      >
        {branding.isPending ? (
          <GovernanceLoading
            label="Loading saved preference-center theme…"
            rows={5}
          />
        ) : branding.isError || !brandingDraft ? (
          <GovernanceError
            message="Could not verify the saved preference-center theme. Preview defaults cannot be saved as if they were current state."
            retrying={branding.isFetching}
            onRetry={() => void branding.refetch()}
          />
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void saveBranding();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="preference-logo">Logo URL</Label>
                <Input
                  id="preference-logo"
                  type="url"
                  value={brandingDraft.logo_url}
                  maxLength={2048}
                  placeholder="https://assets.example.com/logo.png"
                  autoComplete="url"
                  spellCheck={false}
                  disabled={!brandingVerified || mutationBusy}
                  aria-invalid={
                    brandingDraft.logo_url !== "" &&
                    !isSafePreferenceLogoURL(brandingDraft.logo_url)
                  }
                  onChange={(event) => {
                    setBrandingDraft((current) =>
                      current
                        ? { ...current, logo_url: event.target.value }
                        : current,
                    );
                    setBrandingError(null);
                  }}
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Public HTTPS only. Credentials, local/private hosts, data
                  URIs, and capability-token referrers are blocked.
                </p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Primary color</legend>
                <div className="flex items-center gap-3">
                  <Input
                    type="color"
                    aria-label="Choose preference-center primary color"
                    className="w-16 shrink-0 p-1"
                    value={
                      HEX_COLOR.test(brandingDraft.primary_color)
                        ? brandingDraft.primary_color
                        : DEFAULT_BRANDING.primary_color
                    }
                    disabled={!brandingVerified || mutationBusy}
                    onChange={(event) =>
                      setBrandingDraft((current) =>
                        current
                          ? {
                              ...current,
                              primary_color: event.target.value.toUpperCase(),
                            }
                          : current,
                      )
                    }
                  />
                  <Input
                    aria-label="Preference-center primary color hex value"
                    value={brandingDraft.primary_color}
                    maxLength={7}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!brandingVerified || mutationBusy}
                    aria-invalid={!HEX_COLOR.test(brandingDraft.primary_color)}
                    onChange={(event) => {
                      setBrandingDraft((current) =>
                        current
                          ? {
                              ...current,
                              primary_color: event.target.value.toUpperCase(),
                            }
                          : current,
                      );
                      setBrandingError(null);
                    }}
                  />
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Buttons automatically use the higher-contrast black or white
                  label for this six-digit hex color.
                </p>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor="preference-footer">Footer text</Label>
                <Textarea
                  id="preference-footer"
                  value={brandingDraft.footer_text}
                  maxLength={4096}
                  rows={4}
                  disabled={!brandingVerified || mutationBusy}
                  aria-invalid={UNSAFE_MULTILINE.test(
                    brandingDraft.footer_text,
                  )}
                  onChange={(event) => {
                    setBrandingDraft((current) =>
                      current
                        ? { ...current, footer_text: event.target.value }
                        : current,
                    );
                    setBrandingError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {new TextEncoder()
                    .encode(brandingDraft.footer_text)
                    .length.toLocaleString()}{" "}
                  of 4,096 bytes
                </p>
              </div>
              <label className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm">
                <Checkbox
                  checked={brandingDraft.show_postwave_badge}
                  disabled={!brandingVerified || mutationBusy}
                  onChange={(event) =>
                    setBrandingDraft((current) =>
                      current
                        ? {
                            ...current,
                            show_postwave_badge: event.target.checked,
                          }
                        : current,
                    )
                  }
                />
                Show “Powered by Moosewave” badge
              </label>
              {brandingError || brandingValidation ? (
                <p role="alert" className="text-sm text-destructive-emphasis">
                  {brandingError ?? brandingValidation}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!brandingVerified || mutationBusy}
                  onClick={() => {
                    setBrandingDraft({ ...DEFAULT_BRANDING });
                    setBrandingError(null);
                  }}
                >
                  Use defaults
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!brandingDirty || mutationBusy}
                  onClick={() => {
                    if (brandingBaseline)
                      setBrandingDraft({ ...brandingBaseline });
                    setBrandingError(null);
                  }}
                >
                  Discard changes
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !brandingVerified ||
                    !brandingDirty ||
                    Boolean(brandingValidation) ||
                    mutationBusy
                  }
                  loading={activeMutation?.scope === "branding-save"}
                >
                  Save theme
                </Button>
              </div>
            </form>

            <section
              aria-label="Hosted preference-center live preview"
              className="self-start overflow-hidden rounded-2xl border border-t-4 bg-card shadow-sm"
              style={{ borderTopColor: brandingDraft.primary_color }}
            >
              <div className="border-b p-4 text-sm font-semibold">
                Live public-page preview
              </div>
              <div className="space-y-4 p-5">
                <div className="flex min-h-14 items-center justify-center rounded-lg border bg-muted/20 p-2">
                  {brandingDraft.logo_url &&
                  isSafePreferenceLogoURL(brandingDraft.logo_url) &&
                  !logoFailed ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={brandingDraft.logo_url}
                      alt="Organization logo preview"
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      decoding="async"
                      onError={() => setLogoFailed(true)}
                      className="max-h-12 max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {brandingDraft.logo_url
                        ? "Logo unavailable until a safe image loads."
                        : "No logo configured."}
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold">Email preferences</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Choose which emails you would like to receive.
                  </p>
                </div>
                <label className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                  <Checkbox
                    checked
                    readOnly
                    style={{ accentColor: brandingDraft.primary_color }}
                  />
                  Product updates
                </label>
                <span
                  className="inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium"
                  style={{
                    backgroundColor: brandingDraft.primary_color,
                    color: preferredContrastingTextColor(
                      brandingDraft.primary_color,
                    ),
                  }}
                >
                  Save preferences
                </span>
              </div>
              {brandingDraft.footer_text ||
              brandingDraft.show_postwave_badge ? (
                <footer className="space-y-1 border-t p-4 text-center text-xs leading-5 text-muted-foreground">
                  {brandingDraft.footer_text ? (
                    <p className="whitespace-pre-wrap break-words">
                      {brandingDraft.footer_text}
                    </p>
                  ) : null}
                  {brandingDraft.show_postwave_badge ? (
                    <p>Powered by Moosewave</p>
                  ) : null}
                </footer>
              ) : null}
            </section>
          </div>
        )}
      </GovernanceSection>

      <p className="sr-only" role="status" aria-live="polite">
        {activeMutation
          ? `Privacy operation ${activeMutation.scope} is in progress.`
          : "No privacy operation is in progress."}
      </p>

      <ConfirmDialog
        open={deleteRegionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteRegionTarget(null);
        }}
        title="Remove privacy region?"
        description={
          deleteRegionTarget
            ? `Remove ${deleteRegionTarget.region_code}? Future eligibility checks will stop applying this framework. Historical consent evidence is retained.`
            : "Remove this privacy region?"
        }
        confirmLabel="Remove region"
        confirmationToken={deleteRegionTarget?.region_code}
        returnFocusRef={operationTriggerRef}
        fallbackFocusRef={regionCodeRef}
        onConfirm={removeRegion}
      />

      <ConfirmDialog
        open={cancelPendingTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelPendingTarget(null);
        }}
        title="Cancel pending confirmation?"
        description={
          cancelPendingTarget
            ? `Cancel ${cancelPendingTarget.email}'s pending confirmation? The token is deleted and the address must opt in again from scratch.`
            : "Cancel this pending confirmation?"
        }
        confirmLabel="Cancel confirmation"
        returnFocusRef={operationTriggerRef}
        fallbackFocusRef={pendingRefreshRef}
        onConfirm={cancelPending}
      />
    </PageShell>
  );
}

function CountList({
  title,
  description,
  icon,
  rows,
  keyName,
  loading,
  failed,
}: {
  title: string;
  description: string;
  icon: typeof ShieldCheck;
  rows:
    | ReadonlyArray<{
        count: number;
        source?: string;
        reason?: string;
      }>
    | undefined;
  keyName: "source" | "reason";
  loading: boolean;
  failed: boolean;
}) {
  return (
    <GovernanceSection icon={icon} title={title} description={description}>
      {loading ? (
        <GovernanceLoading label={`Loading ${title.toLowerCase()}…`} />
      ) : failed || !rows ? (
        <p className="text-sm text-destructive-emphasis">
          This count inventory could not be verified.
        </p>
      ) : rows.length === 0 ? (
        <GovernanceEmpty>No records in this verified snapshot.</GovernanceEmpty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {rows.map((row, index) => {
            const label = keyName === "source" ? row.source : row.reason;
            return (
              <li
                key={`${String(label)}:${index}`}
                className="flex min-w-0 items-center justify-between gap-3 p-3.5"
              >
                <span className="min-w-0 break-words text-sm font-medium capitalize">
                  {String(label).replace(/_/gu, " ")}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {row.count.toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </GovernanceSection>
  );
}

function PolicyBadge({
  active,
  children,
}: {
  active: boolean;
  children: string;
}) {
  return (
    <Badge variant={active ? "success" : "outline"}>
      {children}: {active ? "yes" : "no"}
    </Badge>
  );
}

function RegionToggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-14 items-start gap-3 rounded-lg border p-3">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {detail}
        </span>
      </span>
    </label>
  );
}

function validateRegionDraft(
  draft: PrivacyRegionInput,
  regions: readonly PrivacyRegion[],
): string | null {
  const code = draft.region_code.trim().toUpperCase();
  if (!code) return "Enter a region code.";
  if (!REGION_CODE.test(code)) {
    return "Use 2–8 uppercase letters or numbers per segment, separated by hyphens.";
  }
  if (regions.some((row) => row.region_code === code)) {
    return `${code} is already configured.`;
  }
  return null;
}

function validateBranding(
  draft: PreferenceCentreBrandingInput | null,
): string | null {
  if (!draft) return "The saved theme has not been verified.";
  if (!isSafePreferenceLogoURL(draft.logo_url)) {
    return "Logo URL must be empty or a public HTTPS URL without credentials or a local/private host.";
  }
  if (!HEX_COLOR.test(draft.primary_color)) {
    return "Primary color must be a six-digit hex value such as #123ABC.";
  }
  if (
    new TextEncoder().encode(draft.footer_text).length > 4096 ||
    UNSAFE_MULTILINE.test(draft.footer_text)
  ) {
    return "Footer text must be at most 4,096 bytes and cannot contain unsupported control characters.";
  }
  return null;
}

function sameRegionInput(
  left: PrivacyRegionInput,
  right: PrivacyRegionInput,
): boolean {
  return (
    left.region_code === right.region_code &&
    left.framework === right.framework &&
    left.requires_double_optin === right.requires_double_optin &&
    left.requires_explicit_consent === right.requires_explicit_consent &&
    left.do_not_sell_default === right.do_not_sell_default &&
    left.gpc_honored === right.gpc_honored
  );
}

function brandingInput(
  value: PreferenceCentreBranding,
): PreferenceCentreBrandingInput {
  return {
    logo_url: value.logo_url,
    primary_color: value.primary_color,
    footer_text: value.footer_text,
    show_postwave_badge: value.show_postwave_badge,
  };
}

function sameBranding(
  left: PreferenceCentreBrandingInput,
  right: PreferenceCentreBrandingInput,
): boolean {
  return (
    left.logo_url === right.logo_url &&
    left.primary_color === right.primary_color &&
    left.footer_text === right.footer_text &&
    left.show_postwave_badge === right.show_postwave_badge
  );
}

function frameworkLabel(framework: PrivacyFramework): string {
  return (
    FRAMEWORKS.find((option) => option.value === framework)?.label ??
    framework.toUpperCase()
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
