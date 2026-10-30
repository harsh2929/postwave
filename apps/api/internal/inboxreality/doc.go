// Package inboxreality is the customer-facing on-demand Inbox Reality
// API. It sits in front of the existing seedlist pipeline in
// services/deliverability/internal/seedlist/ — that service already
// owns the IMAP polling, per-provider categorizers, and the
// controlled-mailbox seedlist registry. This package adds the "test this
// email right now" surface the dashboard and MCP agent call into.
//
// End-to-end flow:
//
//  1. Customer POSTs /api/v1/inbox-reality/tests with the candidate
//     {subject, html, text, from, kind}. The handler creates a row in
//     inbox_reality_tests, mints a header_token (16-byte hex), and
//     returns {test_id, header_token, seed_addresses[], expires_at}.
//
//  2. The customer (or our dispatcher; see SendToSeedList in
//     orchestrator.go) sends the candidate to every seed mailbox
//     with the header X-Postwave-Test-ID: <header_token> attached.
//
//  3. The deliverability service's seedlist poller (existing) tails
//     each seed inbox on a 60s cadence, finds messages with that
//     header, runs the per-provider Categorizer, and writes one
//     inbox_reality_test_results row per (test_id, mailbox_id).
//
//  4. Customer polls /api/v1/inbox-reality/tests/{id}. The handler
//     joins inbox_reality_test_results, rolls into a provider
//     breakdown, and reports status.
//
// Why this package, not a service-side endpoint:
//
//   - The deliverability service exposes /v1/inbox-reality/campaigns/{id}
//     which is keyed by campaign_id and returns AFTER-the-fact roll-ups
//     of seedlist_outcomes. That endpoint serves the campaign reports
//     page; it does not let a customer trigger a test before sending.
//   - The customer-facing API gateway needs RLS-scoped tenancy,
//     idempotency-key handling, API-key scope checking, and Stripe
//     tier gating. None of that belongs in the deliverability
//     service.
//
// What this package deliberately does NOT do:
//
//   - Real seed-mailbox provisioning (ops; see ops/seedlist-runbook.md).
//   - Per-provider IMAP/EWS authentication (deliverability service).
//   - Render previews (a separate render_cache table + HCTI flow lives
//     in services/deliverability/internal/render; the surface there is
//     /v1/render). This package is about WHERE the message lands, not
//     WHAT it looks like.
package inboxreality
