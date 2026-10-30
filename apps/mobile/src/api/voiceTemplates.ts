/**
 * api/voiceTemplates.ts — the shared prompt/template library.
 *
 *   GET    /api/v1/voice/templates            read:campaigns (viewer)
 *   GET    /api/v1/voice/templates/{id}       read:campaigns (viewer)
 *   POST   /api/v1/voice/templates/generate   write:campaigns (editor)
 *   DELETE /api/v1/voice/templates/{id}       admin
 *
 * Mounted at apps/api/main.go:5086-5187 onto `voiceProxy`, which forwards to
 * the voice service's /v1/voice/templates routes
 * (services/voice/internal/handlers/sequences.go genRoutes).
 *
 * LIST RETURNS A BARE ARRAY, not an envelope — the type is `unknown` here on
 * purpose so the single tolerant parser in lib/voiceTemplates owns that shape
 * decision (and the desktop-style `{templates|items|data}` hedge with it).
 *
 * POST /templates (create) and PATCH /templates/{id} (edit) are deliberately
 * absent: a create must supply a whole sequence skeleton — slug, category,
 * variables[] and emails[] of subject/body skeletons — and the store validates
 * none of it (PostgresStore.Create just inserts), so a phone-sized form would
 * write malformed rows into the workspace's shared library.
 */
import { rawRequest, type AIApiResult } from "./request";

/** GET /api/v1/voice/templates[?category=] — payload parsed by lib/voiceTemplates. */
export async function listVoiceTemplates(
  category?: string,
): Promise<AIApiResult<unknown>> {
  const trimmed = typeof category === "string" ? category.trim() : "";
  const path =
    "/api/v1/voice/templates" +
    (trimmed ? `?category=${encodeURIComponent(trimmed)}` : "");
  return rawRequest<unknown>("GET", path);
}

/** GET /api/v1/voice/templates/{id} — one template, same tolerant parse. */
export async function getVoiceTemplate(
  id: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "GET",
    `/api/v1/voice/templates/${encodeURIComponent(id)}`,
  );
}

/**
 * POST /api/v1/voice/templates/generate — one synchronous LLM call that
 * persists nothing and spends one unit of the tenant's daily AI budget
 * (template_generate.go). Answers `{name, subject, body_html, body_mjml?}`.
 */
export async function generateVoiceTemplate(body: {
  brief: string;
  kind: string;
  tone?: string;
}): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "POST",
    "/api/v1/voice/templates/generate",
    body,
  );
}

/** DELETE /api/v1/voice/templates/{id} — admin. */
export async function deleteVoiceTemplate(
  id: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "DELETE",
    `/api/v1/voice/templates/${encodeURIComponent(id)}`,
  );
}
