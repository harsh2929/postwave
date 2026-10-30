/**
 * hooks/useSubjectLab.ts — the Subject Lab's read and its one write-shaped
 * read.
 *
 *   GET  /api/v1/subject-analyzer/buckets   viewer      — what has worked
 *   POST /api/v1/subject-lab/score          ADMIN       — score candidates
 *
 * The floors are unequal and that asymmetry is the whole design of the screen:
 * see the header of src/api/subjectLab.ts for the two-gate measurement.
 *
 * Scoring is a MUTATION even though it mutates nothing. It is a POST the
 * operator triggers with a typed payload; modelling it as a query would key a
 * cache on free text and re-fire it on every focus, which is exactly the LLM-
 * adjacent fan-out the endpoint's own opt-in sibling exists to avoid.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  getSubjectBuckets,
  scoreSubjectCandidates,
  SUBJECT_BUCKETS_WINDOW_DAYS,
} from "@/api/subjectLab";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  SubjectBucketsReading,
  SubjectScoreReading,
} from "@/lib/subjectLab";

/** An SDK error carrying the fields the mobile envelope maps. */
function fail(error: { status: number; message: string }): never {
  throw Object.assign(new Error(error.message), { status: error.status });
}

export function useSubjectBuckets(options: { enabled?: boolean } = {}) {
  const gate = useOnlineQueryGate();
  const active = options.enabled !== false;
  return useQuery({
    queryKey: ["subject-buckets", gate.tenantId, SUBJECT_BUCKETS_WINDOW_DAYS],
    enabled: active && gate.enabled && Boolean(gate.tenantId),
    // A 180-day rollup over sent campaigns moves at the pace of a send, not a
    // screen visit.
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<SubjectBucketsReading> => {
      const res = await getSubjectBuckets();
      if (res.error) fail(res.error);
      return res.data;
    },
  });
}

export function useScoreSubjects() {
  return useMutation({
    mutationFn: async (
      subjects: readonly string[],
    ): Promise<SubjectScoreReading> => {
      const res = await scoreSubjectCandidates(subjects);
      if (res.error) fail(res.error);
      return res.data;
    },
  });
}
