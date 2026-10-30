package storage

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/ingest/archive"
)

// ArchiveStore reads migrated campaign_archive rows for the newsletter archive
// voice source.
type ArchiveStore struct {
	Pool *pgxpool.Pool
}

func NewArchiveStore(pool *pgxpool.Pool) *ArchiveStore {
	return &ArchiveStore{Pool: pool}
}

func (s *ArchiveStore) ListCampaigns(ctx context.Context, tenantID string, limit int) ([]archive.CampaignRow, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, subject, text, html, sent_at
		  FROM campaign_archive
		 WHERE tenant_id = $1::uuid
		 ORDER BY sent_at DESC NULLS LAST, created_at DESC
		 LIMIT $2
	`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []archive.CampaignRow{}
	for rows.Next() {
		var row archive.CampaignRow
		var bodyText, html string
		var sentAt *time.Time
		if err := rows.Scan(&row.ID, &row.Subject, &bodyText, &html, &sentAt); err != nil {
			return nil, err
		}
		row.BodyText = strings.TrimSpace(bodyText)
		if row.BodyText == "" {
			row.BodyText = stripTags(html)
		}
		if sentAt != nil {
			row.PublishedAt = *sentAt
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

var tagRe = regexp.MustCompile(`<[^>]+>`)

func stripTags(html string) string {
	return strings.Join(strings.Fields(tagRe.ReplaceAllString(html, " ")), " ")
}
