package paid_tiers

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultGiftHistoryLimit = 24
	maxGiftHistoryLimit     = 100
	maxGiftHistoryOffset    = 10_000
	maxGiftHistoryQuery     = 96
)

var (
	safePlanID              = regexp.MustCompile(`^(essentials|pro|studio)([-_ .](monthly|yearly|annual))?$`)
	safeGiftHistoryIDPrefix = regexp.MustCompile(`^[0-9a-f]{8,32}$`)
)

// giftHistoryNoStore applies before route authorization and decoding so every
// response owned by the historical Gift surface—including denials and
// validation/internal errors—overrides the authenticated-read cache default.
func giftHistoryNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// GiftHistoryQuery is the bounded, allow-listed query accepted by the
// historical archive. Search deliberately excludes purchaser and recipient
// identities so the reporting scope cannot be used as an email-existence
// oracle.
type GiftHistoryQuery struct {
	Limit  int
	Offset int
	Search string
	Filter string
	Sort   string
}

// GiftHistoryRecord is the only gift row projection mounted for authenticated
// desktop/API history reads. It intentionally excludes tenant identifiers,
// purchaser/recipient identities, free-text messages and cancellation reasons,
// provider identifiers/URLs, redemption material, and subscriber identifiers.
type GiftHistoryRecord struct {
	ID                    string     `json:"id"`
	Label                 string     `json:"label"`
	PlanLabel             string     `json:"plan_label"`
	DurationMonths        int        `json:"duration_months"`
	Status                string     `json:"status"`
	CreatedAt             time.Time  `json:"created_at"`
	RedeemedAt            *time.Time `json:"redeemed_at"`
	ExpiresAt             *time.Time `json:"expires_at"`
	CanceledAt            *time.Time `json:"canceled_at"`
	MessageRecorded       bool       `json:"message_recorded"`
	ProviderInvoiceLinked bool       `json:"provider_invoice_linked"`
	GifterMemberLinked    bool       `json:"gifter_member_linked"`
	RecipientMemberLinked bool       `json:"recipient_member_linked"`
}

type GiftHistoryPage struct {
	Items      []GiftHistoryRecord `json:"items"`
	Total      int                 `json:"total"`
	Limit      int                 `json:"limit"`
	Offset     int                 `json:"offset"`
	SnapshotAt time.Time           `json:"snapshot_at"`
}

func normalizeGiftHistoryQuery(in GiftHistoryQuery) GiftHistoryQuery {
	out := in
	if out.Limit <= 0 {
		out.Limit = defaultGiftHistoryLimit
	}
	if out.Limit > maxGiftHistoryLimit {
		out.Limit = maxGiftHistoryLimit
	}
	if out.Offset < 0 {
		out.Offset = 0
	}
	if out.Offset > maxGiftHistoryOffset {
		out.Offset = maxGiftHistoryOffset
	}
	if prefix, ok := giftHistorySearchPrefix(out.Search); ok {
		out.Search = prefix
	} else {
		out.Search = ""
	}
	switch out.Filter {
	case "", "all":
		out.Filter = "all"
	case "open", "pending", "redeemed", "closed", "cancelled", "expired", "refunded":
	default:
		out.Filter = "all"
	}
	switch out.Sort {
	case "", "newest":
		out.Sort = "newest"
	case "oldest", "duration", "status":
	default:
		out.Sort = "newest"
	}
	return out
}

func giftHistoryQueryFromRequest(r *http.Request) (GiftHistoryQuery, error) {
	values := r.URL.Query()
	out := GiftHistoryQuery{
		Limit:  defaultGiftHistoryLimit,
		Filter: strings.TrimSpace(values.Get("filter")),
		Sort:   strings.TrimSpace(values.Get("sort")),
		Search: strings.TrimSpace(values.Get("q")),
	}
	if raw := strings.TrimSpace(values.Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > maxGiftHistoryLimit {
			return GiftHistoryQuery{}, fmt.Errorf("limit must be between 1 and %d", maxGiftHistoryLimit)
		}
		out.Limit = value
	}
	if raw := strings.TrimSpace(values.Get("offset")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 0 || value > maxGiftHistoryOffset {
			return GiftHistoryQuery{}, fmt.Errorf("offset must be between 0 and %d", maxGiftHistoryOffset)
		}
		out.Offset = value
	}
	if len(out.Search) > maxGiftHistoryQuery {
		return GiftHistoryQuery{}, fmt.Errorf("q must be at most %d characters", maxGiftHistoryQuery)
	}
	if out.Search != "" {
		prefix, ok := giftHistorySearchPrefix(out.Search)
		if !ok {
			return GiftHistoryQuery{}, fmt.Errorf(
				"q must be an opaque gift-record UUID prefix of 8 to 32 hexadecimal characters",
			)
		}
		out.Search = prefix
	}
	switch out.Filter {
	case "", "all", "open", "pending", "redeemed", "closed", "cancelled", "expired", "refunded":
	default:
		return GiftHistoryQuery{}, fmt.Errorf("unsupported filter")
	}
	switch out.Sort {
	case "", "newest", "oldest", "duration", "status":
	default:
		return GiftHistoryQuery{}, fmt.Errorf("unsupported sort")
	}
	return normalizeGiftHistoryQuery(out), nil
}

func giftHistorySearchPrefix(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimSpace(strings.TrimPrefix(value, "gift record "))
	value = strings.ReplaceAll(value, "-", "")
	if !safeGiftHistoryIDPrefix.MatchString(value) {
		return "", false
	}
	return value, true
}

func giftHistoryUUIDFromHex(value string) string {
	return value[0:8] + "-" +
		value[8:12] + "-" +
		value[12:16] + "-" +
		value[16:20] + "-" +
		value[20:32]
}

func giftHistoryIDBounds(prefix string) (string, string) {
	padding := 32 - len(prefix)
	return giftHistoryUUIDFromHex(prefix + strings.Repeat("0", padding)),
		giftHistoryUUIDFromHex(prefix + strings.Repeat("f", padding))
}

func giftHistoryPlanLabel(planID string) string {
	planID = strings.ToLower(strings.TrimSpace(planID))
	if !safePlanID.MatchString(planID) {
		return "Plan on record"
	}
	words := strings.FieldsFunc(planID, func(r rune) bool {
		return r == '-' || r == '_' || r == '.' || r == ' '
	})
	for index, word := range words {
		if word == "" {
			continue
		}
		words[index] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
	}
	if len(words) == 0 {
		return "Plan on record"
	}
	return strings.Join(words, " ")
}

func giftHistoryLabel(id string) string {
	compact := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(id), "-", ""))
	if len(compact) < 8 {
		return "Gift record"
	}
	return "Gift record " + compact[:8]
}

func giftHistoryStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "pending":
		return "pending"
	case "paid":
		return "paid"
	case "granted", "redeemed", "active":
		return "redeemed"
	case "canceled", "cancelled":
		return "cancelled"
	case "expired":
		return "expired"
	case "refunded":
		return "refunded"
	default:
		return "unclassified"
	}
}

func appendGiftHistoryFilter(
	where []string,
	args []any,
	query GiftHistoryQuery,
) ([]string, []any) {
	switch query.Filter {
	case "open":
		where = append(where, "status IN ('pending', 'paid')")
	case "pending":
		where = append(where, "status = 'pending'")
	case "redeemed":
		where = append(where, "status IN ('granted', 'redeemed', 'active')")
	case "closed":
		where = append(where, "status IN ('granted', 'redeemed', 'active', 'canceled', 'cancelled', 'expired', 'refunded')")
	case "cancelled":
		where = append(where, "status IN ('canceled', 'cancelled')")
	case "expired":
		where = append(where, "status = 'expired'")
	case "refunded":
		where = append(where, "status = 'refunded'")
	}
	if query.Search != "" {
		lower, upper := giftHistoryIDBounds(query.Search)
		args = append(args, lower, upper)
		lowerPosition := len(args) - 1
		upperPosition := len(args)
		where = append(where, fmt.Sprintf(
			"id BETWEEN $%d::uuid AND $%d::uuid",
			lowerPosition, upperPosition,
		))
	}
	return where, args
}

func giftHistoryOrder(sort string) string {
	switch sort {
	case "oldest":
		return "created_at ASC, id ASC"
	case "duration":
		return "duration_months DESC, created_at DESC, id DESC"
	case "status":
		return "status ASC, created_at DESC, id DESC"
	default:
		return "created_at DESC, id DESC"
	}
}

// ListGiftHistory returns one bounded, filtered page of sanitized records.
func (r *Repo) ListGiftHistory(
	ctx context.Context,
	tenantID string,
	rawQuery GiftHistoryQuery,
) (*GiftHistoryPage, error) {
	query := normalizeGiftHistoryQuery(rawQuery)
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	where, args := appendGiftHistoryFilter(
		[]string{"tenant_id = $1::uuid"},
		[]any{tenantID},
		query,
	)
	whereSQL := strings.Join(where, " AND ")
	var total int
	if err := tx.QueryRow(
		ctx,
		"SELECT COUNT(*) FROM gift_subscriptions WHERE "+whereSQL,
		args...,
	).Scan(&total); err != nil {
		return nil, err
	}

	args = append(args, query.Limit, query.Offset)
	limitPosition := len(args) - 1
	offsetPosition := len(args)
	rows, err := tx.Query(ctx, fmt.Sprintf(`
SELECT id::text,
       plan_id,
       duration_months,
       status,
       created_at,
       COALESCE(redeemed_at, granted_at),
       expires_at,
       canceled_at,
       COALESCE(message, '') <> '',
       COALESCE(stripe_invoice_id, '') <> '',
       gifter_subscriber_id IS NOT NULL,
       redeemed_by_subscriber_id IS NOT NULL
  FROM gift_subscriptions
 WHERE %s
 ORDER BY %s
 LIMIT $%d OFFSET $%d`,
		whereSQL, giftHistoryOrder(query.Sort), limitPosition, offsetPosition,
	), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := scanGiftHistoryRows(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &GiftHistoryPage{
		Items:      items,
		Total:      total,
		Limit:      query.Limit,
		Offset:     query.Offset,
		SnapshotAt: time.Now().UTC(),
	}, nil
}

type giftHistoryRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanGiftHistoryRows(rows giftHistoryRows) ([]GiftHistoryRecord, error) {
	items := []GiftHistoryRecord{}
	for rows.Next() {
		var (
			record GiftHistoryRecord
			planID string
			status string
		)
		if err := rows.Scan(
			&record.ID,
			&planID,
			&record.DurationMonths,
			&status,
			&record.CreatedAt,
			&record.RedeemedAt,
			&record.ExpiresAt,
			&record.CanceledAt,
			&record.MessageRecorded,
			&record.ProviderInvoiceLinked,
			&record.GifterMemberLinked,
			&record.RecipientMemberLinked,
		); err != nil {
			return nil, err
		}
		record.Label = giftHistoryLabel(record.ID)
		record.PlanLabel = giftHistoryPlanLabel(planID)
		record.Status = giftHistoryStatus(status)
		items = append(items, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// GetGiftHistoryRecord returns the same sanitized projection as the list so a
// detail refresh cannot accidentally widen the privacy boundary.
func (r *Repo) GetGiftHistoryRecord(
	ctx context.Context,
	tenantID string,
	id string,
) (*GiftHistoryRecord, error) {
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text,
       plan_id,
       duration_months,
       status,
       created_at,
       COALESCE(redeemed_at, granted_at),
       expires_at,
       canceled_at,
       COALESCE(message, '') <> '',
       COALESCE(stripe_invoice_id, '') <> '',
       gifter_subscriber_id IS NOT NULL,
       redeemed_by_subscriber_id IS NOT NULL
  FROM gift_subscriptions
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 LIMIT 1`, tenantID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := scanGiftHistoryRows(rows)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &items[0], nil
}
