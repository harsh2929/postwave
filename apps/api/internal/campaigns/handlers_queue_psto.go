// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Per-subscriber send-time optimisation (PSTO): materialises the per-recipient
// schedule inside the queue transaction.

func materializePSTOScheduleTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, emails []string) error {
	var (
		optimize bool
		start    *time.Time
		end      *time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT per_recipient_optimize, send_window_start, send_window_end
  FROM campaigns
 WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		campaignID, tenantID,
	).Scan(&optimize, &start, &end); err != nil {
		return fmt.Errorf("campaigns: load psto config: %w", err)
	}
	if !optimize {
		return nil
	}
	if start == nil || end == nil || !end.After(*start) || end.Before(time.Now().UTC()) {
		freshStart := time.Now().UTC()
		freshEnd := freshStart.Add(24 * time.Hour)
		start, end = &freshStart, &freshEnd
		if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET send_window_start = $3, send_window_end = $4
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, campaignID, tenantID, start, end); err != nil {
			return fmt.Errorf("campaigns: refresh psto window: %w", err)
		}
	}
	if len(emails) == 0 {
		return nil
	}

	normalized := make([]string, 0, len(emails))
	for _, e := range emails {
		e = strings.ToLower(strings.TrimSpace(e))
		if e != "" {
			normalized = append(normalized, e)
		}
	}
	if len(normalized) == 0 {
		return nil
	}

	bestByEmail := map[string]*int{}
	sum, n := 0, 0
	rows, err := tx.Query(ctx, `
SELECT lower(email::text), best_send_hour
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND email = ANY($2::citext[])`,
		tenantID, normalized)
	if err != nil {
		return fmt.Errorf("campaigns: load psto subscriber hours: %w", err)
	}
	for rows.Next() {
		var (
			email string
			hour  *int
		)
		if err := rows.Scan(&email, &hour); err != nil {
			rows.Close()
			return fmt.Errorf("campaigns: scan psto subscriber hour: %w", err)
		}
		bestByEmail[email] = hour
		if hour != nil {
			sum += *hour
			n++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("campaigns: read psto subscriber hours: %w", err)
	}

	tenantMean := 9
	if n > 0 {
		tenantMean = sum / n
	}
	schedules := make([]struct {
		email string
		at    time.Time
	}, 0, len(normalized))
	windowStart := start.UTC()
	windowEnd := end.UTC()
	for _, email := range normalized {
		hour := tenantMean
		if h := bestByEmail[email]; h != nil {
			hour = *h
		}
		when := nextPSTOHourAtOrAfter(windowStart, hour)
		if when.After(windowEnd) {
			when = windowEnd
		}
		if when.Before(windowStart) {
			when = windowStart
		}
		schedules = append(schedules, struct {
			email string
			at    time.Time
		}{email: email, at: when})
	}

	const batchSize = 8000
	for i := 0; i < len(schedules); i += batchSize {
		j := i + batchSize
		if j > len(schedules) {
			j = len(schedules)
		}
		if err := flushPSTOScheduleBatch(ctx, tx, tenantID, campaignID, schedules[i:j]); err != nil {
			return err
		}
	}
	return nil
}

func flushPSTOScheduleBatch(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, batch []struct {
	email string
	at    time.Time
}) error {
	if len(batch) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString(`
INSERT INTO campaign_recipient_send_at
    (tenant_id, campaign_id, subscriber_email, scheduled_send_at)
VALUES `)
	args := make([]any, 0, len(batch)*4)
	for i, row := range batch {
		if i > 0 {
			b.WriteString(", ")
		}
		base := i * 4
		fmt.Fprintf(&b, "($%d::uuid, $%d::uuid, $%d, $%d::timestamptz)",
			base+1, base+2, base+3, base+4)
		args = append(args, tenantID, campaignID, row.email, row.at.UTC())
	}
	b.WriteString(`
ON CONFLICT (campaign_id, subscriber_email) DO UPDATE
   SET scheduled_send_at = EXCLUDED.scheduled_send_at,
       sent_at           = NULL`)
	if _, err := tx.Exec(ctx, b.String(), args...); err != nil {
		return fmt.Errorf("campaigns: persist psto schedule: %w", err)
	}
	return nil
}

func nextPSTOHourAtOrAfter(start time.Time, target int) time.Time {
	if target < 0 || target > 167 {
		target = 9
	}
	start = start.UTC()
	base := time.Date(start.Year(), start.Month(), start.Day(), start.Hour(), 0, 0, 0, time.UTC)
	curr := int(base.Weekday())*24 + base.Hour()
	delta := target - curr
	if delta < 0 {
		delta += 168
	}
	return base.Add(time.Duration(delta) * time.Hour)
}
