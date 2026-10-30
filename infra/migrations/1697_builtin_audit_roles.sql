-- 1697_builtin_audit_roles.sql
-- Backfill the dashboard's durable roles into the editable audit-scope model.

BEGIN;

INSERT INTO roles (tenant_id, name, description)
SELECT t.id, role_name, 'Built-in Postwave role'
  FROM tenants t
 CROSS JOIN unnest(ARRAY['owner','admin','editor','viewer']) AS role_name
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO roles_permissions (role_id, scope)
SELECT r.id, scope
  FROM roles r
 CROSS JOIN unnest(ARRAY[
    'audit:read', 'audit:read_pii', 'audit:read_all_tenants',
    'audit:configure_sinks', 'audit:configure_retention',
    'audit:execute_actions'
 ]) AS scope
 WHERE lower(r.name) IN ('owner', 'admin')
ON CONFLICT (role_id, scope) DO NOTHING;

INSERT INTO roles_permissions (role_id, scope)
SELECT r.id, 'audit:read'
  FROM roles r
 WHERE lower(r.name) IN ('editor', 'viewer')
ON CONFLICT (role_id, scope) DO NOTHING;

COMMIT;
