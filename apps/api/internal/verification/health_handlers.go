// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// HealthReadService is deliberately narrower than Store. Health endpoints
// derive a read model; they never build a vendor chain, spend credits, or
// mutate subscriber consent/suppression state.
type HealthReadService interface {
	Resolve(ctx context.Context, tenantID string, emails []string) ([]EmailHealth, error)
}

func (d *Deps) healthReader() HealthReadService {
	if d.Health != nil {
		return d.Health
	}
	return &PostgresHealthService{Store: d.Store}
}

func noStoreHealth(w http.ResponseWriter) {
	// A grade discloses recipient activity and suppression state. Never let a
	// shared browser/proxy cache retain it.
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
}

// normalizeHealthEmails bounds and canonicalizes lookup keys while preserving
// first-seen order. Syntax validity is evidence for the grade (F), not an HTTP
// validation failure, so malformed-but-bounded addresses remain resolvable.
func normalizeHealthEmails(emails []string) ([]string, int, error) {
	if len(emails) == 0 {
		return nil, 0, errors.New("at least one email address is required")
	}
	if len(emails) > MaxBatch {
		return nil, 0, ErrBatchTooLarge
	}

	out := make([]string, 0, len(emails))
	seen := make(map[string]struct{}, len(emails))
	duplicates := 0
	for _, raw := range emails {
		if hasUnsafeControlText(raw) {
			return nil, 0, errors.New("every email must contain 3 to 320 characters with no control characters")
		}
		email := NormalizeEmail(raw)
		if len(email) < 3 || len(email) > maxJobEmailBytes {
			return nil, 0, errors.New("every email must contain 3 to 320 characters with no control characters")
		}
		if _, ok := seen[email]; ok {
			duplicates++
			continue
		}
		seen[email] = struct{}{}
		out = append(out, email)
	}
	return out, duplicates, nil
}

func (d *Deps) getHealth(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}
	emails, _, err := normalizeHealthEmails([]string{r.URL.Query().Get("email")})
	if err != nil {
		httperror.WriteValidation(w, "invalid_email", err.Error())
		return
	}

	results, err := d.healthReader().Resolve(r.Context(), tenantID, emails)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	if len(results) != 1 {
		d.writeVerificationInternal(w, r,
			errors.New("verification: email health reader returned an incomplete result"))
		return
	}
	writeJSON(w, http.StatusOK, results[0])
}

type healthBatchRequest struct {
	Emails []string `json:"emails"`
}

func (d *Deps) healthBatch(w http.ResponseWriter, r *http.Request) {
	noStoreHealth(w)
	tenantID, ok := d.tenant(w, r)
	if !ok {
		return
	}

	var body healthBatchRequest
	if err := httpbody.DecodeJSONWith(w, r, 1<<20, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	emails, duplicates, err := normalizeHealthEmails(body.Emails)
	if err != nil {
		if errors.Is(err, ErrBatchTooLarge) {
			httperror.WriteValidation(w, "batch_too_large",
				"Batch exceeds "+strconv.Itoa(MaxBatch)+" addresses.")
			return
		}
		httperror.WriteValidation(w, "invalid_emails", err.Error())
		return
	}

	results, err := d.healthReader().Resolve(r.Context(), tenantID, emails)
	if err != nil {
		d.writeVerificationInternal(w, r, err)
		return
	}
	if len(results) != len(emails) {
		d.writeVerificationInternal(w, r,
			errors.New("verification: email health reader returned an incomplete batch"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"results":       results,
		"summary":       summarizeHealth(results),
		"total":         len(results),
		"duplicates":    duplicates,
		"model_version": HealthModelVersion,
	})
}

// summarizeHealth always emits the closed grade set. Stable zero-valued keys
// keep dashboards from inventing their own notion of which grades exist.
func summarizeHealth(results []EmailHealth) map[string]int {
	out := map[string]int{"A": 0, "B": 0, "C": 0, "D": 0, "F": 0, "U": 0}
	for _, result := range results {
		out[string(result.Grade)]++
	}
	return out
}
