-- 1524_auth_sessions_role_override.sql
--
-- SUB-091: View-as-Viewer admin affordance.
--
-- An admin/owner needs to preview the Viewer-gated UI (read-only mode) without
-- logging out and back in as a separate viewer account. Klaviyo, Mailchimp, and
-- HubSpot all ship a "preview as <role>" affordance so an admin can verify what
-- a lower-privilege teammate sees before sharing access.
--
-- Before this migration:
--   * users.role (migration 0058 era) is the immutable, durable role for a user
--     within a tenant (owner|admin|editor|viewer). It MUST NOT be mutated to
--     fake a preview — that would change the user's real permissions and leak
--     into audit + every other session.
--   * auth_sessions (migration 0058) carries no per-session role concept, so
--     /api/v1/auth/me always returns the immutable users.role.
--
-- This migration adds a single nullable `role_override` column to auth_sessions.
-- It is:
--   * Per-session (scoped to one browser tab / cookie), so toggling preview on
--     one device never affects another session for the same user.
--   * Request-scoped in effect: the session resolver reads it and surfaces an
--     `effective_role` to the middleware + /me; the durable users.role is never
--     touched.
--   * Down-only by policy at the handler layer: an admin can only DOWNGRADE
--     their effective role (e.g. owner/admin -> viewer) for preview, never
--     escalate. The CHECK constraint pins the vocabulary to the same role set
--     `users.role` uses so a drifting client cannot land an unknown value.
--   * NULL by default = "no override; use the durable role" — every existing
--     session keeps its exact prior behavior with no backfill.
--
-- RLS: auth_sessions already has tenant_isolation + auth_resolver_read +
-- auth_resolver_update policies (migration 0058). Reads/writes of this column
-- ride the same resolver GUC path (app.auth_resolver = 'true') the rest of the
-- session machinery uses, so no new policy is required — adding a column does
-- not change row visibility.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS keeps the migration replay-safe in the
-- dev-shell-bootstrap flow.

BEGIN;

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS role_override text
        CHECK (role_override IS NULL OR role_override IN ('owner','admin','editor','viewer'));

COMMENT ON COLUMN auth_sessions.role_override IS
    'SUB-091 per-session effective-role override for the View-as-Viewer admin '
    'preview affordance. NULL = use the durable users.role. Set/cleared via '
    'PATCH /api/v1/auth/me/viewer-mode; the session resolver surfaces it as '
    'effective_role on /api/v1/auth/me. Never escalates the durable role.';

COMMIT;
