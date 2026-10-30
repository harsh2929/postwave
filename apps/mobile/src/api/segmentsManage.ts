/**
 * api/segmentsManage.ts — DELETE /api/v1/segments/{id} (editor;
 * handlers.go:83, write:subscribers).
 *
 * ONLINE-ONLY, never the offline outbox: deleting a segment is irreversible
 * (the definition, its snapshots' anchor, and every usage reference die with
 * it) and an irreversible write must not replay from a queue after the
 * person has stopped looking. The UI pairs this with a typed confirm.
 */
import { rawRequest } from "@/api/request";

export async function deleteSegment(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/segments/${encodeURIComponent(id)}`,
  );
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't delete the segment."),
      res.error,
    );
  }
}
