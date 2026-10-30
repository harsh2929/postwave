import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  api,
  type DSAROperation,
  type JurisdictionReconfirmInput,
  type Subscriber,
  type SubscriberDetail,
} from "../../lib/api-client";
import { saveFile } from "../../lib/file-transfer";
import type { SubscriberDetailProps } from "../subscriber-detail-types";
import { toast } from "../Toast";

const EEA_GDPR = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
]);

export type JurisdictionRegime = "gdpr" | "casl" | "law25" | "unknown";

export function regimeForJurisdiction(
  country: string | null | undefined,
  region?: string | null,
): JurisdictionRegime {
  const normalized = (country ?? "").trim().toUpperCase();
  if (!normalized) return "unknown";
  if (EEA_GDPR.has(normalized)) return "gdpr";
  if (normalized === "CA") {
    const normalizedRegion = (region ?? "").trim().toUpperCase();
    return ["QC", "QUEBEC", "QUÉBEC"].includes(normalizedRegion)
      ? "law25"
      : "casl";
  }
  return "unknown";
}

export function regulationsForJurisdiction(
  country: string | null | undefined,
  region?: string | null,
): string {
  switch (regimeForJurisdiction(country, region)) {
    case "gdpr":
      return "GDPR";
    case "casl":
      return "CASL";
    case "law25":
      return "Quebec Law 25";
    default:
      return "stricter consent rules";
  }
}

export interface SubscriberDetailMutationController {
  actionBusy: boolean;
  confirmSuppressOpen: boolean;
  setConfirmSuppressOpen: Dispatch<SetStateAction<boolean>>;
  confirmDeleteOpen: boolean;
  setConfirmDeleteOpen: Dispatch<SetStateAction<boolean>>;
  dsarBusy: boolean;
  dsarModal: DSAROperation | null;
  dsarModalNonce: number;
  eraseConfirm: string;
  setEraseConfirm: Dispatch<SetStateAction<string>>;
  jurisdictionBusy: boolean;
  suppress: () => Promise<void>;
  archiveSubscriber: () => Promise<void>;
  unarchiveSubscriber: () => Promise<void>;
  exportDsar: () => Promise<void>;
  openDsarModal: (operation: DSAROperation) => void;
  closeDsarModal: () => void;
  reconfirmJurisdiction: (input: JurisdictionReconfirmInput) => Promise<void>;
}

interface MutationControllerOptions {
  id: Subscriber["id"];
  detail: SubscriberDetail;
  setDetail: Dispatch<SetStateAction<SubscriberDetail>>;
  onClose: SubscriberDetailProps["onClose"];
  onChange: SubscriberDetailProps["onChange"];
  canMutate: boolean;
  canAdmin: boolean;
  reloadDetail: () => void;
}

interface MutationOwnerToken {
  id: Subscriber["id"];
  generation: number;
}

export function useSubscriberDetailMutations({
  id,
  detail,
  setDetail,
  onClose,
  onChange,
  canMutate,
  canAdmin,
  reloadDetail,
}: MutationControllerOptions): SubscriberDetailMutationController {
  const [actionBusy, setActionBusy] = useState(false);
  const [confirmSuppressOpen, setConfirmSuppressOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [dsarBusy, setDsarBusy] = useState(false);
  const [dsarModal, setDsarModal] = useState<DSAROperation | null>(null);
  const [dsarModalNonce, setDsarModalNonce] = useState(0);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [jurisdictionBusy, setJurisdictionBusy] = useState(false);
  const dsarExportInFlightRef = useRef(false);
  const subscriberActionInFlightRef = useRef(false);
  const jurisdictionInFlightRef = useRef(false);
  const ownerRef = useRef({ id, generation: 0, mounted: false });
  if (!Object.is(ownerRef.current.id, id)) {
    ownerRef.current = {
      id,
      generation: ownerRef.current.generation + 1,
      mounted: false,
    };
  }

  useEffect(() => {
    const generation = ownerRef.current.generation + 1;
    ownerRef.current = { id, generation, mounted: true };
    return () => {
      if (ownerRef.current.generation === generation) {
        ownerRef.current = { id, generation: generation + 1, mounted: false };
      }
    };
  }, [id]);

  const ownerToken = (): MutationOwnerToken => ({
    id: ownerRef.current.id,
    generation: ownerRef.current.generation,
  });
  const ownsResult = (owner: MutationOwnerToken): boolean =>
    ownerRef.current.mounted &&
    Object.is(ownerRef.current.id, owner.id) &&
    ownerRef.current.generation === owner.generation;

  const suppress = async (): Promise<void> => {
    if (id == null || !canMutate || subscriberActionInFlightRef.current) {
      return;
    }
    const owner = ownerToken();
    subscriberActionInFlightRef.current = true;
    setActionBusy(true);
    const previousStatus = detail.status;
    const updated = { ...detail, status: "blocklisted" };
    setDetail(updated);
    try {
      const result = await api.suppressSubscriber(id, "manual");
      if (!ownsResult(owner)) return;
      if (result.error) {
        setDetail((current) => ({ ...current, status: previousStatus }));
        toast.error(`Couldn't suppress: ${result.error.message}`);
        return;
      }
      setConfirmSuppressOpen(false);
      onChange?.(updated, {
        kind: "patch",
        delta: { status: "blocklisted" },
      });
      toast.success(`Suppressed ${detail.email}`);
    } catch {
      if (!ownsResult(owner)) return;
      setDetail((current) => ({ ...current, status: previousStatus }));
      toast.error("Couldn't suppress this subscriber. Try again.");
    } finally {
      subscriberActionInFlightRef.current = false;
      if (ownsResult(owner)) setActionBusy(false);
    }
  };

  const archiveSubscriber = async (): Promise<void> => {
    if (id == null || !canMutate || subscriberActionInFlightRef.current) {
      return;
    }
    const owner = ownerToken();
    subscriberActionInFlightRef.current = true;
    setActionBusy(true);
    try {
      const result = await api.archiveSubscriber(id, detail.version ?? "");
      if (!ownsResult(owner)) return;
      if (result.error) {
        toast.error(`Couldn't archive: ${result.error.message}`);
        return;
      }
      setConfirmDeleteOpen(false);
      onChange?.(result.data ?? null, { kind: "remove" });
      toast.success(`Archived ${detail.email}`);
      onClose();
    } catch {
      if (!ownsResult(owner)) return;
      toast.error("Couldn't archive this subscriber. Try again.");
    } finally {
      subscriberActionInFlightRef.current = false;
      if (ownsResult(owner)) setActionBusy(false);
    }
  };

  const unarchiveSubscriber = async (): Promise<void> => {
    if (id == null || !canMutate || subscriberActionInFlightRef.current) {
      return;
    }
    const owner = ownerToken();
    subscriberActionInFlightRef.current = true;
    setActionBusy(true);
    try {
      const result = await api.unarchiveSubscriber(id, detail.version ?? "");
      if (!ownsResult(owner)) return;
      if (result.error) {
        toast.error(`Couldn't restore: ${result.error.message}`);
        return;
      }
      if (result.data) {
        setDetail(result.data);
        onChange?.(result.data);
      }
      toast.success(`Restored ${detail.email}`);
    } catch {
      if (!ownsResult(owner)) return;
      toast.error("Couldn't restore this subscriber. Try again.");
    } finally {
      subscriberActionInFlightRef.current = false;
      if (ownsResult(owner)) setActionBusy(false);
    }
  };

  const exportDsar = async (): Promise<void> => {
    if (id == null || !canAdmin || dsarExportInFlightRef.current) return;
    const owner = ownerToken();
    dsarExportInFlightRef.current = true;
    setDsarBusy(true);
    try {
      const result = await api.downloadSubscriberDataExport(id);
      if (!ownsResult(owner)) return;
      if (result.error) {
        toast.error("Couldn't prepare the subscriber data export. Try again.");
        return;
      }
      const saved = await saveFile({
        data: result.data.blob,
        suggestedName: result.data.filename,
        label: "Subscriber data export",
        privacy: "confidential",
        mimeType: "application/zip",
      });
      if (!ownsResult(owner)) return;
      if (
        (!saved.ok && saved.code === "cancelled") ||
        (saved.ok && saved.status === "cancelled")
      ) {
        return;
      }
      if (!saved.ok) {
        toast.error(saved.message);
        return;
      }
      if (saved.status === "download_started") {
        toast.info(
          "Subscriber data export download started. Check your browser's downloads for completion.",
        );
      } else {
        toast.success("Subscriber data export saved.");
      }
    } catch {
      if (!ownsResult(owner)) return;
      toast.error("Couldn't save the subscriber data export. Try again.");
    } finally {
      dsarExportInFlightRef.current = false;
      if (ownsResult(owner)) setDsarBusy(false);
    }
  };

  const openDsarModal = (operation: DSAROperation): void => {
    setDsarModalNonce((current) => current + 1);
    setDsarModal(operation);
  };

  const reconfirmJurisdiction = async (
    input: JurisdictionReconfirmInput,
  ): Promise<void> => {
    if (id == null || !canMutate || jurisdictionInFlightRef.current) return;
    const owner = ownerToken();
    jurisdictionInFlightRef.current = true;
    setJurisdictionBusy(true);
    try {
      const result = await api.reconfirmSubscriberJurisdiction(id, input);
      if (!ownsResult(owner)) return;
      if (result.error) {
        toast.error(`Couldn't record decision: ${result.error.message}`);
        if (result.error.status === 409) reloadDetail();
        return;
      }
      if (result.data) {
        setDetail(result.data);
        onChange?.(result.data);
      }
      toast.success(
        input.decision === "accepted"
          ? "Subject acceptance recorded with consent evidence."
          : "Subject decline recorded and email consent removed.",
      );
    } catch {
      if (!ownsResult(owner)) return;
      toast.error("Couldn't record this consent decision. Try again.");
    } finally {
      jurisdictionInFlightRef.current = false;
      if (ownsResult(owner)) setJurisdictionBusy(false);
    }
  };

  return {
    actionBusy,
    confirmSuppressOpen,
    setConfirmSuppressOpen,
    confirmDeleteOpen,
    setConfirmDeleteOpen,
    dsarBusy,
    dsarModal,
    dsarModalNonce,
    eraseConfirm,
    setEraseConfirm,
    jurisdictionBusy,
    suppress,
    archiveSubscriber,
    unarchiveSubscriber,
    exportDsar,
    openDsarModal,
    closeDsarModal: () => setDsarModal(null),
    reconfirmJurisdiction,
  };
}
