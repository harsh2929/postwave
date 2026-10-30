/**
 * lib/aiVoiceProfile.ts — the id every client sends for the workspace's
 * learned brand voice.
 *
 * It is a SENTINEL, not a row id. services/voice/internal/handlers/chat.go
 * `renderVoiceProfileRef` looks the profile up from the TENANT on the request
 * and ignores the id entirely, returning "" when no profile has been built
 * yet. So a client never has to fetch a profile before it can ask for one, and
 * a workspace that has not trained a voice degrades to plain generation rather
 * than to an error. Desktop sends the same literal
 * (apps/desktop/src/pages/PostwaveAI.tsx — `{ type: "voice_profile", id:
 * "active" }`).
 *
 * VALID ON THE CHAT `context_refs` PATH AND NOWHERE ELSE. `renderVoiceProfileRef`
 * is called from exactly one place — chat.go:569, the context_refs enrichment —
 * and it takes `(ctx, h, tenant)`, never the id. Every other route that accepts
 * a profile id treats it as LITERAL TEXT: apps/api's aicompose
 * `profileBindingExtra` (aicompose.go:441-447) turns a non-empty id straight
 * into the context line "Bound brand voice profile: <id>", which is what both
 * /api/v1/ai/compose and /api/v1/subject-lab/variants reach. On those routes
 * this constant would write a profile id that does not exist into the prompt
 * and into the auditable context_text, while `loadBrandVoice` separately emits
 * the tenant's REAL profile id — two lines disagreeing about one profile. So
 * on a route that embeds the id, send a real id or send nothing; do not reach
 * for this constant because it is the string the chat path happens to accept.
 *
 * ITS OWN MODULE, and deliberately: the natural home looked like
 * `api/aiGenerate`, but that module reaches the auth store, `expo/fetch` and
 * the SDK. Importing a streaming transport into two campaign sheets to obtain
 * one string drags react-native into their module graph and puts every test
 * that renders them out of reach of mobile's node vitest — which is exactly
 * what happened when it lived there. A constant with no dependencies belongs
 * where anything may import it.
 */
export const ACTIVE_VOICE_PROFILE = "active";
