package reportstore

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

func (s *PostgresStore) LoadSeedMailboxCursors(ctx context.Context, mailboxID string) (map[string]seedlist.FolderCursor, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("postgres reportstore: nil pool")
	}
	mailboxID, err := boundedRequiredText(mailboxID, 200, "mailbox id")
	if err != nil {
		return nil, err
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("load seed cursors: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.seed_observation_worker','true',true)`); err != nil {
		return nil, fmt.Errorf("load seed cursors: scope: %w", err)
	}
	rows, err := tx.Query(ctx, `
SELECT folder, uid_validity, last_uid, generation,
       last_seen_at, updated_at
  FROM seed_mailbox_capture_cursors
 WHERE mailbox_id = $1
 ORDER BY folder
`, mailboxID)
	if err != nil {
		return nil, fmt.Errorf("load seed cursors: %w", err)
	}
	defer rows.Close()
	out := make(map[string]seedlist.FolderCursor)
	for rows.Next() {
		var cursor seedlist.FolderCursor
		var uidValidity, lastUID, generation int64
		var lastSeen pgtype.Timestamptz
		if err := rows.Scan(&cursor.Folder, &uidValidity, &lastUID, &generation, &lastSeen, &cursor.UpdatedAt); err != nil {
			return nil, err
		}
		cursor.UIDValidity = uint32(uidValidity)
		cursor.LastUID = uint32(lastUID)
		cursor.Generation = uint64(generation)
		if lastSeen.Valid {
			cursor.LastSeenAt = lastSeen.Time
		}
		out[cursor.Folder] = cursor
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("load seed cursors: commit: %w", err)
	}
	return out, nil
}

func (s *PostgresStore) AdvanceSeedMailboxCursors(ctx context.Context, mailboxID string, watermarks []seedlist.FolderWatermark) error {
	if s == nil || s.Pool == nil {
		return errors.New("postgres reportstore: nil pool")
	}
	mailboxID, err := boundedRequiredText(mailboxID, 200, "mailbox id")
	if err != nil {
		return err
	}
	if len(watermarks) == 0 {
		return nil
	}
	ordered := append([]seedlist.FolderWatermark(nil), watermarks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Folder < ordered[j].Folder })
	seen := make(map[string]struct{}, len(ordered))
	for index := range ordered {
		folder, err := boundedRequiredText(ordered[index].Folder, 500, "folder")
		if err != nil {
			return err
		}
		ordered[index].Folder = folder
		if ordered[index].UIDValidity == 0 {
			return errors.New("seed cursor: UIDVALIDITY is required")
		}
		if _, duplicate := seen[folder]; duplicate {
			return fmt.Errorf("seed cursor: duplicate folder %q", folder)
		}
		seen[folder] = struct{}{}
	}
	now := time.Now().UTC()
	if s.Now != nil {
		now = s.Now().UTC()
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("advance seed cursors: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.seed_observation_worker','true',true)`); err != nil {
		return fmt.Errorf("advance seed cursors: scope: %w", err)
	}
	for _, watermark := range ordered {
		observedAt := watermark.ObservedAt.UTC()
		if observedAt.IsZero() {
			observedAt = now
		}
		if observedAt.After(now.Add(5 * time.Minute)) {
			return errors.New("seed cursor: observed_at is in the future")
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\x1f' || $2, 0))`, mailboxID, watermark.Folder); err != nil {
			return fmt.Errorf("advance seed cursor lock: %w", err)
		}
		if err := advanceOneSeedCursor(ctx, tx, mailboxID, watermark, observedAt, now); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("advance seed cursors: commit: %w", err)
	}
	return nil
}

func advanceOneSeedCursor(ctx context.Context, tx pgx.Tx, mailboxID string, watermark seedlist.FolderWatermark, observedAt, now time.Time) error {
	var priorUIDValidity, priorLastUID, generation int64
	var priorUpdatedAt time.Time
	err := tx.QueryRow(ctx, `
SELECT uid_validity, last_uid, generation, updated_at
  FROM seed_mailbox_capture_cursors
 WHERE mailbox_id=$1 AND folder=$2
 FOR UPDATE
`, mailboxID, watermark.Folder).Scan(&priorUIDValidity, &priorLastUID, &generation, &priorUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx, `
INSERT INTO seed_mailbox_capture_cursors (
    mailbox_id, folder, uid_validity, last_uid, generation, last_seen_at, updated_at
) VALUES ($1,$2,$3,$4,1,$5,$6)
`, mailboxID, watermark.Folder, int64(watermark.UIDValidity), int64(watermark.LastUID), observedAt, now); err != nil {
			return fmt.Errorf("create seed cursor: %w", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO seed_mailbox_capture_cursor_events (
    mailbox_id, folder, event_type, uid_validity, last_uid, generation, recorded_at
) VALUES ($1,$2,'created',$3,$4,1,$5)
`, mailboxID, watermark.Folder, int64(watermark.UIDValidity), int64(watermark.LastUID), now); err != nil {
			return fmt.Errorf("record seed cursor creation: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read seed cursor: %w", err)
	}
	if observedAt.Before(priorUpdatedAt) {
		return nil // stale concurrent poll; never roll a cursor backward.
	}

	eventType := "advanced"
	nextGeneration := generation
	if uint32(priorUIDValidity) == watermark.UIDValidity {
		if int64(watermark.LastUID) < priorLastUID {
			return nil
		}
		if int64(watermark.LastUID) == priorLastUID {
			_, err := tx.Exec(ctx, `
UPDATE seed_mailbox_capture_cursors
   SET last_seen_at=GREATEST(COALESCE(last_seen_at,'-infinity'::timestamptz),$3),
       updated_at=$4
 WHERE mailbox_id=$1 AND folder=$2
`, mailboxID, watermark.Folder, observedAt, now)
			return err
		}
	} else {
		eventType = "uidvalidity_reset"
		nextGeneration++
	}
	if _, err := tx.Exec(ctx, `
UPDATE seed_mailbox_capture_cursors
   SET uid_validity=$3, last_uid=$4, generation=$5, last_seen_at=$6, updated_at=$7
 WHERE mailbox_id=$1 AND folder=$2
`, mailboxID, watermark.Folder, int64(watermark.UIDValidity), int64(watermark.LastUID),
		nextGeneration, observedAt, now); err != nil {
		return fmt.Errorf("update seed cursor: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO seed_mailbox_capture_cursor_events (
    mailbox_id, folder, event_type, prior_uid_validity, uid_validity,
    prior_last_uid, last_uid, generation, recorded_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
`, mailboxID, watermark.Folder, eventType, priorUIDValidity, int64(watermark.UIDValidity),
		priorLastUID, int64(watermark.LastUID), nextGeneration, now); err != nil {
		return fmt.Errorf("record seed cursor event: %w", err)
	}
	return nil
}
