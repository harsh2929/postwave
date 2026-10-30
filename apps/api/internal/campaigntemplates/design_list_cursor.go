// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	defaultDesignDraftListLimit = 20
	maxDesignDraftListLimit     = 50
	designDraftCursorVersion    = 1
	maxDesignDraftCursorBytes   = 1024
)

type designDraftCursorEnvelope struct {
	Version   int    `json:"v"`
	Binding   string `json:"b"`
	UpdatedAt string `json:"u"`
	DesignID  string `json:"i"`
}

type designDraftCursorPosition struct {
	UpdatedAt time.Time
	DesignID  string
}

func normalizeDesignDraftListFilter(
	filter DesignDraftListFilter,
) (DesignDraftListFilter, error) {
	if filter.Limit == 0 {
		filter.Limit = defaultDesignDraftListLimit
	}
	if filter.Limit < 1 || filter.Limit > maxDesignDraftListLimit {
		return DesignDraftListFilter{}, ErrInvalidDesignDraftLimit
	}
	filter.Cursor = strings.TrimSpace(filter.Cursor)
	if len(filter.Cursor) > maxDesignDraftCursorBytes {
		return DesignDraftListFilter{}, ErrInvalidDesignDraftCursor
	}
	return filter, nil
}

func encodeDesignDraftCursor(
	last DesignDraftSummary,
	tenantID string,
	actor ReferenceReviewActor,
) string {
	envelope := designDraftCursorEnvelope{
		Version:   designDraftCursorVersion,
		Binding:   designDraftCursorBinding(tenantID, actor),
		UpdatedAt: last.UpdatedAt.UTC().Format(time.RFC3339Nano),
		DesignID:  last.ID,
	}
	raw, _ := json.Marshal(envelope)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeDesignDraftCursor(
	raw, tenantID string,
	actor ReferenceReviewActor,
) (designDraftCursorPosition, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return designDraftCursorPosition{}, nil
	}
	if len(raw) > maxDesignDraftCursorBytes {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	var envelope designDraftCursorEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	if envelope.Version != designDraftCursorVersion ||
		envelope.Binding != designDraftCursorBinding(tenantID, actor) {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	designID, err := uuid.Parse(envelope.DesignID)
	if err != nil || designID == uuid.Nil {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, envelope.UpdatedAt)
	if err != nil || updatedAt.IsZero() {
		return designDraftCursorPosition{}, ErrInvalidDesignDraftCursor
	}
	return designDraftCursorPosition{
		UpdatedAt: updatedAt.UTC(),
		DesignID:  designID.String(),
	}, nil
}

// The binding prevents accidental cursor reuse across tenants or actors. It is
// not an authorization token: every continuation query still applies RLS and
// exact tenant + actor predicates.
func designDraftCursorBinding(
	tenantID string,
	actor ReferenceReviewActor,
) string {
	raw, _ := json.Marshal(struct {
		TenantID  string `json:"tenant_id"`
		ActorType string `json:"actor_type"`
		ActorID   string `json:"actor_id"`
	}{
		TenantID:  strings.TrimSpace(tenantID),
		ActorType: strings.ToLower(strings.TrimSpace(actor.Type)),
		ActorID:   strings.TrimSpace(actor.ID),
	})
	digest := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(digest[:16])
}
