// SPDX-License-Identifier: AGPL-3.0-only
//
// IntegrationLifecycleActions — the server-declared lifecycle verbs for one
// catalog integration (connect, sync, backfill, pause, disconnect), dispatched
// exactly the way desktop's useIntegrationLifecycleController does:
//
//   * a native family row (CRM, lead capture, reviews, loyalty, subscriptions,
//     analytics) with ONE exact connection id runs on its family route, e.g.
//     POST /api/v1/crm/integrations/{id}/backfill;
//   * everything else asks the generic facade (POST /api/v1/integrations/
//     {slug}/{action}, DELETE /api/v1/integrations/{slug}), which answers with
//     the owning surface's handoff — rendered verbatim, never as "done".
//
// Support-provider rows are release-held server-side and send nothing;
// commerce rows are administered from the commerce surface.
"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorMessage } from "@/lib/api";
import { resolveSetupPath } from "@/lib/integration-setup-path";
import {
  SUPPORT_RUNTIME_HOLD_CODE,
  connectionIds,
  connectionIsAmbiguous,
  integrationsLifecycleApi,
  isCommerceOwned,
  isSupportRuntimeHeld,
  nativeLifecycleClients,
  nativeLifecycleEvidence,
  nativeLifecycleFamily,
  type FacadeLifecycleAction,
  type IntegrationActionResponse,
  type IntegrationConnection,
  type LifecycleCatalogItem,
} from "@/lib/integrations-lifecycle-api";
import { asRoute } from "@/lib/typed-routes";

import {
  ADMIN_REQUIRED_REASON,
  useIntegrationLifecycleAuthority,
} from "./use-integration-lifecycle-authority";

export type LifecycleActionItem = Pick<
  LifecycleCatalogItem,
  | "slug"
  | "name"
  | "category"
  | "badge"
  | "runtime_status"
  | "sources"
  | "docs_url"
  | "setup_path"
>;

const SUPPORTED: ReadonlySet<string> = new Set<FacadeLifecycleAction>([
  "connect/start",
  "sync",
  "backfill",
  "pause",
  "disconnect",
]);

const NEEDS_EXACT_CONNECTION: ReadonlySet<string> = new Set([
  "sync",
  "backfill",
  "pause",
  "disconnect",
]);

export function lifecycleActionLabel(action: string): string {
  switch (action) {
    case "connect/start":
      return "Connect";
    case "connect/callback":
      return "Complete OAuth";
    case "sync":
      return "Sync now";
    case "backfill":
      return "Backfill";
    case "pause":
      return "Pause";
    case "disconnect":
      return "Disconnect";
    case "roadmap":
      return "Roadmap";
    default:
      return action
        .split(/[/_-]+/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

interface LifecycleOutcome {
  tone: "info" | "error";
  title: string;
  message: string;
  delegatedTo?: string;
  requiredFields: string[];
  managePath?: string;
}

function facadeCall(
  action: FacadeLifecycleAction,
  slug: string,
  signal: AbortSignal,
): Promise<IntegrationActionResponse> {
  switch (action) {
    case "connect/start":
      return integrationsLifecycleApi.connectStart(slug, { signal });
    case "sync":
      return integrationsLifecycleApi.sync(slug, { signal });
    case "backfill":
      return integrationsLifecycleApi.backfill(slug, { signal });
    case "pause":
      return integrationsLifecycleApi.pause(slug, { signal });
    case "disconnect":
      return integrationsLifecycleApi.disconnect(slug, { signal });
  }
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function IntegrationLifecycleActions({
  item,
  actions,
  connection,
  onChanged,
}: {
  item: LifecycleActionItem;
  /** The server-declared lifecycle_actions for this row (detail response). */
  actions: readonly string[];
  /** The row's connection evidence (detail or /integrations/connections). */
  connection: IntegrationConnection | null;
  onChanged?: () => void | Promise<void>;
}) {
  const authority = useIntegrationLifecycleAuthority();
  const reasonBase = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LifecycleOutcome | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const lockRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      lockRef.current = false;
    },
    [],
  );

  if (isSupportRuntimeHeld(item)) {
    return (
      <div role="note" className="space-y-1 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">
          Support integration runtime held
        </p>
        <p>
          Connect, sync, backfill, pause, and disconnect are release-held for
          support providers. No runtime request is sent. Hold code:{" "}
          <code>{SUPPORT_RUNTIME_HOLD_CODE}</code>.
        </p>
      </div>
    );
  }

  if (isCommerceOwned(item)) {
    return (
      <div role="note" className="space-y-2 text-sm text-muted-foreground">
        <p>
          {item.name} is administered from Commerce. Connect, sync, backfill,
          pause, and disconnect run there against the exact store connection.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={asRoute("/app/commerce")}>Open Commerce</Link>
        </Button>
      </div>
    );
  }

  const family = nativeLifecycleFamily(item);
  const ids = connectionIds(connection);
  const ambiguous = connectionIsAmbiguous(connection);
  const hasConnection = ids.length > 0 || (connection?.count ?? 0) > 0;
  const visible = actions.filter((action) => action.trim().length > 0);

  function unavailableReason(action: string): string | null {
    if (!SUPPORTED.has(action)) {
      return action === "roadmap"
        ? "This integration is on the roadmap; follow its docs for status."
        : "This action runs from the provider's own setup flow, not this panel.";
    }
    if (busy !== null) {
      return "Wait for the current integration operation to finish.";
    }
    if (item.runtime_status === "planned") {
      return "This integration is planned and cannot run yet.";
    }
    if (authority.pending) return "Checking your workspace role…";
    if (!authority.canAdmin) return ADMIN_REQUIRED_REASON;
    if (NEEDS_EXACT_CONNECTION.has(action) && ambiguous) {
      return `This workspace has several ${item.name} accounts. Choose the exact connection in its owning surface first.`;
    }
    if (NEEDS_EXACT_CONNECTION.has(action) && !hasConnection) {
      return "Connect this integration and verify its exact connection first.";
    }
    return null;
  }

  async function run(
    action: FacadeLifecycleAction,
    { rethrow = false }: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (lockRef.current) return;
    const label = lifecycleActionLabel(action);
    const controller = new AbortController();
    lockRef.current = true;
    controllerRef.current = controller;
    setBusy(action);
    setOutcome(null);
    try {
      await authority.beforeWrite(controller.signal);
      if (controller.signal.aborted) return;
      if (family && action !== "connect/start" && ids.length === 1) {
        if (action === "disconnect") {
          // Re-verify the exact target before anything irreversible: the
          // connection this dialog named must still be the only one.
          const fresh = await integrationsLifecycleApi.detail(item.slug, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (
            connectionIsAmbiguous(fresh.connection) ||
            !sameIds(ids, connectionIds(fresh.connection))
          ) {
            throw new Error(
              "The connection changed since this page loaded. Nothing was disconnected — review the newly verified connection before trying again.",
            );
          }
        }
        const client = nativeLifecycleClients[family];
        const body = await client[action](ids[0], {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setOutcome({
          tone: "info",
          title: `${item.name} ${label} request accepted`,
          message:
            nativeLifecycleEvidence(body) ||
            "Refresh connection health to confirm completion.",
          requiredFields: [],
        });
      } else {
        const response = await facadeCall(
          action,
          item.slug,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const delegated = response.status === "delegated";
        setOutcome({
          tone: "info",
          title: delegated
            ? `${item.name} ${label} handoff is ready`
            : `${item.name} ${label}: ${response.status}`,
          message: delegated
            ? `${response.message} No change was made from this panel — continue in the owning surface.`
            : response.message,
          delegatedTo: response.delegated_to,
          requiredFields: response.required_fields,
          managePath: response.manage_path ?? item.setup_path,
        });
      }
      await onChanged?.();
    } catch (failure) {
      if (controller.signal.aborted) return;
      const message = apiErrorMessage(failure, `${label} failed`);
      setOutcome({
        tone: "error",
        title: `${item.name} ${label} failed`,
        message,
        requiredFields: [],
      });
      if (rethrow) throw new Error(message);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        lockRef.current = false;
        setBusy(null);
      }
    }
  }

  const disconnectTarget =
    family && ids.length === 1
      ? `connection ${ids[0]}`
      : "its owning surface";
  const manage = outcome?.managePath
    ? resolveSetupPath(outcome.managePath)
    : null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Action target:{" "}
        <span className="font-medium text-foreground">
          {ambiguous
            ? `${Math.max(connection?.count ?? 0, ids.length)} accounts; exact target not selected`
            : ids.length === 1
              ? ids[0]
              : hasConnection
                ? "One account reported; exact ID unknown"
                : "No saved connection"}
        </span>
      </p>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No lifecycle actions are declared for this connector.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {visible.map((action, index) => {
            const reason = unavailableReason(action);
            const reasonId = `${reasonBase}-${index}`;
            const label = lifecycleActionLabel(action);
            return (
              <li key={action} className="flex max-w-xs flex-col gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={action === "disconnect" ? "outline" : "default"}
                  className={
                    action === "disconnect" ? "text-destructive" : undefined
                  }
                  disabled={reason !== null}
                  loading={busy === action}
                  aria-describedby={reason ? reasonId : undefined}
                  onClick={() => {
                    if (reason !== null) return;
                    if (action === "disconnect") {
                      setConfirmDisconnect(true);
                      return;
                    }
                    void run(action as FacadeLifecycleAction);
                  }}
                >
                  {busy === action ? `${label} in progress…` : label}
                </Button>
                {reason ? (
                  <span
                    id={reasonId}
                    className="text-xs text-muted-foreground"
                  >
                    {reason}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {outcome ? (
        <div
          role={outcome.tone === "error" ? "alert" : "status"}
          className={
            outcome.tone === "error"
              ? "space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
              : "space-y-1 rounded-md border p-3 text-sm"
          }
        >
          <p
            className={
              outcome.tone === "error"
                ? "font-medium text-destructive"
                : "font-medium"
            }
          >
            {outcome.title}
          </p>
          <p className="break-words text-muted-foreground">{outcome.message}</p>
          {outcome.delegatedTo ? (
            <p className="text-xs text-muted-foreground">
              Owning endpoint:{" "}
              <code className="break-all">{outcome.delegatedTo}</code>
            </p>
          ) : null}
          {outcome.requiredFields.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>Required:</span>
              {outcome.requiredFields.map((field) => (
                <Badge key={field} variant="outline">
                  {field}
                </Badge>
              ))}
            </div>
          ) : null}
          {manage ? (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href={manage.href}>Continue in {manage.label} →</Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${item.name}?`}
        description={
          family && ids.length === 1
            ? `Moosewave will stop syncing ${item.name} (${disconnectTarget}) and mark it disconnected. Run and audit history is kept; provider-side credentials and webhooks still need cleanup in ${item.name}. The exact connection is re-verified before anything changes.`
            : `Moosewave will ask the integrations facade for ${item.name}'s disconnect handoff. Nothing is removed from this panel; the owning surface performs the disconnect.`
        }
        confirmLabel="Disconnect"
        onConfirm={() => run("disconnect", { rethrow: true })}
      />
    </div>
  );
}
