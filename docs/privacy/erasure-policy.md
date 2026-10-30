# Moosewave erasure policy contract

Status: code controls implemented; legal dispositions incomplete; production
subject erasure remains fail-closed.

## What the code now guarantees

- The schema ratchet inventories logical stores, not monthly partition
  children. It discovers catalog metadata even when the application role has
  no row access, so operator-only tables cannot disappear from the inventory.
- Every known store has exactly one source disposition: implemented mutation,
  derived view, approval required, or approved bounded retention. There is no
  default disposition for a newly added store.
- A retained-identity policy is invalid unless it has a bounded retention rule,
  legal basis, and private approval-record reference.
- The production entry point evaluates the policy before its hard lock and
  before its first database write. An invalid or approval-incomplete policy
  returns `ErrErasureCoverageIncomplete`.
- Database-backed tests confirm that every implemented target exists and that a
  seeded subject address is absent from every text/JSON column in every covered
  target after the transaction.
- Legal holds and subprocessor acknowledgements continue to block fulfillment;
  erasure and the counts-only fulfillment receipt remain one transaction.

## Current measured boundary

The current schema has 138 logical address-bearing stores. The implemented
engine reaches 23 of those plus five subscriber-ID satellites. The unified
suppression view is derived from covered base stores. The remaining 114
address-bearing stores require an approved disposition. The Helpdesk relational
graph adds 14 unique stores without an address-shaped column, producing 128
approval-required stores in the complete source policy.

These numbers are generated/checked by tests. They are not a claim that every
address column belongs to the requesting subscriber: the deliberately broad
scanner also finds account users, platform operators, senders, reviewers, and
workspace configuration. That subject relationship is one of the required
policy facts.

## Required decision for each approval-required store

Counsel and the product owner must provide all of the following before a store
can leave `approval_required`:

1. Applicable subject type: subscriber/consumer, authenticated account user,
   workspace/operator, or no relationship to that request type.
2. Data purpose and controller/processor role.
3. Disposition: delete, anonymize, cryptoshred, suppression-only hash tombstone,
   or bounded retention with direct identity removed where possible.
4. Exact retention trigger and period. “Indefinite”, “as required”, and an
   omitted trigger are not executable rules.
5. Legal basis and the private counsel/owner approval-record identifier.
6. Legal-hold behavior, including who may set/release a hold and the evidence
   retained after release.
7. Foreign-key/aggregate behavior: which workspace records survive and which
   identifiers must be replaced or severed.
8. Subprocessor, object-store, cache, search-index, analytics, and backup
   propagation plus the maximum purge interval.

Secrets, subject addresses, and privileged legal advice must not be committed
to this repository. Source should contain only the executable rule and opaque
approval-record reference.

## Opening the hard lock

`erasureHistoryCoverageComplete` may become true only in the release that:

- moves every approval-required entry to an implemented mutation or an
  approved bounded-retention record;
- grants the minimum database capability required for each mutation;
- adds representative fixtures for each mutation class and relational graph;
- passes the catalog inventory, cross-tenant/RLS, legal-hold, retry,
  re-import, concurrency, and all-covered-store absence tests against a fresh
  migration chain; and
- records downstream and backup deletion rehearsal evidence.

Until all five conditions hold, reporting a request as globally erased would
be stronger than the evidence and the runtime will continue to refuse it.
