import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import { mergeLayoutOrder } from "../../components/dashboard/dashboard-sections";
import { api } from "../../lib/api-client";
import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../../lib/lifecycle-coordinator";

export interface DashboardLayoutController {
  layout: string[] | null;
  editing: boolean;
  saveStatus: "idle" | "saving" | "saved" | "failed";
  /** Safe, presentation-ready feedback. Server detail is never disclosed. */
  saveMessage: string | null;
  toggleEditing: () => void;
  persist: (group: { stats?: string[]; sections?: string[] }) => void;
}

type DashboardLayoutSaveStatus = DashboardLayoutController["saveStatus"];

const SAVE_MESSAGES: Record<
  Exclude<DashboardLayoutSaveStatus, "idle">,
  string
> = {
  saving: "Saving layout…",
  saved: "Layout saved.",
  failed: "Layout wasn’t saved. Showing the last confirmed layout.",
};

export function validateDashboardLayout(
  order: readonly string[],
): string | null {
  if (order.length === 0 || order.length > 16) {
    return "must have 1–16 cards";
  }
  const invalid = order.find((key) => !key || key.length > 64);
  return invalid === undefined ? null : `card key "${invalid}" is invalid`;
}

export function normalizeDashboardLayout(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((key) => typeof key === "string")) {
    return null;
  }
  if (validateDashboardLayout(value) !== null) return null;
  if (new Set(value).size !== value.length) return null;
  // Resolve only the keys supported by this build, append newly introduced
  // cards, and discard forward-version keys without letting them reach DOM or
  // a later write. This preserves the documented cross-version behavior.
  return mergeLayoutOrder(value, {});
}

function sameOrder(
  left: readonly string[] | null,
  right: readonly string[],
): boolean {
  return (
    left?.length === right.length &&
    right.every((key, index) => left[index] === key)
  );
}

export function useDashboardLayout(
  workspaceKey: string | null,
  enabled = workspaceKey !== null,
): DashboardLayoutController {
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const workspaceEpochRef = useRef(0);
  const revisionRef = useRef(0);
  const layoutRef = useRef<string[] | null>(null);
  const confirmedRef = useRef<string[] | null>(null);
  const pendingRef = useRef<string[] | null>(null);
  /* The epoch, rather than a boolean, prevents an old workspace's request from
   * clearing or publishing state for a newer workspace after a switch. */
  const savingEpochRef = useRef<number | null>(null);
  const [layout, setLayout] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [saveStatus, setSaveStatus] =
    useState<DashboardLayoutSaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const publishSaveState = useCallback(
    (
      workspaceEpoch: number,
      status: DashboardLayoutSaveStatus,
      message: string | null,
    ): void => {
      if (!activeRef.current || workspaceEpoch !== workspaceEpochRef.current) {
        return;
      }
      setSaveStatus(status);
      setSaveMessage(message);
    },
    [],
  );

  const drainSaves = useCallback(async (): Promise<void> => {
    const workspaceEpoch = workspaceEpochRef.current;
    if (
      pendingRef.current === null ||
      savingEpochRef.current === workspaceEpoch
    ) {
      return;
    }
    savingEpochRef.current = workspaceEpoch;
    publishSaveState(workspaceEpoch, "saving", SAVE_MESSAGES.saving);
    let latestSaveFailed = false;
    try {
      while (
        workspaceEpoch === workspaceEpochRef.current &&
        pendingRef.current
      ) {
        const target = pendingRef.current;
        pendingRef.current = null;
        let failureToast: string | null = null;
        try {
          const response = await api.putDashboardLayout({ order: target });
          if (response.error || response.data?.ok !== true) {
            failureToast =
              "Layout wasn’t saved because the latest order could not be confirmed. Try again.";
          }
        } catch {
          failureToast =
            "Layout wasn’t saved because the request could not be completed. Try again.";
        }

        /* A response belonging to an old workspace is deliberately ignored.
         * In particular, it must not clear a newer workspace's saving state. */
        if (workspaceEpoch !== workspaceEpochRef.current) return;

        if (failureToast) {
          if (activeRef.current) toast.error(failureToast);
          if (pendingRef.current === null) {
            const confirmed = confirmedRef.current;
            layoutRef.current = confirmed;
            if (activeRef.current) setLayout(confirmed);
            latestSaveFailed = true;
            publishSaveState(workspaceEpoch, "failed", SAVE_MESSAGES.failed);
          }
        } else {
          confirmedRef.current = target;
        }
      }
      if (!latestSaveFailed && workspaceEpoch === workspaceEpochRef.current) {
        publishSaveState(workspaceEpoch, "saved", SAVE_MESSAGES.saved);
      }
    } finally {
      if (savingEpochRef.current === workspaceEpoch) {
        savingEpochRef.current = null;
        signalLifecycleOwnerChanged();
      }
    }
  }, [publishSaveState]);

  useEffect(() => {
    return registerLifecycleGuard({
      id: `dashboard-layout-${workspaceKey ?? "unresolved"}`,
      label: "Dashboard layout",
      inspect: (intent) => {
        if (intent.disposition === "hide") return null;
        const savingCurrentWorkspace =
          savingEpochRef.current === workspaceEpochRef.current;
        if (!savingCurrentWorkspace && pendingRef.current === null) return null;
        return {
          level: "blocking",
          detail: "The latest dashboard layout order is still being saved.",
          canDiscard: !savingCurrentWorkspace,
        };
      },
      prepare: drainSaves,
      discard: () => {
        if (savingEpochRef.current === workspaceEpochRef.current) {
          throw new Error("dashboard_layout_save_active");
        }
        pendingRef.current = null;
        layoutRef.current = confirmedRef.current;
        setLayout(confirmedRef.current);
        publishSaveState(workspaceEpochRef.current, "idle", null);
        signalLifecycleOwnerChanged();
      },
    });
  }, [drainSaves, publishSaveState, workspaceKey]);

  useEffect(() => {
    activeRef.current = true;
    const workspaceEpoch = ++workspaceEpochRef.current;
    layoutRef.current = null;
    confirmedRef.current = null;
    pendingRef.current = null;
    savingEpochRef.current = null;
    setLayout(null);
    setEditing(false);
    setSaveStatus("idle");
    setSaveMessage(null);
    const cleanUp = (): void => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      revisionRef.current += 1;
      // Do not discard a trailing reorder on route unmount. The already-
      // scoped request loop can finish without touching unmounted React state;
      // a subsequent workspace effect advances the epoch and invalidates it.
      if (
        pendingRef.current &&
        savingEpochRef.current !== workspaceEpochRef.current
      ) {
        void drainSaves();
      }
    };
    if (!enabled || workspaceKey === null) return cleanUp;
    const requestId = ++loadRequestRef.current;
    const revision = revisionRef.current;
    void (async (): Promise<void> => {
      const stillCurrent = (): boolean =>
        activeRef.current &&
        workspaceEpoch === workspaceEpochRef.current &&
        requestId === loadRequestRef.current &&
        revision === revisionRef.current;
      try {
        const response = await api.getDashboardLayout();
        if (!stillCurrent()) return;
        const loaded = response.error
          ? null
          : normalizeDashboardLayout(response.data?.order);
        if (loaded === null) {
          toast.error(
            "Couldn't load your saved Dashboard layout. The default layout is shown.",
          );
          return;
        }
        layoutRef.current = loaded;
        confirmedRef.current = loaded;
        setLayout(loaded);
      } catch {
        if (stillCurrent()) {
          toast.error(
            "Couldn't load your saved Dashboard layout. The default layout is shown.",
          );
        }
      }
    })();
    return cleanUp;
  }, [drainSaves, enabled, workspaceKey]);

  const persist = useCallback(
    (group: { stats?: string[]; sections?: string[] }): void => {
      if (!enabled || workspaceKey === null) return;
      const next = mergeLayoutOrder(layoutRef.current, group);
      const error = validateDashboardLayout(next);
      if (error) {
        toast.error(`Can't save layout: ${error}.`);
        publishSaveState(
          workspaceEpochRef.current,
          "failed",
          "Layout wasn’t saved because the requested order is invalid.",
        );
        return;
      }
      if (sameOrder(layoutRef.current, next)) return;
      revisionRef.current += 1;
      layoutRef.current = next;
      pendingRef.current = next;
      setLayout(next);
      publishSaveState(
        workspaceEpochRef.current,
        "saving",
        SAVE_MESSAGES.saving,
      );
      signalLifecycleOwnerChanged();
      void drainSaves();
    },
    [drainSaves, enabled, publishSaveState, workspaceKey],
  );

  return {
    layout,
    editing,
    saveStatus,
    saveMessage,
    toggleEditing: () => setEditing((current) => !current),
    persist,
  };
}
