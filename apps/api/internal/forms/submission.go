package forms

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

// Submission mirrors form_submissions on the wire.
type Submission struct {
	ID           string            `json:"id"`
	FormID       string            `json:"formId"`
	Email        string            `json:"email"`
	CustomFields map[string]string `json:"customFields"`
	Consent      string            `json:"-"`
	// ConsentEvidence describes the affirmative act in words, as the canonical
	// consent record does: the form the visitor submitted and the consent
	// checkbox they ticked. Stored as the submission consent event's proof so
	// the evidence reads as what happened rather than as an internal id.
	ConsentEvidence string `json:"-"`
	// Metadata is the X3 ambient-context bag (UTM tags, ref code, etc.)
	// captured by the public submit endpoint. Persisted to
	// form_submissions.metadata jsonb (added in migration 0069).
	Metadata          map[string]string `json:"metadata,omitempty"`
	ConfirmationToken string            `json:"-"` // never serialized to admin clients
	// Name is what the visitor typed into the form's name field (migration
	// 2049). The audience write reads it back to name a new subscriber.
	Name string `json:"-"`
	// SignupSource is hosted_page or embedded_form (migration 2049).
	SignupSource string `json:"-"`
	// TargetListIDs are the Moosewave lists this submission joins. Set by
	// InsertSubmissionWithSignup from the resolved form targets.
	TargetListIDs []string         `json:"-"`
	Status        SubmissionStatus `json:"status"`
	IP            *string          `json:"ip,omitempty"`
	UserAgent     *string          `json:"userAgent,omitempty"`
	SubmittedAt   time.Time        `json:"submittedAt"`
	ConfirmedAt   *time.Time       `json:"confirmedAt,omitempty"`
	// ConfirmationEmail is the last outcome of the double opt-in email
	// (migration 2050); empty when the submission has none.
	ConfirmationEmail ConfirmationEmailState `json:"confirmationEmail,omitempty"`
}

// NewConfirmationToken generates a 32-byte (64 hex chars) high-entropy token
// for double opt-in confirmation links.
func NewConfirmationToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// SubmitInput is the body of POST /api/public/forms/{slug}/submit. We accept
// a generic map because the form's structure is user-defined; handlers pull
// "email" + "consent" + "website" (honeypot) explicitly and stash everything
// else under custom_fields.
type SubmitInput struct {
	Email   string `json:"email"`
	Name    string `json:"name,omitempty"`
	Consent string `json:"consent,omitempty"`
	// Website is the honeypot field — bots fill it because they fill every
	// input; humans don't see it (CSS-hidden client-side). If non-empty
	// we silently 200 OK so bots think they succeeded.
	Website string `json:"website,omitempty"`
	// CustomFields collects every cf_<key> input.
	CustomFields map[string]string `json:"customFields,omitempty"`
	// CaptchaToken is the optional reCAPTCHA v3 token. Verified server-side
	// when RECAPTCHA_SECRET is set; otherwise the field is ignored.
	CaptchaToken string `json:"captchaToken,omitempty"`
	// SubmissionAttemptID is minted by the hosted browser, not the server. It
	// is never stored raw; the verification gate persists only a tenant/form-
	// scoped digest so an uncertain retry cannot spend another provider credit.
	SubmissionAttemptID string `json:"submission_attempt_id,omitempty"`
}

// verificationFingerprint hashes the stable signup intent. Captcha tokens are
// deliberately excluded because a transport retry may require a fresh captcha;
// the opaque submission attempt id is excluded because it is the lookup key.
func (in *SubmitInput) verificationFingerprint() []byte {
	if in == nil {
		return nil
	}
	payload := struct {
		Version      string            `json:"version"`
		Email        string            `json:"email"`
		Name         string            `json:"name"`
		Consent      string            `json:"consent"`
		CustomFields map[string]string `json:"custom_fields"`
	}{
		Version:      "postwave-form-signup-v1",
		Email:        in.Email,
		Name:         in.Name,
		Consent:      in.Consent,
		CustomFields: in.CustomFields,
	}
	raw, _ := json.Marshal(payload) // strings + map[string]string cannot fail
	digest := sha256.Sum256(raw)
	return digest[:]
}

// SubmitResponse is the JSON body returned to the public form on success.
type SubmitResponse struct {
	OK       bool   `json:"ok"`
	State    string `json:"state"`              // "subscribed" | "pending-confirmation" | "received"
	Redirect string `json:"redirect,omitempty"` // optional success redirect
	Message  string `json:"message,omitempty"`
}
