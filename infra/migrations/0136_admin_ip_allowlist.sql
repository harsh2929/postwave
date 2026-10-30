-- 0136_admin_ip_allowlist.sql
--
-- Per-tenant IP allowlist for admin-scoped API requests. Required
-- for SOC 2 / ISO 27001 customers who want to restrict admin
-- actions (delete tenant, mint API key, rotate webhook secret) to
-- a specific corporate VPN exit / office IP.
--
-- Storage: text[] on tenants. Each entry is either:
--   * A single IPv4 / IPv6 address (e.g. "203.0.113.7", "2001:db8::1")
--   * A CIDR block (e.g. "203.0.113.0/24", "2001:db8::/32")
--
-- Empty array = no restriction. Operators opting in MUST add their
-- own admin IP first OR they lock themselves out.
--
-- The middleware (apps/api/internal/middleware/admin_ip.go) parses
-- entries on demand and short-circuits ANY admin-scoped request
-- whose RemoteAddr / X-Forwarded-For doesn't match.

BEGIN;

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS admin_ip_allowlist text[] NOT NULL DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN tenants.admin_ip_allowlist IS
    'IPv4/IPv6/CIDR entries that admin-scoped API requests must match. Empty = no restriction.';

COMMIT;
