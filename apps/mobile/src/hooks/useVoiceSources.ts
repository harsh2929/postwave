/**
 * hooks/useVoiceSources.ts — corpus sources for the Voice tab.
 *
 * Split from useVoice.ts so that file keeps to the two profile rows (measured
 * and authored); sources are a third resource family with their own five
 * routes and their own job-polling lifecycle.
 *
 * Every write here is ONLINE-ONLY — see api/voiceSources.ts for why. The card
 * hides the affordances rather than queueing writes that the offline queue
 * would refuse or that would fire unattended hours later.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createVoiceSource,
  deleteVoiceSource,
  getVoiceSourceIngestJob,
  listVoiceSources,
  startVoiceSourceIngest,
} from "@/api/voiceSources";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { newOfflineOperationId } from "@/lib/offlineMutations";
import {
  ingestJobInFlight,
  ingestStatusMessage,
  normalizeIngestStatus,
  voiceSourceErrorMessage,
  type IngestJobStatus,
  type VoiceSourceParamsWire,
  type VoiceSourceType,
  type VoiceSourceWire,
} from "@/lib/voiceSources";

export const VOICE_SOURCES_QUERY_KEY = "voice-sources" as const;

export function useVoiceSources() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [VOICE_SOURCES_QUERY_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<VoiceSourceWire[]> => {
      const res = await listVoiceSources();
      if (res.error) {
        throw new Error(
          voiceSourceErrorMessage(res.error.status, res.error.message),
        );
      }
      // The handler writes the store's rows directly; a nil slice marshals to
      // `null`, not `[]`, so an empty tenant must not throw here.
      return Array.isArray(res.data) ? res.data : [];
    },
  });
}

export function useCreateVoiceSource() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      type: VoiceSourceType;
      params: VoiceSourceParamsWire;
    }): Promise<string> => {
      const res = await createVoiceSource(body, newOfflineOperationId());
      if (res.error) {
        throw new Error(
          voiceSourceErrorMessage(res.error.status, res.error.message),
        );
      }
      return res.data?.source_id ?? "";
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [VOICE_SOURCES_QUERY_KEY, gate.tenantId],
      });
    },
  });
}

export function useDeleteVoiceSource() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const res = await deleteVoiceSource(id);
      if (res.error) {
        throw new Error(
          voiceSourceErrorMessage(res.error.status, res.error.message),
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: [VOICE_SOURCES_QUERY_KEY, gate.tenantId],
      });
    },
  });
}

export interface IngestRunState {
  sourceId: string;
  status: IngestJobStatus;
  message: string;
}

const POLL_INTERVAL_MS = 2_000;
/** ~2 minutes. The server caps a run at 5 minutes; past this the card stops
 *  claiming to know and tells the operator to pull to refresh. */
const MAX_POLLS = 60;

/**
 * Start an ingest and follow it to a terminal state.
 *
 * Polling rather than streaming because RN's fetch has no streaming transport
 * in this app, and because the job route is a plain GET by design. The poll
 * stops on the first terminal status, on unmount, and at a hard ceiling — an
 * unbounded poll against a job that will never finish is a battery bug.
 */
export function useVoiceSourceIngest(): {
  run: (sourceId: string) => void;
  state: IngestRunState | null;
  busySourceId: string | null;
} {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  const [state, setState] = useState<IngestRunState | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const run = useCallback(
    (sourceId: string) => {
      if (busySourceId) return;
      cancelledRef.current = false;
      setBusySourceId(sourceId);
      setState({ sourceId, status: "pending", message: "Queued…" });

      void (async () => {
        const started = await startVoiceSourceIngest(
          sourceId,
          newOfflineOperationId(),
        );
        if (cancelledRef.current) return;
        if (started.error) {
          setBusySourceId(null);
          setState({
            sourceId,
            status: "failed",
            message: voiceSourceErrorMessage(
              started.error.status,
              started.error.message,
            ),
          });
          return;
        }
        const jobId = started.data?.job_id ?? "";
        if (!jobId) {
          setBusySourceId(null);
          setState({
            sourceId,
            status: "unknown",
            message: ingestStatusMessage("unknown", 0),
          });
          return;
        }

        let polls = 0;
        const tick = async (): Promise<void> => {
          if (cancelledRef.current) return;
          polls += 1;
          const job = await getVoiceSourceIngestJob(sourceId, jobId);
          if (cancelledRef.current) return;
          if (job.error) {
            // 404 here means the job store is unwired (dev mode) or the job
            // aged out — NOT that the run succeeded.
            setBusySourceId(null);
            setState({
              sourceId,
              status: "unknown",
              message: ingestStatusMessage("unknown", 0),
            });
            return;
          }
          const status = normalizeIngestStatus(job.data?.status);
          const message = ingestStatusMessage(
            status,
            job.data?.item_count ?? 0,
            job.data?.error_message,
          );
          setState({ sourceId, status, message });
          if (!ingestJobInFlight(status)) {
            setBusySourceId(null);
            void qc.invalidateQueries({
              queryKey: [VOICE_SOURCES_QUERY_KEY, gate.tenantId],
            });
            if (status === "succeeded") {
              // A finished ingest changes the corpus the profile measures.
              void qc.invalidateQueries({ queryKey: ["voice-profile"] });
            }
            return;
          }
          if (polls >= MAX_POLLS) {
            setBusySourceId(null);
            setState({
              sourceId,
              status,
              message:
                "Still running on the server. Pull to refresh in a minute.",
            });
            return;
          }
          timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        };
        timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      })();
    },
    [busySourceId, gate.tenantId, qc],
  );

  return { run, state, busySourceId };
}
