// Package telemetry is Moosewave's opt-in PostHog client for the Go API
// gateway.
//
// Wiring is dormant until POSTHOG_API_KEY is set. When the env var is
// empty, NewClient returns a Noop tracker — every Track() call becomes
// a cheap no-op so the request path is unaffected.
//
// --- PII discipline (HARD RULE) ---
//
// Tracked properties must NEVER include:
//   - subscriber email addresses, names, or any list-member PII
//   - email body content (HTML, MJML, rendered text)
//   - subject lines
//   - raw request bodies, free-form user-typed strings
//   - server stack traces or wrapped error messages
//   - API keys, session tokens, OAuth tokens
//
// Allowed (structural) signals:
//   - event names + status enums ("sent", "failed")
//   - counts, durations, error codes
//   - opaque IDs (tenant_id, campaign_id) — they're useless without DB
//     access and PostHog's ingest is the same trust zone
//
// Use Track for fire-and-forget delivery from request handlers; the
// implementation never blocks the caller's goroutine on a network
// round-trip to PostHog.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/posthog/posthog-go"
)

// Tracker is the surface every consumer codes against. Two
// implementations: posthogTracker (real client) and noopTracker
// (returned when POSTHOG_API_KEY is unset). Tracker is safe to use
// from multiple goroutines.
type Tracker interface {
	// Track enqueues an event for delivery. distinctID is required
	// (use the tenant id, an anonymous device id, or the user id —
	// whichever is appropriate for the event scope). props may be
	// nil. Track is fire-and-forget; the caller never blocks on
	// network IO. ctx is honoured for cancellation BEFORE the event
	// is enqueued, but the underlying SDK has its own background
	// flusher so the actual HTTP send is independent of the request
	// lifetime.
	Track(ctx context.Context, event, distinctID string, props map[string]any)

	// Identify upserts a user/tenant profile. Same semantics as
	// Track for cancellation.
	Identify(ctx context.Context, distinctID string, traits map[string]any)

	// Close flushes any pending batches and shuts the background
	// flusher down. Must be called from the server's graceful-
	// shutdown path so the last few events aren't dropped on
	// SIGTERM.
	Close() error

	// Enabled reports whether the tracker will actually emit events.
	// false for the noop client; true once a real key has been
	// configured.
	Enabled() bool
}

// Config controls NewClient.
type Config struct {
	// APIKey is the PostHog project API key (server-side). Empty =
	// dormant. Read from POSTHOG_API_KEY env var by NewFromEnv.
	APIKey string
	// Endpoint defaults to https://eu.posthog.com when empty — EU Cloud is a
	// published commitment (the /legal/sub-processors register, part of the
	// DPA, states PostHog's region as "EU (eu.posthog.com)"), not a
	// preference. Do not relax this default without amending that page and
	// /legal/cookies.
	Endpoint string
	// Logger is wired into the SDK's debug log path so SDK errors
	// land in the same structured log stream as the rest of the
	// gateway. Optional; falls back to slog.Default.
	Logger *slog.Logger
}

// New constructs a Tracker. Returns a Noop tracker when cfg.APIKey is
// empty so callers can use the result unconditionally.
func New(cfg Config) (Tracker, error) {
	if cfg.APIKey == "" {
		return Noop(), nil
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = "https://eu.posthog.com"
	}
	client, err := posthog.NewWithConfig(cfg.APIKey, posthog.Config{
		Endpoint: endpoint,
		// Structured-log adapter keeps SDK chatter inside the
		// gateway's existing slog stream rather than stdout-spamming
		// every send error.
		Logger: slogAdapter{logger: logger},
		// Default flusher batches on a 5s timer; that's fine.
		Verbose: false,
	})
	if err != nil {
		return nil, err
	}
	return &posthogTracker{
		client: client,
		logger: logger,
	}, nil
}

// NewFromEnv reads POSTHOG_API_KEY (and optional POSTHOG_API_HOST)
// from the process environment. Always returns a non-nil Tracker; on
// missing env it's a Noop.
func NewFromEnv(logger *slog.Logger) (Tracker, error) {
	return New(Config{
		APIKey:   os.Getenv("POSTHOG_API_KEY"),
		Endpoint: os.Getenv("POSTHOG_API_HOST"),
		Logger:   logger,
	})
}

// ---- real client ----------------------------------------------------

type posthogTracker struct {
	client posthog.Client
	logger *slog.Logger
	closed bool
	mu     sync.Mutex
}

func (t *posthogTracker) Track(
	ctx context.Context,
	event, distinctID string,
	props map[string]any,
) {
	if event == "" || distinctID == "" {
		return
	}
	if err := ctx.Err(); err != nil {
		// Caller already cancelled; don't spend a goroutine on a
		// dead request.
		return
	}
	// posthog-go's Enqueue is non-blocking — events go onto an
	// internal channel and the SDK's background flusher handles the
	// HTTP. We still wrap in a goroutine so that even Enqueue's
	// internal locking can't stretch the caller's request budget.
	props = sanitizeProps(props)
	go t.enqueue(event, distinctID, props)
}

func (t *posthogTracker) enqueue(event, distinctID string, props map[string]any) {
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return
	}
	if err := t.client.Enqueue(posthog.Capture{
		Event:      event,
		DistinctId: distinctID,
		Properties: posthog.Properties(props),
		Timestamp:  time.Now().UTC(),
	}); err != nil {
		// Enqueue can fail when the underlying buffer is full or the
		// client has been closed. Log at debug — telemetry must NEVER
		// surface as a user-visible warning.
		t.logger.Debug("posthog enqueue failed",
			"event", event,
			"err", err.Error(),
		)
	}
}

func (t *posthogTracker) Identify(
	ctx context.Context,
	distinctID string,
	traits map[string]any,
) {
	if distinctID == "" {
		return
	}
	if err := ctx.Err(); err != nil {
		return
	}
	traits = sanitizeProps(traits)
	go func() {
		t.mu.Lock()
		closed := t.closed
		t.mu.Unlock()
		if closed {
			return
		}
		if err := t.client.Enqueue(posthog.Identify{
			DistinctId: distinctID,
			Properties: posthog.Properties(traits),
			Timestamp:  time.Now().UTC(),
		}); err != nil {
			t.logger.Debug("posthog identify failed",
				"err", err.Error(),
			)
		}
	}()
}

func (t *posthogTracker) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()
	if err := t.client.Close(); err != nil {
		// posthog-go returns nil from Close even on flush errors,
		// but be defensive.
		return err
	}
	return nil
}

func (t *posthogTracker) Enabled() bool { return true }

// ---- noop -----------------------------------------------------------

// Noop returns a Tracker whose methods are no-ops. Use this in tests
// and as the fallback when no API key is configured.
func Noop() Tracker { return noopTracker{} }

type noopTracker struct{}

func (noopTracker) Track(context.Context, string, string, map[string]any) {}
func (noopTracker) Identify(context.Context, string, map[string]any)      {}
func (noopTracker) Close() error                                          { return nil }
func (noopTracker) Enabled() bool                                         { return false }

// ---- helpers --------------------------------------------------------

// sanitizeProps strips obviously-sensitive keys before send. This is
// a defence-in-depth net for callers who forget to apply the
// "structural signals only" rule. The list is conservative — when in
// doubt, drop. Hard-rule violations should still be caught in code
// review; this is the last line.
var bannedPropKeys = map[string]struct{}{
	"email":         {},
	"password":      {},
	"api_key":       {},
	"apikey":        {},
	"token":         {},
	"session_token": {},
	"refresh_token": {},
	"access_token":  {},
	"name":          {},
	"first_name":    {},
	"last_name":     {},
	"phone":         {},
	"phone_number":  {},
	"address":       {},
	"ip":            {},
	"ip_address":    {},
	"subscriber":    {},
	"recipient":     {},
	"subject":       {},
	"body":          {},
	"body_html":     {},
	"body_mjml":     {},
	"message":       {},
}

func sanitizeProps(in map[string]any) map[string]any {
	if len(in) == 0 {
		return in
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		if _, banned := bannedPropKeys[k]; banned {
			continue
		}
		out[k] = v
	}
	return out
}

// ---- slog adapter ---------------------------------------------------

type slogAdapter struct {
	logger *slog.Logger
}

func (s slogAdapter) Debugf(format string, args ...any) {
	s.logger.Debug("posthog: "+format, "args", args)
}

func (s slogAdapter) Logf(format string, args ...any) {
	// posthog-go uses Logf for non-error informational messages.
	// Push them at DEBUG level so they don't pollute info logs.
	s.logger.Debug("posthog: "+format, "args", args)
}

func (s slogAdapter) Warnf(format string, args ...any) {
	s.logger.Warn("posthog: "+format, "args", args)
}

func (s slogAdapter) Errorf(format string, args ...any) {
	s.logger.Warn("posthog: "+format, "args", args)
}

// Compile-time guarantee that the public Tracker interface stays
// implementable. New return types lean on this.
var (
	_ Tracker = (*posthogTracker)(nil)
	_ Tracker = noopTracker{}
)

// ErrNotConfigured is returned by helpers that REQUIRE telemetry to
// be configured (none today, but reserved for tests asserting
// presence). Production code should use Tracker.Enabled() instead of
// type-asserting.
var ErrNotConfigured = errors.New("telemetry: POSTHOG_API_KEY not set")
