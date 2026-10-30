-- 0149_send_window_policy.sql
--
-- Per-tenant send-window policy.
--
-- "Don't send marketing emails outside business hours" is a hard
-- requirement for a lot of B2B operators (their lists are at-work
-- inboxes; sending at 2am tanks open rate and looks unprofessional).
-- The existing sending/quiet_hours.go handles per-tenant
-- quiet-hours skipping for THE DISPATCHER, but operator-side
-- scheduling can still set a campaign.scheduled_at outside the
-- window. This policy table is the GATE — checked at scheduling
-- time, returns a clear error before the dispatcher ever sees it.
--
-- One row per tenant. Hours are stored in the tenant's local IANA
-- timezone. Weekday CHECK packed to (0=Sun..6=Sat) bitmap so the
-- operator can encode "weekdays only" cheaply.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_send_window_policies (
    tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Local hours, e.g. "08:00" to "20:00".
    start_local      time NOT NULL,
    end_local        time NOT NULL,
    -- Timezone the local times are interpreted in (IANA name).
    timezone         text NOT NULL DEFAULT 'UTC',
    -- Weekday bitmap. Bit 0 = Sunday, bit 6 = Saturday.
    -- Default 0x7E = weekdays only (Mon-Fri).
    weekday_bitmap   int NOT NULL DEFAULT 126
        CHECK (weekday_bitmap >= 0 AND weekday_bitmap <= 127),
    -- 'block'  → reject scheduling outside the window
    -- 'warn'   → return a warning but allow override
    -- 'off'    → policy exists but isn't enforced
    enforcement      text NOT NULL DEFAULT 'warn'
        CHECK (enforcement IN ('block','warn','off')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_send_window_policies TO postwave_app;

ALTER TABLE tenant_send_window_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_send_window_policies AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

COMMIT;
