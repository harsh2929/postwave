# Campaign Assurance public API boundary

This package exposes tenant- and campaign-bound HTTP routes for **Predicted
Agent Comprehension**. It does not expose worker claims or evidence writes.

Public run creation accepts only `profile`, optional `content_revision_id`,
optional `send_plan_id`, and `request_id`. Omitting both immutable IDs invokes
the server-owned freeze → coverage compilation → encrypted materialization
path. Supplying only a revision compiles that exact revision; supplying a plan
also requires its revision. `SuiteRegistry` is constructed at startup with
immutable `fast`, `full`, and `calibration` definitions; model, prompt,
normalization, scoring, compiler policy, gate, retry, configuration, and target
identities never come from request JSON.

Every write requires exactly one `Idempotency-Key` and an authenticated,
tenant-bound actor. The durable `request_id` provides repository-level replay
or conflict semantics for run creation and finding appeals. Cancellation also
converges on an already-cancelled receipt after a transition race. Production
composition mounts these routes inside the shared HTTP idempotency middleware.
`campaignassurancequeue` durably deduplicates the exact tenant/run/request tuple
and leases identity-only commands to `campaignassuranceworker`.

The gateway freezes three startup-owned profiles. `fast` executes the reviewed
deterministic analyzer. `full` additionally records the modeled analyzer as
explicitly unavailable, and `calibration` additionally records modeled and
controlled-observation executors as explicitly unavailable. Those profiles
remain incomplete until separately reviewed executors are configured; no
deterministic result is relabeled as modeled or observed. The whole runtime is
default-off behind `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME` and validates
migration 1925 and tenant object storage before it can start.

The current durable repository has two intentionally visible read limitations:

- There is no append-only run-event table. `/events` returns the authoritative
  current progress snapshot with `event_history_available: false`; it never
  fabricates a timeline.
- Evidence repository methods currently return complete ordered collections.
  The HTTP response is capped to 200 items per evidence class with offset
  metadata, but a future repository migration should add SQL/keyset pagination
  before very large run histories are enabled.

All successful responses identify deterministic, modeled, and controlled
observation source classes and explicitly state that modeled output is a
prediction—not an observation of Gemini or another inbox agent in a stranger's
mailbox.
