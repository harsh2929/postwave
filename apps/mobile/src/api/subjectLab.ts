/**
 * api/subjectLab.ts — the two reads behind the Subject Lab.
 *
 *   GET  /api/v1/subject-analyzer/buckets?days=180
 *   POST /api/v1/subject-lab/score            { subjects: string[1..16] }
 *
 * AUTHORIZATION, MEASURED AT BOTH GATES. apps/api authorises every route
 * twice: the `apikeys.RequireScope(...)` wrapper at the mount site, and
 * `routeauth.Middleware`, which independently evaluates
 * apps/api/internal/routeauth/manifest.json (wired at main.go:2247). The
 * effective floor is the stricter of the two, and for these two routes they
 * DISAGREE:
 *
 *   buckets   mount read:reports (subject_analyzer.go:99)
 *             manifest session_minimum_role "viewer"        → viewer
 *   score     mount read:reports (subject_lab.go:105)
 *             manifest session_minimum_role "admin"         → ADMIN
 *
 * Reading only the handler file would put the scoring button in front of every
 * viewer, where it could return nothing but 403. The caller therefore gates
 * scoring on `admin` and the evidence rollup on nothing at all.
 *
 * Response shaping lives in lib/subjectLab.ts — this module reaches the SDK
 * (and therefore react-native), so it can never be imported by a .test.ts in
 * mobile's node vitest environment.
 */
import { rawRequest, type AIApiResult } from "./request";
import {
  readSubjectBuckets,
  readSubjectLabScore,
  type SubjectBucketsReading,
  type SubjectScoreReading,
} from "@/lib/subjectLab";

/** subject_analyzer.go clamps `days` to 30..730 and defaults to 180. */
export const SUBJECT_BUCKETS_WINDOW_DAYS = 180;

export async function getSubjectBuckets(
  days: number = SUBJECT_BUCKETS_WINDOW_DAYS,
): Promise<AIApiResult<SubjectBucketsReading>> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/subject-analyzer/buckets?days=${encodeURIComponent(String(days))}`,
  );
  if (res.error) return { data: null, error: res.error };
  return { data: readSubjectBuckets(res.data), error: null };
}

export async function scoreSubjectCandidates(
  subjects: readonly string[],
): Promise<AIApiResult<SubjectScoreReading>> {
  const res = await rawRequest<unknown>("POST", "/api/v1/subject-lab/score", {
    subjects: [...subjects],
  });
  if (res.error) return { data: null, error: res.error };
  return { data: readSubjectLabScore(res.data), error: null };
}
