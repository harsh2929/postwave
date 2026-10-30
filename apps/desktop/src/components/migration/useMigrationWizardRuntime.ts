import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type MigrationJob,
  type MigrationPreview,
  type MigrationSource,
  type MigrationSourceCapability,
  api,
} from "../../lib/api-client";
import { parseMigrationSourceCapabilities } from "../../lib/api/migrations";
import {
  applyRuntimeMigrationCapability,
  findSource,
  type MigrationSourceDef,
} from "../../lib/migration-sources";
import {
  normalizeMigrationJob,
  safeMigrationOperationText,
} from "./migrations-surface-helpers";

export const MIGRATION_POLL_INTERVAL_MS = 3000;
const PREVIEW_TIMEOUT_MS = 5 * 60 * 1000;

interface MigrationRuntimeBindings {
  initialCapabilities?: MigrationSourceCapability[];
  setBusy: Dispatch<SetStateAction<boolean>>;
  setJob: Dispatch<SetStateAction<MigrationJob | null>>;
  setOAuthWaiting: Dispatch<SetStateAction<boolean>>;
  setPreview: Dispatch<SetStateAction<MigrationPreview | null>>;
  setSource: Dispatch<SetStateAction<MigrationSourceDef | null>>;
  setStepError: Dispatch<SetStateAction<string | null>>;
}

export function useMigrationWizardRuntime({
  initialCapabilities,
  setBusy,
  setJob,
  setOAuthWaiting,
  setPreview,
  setSource,
  setStepError,
}: MigrationRuntimeBindings) {
  const pollRef = useRef<number | null>(null);
  const oauthPollRef = useRef<number | null>(null);
  const oauthHandoffGenerationRef = useRef(0);
  const previewGenerationRef = useRef(0);
  const previewActiveRef = useRef(false);
  const previewTickActiveRef = useRef(false);
  const pollAliveRef = useRef(true);

  const clearPreviewTimer = useCallback((): void => {
    if (pollRef.current != null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  const stopPreview = useCallback(
    (updateState = true): void => {
      previewGenerationRef.current += 1;
      previewActiveRef.current = false;
      previewTickActiveRef.current = false;
      clearPreviewTimer();
      if (updateState && pollAliveRef.current) setBusy(false);
    },
    [clearPreviewTimer, setBusy],
  );
  const stopOAuthHandoff = useCallback(
    (updateState = true): void => {
      oauthHandoffGenerationRef.current += 1;
      if (oauthPollRef.current != null) {
        window.clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }
      if (updateState) setOAuthWaiting(false);
    },
    [setOAuthWaiting],
  );

  useEffect(() => {
    pollAliveRef.current = true;
    return () => {
      pollAliveRef.current = false;
      previewGenerationRef.current += 1;
      previewActiveRef.current = false;
      clearPreviewTimer();
      if (oauthPollRef.current != null) {
        window.clearInterval(oauthPollRef.current);
        oauthPollRef.current = null;
      }
      oauthHandoffGenerationRef.current += 1;
    };
  }, [clearPreviewTimer]);

  const catalog = useMigrationCapabilities(
    pollAliveRef,
    setSource,
    initialCapabilities,
  );
  const runPreview = useCallback(
    async (
      apiSource: MigrationSource,
      id: string,
      audienceIds?: string[],
    ): Promise<void> => {
      if (previewActiveRef.current) return;
      const generation = ++previewGenerationRef.current;
      previewActiveRef.current = true;
      setBusy(true);
      setStepError(null);
      setPreview(null);
      let kick: Awaited<ReturnType<typeof api.previewMigration>>;
      try {
        kick = await Promise.resolve().then(() =>
          api.previewMigration(apiSource, id, audienceIds),
        );
      } catch (caught) {
        if (
          pollAliveRef.current &&
          previewGenerationRef.current === generation
        ) {
          previewActiveRef.current = false;
          setBusy(false);
          setStepError(safeMigrationOperationText(caught, "Dry-run start"));
        }
        return;
      }
      if (
        !pollAliveRef.current ||
        previewGenerationRef.current !== generation
      ) {
        return;
      }
      if (kick.error || kick.data?.job_id !== id) {
        previewActiveRef.current = false;
        setBusy(false);
        setStepError(
          safeMigrationOperationText(
            kick.error ?? {
              kind: "parse",
              code: "migration_preview_invalid_ack",
            },
            "Dry-run start",
          ),
        );
        return;
      }
      startPreviewPolling({
        generation,
        id,
        pollRef,
        pollAliveRef,
        previewGenerationRef,
        previewActiveRef,
        previewTickActiveRef,
        clearPreviewTimer,
        setBusy,
        setJob,
        setPreview,
        setStepError,
      });
    },
    [clearPreviewTimer, setBusy, setJob, setPreview, setStepError],
  );

  return {
    ...catalog,
    oauthHandoffGenerationRef,
    oauthPollRef,
    pollAliveRef,
    runPreview,
    stopOAuthHandoff,
    stopPreview,
  };
}

function useMigrationCapabilities(
  aliveRef: RefObject<boolean>,
  setSource: Dispatch<SetStateAction<MigrationSourceDef | null>>,
  initialCapabilities?: MigrationSourceCapability[],
) {
  const [capabilities, setCapabilities] = useState<
    MigrationSourceCapability[] | null
  >(() => initialCapabilities ?? null);
  const receivedInitialCapabilitiesRef = useRef(
    initialCapabilities !== undefined,
  );
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null,
  );
  const [capabilitiesRefreshing, setCapabilitiesRefreshing] = useState(false);
  const [capabilitiesStale, setCapabilitiesStale] = useState(false);
  const generationRef = useRef(0);
  const flightRef = useRef<Promise<void> | null>(null);

  const refreshCapabilities = useCallback(async (): Promise<void> => {
    if (flightRef.current) {
      await flightRef.current;
      return;
    }
    const generation = ++generationRef.current;
    if (aliveRef.current) setCapabilitiesRefreshing(true);
    const flight = Promise.resolve()
      .then(() => api.listMigrationSources())
      .then((result) => {
        if (!aliveRef.current || generationRef.current !== generation) return;
        if (result.error) {
          setCapabilities((current) => current ?? []);
          setCapabilitiesStale(true);
          setCapabilitiesError(
            safeMigrationOperationText(result.error, "Migration capabilities"),
          );
          return;
        }
        const parsed = parseMigrationSourceCapabilities(result.data);
        if (parsed.error) {
          setCapabilities((current) => current ?? []);
          setCapabilitiesStale(true);
          setCapabilitiesError(
            safeMigrationOperationText(parsed.error, "Migration capabilities"),
          );
          return;
        }
        setCapabilities(parsed.data);
        setCapabilitiesStale(false);
        setCapabilitiesError(null);
        setSource((current) => {
          if (!current) return current;
          const canonical = findSource(current.id);
          if (!canonical) return null;
          const capability = parsed.data.find(
            (item) => item.source === current.id,
          );
          return applyRuntimeMigrationCapability(canonical, capability);
        });
      })
      .catch((caught: unknown) => {
        if (!aliveRef.current || generationRef.current !== generation) return;
        setCapabilities((current) => current ?? []);
        setCapabilitiesStale(true);
        setCapabilitiesError(
          safeMigrationOperationText(caught, "Migration capabilities"),
        );
      })
      .finally(() => {
        if (flightRef.current === flight) flightRef.current = null;
        if (aliveRef.current && generationRef.current === generation) {
          setCapabilitiesRefreshing(false);
        }
      });
    flightRef.current = flight;
    await flight;
  }, [aliveRef, setSource]);

  useEffect(() => {
    if (receivedInitialCapabilitiesRef.current) return;
    const timer = window.setTimeout(() => void refreshCapabilities(), 0);
    return () => {
      generationRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [refreshCapabilities]);

  return {
    capabilities,
    capabilitiesError,
    capabilitiesRefreshing,
    capabilitiesStale,
    refreshCapabilities,
  };
}

interface PreviewPollingBindings {
  generation: number;
  id: string;
  pollRef: RefObject<number | null>;
  pollAliveRef: RefObject<boolean>;
  previewGenerationRef: RefObject<number>;
  previewActiveRef: RefObject<boolean>;
  previewTickActiveRef: RefObject<boolean>;
  clearPreviewTimer: () => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setJob: Dispatch<SetStateAction<MigrationJob | null>>;
  setPreview: Dispatch<SetStateAction<MigrationPreview | null>>;
  setStepError: Dispatch<SetStateAction<string | null>>;
}

function startPreviewPolling(bindings: PreviewPollingBindings): void {
  const {
    generation,
    id,
    pollRef,
    pollAliveRef,
    previewGenerationRef,
    previewActiveRef,
    previewTickActiveRef,
    clearPreviewTimer,
    setBusy,
    setJob,
    setPreview,
    setStepError,
  } = bindings;
  clearPreviewTimer();
  const startedAt = Date.now();
  let consecutiveFailures = 0;
  const finish = (): void => {
    previewActiveRef.current = false;
    previewTickActiveRef.current = false;
    clearPreviewTimer();
  };
  const schedule = (): void => {
    if (
      pollAliveRef.current &&
      previewGenerationRef.current === generation &&
      previewActiveRef.current
    ) {
      pollRef.current = window.setTimeout(
        () => void tick(),
        MIGRATION_POLL_INTERVAL_MS,
      );
    }
  };
  const fail = (message: string): void => {
    finish();
    setBusy(false);
    setStepError(message);
  };
  const tick = async (): Promise<void> => {
    if (
      !pollAliveRef.current ||
      previewGenerationRef.current !== generation ||
      !previewActiveRef.current ||
      previewTickActiveRef.current
    ) {
      return;
    }
    if (Date.now() - startedAt >= PREVIEW_TIMEOUT_MS) {
      fail(
        "The dry-run did not produce a verified report within five minutes. No real import was started; retry when ready.",
      );
      return;
    }
    previewTickActiveRef.current = true;
    try {
      const result = await Promise.resolve().then(() => api.getMigration(id));
      if (
        !pollAliveRef.current ||
        previewGenerationRef.current !== generation
      ) {
        return;
      }
      if (result.error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          fail(
            safeMigrationOperationText(result.error, "Dry-run status refresh"),
          );
        }
        return;
      }
      const normalized = normalizeMigrationJob(result.data);
      if (!normalized || normalized.id !== id) {
        fail(
          safeMigrationOperationText(
            { kind: "parse", code: "migration_preview_invalid_snapshot" },
            "Dry-run status refresh",
          ),
        );
        return;
      }
      consecutiveFailures = 0;
      setJob(normalized);
      if (
        normalized.verification_report &&
        ["awaiting_confirmation", "completed", "dry_run"].includes(
          normalized.status,
        )
      ) {
        finish();
        setPreview(normalized.verification_report);
        setBusy(false);
      } else if (normalized.status === "failed") {
        fail(
          "The dry-run stopped before a verification report was produced. Provider detail is withheld; review the connection and retry.",
        );
      }
    } catch (caught) {
      consecutiveFailures += 1;
      if (
        pollAliveRef.current &&
        previewGenerationRef.current === generation &&
        consecutiveFailures >= 3
      ) {
        fail(safeMigrationOperationText(caught, "Dry-run status refresh"));
      }
    } finally {
      previewTickActiveRef.current = false;
      schedule();
    }
  };
  void tick();
}
