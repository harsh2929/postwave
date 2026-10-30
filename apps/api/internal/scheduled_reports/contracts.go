// SPDX-License-Identifier: AGPL-3.0-only
package scheduled_reports

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
)

const (
	maxReportNameBytes        = 160
	maxScheduleBytes          = 80
	maxScheduledRecipients    = 20
	maxPersistedErrorBytes    = 512
	maxPersistedErrorCode     = 64
	defaultWorkerBatchSize    = 32
	defaultRunLeaseTTL        = 2 * time.Minute
	defaultDeliverySendWindow = 30 * time.Second
)

func nowUTC() time.Time { return time.Now().UTC() }

var (
	ErrReportNotFound         = errors.New("scheduled_reports: report not found")
	ErrIdempotencyKeyRequired = errors.New("scheduled_reports: idempotency key required")
	ErrIdempotencyKeyInvalid  = errors.New("scheduled_reports: idempotency key invalid")
	ErrReportConfigInvalid    = errors.New("scheduled_reports: report configuration invalid")
)

// RejectedError identifies an error for which the provider or local mail
// adapter proved that it did not accept the message. Every other non-nil send
// error is treated as acceptance-ambiguous and becomes terminal `unknown`.
type RejectedError struct {
	Err error
}

func (e *RejectedError) Error() string {
	if e == nil || e.Err == nil {
		return "scheduled report delivery rejected"
	}
	return "scheduled report delivery rejected: " + e.Err.Error()
}

func (e *RejectedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// NewRejectedError lets a provider adapter explicitly attest that no message
// was accepted. Do not use it for timeouts, connection resets, or lost
// responses: those outcomes are ambiguous.
func NewRejectedError(err error) error {
	if err == nil {
		err = errors.New("provider rejected delivery")
	}
	return &RejectedError{Err: err}
}

type deliveryFailure struct {
	State   string
	Code    string
	Summary string
}

func classifyDeliveryFailure(err error) deliveryFailure {
	var rejected *RejectedError
	if errors.As(err, &rejected) {
		return deliveryFailure{
			State:   "failed",
			Code:    "provider_rejected",
			Summary: "The mail provider rejected this recipient before accepting the message.",
		}
	}
	return deliveryFailure{
		State:   "unknown",
		Code:    "provider_outcome_unknown",
		Summary: "Provider acceptance could not be confirmed. This recipient will not be retried automatically.",
	}
}

func requiredIdempotencyKey(header http.Header) (string, error) {
	values := header.Values(idempotency.HeaderName)
	if len(values) == 0 {
		return "", ErrIdempotencyKeyRequired
	}
	if len(values) != 1 {
		return "", ErrIdempotencyKeyInvalid
	}
	return normalizeIdempotencyKey(values[0])
}

func normalizeIdempotencyKey(value string) (string, error) {
	if !utf8.ValidString(value) ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", ErrIdempotencyKeyInvalid
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ErrIdempotencyKeyRequired
	}
	if len(value) > idempotency.MaxKeyLength ||
		!utf8.ValidString(value) {
		return "", ErrIdempotencyKeyInvalid
	}
	return value, nil
}

// manualRunKeyHash stores no caller-selected idempotency material. Binding the
// digest to the tenant and operation prevents cross-tenant correlation.
func manualRunKeyHash(tenantID, key string) []byte {
	sum := sha256.Sum256([]byte(
		"postwave:scheduled-report-send-now:v1\x00" + tenantID + "\x00" + key,
	))
	return sum[:]
}

func recipientHash(tenantID, recipient string) []byte {
	sum := sha256.Sum256([]byte(
		"postwave:scheduled-report-recipient:v1\x00" +
			tenantID + "\x00" + strings.ToLower(recipient),
	))
	return sum[:]
}

func normalizeReportName(value string) (string, error) {
	if !utf8.ValidString(value) ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", ErrReportConfigInvalid
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxReportNameBytes {
		return "", ErrReportConfigInvalid
	}
	return value, nil
}

func normalizeRecipients(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > maxScheduledRecipients {
		return nil, ErrReportConfigInvalid
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		raw = strings.TrimSpace(raw)
		if raw == "" || len(raw) > 320 || !utf8.ValidString(raw) ||
			strings.IndexFunc(raw, unicode.IsControl) >= 0 {
			return nil, ErrReportConfigInvalid
		}
		addr, err := mail.ParseAddress(raw)
		if err != nil || addr.Address == "" || len(addr.Address) > 320 {
			return nil, ErrReportConfigInvalid
		}
		// Store only the mailbox. Display names are presentation, not routing
		// identity, and may contain user-provided punctuation.
		canonical := addr.Address
		key := strings.ToLower(canonical)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, canonical)
	}
	if len(out) == 0 || len(out) > maxScheduledRecipients {
		return nil, ErrReportConfigInvalid
	}
	return out, nil
}

func boundedDiagnostic(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || len(value) <= max {
		return value
	}
	// Diagnostic constants are ASCII today, but preserve UTF-8 correctness if
	// localized operator summaries are introduced later.
	for max > 0 && !utf8.ValidString(value[:max]) {
		max--
	}
	return strings.TrimSpace(value[:max])
}

// SendNowResult is frozen when the logical manual request is first accepted.
// Reusing the same Idempotency-Key returns the same run identity.
type SendNowResult struct {
	RunID             string    `json:"run_id"`
	ScheduledReportID string    `json:"scheduled_report_id"`
	RunKind           string    `json:"run_kind"`
	Status            string    `json:"status"`
	OccurrenceAt      time.Time `json:"occurrence_at"`
	CreatedAt         time.Time `json:"created_at"`
}

type manualRunQueuer interface {
	QueueManualRun(
		ctx context.Context,
		tenantID, reportID, idempotencyKey string,
	) (SendNowResult, error)
}
