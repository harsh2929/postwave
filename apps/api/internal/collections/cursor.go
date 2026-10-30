// SPDX-License-Identifier: AGPL-3.0-only
package collections

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

	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const collectionCursorVersion = 1
const maxCollectionCursorBytes = 2048

type collectionCursorEnvelope struct {
	Version        int    `json:"v"`
	SortKey        string `json:"k"`
	ID             string `json:"i"`
	Query          string `json:"q"`
	CollectionType string `json:"t"`
	TenantBinding  string `json:"w"`
}

// encodeCollectionCursor binds a keyset position to the exact filters that
// produced it. The cursor is opaque but not an authorization token; every
// resulting query still re-enters tenant RLS and validates its own filters.
func encodeCollectionCursor(last Collection, opts ListOptions, tenantID string) string {
	envelope := collectionCursorEnvelope{
		Version:        collectionCursorVersion,
		SortKey:        last.CreatedAt.UTC().Format(time.RFC3339Nano),
		ID:             last.ID,
		Query:          opts.Query,
		CollectionType: opts.CollectionType,
		TenantBinding:  collectionTenantBinding(tenantID),
	}
	raw, _ := json.Marshal(envelope)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCollectionCursor(raw string, opts ListOptions, tenantID string) (pagination.Cursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return pagination.Cursor{}, nil
	}
	if len(raw) > maxCollectionCursorBytes {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	var envelope collectionCursorEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	if envelope.Version != collectionCursorVersion ||
		envelope.Query != opts.Query ||
		envelope.CollectionType != opts.CollectionType ||
		envelope.TenantBinding != collectionTenantBinding(tenantID) {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	sortKey, err := time.Parse(time.RFC3339Nano, envelope.SortKey)
	if err != nil || sortKey.IsZero() {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	id, err := uuid.Parse(envelope.ID)
	if err != nil {
		return pagination.Cursor{}, pagination.ErrInvalidCursor
	}
	return pagination.Cursor{SortKey: sortKey, ID: id.String()}, nil
}

func collectionTenantBinding(tenantID string) string {
	if parsed, err := uuid.Parse(tenantID); err == nil {
		tenantID = parsed.String()
	}
	digest := sha256.Sum256([]byte(tenantID))
	return base64.RawURLEncoding.EncodeToString(digest[:16])
}
