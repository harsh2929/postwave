# Contributing to `@postwave/migrate`

Thank you for considering a contribution. This package is the read-side of Moosewave's migration pipeline, MIT-licensed, and explicitly designed to accept community-built adapters.

We commit to **merging well-formed adapter PRs within 2 weeks of submission** (no SLA, but it's the goal we hold ourselves to). This document explains what "well-formed" means.

## Code style

- `gofmt -s` clean. CI fails on any diff.
- `golangci-lint run ./...` clean using the repo's `.golangci.yml`. Enabled linters: `gofmt`, `govet`, `staticcheck`, `errcheck`, `ineffassign`, `misspell`, `gosec`.
- One package per adapter. Sibling files within an adapter package are fine (e.g. `adapter.go`, `mappers.go`, `oauth.go`).
- Doc comments on every exported symbol. The `gopls` "missing comment" warning is a CI hard fail.
- All errors wrap a sentinel from `github.com/postwave/migrate/adapter` (`ErrAuth`, `ErrSourceUnavailable`, `ErrUnsupported`, or `*ErrRateLimited`) so callers can `errors.Is`.

## License header

Every Go source file (including tests) must begin with the SPDX identifier as line 1, before the package clause:

```go
// SPDX-License-Identifier: MIT

package mything
```

The `license-check` job in CI greps every `.go` file for this header on line 1 and fails the build if any file lacks it.

## Tests required for new adapters

A new adapter is not merge-eligible without:

1. **Mapper tests.** For every wire-type → canonical mapping function (e.g. `mapMember`, `translateSegment`, `translateAutomation`), a `_test.go` covers:
   - happy-path values
   - the platform's null / missing-field shape
   - at least one "this status doesn't map cleanly, fall through to source_definition" case

2. **HTTP adapter tests.** Use `net/http/httptest` to spin a fake upstream and assert:
   - 401 → `errors.Is(err, adapter.ErrAuth)`
   - 429 → `errors.As(err, &adapter.ErrRateLimited{})`
   - 5xx → `errors.Is(err, adapter.ErrSourceUnavailable)`
   - cursor advances correctly across pages

3. **Capability test.** A trivial test asserts `Capabilities()` returns the same matrix advertised in `README.md`. Stops drift between docs and code.

4. **Race-clean.** `go test -race ./...` must pass. The `TokenBucket` is concurrent; many adapters dispatch goroutines internally — race detection catches the easy bugs.

## No secrets in code or test fixtures

CI runs a secret scan on every PR. Do not commit:

- API keys (real or test-account)
- OAuth client secrets
- Personal data (real subscriber emails, names, etc.)
- Stripe live keys or test keys with non-trivial entropy

For test fixtures, hand-author JSON that mimics the source platform's response shape. Do not paste exports from real accounts — even your own dev account.

## The canonical interface every adapter must implement

```go
type Adapter interface {
    Capabilities() canonical.AdapterCapabilities
    Authenticate(ctx context.Context, creds Credentials) (Session, error)
    Discover(ctx context.Context, sess Session) (DiscoveryReport, error)
    ListSubscribers(ctx context.Context, sess Session, cursor string) ([]canonical.Subscriber, string, error)
    ListSegments(ctx context.Context, sess Session) ([]canonical.Segment, error)
    ListAutomations(ctx context.Context, sess Session) ([]canonical.Automation, error)
    ListCampaignArchive(ctx context.Context, sess Session, cursor string) ([]canonical.CampaignArchive, string, error)
    ListPaidSubs(ctx context.Context, sess Session, stripeAccountID string) ([]canonical.PaidSub, error)
}
```

Defined in [`adapter/adapter.go`](adapter/adapter.go).

**Resumability contract:** `ListSubscribers` and `ListCampaignArchive` accept a cursor string and return the next cursor. An empty `next` signals end-of-stream. Cursors must be JSON-safe (round-trippable through `json.Marshal`) so callers can persist them mid-job.

**Capabilities contract:** if `Capabilities().Supports.Segments == false`, the corresponding `ListSegments` MUST return `(nil, adapter.ErrUnsupported)`. Don't return an empty slice silently — callers rely on the explicit error to distinguish "no segments exist" from "this platform has no segment concept".

**Self-registration:** every adapter package declares an `init()` that calls `adapter.Register(canonical.SourceX, func() adapter.Adapter { return New() })`. The blank-import pattern (`_ "github.com/postwave/migrate/yourplatform"`) is how callers discover adapters.

## Proposing a new source platform

If you'd like to add Ghost, Buttondown, EmailOctopus, or any other platform:

1. Open a `New adapter` issue (template: `.github/ISSUE_TEMPLATE/new-adapter.md`) describing the platform, its auth model, and which canonical capabilities it can satisfy.
2. Wait for a maintainer to thumbs-up the proposal (usually <72 hours). This filters out the cases where someone has already started, or where the platform's API genuinely can't satisfy our minimum interface.
3. Submit the PR with the full test suite as described above.

## Pull request template

PRs use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), which is a checklist of:

- [ ] Tests added (mapper + HTTP + capability)
- [ ] License header (`// SPDX-License-Identifier: MIT`) on every new `.go` file
- [ ] `CHANGELOG.md` updated under the Unreleased section
- [ ] No secrets in code or fixtures
- [ ] Documentation in `README.md` updated (capability matrix + per-source guide)
- [ ] `gofmt`, `golangci-lint`, `go test -race` all clean

PRs that miss the checklist will get a polite "please tick these and ping me" comment, not a close.

## Maintainer commitment

We will:

- Triage new issues within 5 business days.
- Review well-formed adapter PRs within 2 weeks.
- Cut a release within a month of any merged adapter (so contributors see their work shipped, not stuck on `main`).
- Not require a CLA. The MIT license + `git commit --signoff` (DCO) is enough.

## Questions

Open a GitHub Discussion or ping `security@moosewave.com` for security-sensitive matters.
