/**
 * api/listsManage.ts — the two list-management writes mobile ships.
 *
 *   PATCH  /api/v1/lists/{id}   (editor) — subset body, see lib/listSettingsForm
 *   DELETE /api/v1/lists/{id}   (editor) — irreversible; membership rows go
 *                                          with the container
 *
 * Both take the LISTMONK BIGINT id (the handlers strconv.ParseInt the path
 * param), which is what the catalogue rows carry.
 *
 * Both are ONLINE-ONLY, never the offline outbox:
 *   - the PATCH can flip opt-in mode (consent-shaped — see lib/listSettingsForm);
 *   - the DELETE is irreversible, and an irreversible write must never replay
 *     from a queue after the person has stopped looking.
 *
 * UNWRAP BEFORE RETURNING: `rawRequest` resolves to the `{data, error}`
 * envelope (src/api/request.ts), never the body. Errors are thrown with the
 * envelope's fields attached so screens can present a 403 as the permission
 * rule it is (lib/errorCopy reads `.status`/`.denial`).
 */
import { rawRequest } from "@/api/request";
import type { ListSettingsPatch } from "@/lib/listSettingsForm";

function throwEnvelope(
  error: { message?: string; status?: number },
  fallback: string,
): never {
  throw Object.assign(new Error(error.message || fallback), error);
}

export async function updateList(
  id: string,
  patch: ListSettingsPatch,
): Promise<void> {
  const res = await rawRequest<unknown>(
    "PATCH",
    `/api/v1/lists/${encodeURIComponent(id)}`,
    patch,
  );
  if (res.error) throwEnvelope(res.error, "Couldn't save the list settings.");
}

export async function deleteList(id: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/lists/${encodeURIComponent(id)}`,
  );
  if (res.error) throwEnvelope(res.error, "Couldn't delete the list.");
}
