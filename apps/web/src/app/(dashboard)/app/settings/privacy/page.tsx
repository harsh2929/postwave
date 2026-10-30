// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { RelativeTime } from "@/components/relative-time";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { api, ApiError, apiErrorMessage } from "@/lib/api";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteOwnAccount,
} from "@/lib/account-deletion-api";
import { effectiveAuthRole, logout, whoami } from "@/lib/auth-api";
import {
  DSAR_REQUEST_TYPES,
  dataExportDownloadPath,
  listPrivacyRequests,
  type DsarRequestType,
  type PrivacyRequestRecord,
  type PrivacyRegion,
} from "@/lib/privacy-api";
import { qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  retentionPolicyApi,
  type RetentionPolicy,
} from "@/lib/retention-policy-api";

const PrivacyRequestHistoryCard = dynamic(
  () =>
    import("./privacy-request-history-card").then(
      (module) => module.PrivacyRequestHistoryCard,
    ),
  { loading: () => <PrivacyDeferredCard label="Privacy request history" /> },
);

const ExportRetentionPolicyCard = dynamic(
  () =>
    import("@/components/settings/export-retention-policy-card").then(
      (mod) => mod.ExportRetentionPolicyCard,
    ),
  {
    ssr: false,
    loading: () => <PrivacyDeferredCard label="export retention" />,
  },
);
const WorkspaceExportsCard = dynamic(
  () =>
    import("@/components/settings/workspace-exports-card").then(
      (mod) => mod.WorkspaceExportsCard,
    ),
  {
    ssr: false,
    loading: () => <PrivacyDeferredCard label="workspace exports" />,
  },
);

function PrivacyDeferredCard({ label }: { label: string }) {
  return (
    <Card role="status" aria-live="polite" aria-label={`Loading ${label}`}>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

// Validation ranges mirror apps/api/internal/settings/privacy.go.
const AUDIT_LOG_MIN = 7;
const AUDIT_LOG_MAX = 2555;
const EMAIL_EVENT_MIN = 30;
const EMAIL_EVENT_MAX = 2555;
const UNSUB_MIN = 7;
const UNSUB_MAX = 3650;
const HISTORY_PAGE_SIZE = 10;
const NON_TERMINAL: PrivacyRequestRecord["status"][] = [
  "queued",
  "verifying",
  "in_progress",
];

type SubscriberRequestType = Exclude<
  DsarRequestType,
  "subscriber_erasure" | "appeal"
>;

// POST /api/v1/privacy/requests deliberately refuses subscriber_erasure
// (created by the subscriber SAR intake) and appeal (requires a parent id).
// Offering those values here used to guarantee a 400 from the mounted route.
const SUBSCRIBER_REQUEST_TYPES = DSAR_REQUEST_TYPES.filter(
  (
    option,
  ): option is (typeof DSAR_REQUEST_TYPES)[number] & {
    value: SubscriberRequestType;
  } => option.value !== "subscriber_erasure" && option.value !== "appeal",
);

const REGION_OPTIONS: { value: PrivacyRegion; label: string }[] = [
  { value: "OTHER", label: "Other / default" },
  { value: "GDPR", label: "EU / UK GDPR" },
  { value: "CCPA", label: "California CCPA" },
  { value: "LGPD", label: "Brazil LGPD" },
];

export default function PrivacyPage() {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite =
    meQuery.isSuccess && !meQuery.data.viewer_mode && roleCanWrite(role);
  const authorityKey = meQuery.isSuccess
    ? [
        tenantId,
        meQuery.data.user_id,
        role ?? "none",
        meQuery.data.viewer_mode ? "viewer" : "member",
      ].join(":")
    : "unverified";
  const authorityKeyRef = useRef(authorityKey);
  const adminControllersRef = useRef(new Set<AbortController>());

  // Retention fields are strings so an emptied field stays empty (not silently
  // coerced to 0), with per-field inline validation (SETA-025).
  const [auditLogDays, setAuditLogDays] = useState("");
  const [emailEventDays, setEmailEventDays] = useState("");
  const [unsubDays, setUnsubDays] = useState("");
  const [retentionSaving, setRetentionSaving] = useState(false);
  const retentionSavingRef = useRef(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [deletionMfaCode, setDeletionMfaCode] = useState("");
  const [workspaceConfirmText, setWorkspaceConfirmText] = useState("");
  const [region, setRegion] = useState<PrivacyRegion>("OTHER");
  const [deletionRegion, setDeletionRegion] = useState<PrivacyRegion>("OTHER");
  const [workspaceRegion, setWorkspaceRegion] =
    useState<PrivacyRegion>("OTHER");
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [workspaceDeleteOpen, setWorkspaceDeleteOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [workspaceDeleteBusy, setWorkspaceDeleteBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState<
    string | null
  >(null);
  const [lastExportRequestId, setLastExportRequestId] = useState<string | null>(
    null,
  );

  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const dsarTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceDeleteTriggerRef = useRef<HTMLButtonElement>(null);
  const exportBusyRef = useRef(false);
  const dsarBusyRef = useRef(false);
  const deleteBusyRef = useRef(false);
  const workspaceDeleteBusyRef = useRef(false);
  const exportIntentRef = useRef<MutationIntent | null>(null);
  const dsarIntentRef = useRef<MutationIntent | null>(null);
  const deleteIntentRef = useRef<MutationIntent | null>(null);
  const workspaceDeleteIntentRef = useRef<MutationIntent | null>(null);

  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    for (const controller of adminControllersRef.current) controller.abort();
    adminControllersRef.current.clear();
    exportBusyRef.current = false;
    dsarBusyRef.current = false;
    workspaceDeleteBusyRef.current = false;
    setExportBusy(false);
    setDsarBusy(false);
    setWorkspaceDeleteBusy(false);
    retentionSavingRef.current = false;
    setRetentionSaving(false);
    setExportOpen(false);
    setDsarOpen(false);
    setWorkspaceDeleteOpen(false);
    setDeleteOpen(false);
    setRegion("OTHER");
    setWorkspaceRegion("OTHER");
    setWorkspaceConfirmText("");
    setConfirmText("");
    setDeletionPassword("");
    setDeletionMfaCode("");
    setDsarEmail("");
    setDsarNotes("");
    setLastExportRequestId(null);
    exportIntentRef.current = null;
    dsarIntentRef.current = null;
    workspaceDeleteIntentRef.current = null;
    deleteIntentRef.current = null;
  }, [authorityKey]);

  // DSAR (subscriber-rights) creation.
  const [dsarOpen, setDsarOpen] = useState(false);
  const [dsarType, setDsarType] = useState<SubscriberRequestType>("correction");
  const [dsarEmail, setDsarEmail] = useState("");
  const [dsarRegion, setDsarRegion] = useState<PrivacyRegion>("GDPR");
  const [dsarNotes, setDsarNotes] = useState("");
  const [dsarBusy, setDsarBusy] = useState(false);
  const [dsarEmailTouched, setDsarEmailTouched] = useState(false);
  const [dsarError, setDsarError] = useState<string | null>(null);
  const dsarEmailRef = useRef<HTMLInputElement>(null);

  // History filters + pagination.
  const [histType, setHistType] = useState("all");
  const [histStatus, setHistStatus] = useState("all");
  const [histSearch, setHistSearch] = useState("");
  const [histPage, setHistPage] = useState(1);

  const canDelete =
    Boolean(meQuery.data) &&
    confirmText === ACCOUNT_DELETION_CONFIRMATION &&
    (meQuery.data?.auth_provider !== "password" ||
      deletionPassword.length > 0) &&
    (!meQuery.data?.totp_enabled || deletionMfaCode.length === 6);
  const canDeleteWorkspace = workspaceConfirmText === "DELETE WORKSPACE";

  const retentionKey = useMemo(
    () => [...qk.settings(tenantId, role, "privacy-retention"), authorityKey],
    [authorityKey, role, tenantId],
  );
  const requestsKey = useMemo(
    () => [...qk.settings(tenantId, role, "privacy-requests"), authorityKey],
    [authorityKey, role, tenantId],
  );
  const previousProtectedKeysRef = useRef({ retentionKey, requestsKey });
  useEffect(() => {
    const previous = previousProtectedKeysRef.current;
    previousProtectedKeysRef.current = { retentionKey, requestsKey };
    if (previous.retentionKey === retentionKey) return;
    void queryClient.cancelQueries({
      queryKey: previous.retentionKey,
      exact: true,
    });
    void queryClient.cancelQueries({
      queryKey: previous.requestsKey,
      exact: true,
    });
    queryClient.removeQueries({ queryKey: previous.retentionKey, exact: true });
    queryClient.removeQueries({ queryKey: previous.requestsKey, exact: true });
    setAuditLogDays("");
    setEmailEventDays("");
    setUnsubDays("");
  }, [queryClient, requestsKey, retentionKey]);
  const retentionQuery = useQuery({
    queryKey: retentionKey,
    queryFn: ({ signal }) => retentionPolicyApi.get(signal),
    // Backend intentionally permits every authenticated tenant member to read
    // retention policy; only PATCH is ScopeAdmin.
    enabled: meQuery.isSuccess,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
    staleTime: STALE.detail,
  });
  const requestsQuery = useQuery({
    queryKey: requestsKey,
    queryFn: ({ signal }) => listPrivacyRequests(signal),
    enabled: canWrite,
    staleTime: STALE.list,
    // Poll while any request is in a non-terminal state (SETA-053).
    refetchInterval: (query) => {
      const rows = Array.isArray(query.state.data?.requests)
        ? query.state.data?.requests
        : [];
      return rows.some((r) => NON_TERMINAL.includes(r.status)) ? 15_000 : false;
    },
  });
  const policy = retentionQuery.data ?? null;
  // The default policy has Go's zero time, rather than a recorded change.
  const retentionUpdatedAt =
    policy?.updated_at &&
    Number.isFinite(Date.parse(policy.updated_at)) &&
    new Date(policy.updated_at).getUTCFullYear() > 1
      ? policy.updated_at
      : null;
  const retentionLoading =
    meQuery.isLoading || (retentionQuery.isPending && !retentionQuery.data);
  const requests = Array.isArray(requestsQuery.data?.requests)
    ? requestsQuery.data?.requests
    : [];
  // `requestsQuery` is `enabled: canWrite`, and a disabled TanStack query stays
  // `isPending` forever — so without the canWrite term a non-admin got two
  // skeleton bars that never resolve, and never reached the read-only
  // explanation below.
  const requestsLoading =
    meQuery.isLoading ||
    (canWrite && requestsQuery.isPending && !requestsQuery.data);

  // Hydrate the retention form from the server once (and whenever it reloads),
  // only while the form is pristine so in-progress edits aren't clobbered.
  const retentionDirty =
    policy !== null &&
    (auditLogDays !== String(policy.audit_log_retention_days) ||
      emailEventDays !== String(policy.email_event_retention_days) ||
      unsubDays !== String(policy.unsubscribed_subscriber_retention_days));
  useEffect(() => {
    if (!policy) return;
    setAuditLogDays((cur) =>
      cur === "" ? String(policy.audit_log_retention_days) : cur,
    );
    setEmailEventDays((cur) =>
      cur === "" ? String(policy.email_event_retention_days) : cur,
    );
    setUnsubDays((cur) =>
      cur === "" ? String(policy.unsubscribed_subscriber_retention_days) : cur,
    );
  }, [policy]);

  useUnsavedChangesGuard(retentionDirty && !retentionSaving);
  // Readable after an await — see onSaveRetention.
  const retentionRef = useRef(`${auditLogDays}|${emailEventDays}|${unsubDays}`);
  retentionRef.current = `${auditLogDays}|${emailEventDays}|${unsubDays}`;

  useEffect(() => {
    setHistPage(1);
  }, [histType, histStatus, histSearch]);

  const auditLogError = fieldError(auditLogDays, AUDIT_LOG_MIN, AUDIT_LOG_MAX);
  const emailEventError = fieldError(
    emailEventDays,
    EMAIL_EVENT_MIN,
    EMAIL_EVENT_MAX,
  );
  const unsubError = fieldError(unsubDays, UNSUB_MIN, UNSUB_MAX);
  const retentionValid = !auditLogError && !emailEventError && !unsubError;
  const dsarEmailError = subscriberEmailError(dsarEmail);
  const accountConfirmationError = exactTokenError(
    confirmText,
    ACCOUNT_DELETION_CONFIRMATION,
  );
  const workspaceConfirmationError = exactTokenError(
    workspaceConfirmText,
    "DELETE WORKSPACE",
  );
  const deletionMfaError =
    deletionMfaCode.length > 0 && deletionMfaCode.length !== 6
      ? "Enter all 6 digits."
      : null;

  const invalidateRequests = (): Promise<void> =>
    queryClient
      .invalidateQueries({ queryKey: requestsKey, exact: false })
      .then(() => undefined);

  const refreshRequestsInBackground = () => {
    void invalidateRequests().catch(() => undefined);
  };

  const beginAdminMutation = () => {
    if (!canWrite || !meQuery.data) return null;
    const controller = new AbortController();
    adminControllersRef.current.add(controller);
    return { controller, identity: meQuery.data, authority: authorityKey };
  };

  const onExportOpenChange = (open: boolean) => {
    if (!open && exportBusyRef.current) return;
    setExportOpen(open);
    setExportError(null);
    if (!open) {
      setRegion("OTHER");
      exportIntentRef.current = null;
    }
  };

  const onDsarOpenChange = (open: boolean) => {
    if (!open && dsarBusyRef.current) return;
    setDsarOpen(open);
    setDsarError(null);
    if (!open) {
      setDsarType("correction");
      setDsarEmail("");
      setDsarRegion("GDPR");
      setDsarNotes("");
      setDsarEmailTouched(false);
      dsarIntentRef.current = null;
    }
  };

  const onDeleteOpenChange = (open: boolean) => {
    if (deleteBusyRef.current) return;
    setDeleteOpen(open);
    setDeleteError(null);
    if (!open) {
      setConfirmText("");
      setDeletionPassword("");
      setDeletionMfaCode("");
      setDeletionRegion("OTHER");
      deleteIntentRef.current = null;
    }
  };

  const onWorkspaceDeleteOpenChange = (open: boolean) => {
    if (!open && workspaceDeleteBusyRef.current) return;
    setWorkspaceDeleteOpen(open);
    setWorkspaceDeleteError(null);
    if (!open) {
      setWorkspaceConfirmText("");
      setWorkspaceRegion("OTHER");
      workspaceDeleteIntentRef.current = null;
    }
  };

  const onSaveRetention = async () => {
    if (retentionSavingRef.current) return;
    if (!retentionValid) {
      setRetentionError("Fix the highlighted fields before saving.");
      return;
    }
    const mutation = beginAdminMutation();
    if (!mutation) return;
    retentionSavingRef.current = true;
    setRetentionSaving(true);
    setRetentionError(null);
    // The three inputs stay enabled during a save, so record what went to the
    // server; adopting the response unconditionally reverted anything typed
    // while the request was open.
    const sent = `${auditLogDays}|${emailEventDays}|${unsubDays}`;
    try {
      await verifyFreshAdminAuthority(
        mutation.identity,
        mutation.controller.signal,
      );
      const updated = await retentionPolicyApi.patch(
        {
          audit_log_retention_days: Number(auditLogDays),
          email_event_retention_days: Number(emailEventDays),
          unsubscribed_subscriber_retention_days: Number(unsubDays),
        },
        mutation.controller.signal,
      );
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      queryClient.setQueryData<RetentionPolicy>(retentionKey, updated);
      if (retentionRef.current === sent) {
        setAuditLogDays(String(updated.audit_log_retention_days));
        setEmailEventDays(String(updated.email_event_retention_days));
        setUnsubDays(String(updated.unsubscribed_subscriber_retention_days));
      }
      toast.success("Retention policy saved.");
      void queryClient.invalidateQueries({
        queryKey: retentionKey,
        exact: false,
      });
    } catch (e) {
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      const msg = retentionErrorMessage(e, "Could not save retention policy.");
      setRetentionError(msg);
      toast.error(msg);
    } finally {
      adminControllersRef.current.delete(mutation.controller);
      retentionSavingRef.current = false;
      setRetentionSaving(false);
    }
  };

  const onRequestExport = async () => {
    if (exportBusyRef.current) return;
    const mutation = beginAdminMutation();
    if (!mutation) return;
    const body = { region };
    const intentKey = keyForIntent(exportIntentRef, JSON.stringify(body));
    exportBusyRef.current = true;
    setExportBusy(true);
    setExportError(null);
    try {
      await verifyFreshAdminAuthority(
        mutation.identity,
        mutation.controller.signal,
      );
      const res = await postPrivacyWorkflow(
        "/api/v1/privacy/export-requests",
        body,
        intentKey,
        "export request",
        mutation.controller.signal,
      );
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setLastExportRequestId(res.request_id);
      setExportOpen(false);
      setRegion("OTHER");
      exportIntentRef.current = null;
      refreshRequestsInBackground();
      toast.success(
        `Export request queued (${res.request_id}). Response target: ${new Date(
          res.estimated_ready_at,
        ).toLocaleDateString()}.`,
      );
    } catch (err) {
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setExportError(apiErrorMessage(err, "Could not queue the export."));
    } finally {
      adminControllersRef.current.delete(mutation.controller);
      exportBusyRef.current = false;
      setExportBusy(false);
    }
  };

  const onCreateDsar = async () => {
    const email = dsarEmail.trim();
    setDsarEmailTouched(true);
    if (subscriberEmailError(email)) {
      dsarEmailRef.current?.focus();
      return;
    }
    if (dsarBusyRef.current) return;
    const mutation = beginAdminMutation();
    if (!mutation) return;
    const body = {
      request_type: dsarType,
      subject_email: email,
      region: dsarRegion,
      ...(dsarNotes.trim() ? { notes: dsarNotes.trim() } : {}),
    };
    const intentKey = keyForIntent(dsarIntentRef, JSON.stringify(body));
    dsarBusyRef.current = true;
    setDsarBusy(true);
    setDsarError(null);
    try {
      await verifyFreshAdminAuthority(
        mutation.identity,
        mutation.controller.signal,
      );
      const res = await postSubscriberRequest(
        body,
        intentKey,
        mutation.controller.signal,
      );
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setDsarOpen(false);
      setDsarType("correction");
      setDsarEmail("");
      setDsarRegion("GDPR");
      setDsarNotes("");
      setDsarEmailTouched(false);
      dsarIntentRef.current = null;
      refreshRequestsInBackground();
      toast.success(`Request filed (${res.request_id}).`);
    } catch (err) {
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setDsarError(apiErrorMessage(err, "Could not file the request."));
    } finally {
      adminControllersRef.current.delete(mutation.controller);
      dsarBusyRef.current = false;
      setDsarBusy(false);
    }
  };

  const onDeleteOwnAccount = async () => {
    if (!canDelete || deleteBusyRef.current) return;
    const input = {
      confirmation: confirmText as typeof ACCOUNT_DELETION_CONFIRMATION,
      password:
        meQuery.data?.auth_provider === "password"
          ? deletionPassword
          : undefined,
      mfa_code: meQuery.data?.totp_enabled ? deletionMfaCode : undefined,
      region: deletionRegion,
    };
    const intentKey = keyForIntent(deleteIntentRef, JSON.stringify(input));
    deleteBusyRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    let redirectToLogin = false;
    try {
      const res = await deleteOwnAccount(input, intentKey);
      const acknowledgement = accountDeletionAcknowledgement(res);
      setDeleteOpen(false);
      setConfirmText("");
      setDeletionPassword("");
      setDeletionMfaCode("");
      setDeletionRegion("OTHER");
      deleteIntentRef.current = null;
      toast.success(
        `Personal account deletion request accepted (${acknowledgement.request_id}). Current status: ${acknowledgement.status.replaceAll("_", " ")}.`,
      );
      await logout().catch(() => undefined);
      redirectToLogin = true;
    } catch (err) {
      setDeleteError(
        apiErrorMessage(err, "Could not queue personal account deletion."),
      );
    } finally {
      deleteBusyRef.current = false;
      setDeleteBusy(false);
    }
    if (redirectToLogin) {
      window.location.assign("/login?account-deletion=requested");
    }
  };

  const onRequestWorkspaceDeletion = async () => {
    if (!canDeleteWorkspace || workspaceDeleteBusyRef.current) return;
    const mutation = beginAdminMutation();
    if (!mutation) return;
    const body = { region: workspaceRegion };
    const intentKey = keyForIntent(
      workspaceDeleteIntentRef,
      JSON.stringify(body),
    );
    workspaceDeleteBusyRef.current = true;
    setWorkspaceDeleteBusy(true);
    setWorkspaceDeleteError(null);
    try {
      await verifyFreshAdminAuthority(
        mutation.identity,
        mutation.controller.signal,
      );
      const res = await postPrivacyWorkflow(
        "/api/v1/privacy/deletion-requests",
        body,
        intentKey,
        "workspace deletion review",
        mutation.controller.signal,
      );
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setWorkspaceDeleteOpen(false);
      setWorkspaceConfirmText("");
      setWorkspaceRegion("OTHER");
      workspaceDeleteIntentRef.current = null;
      refreshRequestsInBackground();
      toast.success(`Workspace deletion review queued (${res.request_id}).`);
    } catch (err) {
      if (
        mutation.controller.signal.aborted ||
        authorityKeyRef.current !== mutation.authority
      )
        return;
      setWorkspaceDeleteError(
        apiErrorMessage(err, "Could not queue workspace deletion review."),
      );
    } finally {
      adminControllersRef.current.delete(mutation.controller);
      workspaceDeleteBusyRef.current = false;
      setWorkspaceDeleteBusy(false);
    }
  };

  const filteredRequests = requests.filter((r) => {
    if (histType !== "all" && r.type !== histType) return false;
    if (histStatus !== "all" && r.status !== histStatus) return false;
    if (histSearch.trim()) {
      const q = histSearch.trim().toLowerCase();
      const haystack = `${r.request_id} ${r.subject_email ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const pageCount = Math.max(
    1,
    Math.ceil(filteredRequests.length / HISTORY_PAGE_SIZE),
  );
  const page = Math.min(histPage, pageCount);
  const pagedRequests = filteredRequests.slice(
    (page - 1) * HISTORY_PAGE_SIZE,
    page * HISTORY_PAGE_SIZE,
  );

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Privacy &amp; data
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Retention, exports, subscriber-rights requests, and account deletion.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Data retention</CardTitle>
          <CardDescription>
            How long we keep your data. Sensible defaults; tighten if your
            compliance team asks. Values are in days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {retentionLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : retentionQuery.isError ? (
            // Load failed. Without this the form renders with blank fields,
            // which reads like "no policy configured" rather than "we could
            // not read your policy" — and the API never 404s a missing one
            // (it returns the defaults), so any error here is a real failure.
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
            >
              <span>
                Could not load your retention policy. These are not your saved
                values.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void retentionQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void onSaveRetention();
              }}
            >
              <RetentionField
                id="audit-log-days"
                label={`Audit log retention (${AUDIT_LOG_MIN}–${AUDIT_LOG_MAX} days)`}
                hint="Per-mutation audit_log rows older than this are eligible for the trim cron. Default 90 days."
                value={auditLogDays}
                error={auditLogError}
                disabled={!canWrite}
                min={AUDIT_LOG_MIN}
                max={AUDIT_LOG_MAX}
                onChange={setAuditLogDays}
              />
              <RetentionField
                id="email-event-days"
                label={`Email event retention (${EMAIL_EVENT_MIN}–${EMAIL_EVENT_MAX} days)`}
                hint="Aggregate analytics survive trimming regardless."
                value={emailEventDays}
                error={emailEventError}
                disabled={!canWrite}
                min={EMAIL_EVENT_MIN}
                max={EMAIL_EVENT_MAX}
                onChange={setEmailEventDays}
              />
              <RetentionField
                id="unsub-days"
                label={`Unsubscribed subscriber retention (${UNSUB_MIN}–${UNSUB_MAX} days)`}
                hint="Opted-out subscribers are kept this long for compliance audit before purge."
                value={unsubDays}
                error={unsubError}
                disabled={!canWrite}
                min={UNSUB_MIN}
                max={UNSUB_MAX}
                onChange={setUnsubDays}
              />
              {retentionError ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
                >
                  {retentionError}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                {retentionUpdatedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Last changed <RelativeTime iso={retentionUpdatedAt} />
                    {policy?.updated_by_user_id ? (
                      <>
                        {" "}
                        by{" "}
                        <span className="font-mono">
                          {policy.updated_by_user_id.slice(0, 8)}
                        </span>
                      </>
                    ) : null}
                    .
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No retention policy change has been recorded.
                  </p>
                )}
                {canWrite ? (
                  <Button
                    type="submit"
                    disabled={
                      retentionSaving || !retentionDirty || !retentionValid
                    }
                  >
                    {retentionSaving ? "Saving…" : "Save retention policy"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Read-only — only workspace admins can change retention.
                  </p>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <ExportRetentionPolicyCard />

      <WorkspaceExportsCard />

      <Card>
        <CardHeader>
          <CardTitle>Export your data</CardTitle>
          <CardDescription>
            GDPR Article 20: portable, machine-readable export of subscribers,
            campaigns, automations, and consent records.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {canWrite ? (
            <Dialog open={exportOpen} onOpenChange={onExportOpenChange}>
              <DialogTrigger asChild>
                <Button
                  ref={exportTriggerRef}
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                >
                  Export all data
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={exportBusy}
                className="min-w-0 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
                onEscapeKeyDown={(event) => {
                  if (exportBusyRef.current) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                  if (exportBusyRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) =>
                  restoreDialogFocus(event, exportTriggerRef)
                }
              >
                <form
                  className="min-w-0 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onRequestExport();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle className="break-words leading-snug">
                      Request a full export
                    </DialogTitle>
                    <DialogDescription className="break-words leading-5">
                      This records an audited, tenant-scoped export request.
                      From this dashboard, an admin can then generate and
                      download the workspace ZIP locally; the request remains
                      visible in privacy history.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="export-region">Legal region</Label>
                    <Select
                      id="export-region"
                      className="min-h-11 sm:min-h-9"
                      value={region}
                      disabled={exportBusy}
                      onChange={(event) => {
                        setRegion(event.target.value as PrivacyRegion);
                        setExportError(null);
                      }}
                    >
                      {REGION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <MutationFailure
                    id="export-request-error"
                    message={exportError}
                  />
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={exportBusy}
                      >
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" loading={exportBusy}>
                      {exportBusy
                        ? "Queueing…"
                        : exportError
                          ? "Try again"
                          : "Start export"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : (
            <p className="text-sm text-muted-foreground">
              Read-only — only workspace admins can request a workspace export.
            </p>
          )}
          {lastExportRequestId && (
            <div className="min-w-0 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="font-medium">Latest export request recorded</div>
              <p className="mt-1 break-words text-muted-foreground">
                Request{" "}
                <span className="break-all font-mono text-xs">
                  {lastExportRequestId}
                </span>{" "}
                has been audited. Downloading generates the local workspace ZIP
                for this request.
              </p>
              <Button
                asChild
                type="button"
                variant="outline"
                className="mt-3 min-h-11 sm:min-h-9"
              >
                <a href={dataExportDownloadPath(lastExportRequestId)}>
                  Download ZIP
                </a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* The mounted generic intake accepts correction and opt-out variants.
          Subscriber erasure and appeals have separate backend entry points. */}
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Subscriber data requests</CardTitle>
            <CardDescription>
              File a correction, opt-out, or sensitive-data limitation request
              on a subscriber&apos;s behalf. Erasure and appeals use their
              dedicated intake workflows. Every filed request appears in the
              auditable history below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Dialog open={dsarOpen} onOpenChange={onDsarOpenChange}>
              <DialogTrigger asChild>
                <Button
                  ref={dsarTriggerRef}
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                >
                  New subscriber request
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={dsarBusy}
                className="min-w-0 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
                onEscapeKeyDown={(event) => {
                  if (dsarBusyRef.current) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                  if (dsarBusyRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) =>
                  restoreDialogFocus(event, dsarTriggerRef)
                }
              >
                <form
                  className="min-w-0 space-y-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onCreateDsar();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle className="break-words leading-snug">
                      New subscriber data request
                    </DialogTitle>
                    <DialogDescription className="break-words leading-5">
                      This files a request for the named data subject. The
                      privacy workflow verifies and processes it; its status
                      remains visible in the history below.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="dsar-type">Request type</Label>
                      <Select
                        id="dsar-type"
                        className="min-h-11 sm:min-h-9"
                        value={dsarType}
                        disabled={dsarBusy}
                        aria-describedby="dsar-type-help"
                        onChange={(event) => {
                          setDsarType(
                            event.target.value as SubscriberRequestType,
                          );
                          setDsarError(null);
                        }}
                      >
                        {SUBSCRIBER_REQUEST_TYPES.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                      <p
                        id="dsar-type-help"
                        className="break-words text-xs leading-5 text-muted-foreground"
                      >
                        {
                          SUBSCRIBER_REQUEST_TYPES.find(
                            (option) => option.value === dsarType,
                          )?.description
                        }
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dsar-email">Subject email</Label>
                      <Input
                        ref={dsarEmailRef}
                        id="dsar-email"
                        type="email"
                        className="min-h-11 sm:min-h-9"
                        value={dsarEmail}
                        required
                        maxLength={254}
                        disabled={dsarBusy}
                        aria-invalid={
                          dsarEmailTouched && Boolean(dsarEmailError)
                        }
                        aria-describedby={
                          dsarEmailTouched && dsarEmailError
                            ? "dsar-email-error"
                            : "dsar-email-help"
                        }
                        onBlur={() => setDsarEmailTouched(true)}
                        onChange={(event) => {
                          setDsarEmail(event.target.value);
                          setDsarError(null);
                        }}
                        placeholder="subscriber@example.com"
                        autoComplete="off"
                      />
                      {dsarEmailTouched && dsarEmailError ? (
                        <p
                          id="dsar-email-error"
                          className="text-xs text-destructive"
                        >
                          {dsarEmailError}
                        </p>
                      ) : (
                        <p
                          id="dsar-email-help"
                          className="text-xs text-muted-foreground"
                        >
                          Required. This identifies the data subject.
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dsar-region">Legal region</Label>
                      <Select
                        id="dsar-region"
                        className="min-h-11 sm:min-h-9"
                        value={dsarRegion}
                        disabled={dsarBusy}
                        onChange={(event) => {
                          setDsarRegion(event.target.value as PrivacyRegion);
                          setDsarError(null);
                        }}
                      >
                        {REGION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dsar-notes">Notes (optional)</Label>
                      <Textarea
                        id="dsar-notes"
                        value={dsarNotes}
                        disabled={dsarBusy}
                        onChange={(event) => {
                          setDsarNotes(event.target.value);
                          setDsarError(null);
                        }}
                        placeholder="Context for the reviewer…"
                        rows={3}
                      />
                    </div>
                  </div>
                  <MutationFailure
                    id="dsar-request-error"
                    message={dsarError}
                  />
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost" type="button" disabled={dsarBusy}>
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" loading={dsarBusy}>
                      {dsarBusy
                        ? "Filing…"
                        : dsarError
                          ? "Try filing again"
                          : "File request"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      ) : null}

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Delete my account</CardTitle>
          <CardDescription>
            Requests permanent removal of your personal login, profile,
            sessions, linked identities, MFA secret, and device preferences.
            Shared workspace campaigns, subscribers, content, billing, and other
            members remain.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Dialog open={deleteOpen} onOpenChange={onDeleteOpenChange}>
            <DialogTrigger asChild>
              <Button
                ref={deleteTriggerRef}
                type="button"
                variant="destructive"
                className="min-h-11 sm:min-h-9"
                disabled={!meQuery.data}
                aria-disabled={deleteBusy || undefined}
              >
                Delete my account
              </Button>
            </DialogTrigger>
            <DialogContent
              aria-busy={deleteBusy}
              className="min-w-0 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
              onEscapeKeyDown={(event) => {
                if (deleteBusyRef.current) event.preventDefault();
              }}
              onInteractOutside={(event) => {
                if (deleteBusyRef.current) event.preventDefault();
              }}
              onCloseAutoFocus={(event) =>
                restoreDialogFocus(event, deleteTriggerRef)
              }
            >
              <form
                className="min-w-0 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onDeleteOwnAccount();
                }}
              >
                <DialogHeader>
                  <DialogTitle className="break-words leading-snug">
                    Delete your personal account?
                  </DialogTitle>
                  <DialogDescription className="break-words leading-5">
                    Type{" "}
                    <code className="break-all font-mono">
                      DELETE MY ACCOUNT
                    </code>{" "}
                    exactly. The server verifies this exact phrase and your
                    recent authentication. This does not delete the workspace.
                    If you are its last owner, transfer ownership first. A legal
                    hold may delay completion; limited security, billing, legal,
                    immutable audit, and encrypted backup records follow their
                    retention schedules.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="confirm-delete">Confirmation phrase</Label>
                    <Input
                      id="confirm-delete"
                      className="min-h-11 font-mono sm:min-h-9"
                      value={confirmText}
                      required
                      disabled={deleteBusy}
                      aria-invalid={Boolean(accountConfirmationError)}
                      aria-describedby={
                        accountConfirmationError
                          ? "confirm-delete-error"
                          : "confirm-delete-help"
                      }
                      onChange={(event) => {
                        setConfirmText(event.target.value);
                        setDeleteError(null);
                      }}
                      placeholder="DELETE MY ACCOUNT"
                      autoComplete="off"
                      autoFocus
                    />
                    {accountConfirmationError ? (
                      <p
                        id="confirm-delete-error"
                        className="text-xs text-destructive"
                      >
                        {accountConfirmationError}
                      </p>
                    ) : (
                      <p
                        id="confirm-delete-help"
                        className="text-xs text-muted-foreground"
                      >
                        Case and spacing must match exactly.
                      </p>
                    )}
                  </div>
                  {meQuery.data?.auth_provider === "password" ? (
                    <div className="space-y-2">
                      <Label htmlFor="delete-password">Current password</Label>
                      <Input
                        id="delete-password"
                        type="password"
                        className="min-h-11 sm:min-h-9"
                        value={deletionPassword}
                        required
                        disabled={deleteBusy}
                        aria-describedby="delete-password-help"
                        onChange={(event) => {
                          setDeletionPassword(event.target.value);
                          setDeleteError(null);
                        }}
                        autoComplete="current-password"
                      />
                      <p
                        id="delete-password-help"
                        className="text-xs text-muted-foreground"
                      >
                        Required to reauthenticate this deletion request.
                      </p>
                    </div>
                  ) : (
                    <p className="break-words text-xs leading-5 text-muted-foreground">
                      For {meQuery.data?.auth_provider} sign-in, this action
                      requires a provider session issued within the last five
                      minutes. Sign out and sign in again if prompted.
                    </p>
                  )}
                  {meQuery.data?.totp_enabled ? (
                    <div className="space-y-2">
                      <Label htmlFor="delete-mfa-code">
                        Authenticator code
                      </Label>
                      <Input
                        id="delete-mfa-code"
                        className="min-h-11 font-mono tracking-[0.2em] sm:min-h-9"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        pattern="[0-9]{6}"
                        required
                        disabled={deleteBusy}
                        aria-invalid={Boolean(deletionMfaError)}
                        aria-describedby={
                          deletionMfaError
                            ? "delete-mfa-error"
                            : "delete-mfa-help"
                        }
                        value={deletionMfaCode}
                        onChange={(event) => {
                          setDeletionMfaCode(
                            event.target.value.replace(/\D/g, ""),
                          );
                          setDeleteError(null);
                        }}
                      />
                      {deletionMfaError ? (
                        <p
                          id="delete-mfa-error"
                          className="text-xs text-destructive"
                        >
                          {deletionMfaError}
                        </p>
                      ) : (
                        <p
                          id="delete-mfa-help"
                          className="text-xs text-muted-foreground"
                        >
                          Enter the current 6-digit code.
                        </p>
                      )}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="delete-region">Legal region</Label>
                    <Select
                      id="delete-region"
                      className="min-h-11 sm:min-h-9"
                      value={deletionRegion}
                      disabled={deleteBusy}
                      onChange={(event) => {
                        setDeletionRegion(event.target.value as PrivacyRegion);
                        setDeleteError(null);
                      }}
                    >
                      {REGION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <MutationFailure
                  id="account-delete-error"
                  message={deleteError}
                />
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost" type="button" disabled={deleteBusy}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={!canDelete}
                    loading={deleteBusy}
                    className="whitespace-normal text-center leading-5"
                  >
                    {deleteBusy
                      ? "Queueing…"
                      : deleteError
                        ? "Try deletion again"
                        : "Permanently delete my account"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {meQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Account details could not be loaded, so deletion is unavailable.
              Refresh the page and try again.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {role === "owner" || role === "admin" ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle>Request workspace deletion</CardTitle>
            <CardDescription>
              Separate administrative review for deleting the whole workspace,
              including shared customer data and billing resources. This is not
              the personal account-deletion action above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Dialog
              open={workspaceDeleteOpen}
              onOpenChange={onWorkspaceDeleteOpenChange}
            >
              <DialogTrigger asChild>
                <Button
                  ref={workspaceDeleteTriggerRef}
                  type="button"
                  variant="outline"
                  className="min-h-11 sm:min-h-9"
                >
                  Request workspace deletion
                </Button>
              </DialogTrigger>
              <DialogContent
                aria-busy={workspaceDeleteBusy}
                className="min-w-0 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
                onEscapeKeyDown={(event) => {
                  if (workspaceDeleteBusyRef.current) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                  if (workspaceDeleteBusyRef.current) event.preventDefault();
                }}
                onCloseAutoFocus={(event) =>
                  restoreDialogFocus(event, workspaceDeleteTriggerRef)
                }
              >
                <form
                  className="min-w-0 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onRequestWorkspaceDeletion();
                  }}
                >
                  <DialogHeader>
                    <DialogTitle className="break-words leading-snug">
                      Request deletion of this workspace?
                    </DialogTitle>
                    <DialogDescription className="break-words leading-5">
                      To prevent an accidental request in this screen, type{" "}
                      <code className="break-all font-mono">
                        DELETE WORKSPACE
                      </code>{" "}
                      exactly. This browser-side confirmation is not a second
                      authentication factor. The API queues an owner/admin
                      privacy review; it does not immediately erase the
                      workspace.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="confirm-workspace-delete">
                        Confirmation phrase
                      </Label>
                      <Input
                        id="confirm-workspace-delete"
                        className="min-h-11 font-mono sm:min-h-9"
                        value={workspaceConfirmText}
                        required
                        disabled={workspaceDeleteBusy}
                        aria-invalid={Boolean(workspaceConfirmationError)}
                        aria-describedby={
                          workspaceConfirmationError
                            ? "confirm-workspace-delete-error"
                            : "confirm-workspace-delete-help"
                        }
                        onChange={(event) => {
                          setWorkspaceConfirmText(event.target.value);
                          setWorkspaceDeleteError(null);
                        }}
                        placeholder="DELETE WORKSPACE"
                        autoComplete="off"
                        autoFocus
                      />
                      {workspaceConfirmationError ? (
                        <p
                          id="confirm-workspace-delete-error"
                          className="text-xs text-destructive"
                        >
                          {workspaceConfirmationError}
                        </p>
                      ) : (
                        <p
                          id="confirm-workspace-delete-help"
                          className="text-xs text-muted-foreground"
                        >
                          Case and spacing must match exactly.
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workspace-delete-region">
                        Legal region
                      </Label>
                      <Select
                        id="workspace-delete-region"
                        className="min-h-11 sm:min-h-9"
                        value={workspaceRegion}
                        disabled={workspaceDeleteBusy}
                        onChange={(event) => {
                          setWorkspaceRegion(
                            event.target.value as PrivacyRegion,
                          );
                          setWorkspaceDeleteError(null);
                        }}
                      >
                        {REGION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <MutationFailure
                    id="workspace-delete-error"
                    message={workspaceDeleteError}
                  />
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={workspaceDeleteBusy}
                      >
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={!canDeleteWorkspace}
                      loading={workspaceDeleteBusy}
                    >
                      {workspaceDeleteBusy
                        ? "Queueing…"
                        : workspaceDeleteError
                          ? "Try queueing again"
                          : "Queue deletion review"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      ) : null}

      <PrivacyRequestHistoryCard
        requestsLoading={requestsLoading}
        identityUnavailable={meQuery.isError}
        canWrite={canWrite}
        requestsError={requestsQuery.isError}
        refreshing={requestsQuery.isFetching}
        onRefresh={() => void requestsQuery.refetch()}
        requests={requests}
        filteredCount={filteredRequests.length}
        pagedRequests={pagedRequests}
        histType={histType}
        onTypeChange={setHistType}
        histStatus={histStatus}
        onStatusChange={setHistStatus}
        histSearch={histSearch}
        onSearchChange={setHistSearch}
        page={page}
        pageCount={pageCount}
        onPreviousPage={() => setHistPage((p) => Math.max(1, p - 1))}
        onNextPage={() => setHistPage((p) => Math.min(pageCount, p + 1))}
      />
    </div>
  );
}

function RetentionField({
  id,
  label,
  hint,
  value,
  error,
  disabled,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error: string | null;
  disabled: boolean;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function fieldError(value: string, min: number, max: number): string | null {
  if (value.trim() === "") return "Required.";
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n))
    return "Must be a whole number.";
  if (n < min || n > max) return `Must be between ${min} and ${max} days.`;
  return null;
}

function subscriberEmailError(value: string): string | null {
  const email = value.trim();
  if (!email) return "Enter the data subject's email address.";
  if (email.length > 254)
    return "Email addresses must be 254 characters or fewer.";
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) {
    return "Enter a complete email address, such as subscriber@example.com.";
  }
  return null;
}

function exactTokenError(value: string, token: string): string | null {
  if (value.length === 0 || value === token) return null;
  return `Type ${token} exactly, including spaces and capital letters.`;
}

interface MutationIntent {
  fingerprint: string;
  key: string;
}

function keyForIntent(
  ref: { current: MutationIntent | null },
  fingerprint: string,
): string {
  if (ref.current?.fingerprint === fingerprint) return ref.current.key;
  const key = crypto.randomUUID();
  ref.current = { fingerprint, key };
  return key;
}

interface WorkflowAcknowledgement {
  request_id: string;
  status: "queued";
  requested_at: string;
  estimated_ready_at: string;
}

interface SubscriberRequestAcknowledgement extends WorkflowAcknowledgement {
  request_type: SubscriberRequestType;
}

async function postPrivacyWorkflow(
  path: "/api/v1/privacy/export-requests" | "/api/v1/privacy/deletion-requests",
  body: { region: PrivacyRegion },
  idempotencyKey: string,
  label: string,
  signal?: AbortSignal,
): Promise<WorkflowAcknowledgement> {
  const raw = await api.post<unknown>(path, body, {
    headers: { "Idempotency-Key": idempotencyKey },
    requireOnline: true,
    signal,
  });
  return workflowAcknowledgement(raw, label);
}

async function postSubscriberRequest(
  body: {
    request_type: SubscriberRequestType;
    subject_email: string;
    region: PrivacyRegion;
    notes?: string;
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<SubscriberRequestAcknowledgement> {
  const raw = await api.post<unknown>("/api/v1/privacy/requests", body, {
    headers: { "Idempotency-Key": idempotencyKey },
    requireOnline: true,
    signal,
  });
  const acknowledgement = workflowAcknowledgement(raw, "subscriber request");
  const requestType = stringProperty(raw, "request_type");
  if (requestType !== body.request_type) {
    throw new Error(
      "The subscriber request returned an invalid acknowledgement. Try again without changing the form.",
    );
  }
  return { ...acknowledgement, request_type: requestType };
}

function workflowAcknowledgement(
  raw: unknown,
  label: string,
): WorkflowAcknowledgement {
  const requestId = stringProperty(raw, "request_id");
  const status = stringProperty(raw, "status");
  const requestedAt = stringProperty(raw, "requested_at");
  const estimatedReadyAt = stringProperty(raw, "estimated_ready_at");
  if (
    !requestId ||
    status !== "queued" ||
    !validWireDate(requestedAt) ||
    !validWireDate(estimatedReadyAt)
  ) {
    throw new Error(
      `The ${label} returned an invalid acknowledgement. Try again without changing the form.`,
    );
  }
  return {
    request_id: requestId,
    status,
    requested_at: requestedAt,
    estimated_ready_at: estimatedReadyAt,
  };
}

function accountDeletionAcknowledgement(raw: unknown): {
  request_id: string;
  status: string;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      "Account deletion returned an invalid acknowledgement. Try again without changing the form.",
    );
  }
  const requestId = stringProperty(
    (raw as { request?: unknown }).request,
    "request_id",
  );
  const status = stringProperty(
    (raw as { request?: unknown }).request,
    "status",
  );
  if (
    !requestId ||
    ![
      "queued",
      "verifying",
      "in_progress",
      "blocked_legal_hold",
      "blocked_ownership",
      "fulfilled",
    ].includes(status)
  ) {
    throw new Error(
      "Account deletion returned an invalid acknowledgement. Try again without changing the form.",
    );
  }
  return { request_id: requestId, status };
}

function stringProperty(value: unknown, property: string): string {
  if (!value || typeof value !== "object") return "";
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function validWireDate(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function restoreDialogFocus(
  event: Event,
  triggerRef: { current: HTMLButtonElement | null },
): void {
  event.preventDefault();
  if (triggerRef.current?.isConnected) triggerRef.current.focus();
}

function MutationFailure({
  id,
  message,
}: {
  id: string;
  message: string | null;
}) {
  if (!message) return null;
  return (
    <div
      id={id}
      role="alert"
      className="min-w-0 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
    >
      <p className="break-words">{message}</p>
      <p className="mt-1 break-words text-xs leading-5">
        The form is still open. Trying again without changing it reuses the same
        request identity.
      </p>
    </div>
  );
}

function retentionErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? e.message ?? fallback;
  }
  return e instanceof Error ? e.message : fallback;
}
