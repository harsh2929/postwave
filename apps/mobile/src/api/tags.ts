/**
 * api/tags.ts — the tag registry's one mobile write.
 *
 *   POST /api/v1/tags   editor / write:subscribers   → 201 Tag
 *
 * ONLINE-ONLY, DELIBERATELY. Creation is name-conflict-prone by design —
 * the server answers 409 `name_taken` for a registered duplicate — and the
 * author must be present to pick a different name. Parking it in the
 * offline outbox would let the operator walk away believing a tag exists
 * while the replay silently fails hours later, which is worse than the
 * sheet saying "you're offline" up front. (Reads stay in
 * hooks/useTagCatalogue with their snapshot story; this file is writes.)
 *
 * UNWRAP BEFORE PARSING: `rawRequest` resolves to the {data,error}
 * ENVELOPE (api/request.ts), and a failure must surface as a throw, never
 * as a silently-undefined "created" tag.
 */
import { rawRequest, type AIApiError } from "@/api/request";

export class TagCreateError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(error: AIApiError) {
    super(error.message || "Couldn't create the tag.");
    this.name = "TagCreateError";
    this.status = error.status;
    this.code = error.code;
  }
}

export interface CreatedTag {
  id: string;
  name: string;
}

export async function createTag(body: {
  name: string;
  color?: string;
  description?: string;
  group_id?: string;
}): Promise<CreatedTag> {
  const res = await rawRequest<unknown>("POST", "/api/v1/tags", body);
  if (res.error) throw new TagCreateError(res.error);
  const row =
    res.data && typeof res.data === "object"
      ? (res.data as { id?: unknown; name?: unknown })
      : {};
  return {
    id: typeof row.id === "string" ? row.id : "",
    name: typeof row.name === "string" ? row.name : body.name,
  };
}

/**
 * The sentence the sheet shows for a failed create. Two failures get their
 * own words: a 409 is a naming decision the author must make, and a 403 is
 * a PERMISSION RULE — it must never read as a generic fault.
 */
export function tagCreateFailureCopy(err: unknown): string {
  if (err instanceof TagCreateError) {
    if (err.status === 409 || err.code === "name_taken") {
      return "A tag with this name already exists in the catalogue. Pick a different name, or use the existing tag.";
    }
    if (err.status === 403) {
      return "Creating tags needs an editor role in this workspace. Ask an admin to raise your role if you need it.";
    }
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Couldn't create the tag.";
}
