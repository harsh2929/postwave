package send_time_opt

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type AnalysisBucket struct {
	DayOfWeek        int     `json:"day_of_week"`
	HourUTC          int     `json:"hour_utc"`
	Sent             int     `json:"sent"`
	Delivered        int     `json:"delivered"`
	Opened           int     `json:"opened"`
	Clicked          int     `json:"clicked"`
	OpenRate         float64 `json:"open_rate"`
	ClickRate        float64 `json:"click_rate"`
	Score            float64 `json:"score"`
	SubscriberSignal int     `json:"subscriber_signal,omitempty"`
}

type BestTimeAnalysisResponse struct {
	LookbackDays int              `json:"lookback_days"`
	GeneratedAt  time.Time        `json:"generated_at"`
	TopBuckets   []AnalysisBucket `json:"top_buckets"`
	Heatmap      []AnalysisBucket `json:"heatmap"`
}

func (d *Deps) BestTimeAnalysis(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	days := 90
	if raw := r.URL.Query().Get("days"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 730 {
			days = n
		}
	}
	out, err := d.Repo.BestTimeAnalysis(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (r *Repo) BestTimeAnalysis(ctx context.Context, tenantID string, days int) (*BestTimeAnalysisResponse, error) {
	if days <= 0 {
		days = 90
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT EXTRACT(DOW FROM at)::int AS dow,
       EXTRACT(HOUR FROM at)::int AS hour,
       count(*) FILTER (WHERE event_type = 'sent')::int,
       count(*) FILTER (WHERE event_type = 'delivered')::int,
       count(*) FILTER (WHERE event_type = 'opened')::int,
       count(*) FILTER (WHERE event_type = 'clicked')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= now() - ($2::int * interval '1 day')
 GROUP BY 1, 2
 ORDER BY 1, 2`, tenantID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	buckets := make(map[int]*AnalysisBucket, 168)
	for rows.Next() {
		var b AnalysisBucket
		if err := rows.Scan(&b.DayOfWeek, &b.HourUTC, &b.Sent, &b.Delivered, &b.Opened, &b.Clicked); err != nil {
			return nil, err
		}
		finalizeBucket(&b)
		buckets[b.DayOfWeek*24+b.HourUTC] = &b
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := mergeSubscriberSignals(ctx, tx, tenantID, buckets); err != nil {
		return nil, err
	}
	heatmap := make([]AnalysisBucket, 0, 168)
	for dow := 0; dow < 7; dow++ {
		for hour := 0; hour < 24; hour++ {
			key := dow*24 + hour
			if b := buckets[key]; b != nil {
				finalizeBucket(b)
				heatmap = append(heatmap, *b)
				continue
			}
			heatmap = append(heatmap, AnalysisBucket{DayOfWeek: dow, HourUTC: hour})
		}
	}
	top := append([]AnalysisBucket(nil), heatmap...)
	sort.Slice(top, func(i, j int) bool {
		if top[i].Score == top[j].Score {
			return top[i].SubscriberSignal > top[j].SubscriberSignal
		}
		return top[i].Score > top[j].Score
	})
	if len(top) > 12 {
		top = top[:12]
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &BestTimeAnalysisResponse{
		LookbackDays: days,
		GeneratedAt:  time.Now().UTC(),
		TopBuckets:   top,
		Heatmap:      heatmap,
	}, nil
}

func mergeSubscriberSignals(ctx context.Context, tx pgx.Tx, tenantID string, buckets map[int]*AnalysisBucket) error {
	rows, err := tx.Query(ctx, `
SELECT (best_send_hour / 24)::int AS dow,
       (best_send_hour % 24)::int AS hour,
       count(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND best_send_hour IS NOT NULL
 GROUP BY 1, 2`, tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var dow, hour, count int
		if err := rows.Scan(&dow, &hour, &count); err != nil {
			return err
		}
		key := dow*24 + hour
		b := buckets[key]
		if b == nil {
			b = &AnalysisBucket{DayOfWeek: dow, HourUTC: hour}
			buckets[key] = b
		}
		b.SubscriberSignal = count
	}
	return rows.Err()
}

func finalizeBucket(b *AnalysisBucket) {
	if b == nil {
		return
	}
	denom := b.Delivered
	if denom == 0 {
		denom = b.Sent
	}
	if denom > 0 {
		b.OpenRate = float64(b.Opened) / float64(denom)
		b.ClickRate = float64(b.Clicked) / float64(denom)
	}
	b.Score = b.OpenRate + (2 * b.ClickRate) + (float64(b.SubscriberSignal) / 1000)
}
