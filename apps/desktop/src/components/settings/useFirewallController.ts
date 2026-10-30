import { useCallback, useEffect, useRef, useState } from "react";

import {
  lifecycleOperationError,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import {
  type FirewallEvent,
  type FirewallSettings,
  type FirewallStats,
  firewallApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import {
  type FirewallDraft,
  firewallPatch,
  surgeResultCopy,
  validateFirewallDraft,
} from "./firewall-helpers";

const EVENTS_LIMIT = 20;

export interface FirewallController {
  canAdmin: boolean;
  server: FirewallSettings | null;
  draft: FirewallDraft | null;
  stats: FirewallStats | null;
  events: FirewallEvent[] | null;
  loading: boolean;
  error: string | null;
  saveError: string | null;
  saving: boolean;
  detecting: boolean;
  detectResult: string | null;
  dirty: boolean;
  mutationsLocked: boolean;
  load: () => Promise<void>;
  save: () => Promise<boolean>;
  detect: () => Promise<void>;
  setDraft: (patch: Partial<FirewallDraft>) => void;
}

export function firewallSettingsToDraft(
  settings: FirewallSettings,
): FirewallDraft {
  return {
    attack_mode_enabled: settings.attack_mode_enabled,
    auto_attack_mode: settings.auto_attack_mode,
    fingerprint_required: settings.fingerprint_required,
    attack_mode_threshold: settings.attack_mode_threshold,
    surge_multiplier: settings.surge_multiplier,
    surge_min_per_hour: settings.surge_min_per_hour,
  };
}

export function useFirewallController(): FirewallController {
  const canAdmin = useCanAdmin();
  const activeRef = useRef(true);
  const loadRequestRef = useRef(0);
  const actionRequestRef = useRef(0);
  const serverRef = useRef<FirewallSettings | null>(null);
  const draftRef = useRef<FirewallDraft | null>(null);
  const mutation = useSingleFlightOperation({
    ownerId: "firewall-settings",
    label: "Firewall settings request",
  });
  const [server, setServer] = useState<FirewallSettings | null>(null);
  const [draft, setDraftState] = useState<FirewallDraft | null>(null);
  const [stats, setStats] = useState<FirewallStats | null>(null);
  const [events, setEvents] = useState<FirewallEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError(null);
    let settingsResult;
    let statsResult;
    let eventsResult;
    try {
      [settingsResult, statsResult, eventsResult] = await Promise.all([
        firewallApi.settings(),
        firewallApi.stats(),
        firewallApi.events({ limit: EVENTS_LIMIT }),
      ]);
    } catch (loadError) {
      if (activeRef.current && requestId === loadRequestRef.current) {
        setError(
          lifecycleOperationError(
            loadError,
            "Firewall settings couldn't be loaded.",
          ),
        );
        setLoading(false);
      }
      return;
    }
    if (!activeRef.current || requestId !== loadRequestRef.current) return;
    const firstError =
      settingsResult.error ?? statsResult.error ?? eventsResult.error;
    if (firstError || !settingsResult.data) {
      setError(firstError?.message ?? "Firewall settings response was empty.");
      setLoading(false);
      return;
    }

    const localPatch =
      serverRef.current && draftRef.current
        ? firewallPatch(
            firewallSettingsToDraft(serverRef.current),
            draftRef.current,
          )
        : null;
    const nextServer = settingsResult.data;
    const nextDraft = {
      ...firewallSettingsToDraft(nextServer),
      ...(localPatch ?? {}),
    };
    serverRef.current = nextServer;
    draftRef.current = nextDraft;
    setServer(nextServer);
    setDraftState(nextDraft);
    setStats(statsResult.data ?? null);
    setEvents(eventsResult.data?.events ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
      loadRequestRef.current += 1;
      actionRequestRef.current += 1;
    };
  }, [load]);

  const setDraft = (patch: Partial<FirewallDraft>): void => {
    if (!canAdmin || mutation.promiseRef.current) return;
    setSaveError(null);
    setDraftState((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      draftRef.current = next;
      return next;
    });
  };

  const save = async (): Promise<boolean> => {
    const currentServer = serverRef.current;
    const currentDraft = draftRef.current;
    if (
      !canAdmin ||
      loading ||
      !currentServer ||
      !currentDraft
    )
      return false;
    if (mutation.promiseRef.current) {
      await mutation.wait();
      const acknowledged = serverRef.current;
      const current = draftRef.current;
      return Boolean(
        acknowledged &&
          current &&
          !firewallPatch(firewallSettingsToDraft(acknowledged), current),
      );
    }
    const patch = firewallPatch(
      firewallSettingsToDraft(currentServer),
      currentDraft,
    );
    if (!patch) return true;
    const validationError = validateFirewallDraft(currentDraft);
    if (validationError) {
      setSaveError(validationError);
      return false;
    }

    const requestId = ++actionRequestRef.current;
    setSaving(true);
    setSaveError(null);
    const request = mutation.run(async (): Promise<boolean> => {
      try {
        const response = await firewallApi.putSettings(patch);
        if (!activeRef.current || requestId !== actionRequestRef.current) {
          return false;
        }
        if (response.error || !response.data) {
          setSaveError(
            response.error?.message ??
              "Firewall settings update returned no settings.",
          );
          return false;
        }

        const editsAfterRequest = draftRef.current
          ? firewallPatch(currentDraft, draftRef.current)
          : null;
        const nextDraft = {
          ...firewallSettingsToDraft(response.data),
          ...(editsAfterRequest ?? {}),
        };
        serverRef.current = response.data;
        draftRef.current = nextDraft;
        setServer(response.data);
        setDraftState(nextDraft);
        toast.success("Firewall settings saved");
        return editsAfterRequest === null;
      } catch (saveFailure) {
        if (activeRef.current && requestId === actionRequestRef.current) {
          setSaveError(
            lifecycleOperationError(
              saveFailure,
              "Firewall settings couldn't be saved.",
            ),
          );
        }
        return false;
      } finally {
        if (activeRef.current && requestId === actionRequestRef.current) {
          setSaving(false);
        }
      }
    });
    return request ? await request : false;
  };

  const detect = async (): Promise<void> => {
    if (!canAdmin || loading) return;
    if (mutation.promiseRef.current) {
      await mutation.wait();
      return;
    }
    const requestId = ++actionRequestRef.current;
    setDetecting(true);
    setDetectResult(null);
    const request = mutation.run(async (): Promise<void> => {
      try {
        const response = await firewallApi.detect();
        if (!activeRef.current || requestId !== actionRequestRef.current) return;
        if (response.error || !response.data) {
          toast.error({
            message: "Surge check failed",
            detail:
              response.error?.message ?? "The server returned no surge result.",
          });
          return;
        }
        setDetectResult(surgeResultCopy(response.data.flipped));
        if (response.data.flipped) await load();
      } catch (detectFailure) {
        if (activeRef.current && requestId === actionRequestRef.current) {
          toast.error({
            message: "Surge check failed",
            detail: lifecycleOperationError(
              detectFailure,
              "The surge check couldn't be completed.",
            ),
          });
        }
      } finally {
        if (activeRef.current && requestId === actionRequestRef.current) {
          setDetecting(false);
        }
      }
    });
    if (request) await request;
  };

  const patch =
    server && draft
      ? firewallPatch(firewallSettingsToDraft(server), draft)
      : null;
  const discard = useCallback((): void => {
    const acknowledged = serverRef.current;
    if (!acknowledged) return;
    const restored = firewallSettingsToDraft(acknowledged);
    draftRef.current = restored;
    setDraftState(restored);
    setSaveError(null);
  }, []);
  useExistingSettingLifecycle({
    ownerId: "firewall-settings",
    label: "Firewall settings",
    dirty: patch !== null,
    operationRef: mutation.promiseRef,
    save,
    discard,
    detail: "Firewall policy changes have not been saved.",
    operationDetail:
      "Wait for the firewall policy request to finish before leaving Moosewave.",
  });
  return {
    canAdmin,
    server,
    draft,
    stats,
    events,
    loading,
    error,
    saveError,
    saving,
    detecting,
    detectResult,
    dirty: patch !== null,
    mutationsLocked: mutation.active || saving || detecting,
    load,
    save,
    detect,
    setDraft,
  };
}
