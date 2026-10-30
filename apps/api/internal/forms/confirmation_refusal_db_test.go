// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// sesStandIn answers SendEmail the way SES v2 does, with the error SES sends
// for the configured refusal.
type sesStandIn struct {
	mu        sync.Mutex
	status    int
	errorType string
	message   string
	calls     int
}

func (s *sesStandIn) respond(status int, errorType, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status, s.errorType, s.message = status, errorType, message
}

func (s *sesStandIn) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Amzn-Errortype", s.errorType)
	w.Header().Set("X-Amzn-Requestid", "4ca9fa56-2260-4a14-a7b4-a79e27b0a793")
	w.WriteHeader(s.status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": s.message})
}

// newStandInSESMailer builds the production SES mailer the way main does,
// pointed at the stand-in.
func newStandInSESMailer(t *testing.T, ses *sesStandIn) mailer.Mailer {
	t.Helper()
	srv := httptest.NewServer(ses)
	t.Cleanup(srv.Close)
	t.Setenv("AWS_ENDPOINT_URL", srv.URL)
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIDSTANDIN")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "stand-in-secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_PROFILE", "")
	t.Setenv("AWS_CONFIG_FILE", t.TempDir()+"/config")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", t.TempDir()+"/credentials")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_MAX_ATTEMPTS", "1")
	m, err := mailer.NewSESMailer(context.Background(), "eu-west-1", "")
	if err != nil {
		t.Fatalf("NewSESMailer: %v", err)
	}
	return m
}

// What staging's SES answered every confirmation email: an IAM policy that
// only lets the environment send to approved recipients.
const stagingSESDenial = "User 'arn:aws:sts::111122223333:assumed-role/moosewave-staging-ApiTaskRole/test-session' is not authorized to perform 'ses:SendEmail' on resource 'arn:aws:ses:eu-west-1:111122223333:identity/staging.moosewave.com'"

// A refusal the email provider gives for good is answered as one: the
// operator's resend gets a 4xx saying resending won't help and what would,
// not a 502 telling them to try again in a few minutes. A failure a later
// attempt may get past stays a 502 with retry guidance. The automatic sends
// log each failed attempt at WARN and the last one at ERROR, so a visitor who
// never gets their email is visible in the logs.
func TestAPermanentConfirmationRefusalIsNotReportedAsTransient(t *testing.T) {
	h := newSignupHarness(t, harnessForm{optIn: OptInDouble})
	ses := &sesStandIn{}
	ses.respond(http.StatusForbidden, "AccessDeniedException", stagingSESDenial)
	h.deps.ConfirmationMailer = newStandInSESMailer(t, ses)

	if rec := h.post(body(consentedBody, "visitor@example.com")); rec.Code != http.StatusOK {
		t.Fatalf("submit = %d %s", rec.Code, rec.Body.String())
	}
	if err := h.tryDrain(); err == nil {
		t.Fatal("a refused confirmation email was acknowledged; the outbox would never retry it")
	}
	if ses.calls != 1 {
		t.Fatalf("SES calls = %d, want the one automatic send", ses.calls)
	}
	logs := h.logs.String()
	if !strings.Contains(logs, `level=WARN msg="forms: a confirmation email could not be sent; it will be retried"`) ||
		!strings.Contains(logs, "refusal=not_permitted") || !strings.Contains(logs, "attempt=1 max_attempts=10") {
		t.Fatalf("a failed automatic send was not logged as a warning naming the refusal:\n%s", logs)
	}

	stored := h.submission("visitor@example.com")
	// The outbox's last attempt.
	payload, _ := json.Marshal(confirmationSendPayload{TenantID: h.tenantID, FormID: h.formID, SubmissionID: stored.ID})
	if err := h.deps.DeliverConfirmation(context.Background(), h.tenantID, payload, DeliveryAttempt{Number: 10, Max: 10}); err == nil {
		t.Fatal("the last attempt's failure was acknowledged")
	}
	if logs := h.logs.String(); !strings.Contains(logs,
		`level=ERROR msg="forms: a confirmation email could not be sent and will not be retried; the submission stays pending until it is resent"`) {
		t.Fatalf("the last failed attempt was not logged as an error:\n%s", logs)
	}

	resend := "/api/v1/forms/" + h.formID + "/submissions/" + stored.ID + "/resend-confirmation"
	refused := h.serve(http.MethodPost, resend, "")
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(refused.Body.Bytes(), &envelope)
	if refused.Code != http.StatusUnprocessableEntity || envelope.Error.Code != "confirmation_recipient_not_allowed" ||
		envelope.Error.Message != "The email provider refused this confirmation email: this environment isn't allowed to send to this address (it may only send to approved addresses). Resending won't help until the address is approved or sending is enabled for this environment." {
		t.Fatalf("resend refused for good = %d %s, want 422 confirmation_recipient_not_allowed", refused.Code, refused.Body.String())
	}
	if strings.Contains(refused.Body.String(), "Try again") || strings.Contains(refused.Body.String(), "arn:aws") {
		t.Fatalf("the refusal tells the operator to retry, or leaks the provider's error: %s", refused.Body.String())
	}
	if state := h.submission("visitor@example.com").EmailState; state != string(ConfirmationEmailSendFailed) {
		t.Fatalf("state after a refused resend = %q, want send_failed", state)
	}
	if logs := h.logs.String(); !strings.Contains(logs, `level=WARN msg="forms: re-sending a confirmation email failed"`) ||
		!strings.Contains(logs, "code=confirmation_recipient_not_allowed") {
		t.Fatalf("the refused resend was not logged as a warning:\n%s", logs)
	}

	ses.respond(http.StatusInternalServerError, "InternalServiceErrorException", "Internal failure")
	transient := h.serve(http.MethodPost, resend, "")
	if transient.Code != http.StatusBadGateway || !strings.Contains(transient.Body.String(), `"code":"confirmation_email_failed"`) ||
		!strings.Contains(transient.Body.String(), "Try again in a few minutes.") {
		t.Fatalf("resend after a transient failure = %d %s, want 502 with retry guidance", transient.Code, transient.Body.String())
	}
	if logs := h.logs.String(); !strings.Contains(logs, `level=ERROR msg="forms: re-sending a confirmation email failed"`) {
		t.Fatalf("the transient resend failure was not logged as an error:\n%s", logs)
	}
}
