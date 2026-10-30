/**
 * hooks/useSubjectLabVariants.ts — the Subject Lab's generator.
 *
 *   POST /api/v1/subject-lab/variants   editor + the `subject_lab` flag
 *
 * A MUTATION that mutates nothing, for the same reason `useScoreSubjects` is:
 * it is a POST an operator triggers with a typed payload, and modelling it as
 * a query would key a cache on free text and re-fire an LLM fan-out on every
 * screen focus. Deliberately NOT given `offlineSafeMutationMeta` — an hour-old
 * generation replayed from the outbox arrives with nobody looking at the
 * screen and spends model budget on a subject line that is no longer being
 * written.
 *
 * THE ERROR IS CARRIED WHOLE. `useSubjectLab`'s local `fail()` rebuilds an
 * Error from `{ status, message }` and drops everything else, which is exactly
 * what makes the entitlement envelope invisible: `/variants` refuses a
 * workspace without the flag with `reason: "flag"` /
 * `remedy: "contact_workspace_admin"`, and lib/errorCopy reads that off
 * `error.denial` to produce the one sentence that is actually actionable. So
 * `denial`, `code` and `payload` travel with the throw.
 */
import { useMutation } from "@tanstack/react-query";

import {
  generateSubjectVariants,
  type SubjectVariantsInput,
} from "@/api/subjectLabVariants";
import type { AIApiError } from "@/api/request";
import type { SubjectVariantsReading } from "@/lib/subjectLabVariants";

/**
 * Rebuild the mobile error envelope as a thrown Error without losing the
 * fields the copy layer branches on. `exactOptionalPropertyTypes` is on, so
 * absent fields are omitted rather than set to undefined.
 */
function fail(error: AIApiError): never {
  throw Object.assign(new Error(error.message), {
    status: error.status,
    ...(error.code ? { code: error.code } : {}),
    ...(error.denial ? { denial: error.denial } : {}),
    ...(error.payload !== undefined ? { payload: error.payload } : {}),
  });
}

export function useGenerateSubjectVariants() {
  return useMutation({
    mutationFn: async (
      input: SubjectVariantsInput,
    ): Promise<SubjectVariantsReading> => {
      const res = await generateSubjectVariants(input);
      if (res.error) fail(res.error);
      return res.data;
    },
  });
}
