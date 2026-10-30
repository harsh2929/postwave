// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a topic / token lookup misses.
var ErrNotFound = errors.New("preferences: not found")

// ErrSlugConflict is returned when (tenant_id, slug) UNIQUE fires.
var ErrSlugConflict = errors.New("preferences: slug already in use")

// ErrTokenExpired is returned when the token row exists but is past its TTL.
var ErrTokenExpired = errors.New("preferences: token expired")

// Repo wraps the pgx pool with the topic + subscriber-topic + token CRUD.
// Tenant-scoped methods open their own db.WithTenant tx; public methods bind
// narrow app.preference_* settings in transactions for the RLS policies in
// 0016_topics.sql.
type Repo struct {
	Pool *db.Pool
}

// ---------- topics (tenant-scoped) ----------

// ListTopics returns the tenant's topics ordered by display_order, slug.
func (r *Repo) ListTopics(ctx context.Context, tenantID string) ([]Topic, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT t.id::text, t.tenant_id::text, t.slug, t.name, COALESCE(t.description, ''),
       t.default_opt_in, t.display_order, t.created_at, t.updated_at,
       COALESCE(c.in_ct, 0), COALESCE(c.out_ct, 0)
FROM topics t
LEFT JOIN (
    SELECT topic_id,
           SUM((opted_in)::int) AS in_ct,
           SUM((NOT opted_in)::int) AS out_ct
    FROM subscriber_topics
    WHERE tenant_id = $1::uuid
    GROUP BY topic_id
) c ON c.topic_id = t.id
WHERE t.tenant_id = $1::uuid
ORDER BY t.display_order ASC, t.slug ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Topic{}
	for rows.Next() {
		var t Topic
		var inCt, outCt int64
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Slug, &t.Name, &t.Description,
			&t.DefaultOptIn, &t.DisplayOrder, &t.CreatedAt, &t.UpdatedAt,
			&inCt, &outCt); err != nil {
			return nil, err
		}
		t.OptedInCount = &inCt
		t.OptedOutCount = &outCt
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetTopic fetches a single topic.
func (r *Repo) GetTopic(ctx context.Context, tenantID, id string) (*Topic, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t Topic
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug, name, COALESCE(description, ''),
       default_opt_in, display_order, created_at, updated_at
FROM topics WHERE id::text = $1`, id)
	if err := row.Scan(&t.ID, &t.TenantID, &t.Slug, &t.Name, &t.Description,
		&t.DefaultOptIn, &t.DisplayOrder, &t.CreatedAt, &t.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}

// CreateTopic inserts a new topic, surfacing ErrSlugConflict on the unique
// (tenant_id, slug) violation.
func (r *Repo) CreateTopic(ctx context.Context, tenantID string, in CreateTopicInput) (*Topic, error) {
	if err := validateCreateTopicInput(&in); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t Topic
	row := tx.QueryRow(ctx, `
INSERT INTO topics (tenant_id, slug, name, description, default_opt_in, display_order)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6)
RETURNING id::text, tenant_id::text, slug, name, COALESCE(description, ''),
          default_opt_in, display_order, created_at, updated_at`,
		tenantID, in.Slug, in.Name, in.Description, in.DefaultOptIn, in.DisplayOrder)
	if err := row.Scan(&t.ID, &t.TenantID, &t.Slug, &t.Name, &t.Description,
		&t.DefaultOptIn, &t.DisplayOrder, &t.CreatedAt, &t.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}

// UpdateTopic applies a sparse patch.
func (r *Repo) UpdateTopic(ctx context.Context, tenantID, id string, in UpdateTopicInput) (*Topic, error) {
	cur, err := r.GetTopic(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if in.Slug != nil {
		cur.Slug = *in.Slug
	}
	if in.Name != nil {
		cur.Name = *in.Name
	}
	if in.Description != nil {
		cur.Description = *in.Description
	}
	if in.DefaultOptIn != nil {
		cur.DefaultOptIn = *in.DefaultOptIn
	}
	if in.DisplayOrder != nil {
		cur.DisplayOrder = *in.DisplayOrder
	}
	if err := validateTopicFields(cur.Slug, cur.Name, cur.Description, cur.DisplayOrder); err != nil {
		return nil, err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	row := tx.QueryRow(ctx, `
UPDATE topics SET slug=$1, name=$2, description=NULLIF($3, ''),
                  default_opt_in=$4, display_order=$5, updated_at=now()
WHERE id::text = $6
RETURNING updated_at`,
		cur.Slug, cur.Name, cur.Description, cur.DefaultOptIn, cur.DisplayOrder, id)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cur, nil
}

// DeleteTopic removes a topic (cascades to subscriber_topics).
func (r *Repo) DeleteTopic(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM topics WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ---------- subscriber_topics (tenant-scoped) ----------

// ListSubscriberTopics returns the per-topic opt-in state for a subscriber.
// Unset topics fall back to the topic's default_opt_in.
func (r *Repo) ListSubscriberTopics(ctx context.Context, tenantID, email string) ([]SubscriberTopicView, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT t.id::text, t.tenant_id::text, t.slug, t.name, COALESCE(t.description, ''),
       t.default_opt_in, t.display_order, t.created_at, t.updated_at,
       COALESCE(st.opted_in, t.default_opt_in) AS opted_in
FROM topics t
LEFT JOIN subscriber_topics st
    ON st.tenant_id = t.tenant_id
   AND st.topic_id = t.id
   AND st.subscriber_email = $2::citext
WHERE t.tenant_id = $1::uuid
ORDER BY t.display_order ASC, t.slug ASC`, tenantID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SubscriberTopicView{}
	for rows.Next() {
		var v SubscriberTopicView
		if err := rows.Scan(&v.Topic.ID, &v.Topic.TenantID, &v.Topic.Slug,
			&v.Topic.Name, &v.Topic.Description, &v.Topic.DefaultOptIn,
			&v.Topic.DisplayOrder, &v.Topic.CreatedAt, &v.Topic.UpdatedAt,
			&v.OptedIn); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ReplaceSubscriberTopics upserts the supplied opt-in state for a subscriber.
// Topics not in the input are left untouched (use the per-topic default
// fallback at read time).
func (r *Repo) ReplaceSubscriberTopics(ctx context.Context, tenantID, email string, items []TopicOptIn) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, it := range items {
		tag, err := tx.Exec(ctx, `
INSERT INTO subscriber_topics (tenant_id, subscriber_email, topic_id, opted_in, at)
SELECT $1::uuid, $2::citext, t.id, $4, now()
  FROM topics t
 WHERE t.tenant_id = $1::uuid
   AND t.id = $3::uuid
ON CONFLICT (tenant_id, subscriber_email, topic_id)
DO UPDATE SET opted_in = EXCLUDED.opted_in, at = now()`,
			tenantID, email, it.TopicID, it.OptedIn)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrInvalidTopicChoice
		}
	}
	return tx.Commit(ctx)
}

// ---------- preference_tokens ----------

// CreateToken inserts a freshly-generated token.
func (r *Repo) CreateToken(ctx context.Context, tenantID, email string, ttl time.Duration) (*PreferenceToken, error) {
	token, err := NewToken()
	if err != nil {
		return nil, err
	}
	expiresAt := time.Now().UTC().Add(ttl)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pt PreferenceToken
	row := tx.QueryRow(ctx, `
INSERT INTO preference_tokens (token, tenant_id, subscriber_email, expires_at)
VALUES ($1, $2::uuid, $3::citext, $4)
RETURNING token, tenant_id::text, subscriber_email, expires_at, created_at`,
		token, tenantID, email, expiresAt)
	if err := row.Scan(&pt.Token, &pt.TenantID, &pt.SubscriberEmail, &pt.ExpiresAt, &pt.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &pt, nil
}

// LookupToken fetches a token row WITHOUT a tenant context. It binds the exact
// app.preference_token so RLS can expose only that token row. Returns
// ErrTokenExpired when the row exists but is past expires_at.
func (r *Repo) LookupToken(ctx context.Context, token string) (*PreferenceToken, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.preference_token', $1, true)`, token); err != nil {
		return nil, err
	}

	var pt PreferenceToken
	row := tx.QueryRow(ctx, `
SELECT token, tenant_id::text, subscriber_email, expires_at, created_at
FROM preference_tokens WHERE token = $1`, token)
	if err := row.Scan(&pt.Token, &pt.TenantID, &pt.SubscriberEmail, &pt.ExpiresAt, &pt.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if time.Now().UTC().After(pt.ExpiresAt) {
		return &pt, ErrTokenExpired
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &pt, nil
}

// PublicListSubscriberTopics is the no-tenant-context counterpart used by
// the hosted preference page after the token has been validated. It runs
// outside db.WithTenant and binds the token-derived tenant/email for RLS plus
// an explicit tenant filter.
func (r *Repo) PublicListSubscriberTopics(ctx context.Context, tenantID, email string) ([]PublicSubscriberTopicView, error) {
	if tenantID == "" || email == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.preference_tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.preference_email', $1, true)`, email); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT t.id::text, t.slug, t.name, COALESCE(t.description, ''),
       t.default_opt_in, t.display_order,
       COALESCE(st.opted_in, t.default_opt_in) AS opted_in
FROM topics t
LEFT JOIN subscriber_topics st
    ON st.tenant_id = t.tenant_id
   AND st.topic_id = t.id
   AND st.subscriber_email = $2::citext
WHERE t.tenant_id = $1::uuid
ORDER BY t.display_order ASC, t.slug ASC`, tenantID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PublicSubscriberTopicView{}
	for rows.Next() {
		var v PublicSubscriberTopicView
		if err := rows.Scan(&v.Topic.ID, &v.Topic.Slug,
			&v.Topic.Name, &v.Topic.Description, &v.Topic.DefaultOptIn,
			&v.Topic.DisplayOrder, &v.OptedIn); err != nil {
			return nil, err
		}
		if err := validateTopicFields(v.Topic.Slug, v.Topic.Name, v.Topic.Description, v.Topic.DisplayOrder); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// PublicReplaceSubscriberTopics mirrors ReplaceSubscriberTopics but for
// the public token-gated path: no db.WithTenant, with token-derived
// tenant/email bound for RLS.
func (r *Repo) PublicReplaceSubscriberTopics(ctx context.Context, tenantID, email string, items []TopicOptIn) error {
	if tenantID == "" || email == "" {
		return ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.preference_tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.preference_email', $1, true)`, email); err != nil {
		return err
	}

	for _, it := range items {
		tag, err := tx.Exec(ctx, `
INSERT INTO subscriber_topics (tenant_id, subscriber_email, topic_id, opted_in, at)
SELECT $1::uuid, $2::citext, t.id, $4, now()
  FROM topics t
 WHERE t.tenant_id = $1::uuid
   AND t.id = $3::uuid
ON CONFLICT (tenant_id, subscriber_email, topic_id)
DO UPDATE SET opted_in = EXCLUDED.opted_in, at = now()`,
			tenantID, email, it.TopicID, it.OptedIn)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return ErrInvalidTopicChoice
		}
	}
	return tx.Commit(ctx)
}

// PublicTrackingPrefsGPC returns the GPC (Global Privacy Control) acknowledgement
// flag for the token-derived subscriber (SUB-043). The hosted preference page
// surfaces this so a visitor whose browser sent a GPC signal sees that we honour
// it — a mandatory disclosure in CA from 2026-01-01.
//
// subscriber_tracking_prefs (migration 0235) is RLS-scoped on app.tenant_id and
// has no public-token policy, so this binds the token-derived tenant into
// app.tenant_id for the RLS read. The token (validated upstream by LookupToken)
// has already proved the caller owns this tenant + email. A missing row means
// no tracking prefs were ever recorded for the subscriber → GPC is false (the
// column default), which is the safe "no GPC signal recorded" answer.
func (r *Repo) PublicTrackingPrefsGPC(ctx context.Context, tenantID, email string) (bool, error) {
	if tenantID == "" || email == "" {
		return false, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return false, err
	}

	var gpc bool
	row := tx.QueryRow(ctx, `
SELECT gpc
  FROM subscriber_tracking_prefs
 WHERE tenant_id = $1::uuid AND subscriber_email = $2::citext`, tenantID, email)
	if err := row.Scan(&gpc); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No prefs row → no GPC signal recorded. Commit the (read-only) tx
			// and report false.
			if cerr := tx.Commit(ctx); cerr != nil {
				return false, cerr
			}
			return false, nil
		}
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return gpc, nil
}

// PublicFrequencyState returns the subscriber's currently-persisted smart
// unsubscribe choice for the token-gated hosted page. The token has already
// bound tenantID+email; we set the tenant RLS context explicitly here.
func (r *Repo) PublicFrequencyState(ctx context.Context, tenantID, email string) (FrequencyChoice, *time.Time, error) {
	if tenantID == "" || email == "" {
		return FreqDefault, nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return FreqDefault, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return FreqDefault, nil, err
	}
	var choice string
	var pausedUntil *time.Time
	err = tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(frequency_preference, ''), 'default'), paused_until
  FROM subscribers
 WHERE tenant_id = $1::uuid AND email = $2::citext`, tenantID, email).Scan(&choice, &pausedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return FreqDefault, nil, err
		}
		return FreqDefault, nil, nil
	}
	if err != nil {
		return FreqDefault, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FreqDefault, nil, err
	}
	switch FrequencyChoice(choice) {
	case FreqWeekly, FreqMonthly, FreqPaused:
		return FrequencyChoice(choice), pausedUntil, nil
	default:
		return FreqDefault, pausedUntil, nil
	}
}

func defaultPublicPreferenceCustomization() PublicPreferenceCustomization {
	return PublicPreferenceCustomization{
		PrimaryColor:      "#5B6CFF",
		FooterText:        "You're receiving this because you subscribed.",
		ShowPostwaveBadge: true,
	}
}

// PublicPreferenceCustomization returns only presentation fields safe to put
// on the unauthenticated token page. Legacy rows with an unsafe logo scheme or
// unbounded/control-bearing footer fail closed to the corresponding default;
// subscriber preference access itself remains available.
func (r *Repo) PublicPreferenceCustomization(ctx context.Context, tenantID string) (PublicPreferenceCustomization, error) {
	if strings.TrimSpace(tenantID) == "" {
		return PublicPreferenceCustomization{}, ErrNotFound
	}
	out := defaultPublicPreferenceCustomization()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return PublicPreferenceCustomization{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT logo_url, primary_color, footer_text, show_postwave_badge
  FROM tenant_preference_customization
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.LogoURL, &out.PrimaryColor, &out.FooterText, &out.ShowPostwaveBadge)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.Commit(ctx); err != nil {
			return PublicPreferenceCustomization{}, err
		}
		return defaultPublicPreferenceCustomization(), nil
	}
	if err != nil {
		if sqlState(err) == "42P01" {
			return defaultPublicPreferenceCustomization(), nil
		}
		return PublicPreferenceCustomization{}, err
	}
	if !safePublicPreferenceLogo(out.LogoURL) {
		out.LogoURL = ""
	}
	if !safePublicPreferenceColor(out.PrimaryColor) {
		out.PrimaryColor = defaultPublicPreferenceCustomization().PrimaryColor
	}
	if !safePublicPreferenceFooter(out.FooterText) {
		out.FooterText = defaultPublicPreferenceCustomization().FooterText
	}
	if err := tx.Commit(ctx); err != nil {
		return PublicPreferenceCustomization{}, err
	}
	return out, nil
}

func safePublicPreferenceLogo(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw {
		return false
	}
	parsed, err := url.ParseRequestURI(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && safePublicPreferenceLogoHost(parsed.Hostname())
}

func safePublicPreferenceLogoHost(raw string) bool {
	host := strings.ToLower(strings.TrimSuffix(raw, "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return !ip.IsUnspecified() && !ip.IsLoopback() && !ip.IsPrivate() &&
			!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
	}
	return strings.Contains(host, ".")
}

func safePublicPreferenceColor(raw string) bool {
	if len(raw) != 7 || raw[0] != '#' {
		return false
	}
	for _, char := range raw[1:] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func safePublicPreferenceFooter(raw string) bool {
	if len(raw) > 4096 {
		return false
	}
	for _, char := range raw {
		if char == '\n' || char == '\r' || char == '\t' {
			continue
		}
		if unicode.IsControl(char) || unicode.In(char, unicode.Cf, unicode.Cs) {
			return false
		}
	}
	return true
}

func sqlState(err error) string {
	type sqlStater interface{ SQLState() string }
	var state sqlStater
	if errors.As(err, &state) {
		return state.SQLState()
	}
	return ""
}

func isUniqueViolation(err error) bool {
	return sqlState(err) == "23505"
}

// fmt is referenced by upstream callers for error wrapping; keep imported.
var _ = fmt.Sprintf
