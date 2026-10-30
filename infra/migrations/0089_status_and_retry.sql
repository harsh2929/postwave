-- 0089_status_and_retry.sql
--
-- Trust + ops layer schema:
--
--   1. service_health_pings   — periodic health probes, raw rows; aggregator
--                               writes one row per service per minute. NOT
--                               tenant-scoped: this is global ops data and
--                               the status page is public-readable.
--   2. incidents              — operator-curated incident timeline. Same
--                               public-readable contract; no RLS.
--   3. stripe_webhook_attempts — durable retry queue for Stripe webhook
--                               events the inline handler couldn't process.
--                               Worker picks pending rows up by
--                               next_attempt_at, runs the handler,
--                               increments attempt_number on failure, and
--                               dead-letters after 8 attempts. Also not
--                               tenant-scoped — Stripe webhooks arrive
--                               before any tenant context binds; the
--                               payload itself carries the tenant id when
--                               relevant.
--
-- Public-readable: the status page hits these tables via the API which runs
-- as the postwave_app role; we deliberately skip RLS so a single SELECT
-- without a bound tenant_id GUC succeeds.

-- ---------------------------------------------------------------------------
-- Health pings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_health_pings (
  id bigserial PRIMARY KEY,
  service text NOT NULL,                       -- api / voice / deliverability / migration / automation
  pinged_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,                        -- ok | degraded | down
  latency_ms int,
  http_status int,
  error text
);
CREATE INDEX IF NOT EXISTS idx_health_pings_service_time
  ON service_health_pings(service, pinged_at DESC);

-- ---------------------------------------------------------------------------
-- Incidents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  severity text NOT NULL,                       -- minor | major | critical
  status text NOT NULL,                         -- investigating | identified | monitoring | resolved
  affected_services text[] NOT NULL,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incidents_active
  ON incidents(resolved_at)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_recent
  ON incidents(started_at DESC);

-- ---------------------------------------------------------------------------
-- Stripe webhook retry queue
-- ---------------------------------------------------------------------------
--
-- attempt_number=0 is the inline handler's failure slot. Each retry the
-- worker performs increments attempt_number; the (event_id, attempt_number)
-- unique pair guards against double-enqueue races. Status transitions:
--
--   pending    → succeeded       (worker handled it; succeeded_at set)
--   pending    → dead_lettered   (after MaxAttempts; dead_lettered_at set)
--
-- The partial index on (next_attempt_at) WHERE status='pending' is what the
-- worker's DequeueDue uses to keep the scan cheap.

CREATE TABLE IF NOT EXISTS stripe_webhook_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  payload_json jsonb NOT NULL,
  attempt_number int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',       -- pending | succeeded | dead_lettered
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  dead_lettered_at timestamptz,
  UNIQUE (event_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_stripe_attempts_due
  ON stripe_webhook_attempts(next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_stripe_attempts_status
  ON stripe_webhook_attempts(status, updated_at DESC);
