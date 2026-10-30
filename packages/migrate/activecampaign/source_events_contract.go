// SPDX-License-Identifier: MIT

package activecampaign

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	adapter "github.com/postwave/migrate/adapter"
)

const activeCampaignDeltaCursorVersion = 1

type activeCampaignDeltaCursor struct {
	Version            int       `json:"v"`
	AccountFingerprint string    `json:"account"`
	LowerBound         time.Time `json:"lower"`
	UpperBound         time.Time `json:"upper"`
	LastContactID      int       `json:"last_id"`
}

func (a *Adapter) newOrResumeDeltaCursor(sess adapter.Session, since time.Time, raw string) (activeCampaignDeltaCursor, error) {
	fingerprint := AccountFingerprint(sess)
	if fingerprint == "" {
		var err error
		fingerprint, err = accountFingerprintFromAPIURL(firstNonEmpty(a.BaseURL, sess.Extra["api_url"]))
		if err != nil {
			return activeCampaignDeltaCursor{}, fmt.Errorf("activecampaign: source-event account identity: %w", err)
		}
	}
	expectedLower := sourceEventUpdatedAfter(since)
	raw = strings.TrimSpace(raw)
	if raw == "" {
		upper := a.currentTime().UTC()
		if !expectedLower.IsZero() && !upper.After(expectedLower) {
			return activeCampaignDeltaCursor{}, fmt.Errorf("activecampaign: source-event upper bound %s is not after lower bound %s", upper.Format(time.RFC3339Nano), expectedLower.Format(time.RFC3339Nano))
		}
		return activeCampaignDeltaCursor{
			Version:            activeCampaignDeltaCursorVersion,
			AccountFingerprint: fingerprint,
			LowerBound:         expectedLower.UTC(),
			UpperBound:         upper,
		}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return activeCampaignDeltaCursor{}, fmt.Errorf("invalid fixed-window cursor encoding")
	}
	var cursor activeCampaignDeltaCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil {
		return activeCampaignDeltaCursor{}, fmt.Errorf("invalid fixed-window cursor: %w", err)
	}
	if cursor.Version != activeCampaignDeltaCursorVersion || cursor.AccountFingerprint == "" || cursor.UpperBound.IsZero() || cursor.LastContactID < 0 {
		return activeCampaignDeltaCursor{}, fmt.Errorf("invalid fixed-window cursor fields")
	}
	if cursor.AccountFingerprint != fingerprint {
		return activeCampaignDeltaCursor{}, fmt.Errorf("source-event cursor belongs to a different ActiveCampaign account")
	}
	if !cursor.LowerBound.Equal(expectedLower) {
		return activeCampaignDeltaCursor{}, fmt.Errorf("source-event cursor lower bound does not match the durable replay watermark")
	}
	if !cursor.LowerBound.IsZero() && !cursor.UpperBound.After(cursor.LowerBound) {
		return activeCampaignDeltaCursor{}, fmt.Errorf("invalid fixed-window cursor bounds")
	}
	cursor.LowerBound = cursor.LowerBound.UTC()
	cursor.UpperBound = cursor.UpperBound.UTC()
	return cursor, nil
}

func formatActiveCampaignDeltaCursor(cursor activeCampaignDeltaCursor) (string, error) {
	raw, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (a *Adapter) currentTime() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func contactDeltaUpdatedAt(contact acContact) time.Time {
	if parsed := firstParsedTime(contact.UpdatedAt, contact.UpdatedTimestamp); parsed != nil {
		return parsed.UTC()
	}
	return time.Time{}
}

// ActiveCampaign documents the contacts updated_before/updated_after filters as
// date-only values. Widen each provider-side edge by a UTC day, then enforce
// the immutable timestamp window after hydrating each contact. The extra day
// makes this safe whether the provider treats a date edge as inclusive or
// exclusive and avoids losing sub-day updates at either boundary.
func activeCampaignProviderUpdatedAfter(lower time.Time) string {
	if lower.IsZero() {
		return ""
	}
	return lower.UTC().AddDate(0, 0, -1).Format(time.DateOnly)
}

func activeCampaignProviderUpdatedBefore(upper time.Time) string {
	if upper.IsZero() {
		return ""
	}
	return upper.UTC().AddDate(0, 0, 1).Format(time.DateOnly)
}

func activeCampaignDeltaTimestampInWindow(occurred, lower, upper time.Time) bool {
	if !lower.IsZero() && occurred.Before(lower) {
		return false
	}
	return !occurred.After(upper)
}
