import { useEffect, useRef, useState } from "react";

import { api, type Sequence } from "../../lib/api-client";
import {
  confirmedNextSequenceVersion,
  SEQUENCE_VERSION_CONFIRMATION_ERROR,
} from "../../lib/sequence-version";
import { toast } from "../Toast";

export type SequenceStatus = "active" | "paused" | "draft" | "archived";

export type SequenceMutationEnqueuer = <T>(
  task: () => Promise<T>,
) => Promise<T>;

export interface SequenceStatusOption {
  value: SequenceStatus;
  label: string;
  helper: string;
  tone: "success" | "warning" | "neutral" | "danger";
}

export const SEQUENCE_STATUS_OPTIONS: readonly SequenceStatusOption[] = [
  {
    value: "active",
    label: "Active",
    helper: "Subscribers move through the flow on their normal cadence.",
    tone: "success",
  },
  {
    value: "paused",
    label: "Paused",
    helper: "Subscribers hold at their current step until you resume.",
    tone: "warning",
  },
  {
    value: "draft",
    label: "Draft",
    helper: "Not enrolling anyone — safe to edit copy and timing.",
    tone: "neutral",
  },
  {
    value: "archived",
    label: "Archived",
    helper: "Hidden from active listings; existing runs are stopped.",
    tone: "danger",
  },
];

export function normalizeSequenceStatus(
  raw: string | undefined,
): SequenceStatus {
  const status = (raw ?? "active").toLowerCase();
  if (status === "running") return "active";
  if (status === "paused" || status === "draft" || status === "archived") {
    return status;
  }
  return "active";
}

function statusToast(status: SequenceStatus): void {
  if (status === "active") toast.success("Sequence activated");
  else if (status === "paused") toast.success("Sequence paused");
  else if (status === "archived") toast.success("Sequence archived");
  else toast.success("Sequence moved to draft");
}

export function useSequenceStatusController(options: {
  sequence: Sequence;
  canMutate: boolean;
  onChange: (next: Sequence) => void;
  versionRef?: { current: number | null };
  enqueueMutation?: SequenceMutationEnqueuer;
}) {
  const { sequence, canMutate, onChange, versionRef, enqueueMutation } =
    options;
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"pause" | "archive" | null>(
    null,
  );
  const [archiveTyped, setArchiveTyped] = useState("");
  const activeRef = useRef(false);
  const requestRef = useRef(0);
  const mutationRef = useRef(false);
  const sequenceRef = useRef(sequence);
  const canMutateRef = useRef(canMutate);
  const onChangeRef = useRef(onChange);
  sequenceRef.current = sequence;
  canMutateRef.current = canMutate;
  onChangeRef.current = onChange;
  const sequenceKey = sequence.id == null ? null : String(sequence.id);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
      mutationRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    mutationRef.current = false;
    setBusy(false);
    setMenuOpen(false);
    setConfirmKind(null);
    setArchiveTyped("");
  }, [sequenceKey]);

  useEffect(() => {
    if (canMutate && sequenceKey !== null) return;
    setMenuOpen(false);
    setConfirmKind(null);
    setArchiveTyped("");
  }, [canMutate, sequenceKey]);

  const current = normalizeSequenceStatus(sequence.status);
  const currentOption =
    SEQUENCE_STATUS_OPTIONS.find((option) => option.value === current) ??
    SEQUENCE_STATUS_OPTIONS[0]!;
  const hasConfirmedVersion =
    Number.isSafeInteger(versionRef?.current) && (versionRef?.current ?? 0) > 0;
  const canChange = canMutate && sequenceKey !== null && hasConfirmedVersion;
  const confirmationName = sequence.name?.trim() || "ARCHIVE";
  const archiveTypedMatches = archiveTyped.trim() === confirmationName;
  const activeRuns =
    typeof sequence.active_runs === "number" &&
    Number.isFinite(sequence.active_runs)
      ? Math.max(0, sequence.active_runs)
      : 0;

  const persistStatus = async (next: SequenceStatus): Promise<void> => {
    const startSequence = sequenceRef.current;
    const startKey = startSequence.id == null ? null : String(startSequence.id);
    if (
      !activeRef.current ||
      !canMutateRef.current ||
      mutationRef.current ||
      startKey === null
    ) {
      return;
    }
    const requestId = ++requestRef.current;
    const previousStatus = startSequence.status;
    const targetVersionRef = versionRef;
    let requestedVersion: number | null = null;
    mutationRef.current = true;
    setBusy(true);
    onChangeRef.current({ ...startSequence, status: next });
    const updateStatus = () => {
      const expectedVersion = targetVersionRef?.current;
      if (
        !Number.isSafeInteger(expectedVersion) ||
        (expectedVersion ?? 0) < 1
      ) {
        return Promise.resolve({
          error: {
            kind: "invalid_config" as const,
            message:
              "A fresh sequence version is required before changing status. Reload the sequence and try again.",
          },
        });
      }
      requestedVersion = expectedVersion!;
      return api.updateSequence(
        startSequence.id!,
        { status: next },
        expectedVersion!,
      );
    };
    const response = await (enqueueMutation
      ? enqueueMutation(updateStatus)
      : updateStatus());
    const latestSequence = sequenceRef.current;
    const latestKey =
      latestSequence.id == null ? null : String(latestSequence.id);
    if (
      !activeRef.current ||
      requestId !== requestRef.current ||
      latestKey !== startKey
    ) {
      return;
    }
    mutationRef.current = false;
    setBusy(false);
    if (response.error) {
      onChangeRef.current({ ...latestSequence, status: previousStatus });
      if (
        "code" in response.error &&
        response.error.code === "precondition_failed"
      ) {
        toast.error(
          "This sequence was edited in another tab — refresh to see the latest version, then re-apply your change.",
        );
      } else {
        toast.error(`Couldn't update status: ${response.error.message}`);
      }
      return;
    }
    const updatedVersion = response.data?.version;
    const confirmedVersion = confirmedNextSequenceVersion(
      updatedVersion,
      requestedVersion ?? 0,
    );
    if (targetVersionRef && confirmedVersion === null) {
      targetVersionRef.current = null;
      onChangeRef.current({ ...latestSequence, status: previousStatus });
      toast.error(SEQUENCE_VERSION_CONFIRMATION_ERROR);
      return;
    }
    if (targetVersionRef) {
      targetVersionRef.current = confirmedVersion;
    }
    const serverStatus =
      typeof response.data?.status === "string" ? response.data.status : next;
    onChangeRef.current({ ...latestSequence, status: serverStatus });
    statusToast(next);
  };

  const pickStatus = (next: SequenceStatus): void => {
    if (!canChange || mutationRef.current) return;
    setMenuOpen(false);
    if (next === current) return;
    if (next === "paused" && current === "active") {
      setConfirmKind("pause");
      return;
    }
    if (next === "archived") {
      setArchiveTyped("");
      setConfirmKind("archive");
      return;
    }
    void persistStatus(next);
  };

  const confirm = (kind: "pause" | "archive"): void => {
    if (!canChange || mutationRef.current || confirmKind !== kind) return;
    if (kind === "archive" && !archiveTypedMatches) return;
    setConfirmKind(null);
    setArchiveTyped("");
    void persistStatus(kind === "pause" ? "paused" : "archived");
  };

  return {
    current,
    currentOption,
    canChange,
    menuOpen,
    busy,
    confirmKind,
    archiveTyped,
    archiveTypedMatches,
    confirmationName,
    activeRuns,
    toggleMenu: () => {
      if (canChange && !mutationRef.current) {
        setMenuOpen((open) => !open);
      }
    },
    openMenu: () => {
      if (canChange && !mutationRef.current) setMenuOpen(true);
    },
    closeMenu: () => setMenuOpen(false),
    pickStatus,
    setArchiveTyped: (value: string) => {
      if (!mutationRef.current) setArchiveTyped(value);
    },
    cancelConfirm: () => {
      if (mutationRef.current) return;
      setConfirmKind(null);
      setArchiveTyped("");
    },
    confirmPause: () => confirm("pause"),
    confirmArchive: () => confirm("archive"),
  };
}

export type SequenceStatusController = ReturnType<
  typeof useSequenceStatusController
>;
