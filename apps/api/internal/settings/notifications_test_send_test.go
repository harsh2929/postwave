// SPDX-License-Identifier: AGPL-3.0-only
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// captureMailer records the last Message it was asked to send (SETC-053).
type captureMailer struct {
	sent    []mailer.Message
	failErr error
}

func (c *captureMailer) Send(_ context.Context, m mailer.Message) error {
	if c.failErr != nil {
		return c.failErr
	}
	c.sent = append(c.sent, m)
	return nil
}

func testSendRequest(t *testing.T, withUser bool, body string) *http.Request {
	t.Helper()
	ctx := middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	if withUser {
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID:    "00000000-0000-0000-0000-0000000000aa",
			Email: "owner@example.com",
		})
	}
	var r *http.Request
	if body == "" {
		r = httptest.NewRequestWithContext(ctx, http.MethodPost,
			"/api/v1/settings/notifications/test", nil)
	} else {
		r = httptest.NewRequestWithContext(ctx, http.MethodPost,
			"/api/v1/settings/notifications/test", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func TestSendTest_MailerNil_Returns503(t *testing.T) {
	d := &NotificationsDeps{} // Mailer nil
	rec := httptest.NewRecorder()
	d.SendTest(rec, testSendRequest(t, true, ""))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil mailer: code = %d, want 503", rec.Code)
	}
}

func TestSendTest_NoUser_Returns401(t *testing.T) {
	d := &NotificationsDeps{Mailer: &captureMailer{}}
	rec := httptest.NewRecorder()
	d.SendTest(rec, testSendRequest(t, false, ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no user: code = %d, want 401", rec.Code)
	}
}

func TestSendTest_EmptyBody_SendsCategoryToUser(t *testing.T) {
	cm := &captureMailer{}
	d := &NotificationsDeps{Mailer: cm, FromAddress: "Moosewave <noreply@moosewave.com>"}
	rec := httptest.NewRecorder()
	d.SendTest(rec, testSendRequest(t, true, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("empty body: code = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(cm.sent) != 1 {
		t.Fatalf("expected exactly one send, got %d", len(cm.sent))
	}
	msg := cm.sent[0]
	if msg.To != "owner@example.com" {
		t.Errorf("To = %q, want the signed-in user's email", msg.To)
	}
	if msg.From == "" || msg.Subject == "" || (msg.Body == "" && msg.HTMLBody == "") {
		t.Errorf("message is missing From/Subject/Body: %+v", msg)
	}
	if msg.Tags["purpose"] != "settings_test_notification" {
		t.Errorf("purpose tag = %q, want settings_test_notification", msg.Tags["purpose"])
	}
	var out struct {
		Sent bool   `json:"sent"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !out.Sent || out.To != "owner@example.com" {
		t.Errorf("response = %+v, want {sent:true, to:owner@example.com}", out)
	}
}

func TestSendTest_DigestKind_UsesDigestCopy(t *testing.T) {
	cm := &captureMailer{}
	d := &NotificationsDeps{Mailer: cm}
	rec := httptest.NewRecorder()
	d.SendTest(rec, testSendRequest(t, true, `{"kind":"digest"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("digest: code = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if len(cm.sent) != 1 || !strings.Contains(strings.ToLower(cm.sent[0].Subject), "digest") {
		t.Errorf("digest subject = %q, want it to mention digest", cm.sent[0].Subject)
	}
}

func TestSendTest_MailerError_Returns500(t *testing.T) {
	d := &NotificationsDeps{Mailer: &captureMailer{failErr: errors.New("ses down")}}
	rec := httptest.NewRecorder()
	d.SendTest(rec, testSendRequest(t, true, ""))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("mailer error: code = %d, want 500", rec.Code)
	}
}
