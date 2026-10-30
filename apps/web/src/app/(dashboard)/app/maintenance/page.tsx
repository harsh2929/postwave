// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Maintenance — on-demand jobs and configuration validators.
 *
 * Nine POST paths desktop reached and web did not.
 *
 * Two things this page refuses to do:
 *
 *   - Render a passing validation as "nothing to know". Every validator
 *     returns `warnings` beside `errors`, and warnings survive a pass. The
 *     live social-capture validator answers valid:true with "sms_list_id is
 *     missing; social answers will be captured without SMS consent handoff".
 *     A green badge alone would say the setup is fine while consent is
 *     dropped.
 *
 *   - Let a zero count stand in for "did it run". A sweep that found nothing
 *     and a sweep that never happened both show zero; only `completed_at`
 *     separates them, so it is what the page reports.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  FlaskConical,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  actingBelowRole,
  effectiveAuthRole,
  setViewerMode,
  whoamiFresh,
} from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { qk, STALE } from "@/lib/query-keys";
import { newUUIDv7 } from "@/lib/http-fetch";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import {
  jobDidRun,
  previewReengagement,
  publishEvent,
  recheckDns,
  recomputeContactRatings,
  recomputePredictive,
  runFirewallDetect,
  runSoftBounceRecovery,
  runSpamTrapSweep,
  type ValidationResult,
  validSocialCaptureSample,
  validWithCaveats,
  validateOnsiteGrowth,
  validateZeroCopyTrigger,
} from "@/lib/maintenance-api";

type Line = { id: number; text: string; tone: "note" | "warn" | "bad" };

/**
 * A sweep that writes to live state before the operator has said so twice.
 *
 * These sit in the same uniform grid as read-only validators, so the control
 * itself cannot tell an operator that "Spam-trap sweep" blocklists subscribers
 * while "Validate onsite growth" does nothing at all. The banner above the
 * grid already concedes there is no batch undo; this is what stands between a
 * mis-aimed pointer and the write it cannot take back.
 */
type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  /** Typed second gate, for sweeps whose blast radius is subscriber data. */
  token?: string;
};

const ACTION_GROUPS = [
  {
    id: "protection",
    title: "Protection and deliverability",
    description:
      "Immediate sweeps over live safety, bounce, firewall, and DNS state.",
    icon: ShieldCheck,
    actions: [
      "Spam-trap sweep",
      "Soft-bounce recovery",
      "Firewall detection",
      "Recheck DNS",
    ],
  },
  {
    id: "models",
    title: "Models and scheduled work",
    description:
      "Recompute derived data or explicitly start due warehouse syncs.",
    icon: DatabaseZap,
    actions: [
      "Recompute predictions",
      "Recompute ratings",
      "Run due warehouse syncs",
    ],
  },
  {
    id: "validation",
    title: "Validation and previews",
    description:
      "Dry-run configuration and content paths without claiming runtime success.",
    icon: FlaskConical,
    actions: [
      "Re-engagement preview",
      "Validate zero-copy trigger",
      "Validate onsite growth",
      "Validate social capture",
    ],
  },
  {
    id: "session",
    title: "Session and event controls",
    description:
      "Change the effective role for this session or test event publication policy.",
    icon: Activity,
    actions: ["Publish test event", "Enter viewer mode", "Leave viewer mode"],
  },
] as const;

export default function MaintenancePage() {
  // The nav manifest scopes this page to admin, but that field is metadata:
  // nothing in web enforces it, and some of these endpoints accept an editor
  // server-side. Gating here is what actually makes the page match its own
  // declared scope, and it keeps a non-admin from firing a control that
  // either 403s or — worse — succeeds.
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: () => whoamiFresh(),
    staleTime: STALE.authMe,
  });
  const canWrite =
    meQuery.isSuccess &&
    !meQuery.data.viewer_mode &&
    roleCanWrite(effectiveAuthRole(meQuery.data));
  const authorityKey = meQuery.isSuccess
    ? [
        meQuery.data.tenant_id,
        meQuery.data.user_id,
        effectiveAuthRole(meQuery.data),
        meQuery.data.viewer_mode ? "viewer" : "member",
      ].join(":")
    : "unverified";
  // Who the session results belong to. Deliberately narrower than
  // `authorityKey`: viewer mode is the same person in the same workspace, so
  // toggling it must not throw the log away. Keying the wipe on the authority
  // did exactly that — "Enter viewer mode" invalidates whoami, the effective
  // role changes, and every job result the operator was still reading
  // vanished along with the line explaining what the toggle had just done.
  const identityKey = meQuery.isSuccess
    ? `${meQuery.data.tenant_id}:${meQuery.data.user_id}`
    : "unverified";
  const authorityKeyRef = useRef(authorityKey);
  const controllerRef = useRef<AbortController | null>(null);
  const activeAuthorityRef = useRef<string | null>(null);
  const canLeaveViewerMode =
    meQuery.isSuccess &&
    meQuery.data.viewer_mode === true &&
    roleCanWrite(meQuery.data.role);
  // Both viewer-mode gates read the DURABLE role, because that is what the
  // server checks (auth.canActivateViewerMode) — the effective role is the
  // very thing viewer mode lowers, so gating on it would let an editor press
  // a fully live button whose only possible answer is a 403 role denial.
  const canEnterViewerMode =
    meQuery.isSuccess &&
    meQuery.data.viewer_mode !== true &&
    roleCanWrite(meQuery.data.role);
  // Neither control carries a usable `title`: buttonVariants sets
  // `disabled:pointer-events-none`, so a tooltip on a disabled button never
  // opens. The condition has to be said in the page itself.
  const viewerModeNote = !meQuery.isSuccess
    ? null
    : !roleCanWrite(meQuery.data.role)
      ? "Only owners and admins can preview the workspace as a viewer, so both viewer-mode controls stay locked for your role."
      : meQuery.data.viewer_mode === true
        ? "You are previewing as a viewer right now, so only Leave viewer mode is available."
        : "You are not in viewer mode, so only Enter viewer mode is available.";
  const roleLoading = meQuery.isPending;

  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const nextLineIdRef = useRef(0);
  const logIdentityRef = useRef<string | null>(null);
  const visibleLines = identityKey === logIdentityRef.current ? lines : [];
  const enterViewerModeRef = useRef<HTMLButtonElement>(null);
  const leaveViewerModeRef = useRef<HTMLButtonElement>(null);

  // An in-flight job was authorised under the old role, so it is abandoned the
  // moment that role changes — including on a viewer-mode toggle.
  useEffect(() => {
    authorityKeyRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeAuthorityRef.current = null;
    busyRef.current = null;
    setBusy(null);
  }, [authorityKey]);

  // Results, unlike in-flight work, survive a role change and are dropped only
  // when the workspace or the signed-in user behind them changes.
  useEffect(() => {
    // Cache resets briefly unverify the same session. Hide results while
    // identity is unknown, but keep them until a different identity is verified.
    if (identityKey === "unverified") return;
    if (
      logIdentityRef.current !== null &&
      logIdentityRef.current !== identityKey
    )
      setLines([]);
    logIdentityRef.current = identityKey;
  }, [identityKey]);

  function say(text: string, tone: Line["tone"] = "note") {
    if (
      activeAuthorityRef.current !== null &&
      activeAuthorityRef.current !== authorityKeyRef.current
    )
      return;
    const id = nextLineIdRef.current;
    nextLineIdRef.current += 1;
    setLines((prev) => [{ id, text, tone }, ...prev].slice(0, 20));
  }

  function focusViewerModeControl(target: "enter" | "leave") {
    requestAnimationFrame(() => {
      (target === "enter"
        ? enterViewerModeRef.current
        : leaveViewerModeRef.current
      )?.focus();
    });
  }

  function reportValidation(label: string, v: ValidationResult) {
    if (!v.valid) {
      say(
        `${label}: not valid — ${v.errors.join("; ") || "no reason given"}`,
        "bad",
      );
    } else if (validWithCaveats(v)) {
      // The case a green badge would erase.
      say(`${label}: valid, but ${v.warnings.join("; ")}`, "warn");
    } else {
      say(`${label}: valid, no warnings.`);
    }
    // Warnings matter on failure too, and are not implied by the errors.
    if (!v.valid && v.warnings.length > 0) {
      say(`${label}: also warns — ${v.warnings.join("; ")}`, "warn");
    }
  }

  async function run(
    label: string,
    fn: (signal: AbortSignal) => Promise<void>,
    adminOnly: boolean,
  ) {
    if (busyRef.current !== null || !meQuery.data) return;
    const openedAuthority = authorityKey;
    const identity = meQuery.data;
    const controller = new AbortController();
    busyRef.current = label;
    controllerRef.current = controller;
    activeAuthorityRef.current = openedAuthority;
    setBusy(label);
    try {
      if (adminOnly)
        await verifyFreshAdminAuthority(identity, controller.signal);
      await fn(controller.signal);
    } catch (error) {
      if (
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      say(
        `${label}: could not run — ${error instanceof Error ? error.message : "the request did not complete."}`,
        "bad",
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        activeAuthorityRef.current = null;
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  const actions: {
    label: string;
    adminOnly: boolean;
    confirm?: Confirmation;
    run: (signal: AbortSignal) => Promise<void>;
  }[] = [
    {
      label: "Spam-trap sweep",
      adminOnly: true,
      confirm: {
        title: "Run the spam-trap sweep?",
        description:
          "Every subscriber matching a known trap pattern is set to blocklisted and gains a suppression row. They stop receiving mail immediately, and nothing on this page reverses it — each one has to be un-blocklisted by hand.",
        confirmLabel: "Run sweep and blocklist",
        token: "BLOCKLIST SPAM TRAPS",
      },
      run: async (signal) => {
        const r = await runSpamTrapSweep(signal);
        say(
          jobDidRun(r)
            ? `Spam-trap sweep ran ${formatWireTimestamp(r.completed_at, "just now")} and blocklisted ${r.counts.blocklisted}.`
            : "Spam-trap sweep returned no completion time, so it cannot be confirmed to have run.",
          jobDidRun(r) ? "note" : "warn",
        );
      },
    },
    {
      label: "Soft-bounce recovery",
      adminOnly: true,
      confirm: {
        // Same wording as the deliverability operations panel, which gates the
        // same job — one phrase so an operator does not learn two of them.
        title: "Expire eligible transient suppressions?",
        description:
          "Already-expired soft-bounce suppressions are cleared, so those addresses become sendable again on the next campaign. Putting a suppression back means bouncing the address again.",
        confirmLabel: "Run recovery",
        token: "EXPIRE TRANSIENT SUPPRESSIONS",
      },
      run: async (signal) => {
        const r = await runSoftBounceRecovery(signal);
        say(
          `Soft-bounce recovery: ${r.counts.recovered} recovered, ${r.counts.expired_suppressions} suppressions expired.` +
            (jobDidRun(r) ? "" : " No completion time was returned."),
          jobDidRun(r) ? "note" : "warn",
        );
      },
    },
    {
      label: "Recompute predictions",
      adminOnly: true,
      run: async (signal) => {
        const r = await recomputePredictive(signal);
        say(
          `Predictions recomputed under model ${r.model_version || "an unstated version"}. Scores from other versions are not directly comparable.`,
        );
      },
    },
    {
      label: "Firewall detection",
      adminOnly: true,
      confirm: {
        title: "Run firewall detection?",
        description:
          "Detection can switch this workspace into attack mode, which starts challenging or refusing form and signup traffic from real visitors. It changes live protection state; it is not a dry run.",
        confirmLabel: "Run detection",
      },
      run: async (signal) => {
        const r = await runFirewallDetect(signal);
        say(
          r.flipped
            ? "Firewall detection ran and changed attack mode."
            : "Firewall detection ran and left attack mode unchanged — it executed, it did not decline to act.",
        );
      },
    },
    {
      label: "Re-engagement preview",
      adminOnly: false,
      run: async (signal) => {
        const p = await previewReengagement(signal);
        say(
          `Re-engagement draft: “${p.subject}”. The body still contains Liquid placeholders; they resolve per recipient at send time, not here.`,
        );
      },
    },
    {
      label: "Recompute ratings",
      adminOnly: true,
      run: async (signal) => {
        const r = await recomputeContactRatings(signal);
        say(
          r.scanned === 0
            ? `No subscriber was eligible for rating in the last ${r.window_days} days, so nothing was scanned. "0 updated" here means nobody qualified, not that every rating was already correct.`
            : `${r.updated} of ${r.scanned} scanned rating(s) updated over ${r.window_days} days.`,
          r.scanned === 0 ? "warn" : "note",
        );
      },
    },
    {
      label: "Validate zero-copy trigger",
      adminOnly: true,
      run: async (signal) => {
        reportValidation(
          "Zero-copy trigger",
          await validateZeroCopyTrigger({}, signal),
        );
      },
    },
    {
      label: "Run due warehouse syncs",
      adminOnly: true,
      confirm: {
        title: "Start due warehouse syncs?",
        description:
          "This starts up to 10 due import or export runs for active warehouse connections. It can read from connected providers, export workspace data, and import subscriber changes. This is not a preview or an inventory check.",
        confirmLabel: "Start due syncs",
      },
      run: async (signal) => {
        const identity = meQuery.data;
        const role = identity ? effectiveAuthRole(identity) : null;
        if (!identity || (role !== "owner" && role !== "admin"))
          throw new Error("Administrator access is required.");
        const { runDueWarehouseConnections } =
          await import("@/lib/warehouse-api");
        const rows = await runDueWarehouseConnections({
          authority: {
            tenantId: identity.tenant_id,
            userId: identity.user_id,
            role,
          },
          limit: 10,
          idempotencyKey: newUUIDv7(),
          signal,
        });
        say(
          `${rows.length} warehouse run receipt(s) returned. Review each run's status in Warehouse; a receipt alone does not prove completion.`,
        );
      },
    },
    {
      label: "Recheck DNS",
      adminOnly: true,
      run: async (signal) => {
        const r = await recheckDns(signal);
        say(
          `DNS recheck complete: ${r.rechecked} sending identity/identities rechecked.`,
        );
      },
    },
    {
      label: "Publish test event",
      adminOnly: false,
      run: async (signal) => {
        const r = await publishEvent(
          "campaign.sent",
          {
            source: "maintenance",
          },
          signal,
        );
        say(
          "notPublishable" in r
            ? "campaign.sent is not on the client-publishable allow-list. That is a deliberate boundary, not a misconfiguration — the topic can only be raised by the server."
            : "Event published.",
          "notPublishable" in r ? "warn" : "note",
        );
      },
    },
    {
      label: "Validate onsite growth",
      adminOnly: true,
      run: async (signal) => {
        reportValidation(
          "Onsite growth",
          await validateOnsiteGrowth({}, signal),
        );
      },
    },
    {
      label: "Enter viewer mode",
      adminOnly: false,
      run: async () => {
        const v = await setViewerMode(true);
        say(
          actingBelowRole(v)
            ? `Viewer mode on: you hold ${v.role} but the app is enforcing ${v.effective_role}. Writes will be refused exactly as they would be for a real viewer.`
            : `Viewer mode is ${v.viewer_mode ? "on" : "off"}; effective role ${v.effective_role || "unreported"}.`,
          "warn",
        );
        // A context-epoch change clears the cache, so invalidation can miss
        // the detached identity observer. Refetch this observer directly.
        await meQuery.refetch({ throwOnError: true });
        focusViewerModeControl("leave");
      },
    },
    {
      label: "Leave viewer mode",
      adminOnly: false,
      run: async () => {
        const v = await setViewerMode(false);
        say(
          `Viewer mode off; acting as ${v.effective_role || "your own role"} again.`,
        );
        // A context-epoch change clears the cache, so invalidation can miss
        // the detached identity observer. Refetch this observer directly.
        await meQuery.refetch({ throwOnError: true });
        focusViewerModeControl("enter");
      },
    },
    {
      label: "Validate social capture",
      adminOnly: true,
      run: async (signal) => {
        reportValidation(
          "Social capture",
          await validSocialCaptureSample(signal),
        );
      },
    },
  ];

  const actionByLabel = new Map(
    actions.map((action) => [action.label, action]),
  );

  return (
    <OperationsShell className="max-w-6xl">
      <OperationsHeader
        icon={Wrench}
        eyebrow="Operations · Live workspace"
        title="Maintenance"
        description="Run bounded safety jobs and configuration checks. Every control below performs a real request; previews and validators do not prove production execution."
      />

      {roleLoading ? (
        <Alert>
          <AlertTitle>Checking workspace access</AlertTitle>
          <AlertDescription role="status">
            Maintenance actions remain locked until your current role is
            verified.
          </AlertDescription>
        </Alert>
      ) : meQuery.isError ? (
        <OperationsFailure
          title="Workspace access could not be verified"
          description="No maintenance job or validation request has been sent."
          onRetry={() => void meQuery.refetch()}
          retrying={meQuery.isFetching}
        />
      ) : !canWrite ? (
        <Alert>
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            Administrative jobs remain locked. Re-engagement preview and test
            event publication remain available under their report-read scope.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-warning/40 bg-warning-subtle text-warning-emphasis">
          <AlertTriangle aria-hidden className="size-4" />
          <AlertTitle>Actions run immediately</AlertTitle>
          <AlertDescription>
            Run one control at a time and read its result before continuing.
            There is no batch undo for maintenance jobs.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        {ACTION_GROUPS.map((group) => {
          const GroupIcon = group.icon;
          return (
            <OperationsSection
              key={group.id}
              id={`maintenance-${group.id}`}
              title={group.title}
              description={group.description}
              aside={
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <GroupIcon className="size-4" aria-hidden />
                </span>
              }
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {group.actions.map((label) => {
                  const action = actionByLabel.get(label);
                  if (!action) return null;
                  const actionAllowed =
                    label === "Enter viewer mode"
                      ? canEnterViewerMode
                      : label === "Leave viewer mode"
                        ? canLeaveViewerMode
                        : action.adminOnly
                          ? canWrite
                          : meQuery.isSuccess;
                  const trigger = (
                    <Button
                      key={label}
                      ref={
                        label === "Enter viewer mode"
                          ? enterViewerModeRef
                          : label === "Leave viewer mode"
                            ? leaveViewerModeRef
                            : undefined
                      }
                      type="button"
                      variant="outline"
                      className={`h-auto min-h-11 justify-start whitespace-normal px-3 py-3 text-left leading-5 sm:min-h-12${
                        action.confirm
                          ? // A sweep must not look like a validator.
                            " border-destructive/40 text-destructive-emphasis hover:bg-destructive/5 hover:text-destructive-emphasis"
                          : ""
                      }`}
                      onClick={
                        action.confirm
                          ? undefined
                          : () =>
                              void run(
                                action.label,
                                action.run,
                                action.adminOnly,
                              )
                      }
                      loading={busy === action.label}
                      disabled={roleLoading || !actionAllowed || busy !== null}
                    >
                      {action.label}
                    </Button>
                  );
                  return action.confirm ? (
                    <ConfirmDialog
                      key={label}
                      trigger={trigger}
                      title={action.confirm.title}
                      description={action.confirm.description}
                      confirmLabel={action.confirm.confirmLabel}
                      confirmationToken={action.confirm.token}
                      onConfirm={() =>
                        run(action.label, action.run, action.adminOnly)
                      }
                    />
                  ) : (
                    trigger
                  );
                })}
              </div>
              {group.id === "session" && viewerModeNote ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {viewerModeNote}
                </p>
              ) : null}
            </OperationsSection>
          );
        })}
      </div>

      <OperationsSection
        id="maintenance-results"
        title="Session results"
        description="Results are ordered newest first and live only in this browser session. Warnings remain visible even when a validator reports valid."
        aside={
          visibleLines.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLines([])}
              disabled={busy !== null}
            >
              Clear
            </Button>
          ) : null
        }
      >
        <div aria-live="polite" aria-busy={busy !== null}>
          {visibleLines.length === 0 ? (
            <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No maintenance action has run in this session.
            </div>
          ) : (
            <ol className="space-y-2">
              {visibleLines.map((line) => {
                const Icon =
                  line.tone === "note" ? CheckCircle2 : AlertTriangle;
                return (
                  <li
                    key={line.id}
                    className={`flex min-w-0 gap-3 rounded-lg border p-3 text-sm ${
                      line.tone === "bad"
                        ? "border-destructive/30 bg-destructive/5 text-destructive-emphasis"
                        : line.tone === "warn"
                          ? "border-warning/40 bg-warning-subtle text-warning-emphasis"
                          : "border-success/30 bg-success/10"
                    }`}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <p className="min-w-0 break-words [overflow-wrap:anywhere]">
                      {line.text}
                    </p>
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
