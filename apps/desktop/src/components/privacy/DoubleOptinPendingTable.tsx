/**
 * Pending double-opt-in confirmations. The backend's historical `resend`
 * endpoint only extends expiry; this surface deliberately never claims that
 * another email was sent.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  type PrivacyPortalDoubleOptinPending,
  api,
} from "../../lib/api-client";
import {
  isInitialRemoteLoad,
  remoteFailureFromError,
} from "../../lib/remote-resource";
import { ConfirmModal } from "../ConfirmModal";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { toast } from "../Toast";

type MutationKind = "extend" | "cancel";

interface MutationContext {
  kind: MutationKind;
  id: string;
  email: string;
}

function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatRelative(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "Time could not be parsed";
  const diffMs = timestamp - Date.now();
  const absolute = Math.abs(diffMs);
  const prefix = diffMs > 0 ? "in " : "";
  const suffix = diffMs > 0 ? "" : " ago";
  if (absolute < 60_000) {
    return `${prefix}${Math.round(absolute / 1000)} seconds${suffix}`;
  }
  if (absolute < 3_600_000) {
    return `${prefix}${Math.round(absolute / 60_000)} minutes${suffix}`;
  }
  if (absolute < 86_400_000) {
    return `${prefix}${Math.round(absolute / 3_600_000)} hours${suffix}`;
  }
  return `${prefix}${Math.round(absolute / 86_400_000)} days${suffix}`;
}

async function loadPendingConfirmations() {
  const result = await api.privacyPortal.doubleOptin.listPending();
  if (result.error) return { error: result.error };
  if (!Array.isArray(result.data?.pending)) {
    return {
      error: {
        kind: "parse" as const,
        code: "invalid_pending_confirmation_response",
      },
    };
  }
  return { data: result.data.pending };
}

export function DoubleOptinPendingTable(): ReactElement {
  const pending = useRemoteResource<PrivacyPortalDoubleOptinPending[]>(
    loadPendingConfirmations,
    { identity: "privacy-double-optin-pending" },
  );
  const operation = useSingleFlightOperation({
    ownerId: "privacy-double-optin-mutation",
    label: "Pending confirmation change",
    detail:
      "Wait for the pending-confirmation change and verified list refresh to finish before leaving Moosewave.",
  });
  const [mutation, setMutation] = useState<MutationContext | null>(null);
  const [pendingCancel, setPendingCancel] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const mountedRef = useRef(true);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const operationHelpId = useId();
  const operationActive = operation.active || mutation !== null;
  const rows = pending.data ?? [];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshPending = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current) {
      await refreshPromiseRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = pending.reload().finally(() => {
      if (refreshPromiseRef.current === tracked)
        refreshPromiseRef.current = null;
    });
    refreshPromiseRef.current = tracked;
    await tracked;
  }, [pending.reload]);

  const reportMutationFailure = useCallback(
    (kind: MutationKind, error: unknown): void => {
      if (!mountedRef.current) return;
      const normalized =
        error && typeof error === "object"
          ? (error as Parameters<typeof remoteFailureFromError>[0])
          : { kind: "network" as const };
      const failure = remoteFailureFromError(normalized);
      const diagnostics = [failure.code, failure.requestId]
        .filter(Boolean)
        .join(" · ");
      toast.error({
        message:
          kind === "extend"
            ? "The confirmation window couldn't be extended."
            : "The pending confirmation couldn't be cancelled.",
        detail: `${failure.message}${diagnostics ? ` Reference: ${diagnostics}.` : ""} No server change was confirmed.`,
      });
    },
    [],
  );

  async function extendWindow(id: string, email: string): Promise<void> {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setMutation({ kind: "extend", id, email });
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await api.privacyPortal.doubleOptin.resend(id);
        if (!mountedRef.current) return;
        if (result.error) {
          reportMutationFailure("extend", result.error);
          return;
        }
        toast.success({
          message: `Extended ${email}'s confirmation deadline by 60 days.`,
          detail:
            "No confirmation email was sent. The existing pending token remains the confirmation path.",
        });
        await refreshPending();
      } catch (error) {
        reportMutationFailure("extend", error);
      } finally {
        if (mountedRef.current) setMutation(null);
      }
    });
    if (request) await request;
  }

  async function confirmCancel(): Promise<void> {
    if (!pendingCancel) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const target = pendingCancel;
    setMutation({ kind: "cancel", id: target.id, email: target.email });
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await api.privacyPortal.doubleOptin.cancel(target.id);
        if (!mountedRef.current) return;
        if (result.error) {
          reportMutationFailure("cancel", result.error);
          return;
        }
        toast.success({
          message: `Cancelled the pending confirmation for ${target.email}.`,
          detail:
            "That address must start double opt-in again before it can become eligible.",
        });
        setPendingCancel(null);
        await refreshPending();
      } catch (error) {
        reportMutationFailure("cancel", error);
      } finally {
        if (mountedRef.current) setMutation(null);
      }
    });
    if (request) await request;
  }

  const columns: readonly DataTableColumn<PrivacyPortalDoubleOptinPending>[] = [
    {
      id: "email",
      header: "Subscriber",
      width: "minmax(220px, 1.4fr)",
      cell: (row) => (
        <span className="privacy-doi-identity">
          <strong>{row.email}</strong>
          <span className="muted">
            Pending confirmation ID: <code>{row.id}</code>
          </span>
        </span>
      ),
    },
    {
      id: "sent",
      header: "Window started",
      width: "minmax(190px, 1fr)",
      cell: (row) => <ConfirmationTime iso={row.sent_at} />,
    },
    {
      id: "expires",
      header: "Deadline",
      width: "minmax(190px, 1fr)",
      cell: (row) => <ConfirmationTime iso={row.expires_at} deadline />,
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Confirmation actions</span>,
      width: "220px",
      align: "end",
      cell: (row) => {
        const rowBusy = operationActive && mutation?.id === row.id;
        return (
          <span className="privacy-doi-actions">
            <button
              type="button"
              className="btn btn-sm pw-discoverable-unavailable"
              onClick={() => {
                if (!operation.promiseRef.current) {
                  void extendWindow(row.id, row.email);
                }
              }}
              aria-disabled={operationActive || undefined}
              aria-busy={
                rowBusy && mutation?.kind === "extend" ? "true" : undefined
              }
              aria-describedby={operationHelpId}
            >
              {rowBusy && mutation?.kind === "extend"
                ? "Extending…"
                : "Extend 60 days"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger pw-discoverable-unavailable"
              onClick={() => {
                if (!operation.promiseRef.current) {
                  setPendingCancel({ id: row.id, email: row.email });
                }
              }}
              aria-disabled={operationActive || undefined}
              aria-describedby={operationHelpId}
            >
              Cancel
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <section
      className="card privacy-doi-card"
      aria-busy={operationActive || undefined}
    >
      <RemoteDataNotice
        resource={pending}
        label="pending confirmations"
        onRetry={() => void refreshPending()}
      />
      <p id={operationHelpId} className="pw-action-status" role="status">
        {operationActive
          ? mutation?.kind === "cancel"
            ? `Cancelling the pending confirmation for ${mutation.email}; other row actions are temporarily unavailable.`
            : `Extending the confirmation deadline for ${mutation?.email ?? "this row"}; no email is being sent.`
          : "Extend 60 days changes only the token deadline; it does not send another confirmation email. Cancel requires the subscriber to opt in again from scratch."}
      </p>
      <DataTable
        caption="Double opt-in · pending"
        description="Addresses awaiting a subscriber click, with the full verified start time, deadline, and action consequences."
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        loading={isInitialRemoteLoad(pending)}
        loadingLabel="Loading pending confirmations…"
        emptyState={
          pending.transport === "error" && pending.data === null
            ? "Pending confirmations are unavailable. Retry to load them."
            : "No pending confirmations."
        }
        density="compact"
        columnControls={
          <button
            type="button"
            className="btn btn-sm pw-discoverable-unavailable"
            onClick={() => {
              if (!operationActive && pending.transport !== "loading") {
                void refreshPending();
              }
            }}
            aria-disabled={
              operationActive || pending.transport === "loading" || undefined
            }
            aria-busy={pending.transport === "loading" ? "true" : undefined}
            aria-describedby={operationHelpId}
          >
            {pending.transport === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      <ConfirmModal
        open={pendingCancel !== null}
        title="Cancel pending confirmation?"
        description={
          pendingCancel
            ? `Cancel the pending confirmation for ${pendingCancel.email}? The address will need to opt in again from scratch.`
            : ""
        }
        confirmLabel="Cancel confirmation"
        danger
        busy={operationActive}
        onConfirm={confirmCancel}
        onClose={() => {
          if (!operation.promiseRef.current) setPendingCancel(null);
        }}
      >
        <p className="pw-action-status">
          This does not delete historical consent evidence. It invalidates the
          current pending confirmation path.
        </p>
      </ConfirmModal>
    </section>
  );
}

function ConfirmationTime({
  iso,
  deadline = false,
}: {
  iso: string;
  deadline?: boolean;
}): ReactElement {
  const timestamp = new Date(iso).getTime();
  const expired =
    deadline && Number.isFinite(timestamp) && timestamp <= Date.now();
  return (
    <time className="privacy-doi-time" dateTime={iso}>
      <span>{formatAbsolute(iso)}</span>
      <small className={expired ? "field-error" : "muted"}>
        {expired ? `Expired ${formatRelative(iso)}` : formatRelative(iso)}
      </small>
    </time>
  );
}
