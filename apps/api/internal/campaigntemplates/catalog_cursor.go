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
	catalogCursorVersion  = 1
	maxCatalogCursorBytes = 2048
)

type catalogCursorEnvelope struct {
	Version    int     `json:"v"`
	FilterHash string  `json:"f"`
	Sort       string  `json:"s"`
	Page       int     `json:"p"`
	ID         string  `json:"i"`
	Name       string  `json:"n,omitempty"`
	Featured   bool    `json:"x,omitempty"`
	Quality    float64 `json:"q,omitempty"`
	Usage      int     `json:"u,omitempty"`
	CreatedAt  string  `json:"c,omitempty"`
}

type catalogCursorPosition struct {
	Page      int
	ID        string
	Name      string
	Featured  bool
	Quality   float64
	Usage     int
	CreatedAt time.Time
}

func encodeCatalogCursor(last Template, filter SearchFilter, tenantID string, nextPage int) string {
	envelope := catalogCursorEnvelope{
		Version: catalogCursorVersion, FilterHash: catalogSearchBinding(filter, tenantID),
		Sort: filter.Sort, Page: nextPage, ID: last.ID,
	}
	switch filter.Sort {
	case "name":
		envelope.Name = strings.ToLower(last.Name)
	case "most_used":
		envelope.Usage = last.UsageCount
		envelope.CreatedAt = last.CreatedAt.UTC().Format(time.RFC3339Nano)
	default:
		envelope.Featured = last.IsFeatured
		envelope.Quality = last.QualityScore
		envelope.Usage = last.UsageCount
		envelope.CreatedAt = last.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	raw, _ := json.Marshal(envelope)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCatalogCursor(raw string, filter SearchFilter, tenantID string) (catalogCursorPosition, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return catalogCursorPosition{}, nil
	}
	if len(raw) > maxCatalogCursorBytes {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	var envelope catalogCursorEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	if envelope.Version != catalogCursorVersion ||
		envelope.FilterHash != catalogSearchBinding(filter, tenantID) ||
		envelope.Sort != filter.Sort ||
		envelope.Page < 2 {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	id, err := uuid.Parse(envelope.ID)
	if err != nil {
		return catalogCursorPosition{}, ErrInvalidCatalogCursor
	}
	position := catalogCursorPosition{
		Page: envelope.Page, ID: id.String(), Name: envelope.Name,
		Featured: envelope.Featured, Quality: envelope.Quality, Usage: envelope.Usage,
	}
	switch envelope.Sort {
	case "name":
		if strings.TrimSpace(envelope.Name) == "" {
			return catalogCursorPosition{}, ErrInvalidCatalogCursor
		}
	default:
		position.CreatedAt, err = time.Parse(time.RFC3339Nano, envelope.CreatedAt)
		if err != nil || position.CreatedAt.IsZero() {
			return catalogCursorPosition{}, ErrInvalidCatalogCursor
		}
	}
	return position, nil
}

// catalogSearchBinding prevents a cursor from being accidentally reused after
// a filter, actor, tenant, or sort change. It is not an authorization token:
// continuation queries still re-enter RLS and apply every filter.
func catalogSearchBinding(filter SearchFilter, tenantID string) string {
	binding := struct {
		Tenant, User, Query, Goal, Category, Source, Provider string
		Industry, Style, Layout, Kind, Archived, Sort         string
		Tags                                                  []string
		Featured                                              *bool
		Favorited                                             bool
	}{
		Tenant: tenantID, User: filter.UserID, Query: filter.Query,
		Goal: filter.Goal, Category: filter.Category, Source: filter.Source,
		Provider: filter.Provider, Industry: filter.Industry, Style: filter.Style,
		Layout: filter.Layout, Kind: filter.Kind, Tags: filter.Tags,
		Featured: filter.Featured, Favorited: filter.FavoritedOnly,
		Archived: filter.Archived, Sort: filter.Sort,
	}
	raw, _ := json.Marshal(binding)
	digest := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(digest[:16])
}
