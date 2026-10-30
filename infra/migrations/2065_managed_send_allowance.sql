-- 2065_managed_send_allowance.sql
-- Concurrency-safe, tenant/month hard caps for Moosewave-funded email.
-- Studio/BYO traffic never enters these tables. There is deliberately no
-- overage state: a bucket that cannot reserve the full request rejects it.
--
-- migration-execution: transactional. This creates new, initially empty
-- tables and takes only the brief catalog/FK locks needed to attach them to
-- tenants; lock_timeout prevents deployment from waiting behind tenant DDL.
-- rollback-strategy: no-op
-- rollback-details: Earlier binaries never read or write these additive
-- tables. Leave the append-only evidence in place if an application rollback
-- is required; dropping it would erase billing/allowance audit history.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE managed_send_allowance_buckets (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start    date NOT NULL,
    allowance_units integer NOT NULL CHECK (allowance_units > 0),
    reserved_units  integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
    committed_units integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_start),
    CHECK (reserved_units + committed_units <= allowance_units)
);

CREATE TABLE managed_send_allowance_reservations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start    date NOT NULL,
    reservation_key text NOT NULL CHECK (length(reservation_key) BETWEEN 1 AND 255),
    source          text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
    source_ref      text CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 255),
    units           integer NOT NULL CHECK (units > 0),
    state           text NOT NULL CHECK (state IN ('reserved','committed','released')),
    committed_at    timestamptz,
    released_at     timestamptz,
    release_reason  text CHECK (release_reason IS NULL OR length(release_reason) <= 255),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period_start, reservation_key),
    UNIQUE (id, tenant_id),
    FOREIGN KEY (tenant_id, period_start)
      REFERENCES managed_send_allowance_buckets(tenant_id, period_start) ON DELETE CASCADE,
    CHECK (
      (state = 'reserved' AND committed_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
      OR (state = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
      OR (state = 'released' AND released_at IS NOT NULL)
    )
);

CREATE TABLE managed_send_allowance_recipients (
    reservation_id       uuid NOT NULL,
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ordinal              integer NOT NULL CHECK (ordinal >= 0),
    recipient_fingerprint text NOT NULL CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reservation_id, ordinal),
    FOREIGN KEY (reservation_id, tenant_id)
      REFERENCES managed_send_allowance_reservations(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE managed_send_allowance_events (
    id             bigserial PRIMARY KEY,
    reservation_id uuid NOT NULL,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type     text NOT NULL CHECK (event_type IN ('reserved','committed','released')),
    units          integer NOT NULL CHECK (units > 0),
    reason         text CHECK (reason IS NULL OR length(reason) <= 255),
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (reservation_id, tenant_id)
      REFERENCES managed_send_allowance_reservations(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX managed_send_allowance_reservations_period_idx
    ON managed_send_allowance_reservations (tenant_id, period_start, state);
CREATE INDEX managed_send_allowance_events_reservation_idx
    ON managed_send_allowance_events (tenant_id, reservation_id, id);

GRANT SELECT, INSERT, UPDATE ON managed_send_allowance_buckets TO postwave_app;
GRANT SELECT, INSERT, UPDATE ON managed_send_allowance_reservations TO postwave_app;
GRANT SELECT, INSERT ON managed_send_allowance_recipients TO postwave_app;
GRANT SELECT, INSERT ON managed_send_allowance_events TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE managed_send_allowance_events_id_seq TO postwave_app;

ALTER TABLE managed_send_allowance_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_buckets FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_send_allowance_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON managed_send_allowance_buckets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON managed_send_allowance_reservations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON managed_send_allowance_recipients
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON managed_send_allowance_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION managed_send_allowance_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER managed_send_allowance_recipients_immutable
  BEFORE UPDATE ON managed_send_allowance_recipients
  FOR EACH ROW EXECUTE FUNCTION managed_send_allowance_immutable();
CREATE TRIGGER managed_send_allowance_events_immutable
  BEFORE UPDATE ON managed_send_allowance_events
  FOR EACH ROW EXECUTE FUNCTION managed_send_allowance_immutable();

COMMIT;
