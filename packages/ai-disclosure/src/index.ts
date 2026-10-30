/**
 * @postwave/ai-disclosure — the SINGLE client-side source of truth for the
 * EU AI Act Article 50 disclosure text and the machine-readable
 * generated-content marker.
 *
 * The Apple-level integration validation (docs/ecosystem/apple-level-integration.md,
 * dimension 11) found that the server centralizes this text
 * (apps/api/internal/aidisclosure/aidisclosure.go) with an explicit
 * "clients render this" contract — but it had ZERO client consumers, so the
 * Art. 50(1) "you are talking to an AI" notice rendered on at most one desktop
 * panel. Art. 50 comes into force 2026-08-02.
 *
 * This package is the client mirror of the Go constants. `src/index.test.ts`
 * parses the Go file and asserts byte-for-byte equality (mirroring the
 * cross-language guard in @postwave/notifications), so the disclosure text can
 * never diverge between the gateway and the clients. Every interactive AI
 * surface (chat/agent) imports {@link AI_DISCLOSURE_TEXT} and renders it before
 * the first agent turn; generated output is machine-marked with
 * {@link AI_GENERATED_MARKER}.
 */

/**
 * Article 50(1) notice: shown when a user interacts with the in-app AI agent.
 * Clients render this before the first agent turn. MUST equal
 * `aidisclosure.DisclosureText` in the Go gateway.
 */
export const AI_DISCLOSURE_TEXT =
  "You are chatting with an AI assistant. Responses are generated automatically and may be inaccurate.";

/**
 * Article 50(2) machine-readable marker embedded in AI-generated content. MUST
 * equal `aidisclosure.Marker` in the Go gateway.
 */
export const AI_GENERATED_MARKER = "ai-generated:postwave";

/**
 * Delivery header flagging a message as containing AI-generated content. MUST
 * equal `aidisclosure.HeaderName` in the Go gateway.
 */
export const AI_GENERATED_HEADER = "X-Postwave-AI-Generated";

/**
 * A stable, human-readable label for the disclosure, useful as an
 * `accessibilityLabel` / `aria-label` on the surface that renders the text.
 */
export const AI_DISCLOSURE_LABEL = "AI interaction disclosure";
