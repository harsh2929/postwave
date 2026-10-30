// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the send-complete email path. These are pure-Go unit tests
// — they do NOT need a real Postgres, because the path under test is
// the Notifier.Notify fan-out, not the sendloop transition trigger
// (which is exercised by sendloop_test.go's integration suite when
// DATABASE_URL is set).

package sending

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// recordingMailer captures every Send call. Goroutine-safe so a
// hypothetical concurrent test could share one between goroutines.
type recordingMailer struct {
	mu        sync.Mutex
	sent      []MailMessage
	failFor   map[string]error // keyed by recipient
	callCount int32
}

func (m *recordingMailer) Send(_ context.Context, msg MailMessage) error {
	atomic.AddInt32(&m.callCount, 1)
	m.mu.Lock()
	defer m.mu.Unlock()
	if err, ok := m.failFor[msg.To]; ok {
		return err
	}
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) recipients() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.sent))
	for _, msg := range m.sent {
		out = append(out, msg.To)
	}
	return out
}

type panicSendCompleteMailer struct{}

func (panicSendCompleteMailer) Send(context.Context, MailMessage) error {
	panic("mailer exploded")
}

// stubUserRepo is a TenantUserRepo whose return value is a static
// slice (plus an optional error).
type stubUserRepo struct {
	users []TenantUser
	err   error
}

func (s *stubUserRepo) ListUsersForTenant(_ context.Context, _ string, _ []string) ([]TenantUser, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.users, nil
}

type panicUserRepo struct{}

func (panicUserRepo) ListUsersForTenant(context.Context, string, []string) ([]TenantUser, error) {
	panic("repo exploded")
}

// stubGate is a notifications.Dispatcher returning a per-user fixed
// allow/error result. Missing user defaults to allowed=true so tests
// only enumerate negative cases.
type stubGate struct {
	allow map[string]bool
	err   map[string]error
}

func (g *stubGate) Gate(_ context.Context, _, userID string, _ notifications.Pref) (bool, error) {
	if e, ok := g.err[userID]; ok {
		return true, e // production fail-open contract: (true, err)
	}
	if v, ok := g.allow[userID]; ok {
		return v, nil
	}
	return true, nil
}

// fixedEvent is the typical SendCompleteEvent the tests below build
// on. Constants are deliberate (no time.Now()) so the rendered body
// is bit-stable.
func fixedEvent() SendCompleteEvent {
	return SendCompleteEvent{
		TenantID:     "t1",
		CampaignID:   "c1",
		CampaignName: "Welcome Newsletter",
		Subject:      "Hi friend",
		Recipients:   1234,
		Sent:         1200,
		Bounced:      24,
		Suppressed:   10,
		SentAt:       time.Date(2026, 5, 9, 16, 32, 0, 0, time.UTC),
	}
}

// TestSendCompleteNotify_PerRecipientGating: 3 users with mixed prefs
// → 2 emails sent, 1 skipped.
func TestSendCompleteNotify_PerRecipientGating(t *testing.T) {
	t.Parallel()
	mailer := &recordingMailer{}
	notifier := &SendCompleteNotifier{
		Mailer: mailer,
		TenantRepo: &stubUserRepo{users: []TenantUser{
			{ID: "u-alice", Email: "alice@tenant.test"},
			{ID: "u-bob", Email: "bob@tenant.test"},
			{ID: "u-carol", Email: "carol@tenant.test"},
		}},
		Dispatcher: &stubGate{allow: map[string]bool{
			"u-alice": true,
			"u-bob":   true,
			"u-carol": false,
		}},
		From:    "noreply@postwave.test",
		BaseURL: "https://app.test",
	}
	if err := notifier.Notify(context.Background(), fixedEvent()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := mailer.recipients()
	want := []string{"alice@tenant.test", "bob@tenant.test"}
	if !sameStrings(got, want) {
		t.Errorf("recipients: got %v want %v", got, want)
	}
	if got := atomic.LoadInt32(&mailer.callCount); got != int32(len(want)) {
		t.Errorf("Mailer.Send calls: got %d want %d", got, len(want))
	}
}

// TestSendCompleteNotify_MailerErrorContinues: user 2 fails →
// users 1 and 3 still receive.
func TestSendCompleteNotify_MailerErrorContinues(t *testing.T) {
	t.Parallel()
	mailer := &recordingMailer{
		failFor: map[string]error{"bob@tenant.test": errors.New("ses: throttled")},
	}
	notifier := &SendCompleteNotifier{
		Mailer: mailer,
		TenantRepo: &stubUserRepo{users: []TenantUser{
			{ID: "u-alice", Email: "alice@tenant.test"},
			{ID: "u-bob", Email: "bob@tenant.test"},
			{ID: "u-carol", Email: "carol@tenant.test"},
		}},
	}
	err := notifier.Notify(context.Background(), fixedEvent())
	if err == nil {
		t.Errorf("expected non-nil aggregate error from mailer failure")
	}
	got := mailer.recipients()
	want := []string{"alice@tenant.test", "carol@tenant.test"}
	if !sameStrings(got, want) {
		t.Errorf("recipients: got %v want %v", got, want)
	}
}

// TestSendCompleteNotify_DispatcherErrorFailsOpen: a gate error
// defaults to send (mirrors PgDispatcher's contract).
func TestSendCompleteNotify_DispatcherErrorFailsOpen(t *testing.T) {
	t.Parallel()
	mailer := &recordingMailer{}
	notifier := &SendCompleteNotifier{
		Mailer: mailer,
		TenantRepo: &stubUserRepo{users: []TenantUser{
			{ID: "u-alice", Email: "alice@tenant.test"},
		}},
		Dispatcher: &stubGate{err: map[string]error{"u-alice": errors.New("pgx: closed")}},
	}
	if err := notifier.Notify(context.Background(), fixedEvent()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := mailer.recipients(); len(got) != 1 {
		t.Errorf("dispatcher error must fail open and still send; got %v", got)
	}
}

// TestSendCompleteNotify_EmptyUsers is a no-panic guard for tenants
// without any admin/editor user yet (fresh signup, etc.).
func TestSendCompleteNotify_EmptyUsers(t *testing.T) {
	t.Parallel()
	mailer := &recordingMailer{}
	notifier := &SendCompleteNotifier{
		Mailer:     mailer,
		TenantRepo: &stubUserRepo{users: nil},
	}
	if err := notifier.Notify(context.Background(), fixedEvent()); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := mailer.recipients(); len(got) != 0 {
		t.Errorf("empty user list: got %v sends, want 0", got)
	}
}

// TestSendCompleteNotify_TenantRepoError surfaces the lookup failure.
func TestSendCompleteNotify_TenantRepoError(t *testing.T) {
	t.Parallel()
	mailer := &recordingMailer{}
	notifier := &SendCompleteNotifier{
		Mailer:     mailer,
		TenantRepo: &stubUserRepo{err: errors.New("pgx: boom")},
	}
	err := notifier.Notify(context.Background(), fixedEvent())
	if err == nil {
		t.Errorf("expected non-nil err on tenant-repo failure")
	}
	if got := atomic.LoadInt32(&mailer.callCount); got != 0 {
		t.Errorf("mailer should not fire on repo failure; got %d calls", got)
	}
}

func TestSendCompleteNotify_RecoversTenantRepoPanic(t *testing.T) {
	t.Parallel()
	notifier := &SendCompleteNotifier{
		Mailer:     &recordingMailer{},
		TenantRepo: panicUserRepo{},
	}
	err := notifier.Notify(context.Background(), fixedEvent())
	if err == nil || !strings.Contains(err.Error(), "send-complete panic: repo exploded") {
		t.Fatalf("err = %v; want recovered repo panic", err)
	}
}

func TestSendCompleteNotify_RecoversMailerPanic(t *testing.T) {
	t.Parallel()
	notifier := &SendCompleteNotifier{
		Mailer: panicSendCompleteMailer{},
		TenantRepo: &stubUserRepo{users: []TenantUser{
			{ID: "u-alice", Email: "alice@tenant.test"},
		}},
	}
	err := notifier.Notify(context.Background(), fixedEvent())
	if err == nil || !strings.Contains(err.Error(), "send-complete panic: mailer exploded") {
		t.Fatalf("err = %v; want recovered mailer panic", err)
	}
}

// TestRenderSendCompleteHTML_ContainsCampaignNameAndCount pins the
// rendered body content.
func TestRenderSendCompleteHTML_ContainsCampaignNameAndCount(t *testing.T) {
	t.Parallel()
	html := renderSendCompleteHTML(fixedEvent(), "https://app.test")
	for _, want := range []string{
		"Welcome Newsletter",
		"1234",
		"View report",
		"https://app.test/campaigns/c1",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("HTML missing %q\n--- HTML ---\n%s", want, html)
		}
	}
}

func TestCampaignReportLinkEscapesIDAndRejectsUnsafeBase(t *testing.T) {
	t.Parallel()
	got := campaignReportLink("https://app.test/postwave/", "campaign/../id")
	if got != "https://app.test/postwave/campaigns/campaign%2F..%2Fid" {
		t.Fatalf("escaped link = %q", got)
	}
	for _, base := range []string{
		"javascript:alert(1)",
		"https://user:pass@app.test",
		"https://app.test?next=https://evil.test",
		"https://app.test#frag",
	} {
		if got := campaignReportLink(base, "c1"); got != "" {
			t.Fatalf("campaignReportLink(%q) = %q, want empty", base, got)
		}
	}
}

// TestRenderSendCompleteText_PlainNoHTMLTags pins the plain body's
// shape: must contain campaign + count, must NOT contain '<' / '>'
// HTML tag markers.
func TestRenderSendCompleteText_PlainNoHTMLTags(t *testing.T) {
	t.Parallel()
	text := renderSendCompleteText(fixedEvent(), "https://app.test")
	if !strings.Contains(text, "Welcome Newsletter") {
		t.Errorf("text body missing campaign name: %q", text)
	}
	if !strings.Contains(text, "1234 recipients") {
		t.Errorf("text body missing recipient count: %q", text)
	}
	if strings.ContainsAny(text, "<>") {
		t.Errorf("text body contains HTML tag markers: %q", text)
	}
}

// TestRenderSendCompleteHTML_EscapesCampaignName: a tenant naming
// their campaign with raw HTML cannot inject markup into the email.
func TestRenderSendCompleteHTML_EscapesCampaignName(t *testing.T) {
	t.Parallel()
	evt := fixedEvent()
	evt.CampaignName = `<script>alert("xss")</script>`
	html := renderSendCompleteHTML(evt, "https://app.test")
	if strings.Contains(html, "<script>") {
		t.Errorf("HTML did NOT escape campaign name; XSS surface: %s", html)
	}
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Errorf("HTML must contain escaped form of injected tag: %s", html)
	}
}

// TestSendCompleteNotify_NilNotifierIsSafe: callers must be able to
// dispatch through a nil pointer without crashing.
func TestSendCompleteNotify_NilNotifierIsSafe(t *testing.T) {
	t.Parallel()
	var n *SendCompleteNotifier
	if err := n.Notify(context.Background(), fixedEvent()); err != nil {
		t.Errorf("nil notifier should be a no-op, got err=%v", err)
	}
}

// --- helpers ---

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	// Compare as multisets — recipient ordering is implementation-
	// detail, not contract.
	m := make(map[string]int, len(a))
	for _, s := range a {
		m[s]++
	}
	for _, s := range b {
		m[s]--
	}
	for _, v := range m {
		if v != 0 {
			return false
		}
	}
	return true
}
