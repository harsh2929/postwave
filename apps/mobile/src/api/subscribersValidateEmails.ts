/**
 * api/subscribersValidateEmails.ts — POST /api/v1/email-validation/check-batch
 * (admin; MaxBatch 1000, comfortably above the 500-row selection ceiling).
 *
 * Surface validation only — no verification credits are spent, so this is not
 * routed through any billable-idempotency discipline. Kept react-native-free
 * so the node vitest run pins the wire body with `rawRequest` mocked; the
 * envelope's error becomes a THROW so a failed check can never read as a
 * clean result.
 */
import { rawRequest } from "@/api/request";

export async function checkEmailBatch(emails: string[]): Promise<unknown> {
  const res = await rawRequest<unknown>(
    "POST",
    "/api/v1/email-validation/check-batch",
    { emails },
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't validate the selection."),
      res.error,
    );
  }
  return res.data;
}
