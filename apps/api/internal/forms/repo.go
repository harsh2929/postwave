package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// ErrNotFound is returned when a form / submission lookup misses.
var ErrNotFound = errors.New("forms: not found")

// ErrSlugConflict is returned when a tenant tries to use a slug that already
// exists for them. The (tenant_id, slug) UNIQUE constraint surfaces as a
// pgx integrity violation; we translate it.
var ErrSlugConflict = errors.New("forms: slug already in use for this tenant")

// ErrPublicSlugConflict is returned when publishing would claim a hosted URL
// already owned by another workspace's published form. Public form URLs do not
// include a tenant discriminator, so published slugs are globally unique.
var ErrPublicSlugConflict = errors.New("forms: hosted slug already in use by another published form")

var ErrPreconditionFailed = errors.New("forms: precondition failed")

// Repo abstracts the postgres calls so handlers stay readable. Methods that
// take a `tenantID` open their own tenant-scoped tx via db.WithTenant. The
// public-routes counterparts bind narrow app.public_* settings in their own
// transactions; the public RLS policies in 0007_forms.sql require those
// values.
type Repo struct {
	Pool *db.Pool
}

// List returns the tenant's forms with computed 30d submission counts.
// When q is non-empty it filters by name OR slug substring (ILIKE).
// Empty q means no filter.
func (r *Repo) List(ctx context.Context, tenantID, q string) ([]FormListItem, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const sqlQ = `
SELECT f.id::text, f.tenant_id::text, f.slug, f.name, f.opt_in_mode,
       f.structure, f.settings, COALESCE(f.steps, '[]'::jsonb),
       f.status, f.created_at, f.updated_at,
       (SELECT COUNT(*) FROM form_submissions s
            WHERE s.form_id = f.id AND s.submitted_at > now() - interval '30 days') AS subs_30d,
       (SELECT COALESCE(SUM(v.count), 0) FROM form_visits v
            WHERE v.tenant_id = f.tenant_id AND v.form_id = f.id
              AND v.day > ((now() AT TIME ZONE 'utc')::date - 30)) AS visits_30d
FROM forms f
WHERE f.tenant_id = $1::uuid
  AND ($2 = '' OR (f.name ILIKE '%' || $2 || '%' OR f.slug ILIKE '%' || $2 || '%'))
ORDER BY f.updated_at DESC`

	rows, err := tx.Query(ctx, sqlQ, tenantID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FormListItem{}
	for rows.Next() {
		var (
			f          Form
			structRaw  []byte
			settingRaw []byte
			stepsRaw   []byte
			subs30     int64
			visits30   int64
		)
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Slug, &f.Name, &f.OptInMode,
			&structRaw, &settingRaw, &stepsRaw, &f.Status, &f.CreatedAt, &f.UpdatedAt,
			&subs30, &visits30); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(structRaw, &f.Structure)
		_ = json.Unmarshal(settingRaw, &f.Settings)
		if len(stepsRaw) > 0 {
			_ = json.Unmarshal(stepsRaw, &f.Steps)
		}
		if f.Steps == nil {
			f.Steps = []FormStep{}
		}
		f.StepCount = len(f.Steps)
		conv := 0
		conv = formConversionRate(subs30, visits30)
		out = append(out, FormListItem{
			Form:           f,
			Submissions30d: int(subs30),
			ConversionRate: conv,
			Visits30d:      int(visits30),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func formConversionRate(submissions, visits int64) int {
	if visits <= 0 || submissions <= 0 {
		return 0
	}
	return int(min(submissions, visits) * 100 / visits)
}

// Get fetches a form by id, tenant-scoped.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Form, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	f, err := scanForm(ctx, tx, "id::text = $1", id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return f, nil
}

// ByPublicSlug looks up a published form by slug WITHOUT a tenant context.
// It binds app.public_form_slug so RLS can expose only that published slug.
func (r *Repo) ByPublicSlug(ctx context.Context, slug string) (*Form, error) {
	if slug == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_form_slug', $1, true)`, slug); err != nil {
		return nil, err
	}

	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug, name, opt_in_mode, structure, settings,
       COALESCE(steps, '[]'::jsonb), status, created_at, updated_at
FROM forms
WHERE slug = $1 AND status = 'published'
LIMIT 1`, slug)

	var (
		f          Form
		structRaw  []byte
		settingRaw []byte
		stepsRaw   []byte
	)
	if err := row.Scan(&f.ID, &f.TenantID, &f.Slug, &f.Name, &f.OptInMode,
		&structRaw, &settingRaw, &stepsRaw, &f.Status, &f.CreatedAt, &f.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(structRaw, &f.Structure)
	_ = json.Unmarshal(settingRaw, &f.Settings)
	if len(stepsRaw) > 0 {
		_ = json.Unmarshal(stepsRaw, &f.Steps)
	}
	if f.Steps == nil {
		f.Steps = []FormStep{}
	}
	f.StepCount = len(f.Steps)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// Create inserts a new form. Surfaces ErrSlugConflict on the unique
// (tenant_id, slug) violation.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput, structure, settings map[string]any) (*Form, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	structBytes, _ := json.Marshal(structure)
	settingBytes, _ := json.Marshal(settings)
	steps := in.Steps
	if steps == nil {
		steps = []FormStep{}
	}
	stepsBytes, _ := json.Marshal(steps)
	row := tx.QueryRow(ctx, `
INSERT INTO forms (tenant_id, slug, name, opt_in_mode, structure, settings, steps, status)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'draft')
RETURNING id::text, created_at, updated_at`,
		tenantID, in.Slug, in.Name, in.OptInMode, structBytes, settingBytes, stepsBytes)

	f := &Form{
		TenantID: tenantID, Slug: in.Slug, Name: in.Name,
		OptInMode: in.OptInMode, Status: StatusDraft,
		Structure: structure, Settings: settings,
		Steps: steps, StepCount: len(steps),
	}
	if err := row.Scan(&f.ID, &f.CreatedAt, &f.UpdatedAt); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return f, nil
}

// Update applies the provided patch to an existing form. The current row is
// loaded inside the same tx so AllowedTransition enforcement is consistent.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Form, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := scanForm(ctx, tx, "id::text = $1", id)
	if err != nil {
		return nil, err
	}
	var expectedUpdatedAt *time.Time
	if in.IfMatchToken != "" {
		if in.IfMatchToken != httpcache.ConcurrencyToken("form", cur.ID, cur.UpdatedAt) {
			return nil, ErrPreconditionFailed
		}
		ts := cur.UpdatedAt
		expectedUpdatedAt = &ts
	}

	if in.Status != nil && !AllowedTransition(cur.Status, *in.Status) {
		return nil, fmt.Errorf("forms: illegal status transition %s -> %s", cur.Status, *in.Status)
	}

	if in.Name != nil {
		cur.Name = *in.Name
	}
	if in.Slug != nil {
		cur.Slug = *in.Slug
	}
	if in.OptInMode != nil {
		cur.OptInMode = *in.OptInMode
	}
	if in.Structure != nil {
		cur.Structure = *in.Structure
	}
	if in.Settings != nil {
		cur.Settings = *in.Settings
	}
	if in.Steps != nil {
		cur.Steps = *in.Steps
		cur.StepCount = len(cur.Steps)
	}
	if in.Status != nil {
		cur.Status = *in.Status
	}
	// A form may only target the workspace's own lists. Checked whenever the
	// target can change and whenever the form goes live, in the transaction
	// that writes it, so a form published with another workspace's list (or
	// one of Listmonk's install lists, which no workspace owns) cannot exist.
	if in.Settings != nil || (in.Status != nil && *in.Status == StatusPublished) {
		engineIDs, err := listIDsFromSettings(cur.Settings)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrTargetListNotFound, err)
		}
		if _, err := resolveTargetListsInTx(ctx, tx, tenantID, engineIDs); err != nil {
			return nil, err
		}
	}

	structBytes, _ := json.Marshal(cur.Structure)
	settingBytes, _ := json.Marshal(cur.Settings)
	stepsForWrite := cur.Steps
	if stepsForWrite == nil {
		stepsForWrite = []FormStep{}
	}
	stepsBytes, _ := json.Marshal(stepsForWrite)
	row := tx.QueryRow(ctx, `
UPDATE forms SET name=$1, slug=$2, opt_in_mode=$3, structure=$4::jsonb,
                 settings=$5::jsonb, steps=$6::jsonb, status=$7, updated_at=now()
WHERE id::text = $8
  AND ($9::timestamptz IS NULL OR updated_at = $9)
RETURNING updated_at`,
		cur.Name, cur.Slug, cur.OptInMode, structBytes, settingBytes, stepsBytes, cur.Status, id, expectedUpdatedAt)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) && expectedUpdatedAt != nil {
			return nil, ErrPreconditionFailed
		}
		if isUniqueConstraintViolation(err, "forms_public_slug_uniq") {
			return nil, ErrPublicSlugConflict
		}
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

// Delete removes the form (cascades to submissions).
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	return r.DeleteWithVersion(ctx, tenantID, id, "")
}

// DeleteWithVersion removes a form only when ifMatchToken still identifies
// the current row. Keeping Delete as the unconditional compatibility wrapper
// lets older callers migrate without weakening concurrency-aware clients.
func (r *Repo) DeleteWithVersion(ctx context.Context, tenantID, id, ifMatchToken string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var expectedUpdatedAt *time.Time
	if ifMatchToken != "" {
		current, err := scanForm(ctx, tx, "id::text = $1", id)
		if err != nil {
			return err
		}
		if ifMatchToken != httpcache.ConcurrencyToken("form", current.ID, current.UpdatedAt) {
			return ErrPreconditionFailed
		}
		ts := current.UpdatedAt
		expectedUpdatedAt = &ts
	}

	tag, err := tx.Exec(ctx, `
DELETE FROM forms
WHERE id::text = $1
  AND ($2::timestamptz IS NULL OR updated_at = $2)`, id, expectedUpdatedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if expectedUpdatedAt != nil {
			return ErrPreconditionFailed
		}
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RecordVisit bumps the daily visit counter for (tenantID, formID)
// (A23, desktop audit 2026-06-10). Called best-effort from the public
// form render routes AFTER the slug lookup resolved tenant + form, so
// the standard tenant-scoped tx (which binds app.tenant_id for the
// form_visits RLS policy) is safe here despite the routes being
// unauthenticated. One upsert against the (tenant_id, form_id, day)
// primary key — deliberately the cheapest possible write so the public
// GET path stays fast. Day buckets are UTC so counts don't shift with
// the deployment's timezone.
func (r *Repo) RecordVisit(ctx context.Context, tenantID, formID string) error {
	if tenantID == "" || formID == "" {
		return fmt.Errorf("forms: visit scope required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO form_visits (tenant_id, form_id, day, count)
VALUES ($1::uuid, $2::uuid, (now() AT TIME ZONE 'utc')::date, 1)
ON CONFLICT (tenant_id, form_id, day)
DO UPDATE SET count = form_visits.count + 1`, tenantID, formID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// maxVisitWindowDays caps the per-day visit window (A23). 90 days
// matches the analytics grouped-timeseries cap so the desktop's range
// pickers can share one constant.
const maxVisitWindowDays = 90

// VisitPoint is one daily bucket of hosted-form visits.
type VisitPoint struct {
	Date  string `json:"date"` // YYYY-MM-DD (UTC bucket)
	Count int    `json:"count"`
}

// VisitsByDay returns the per-day visit counters for one form over the
// trailing `days` UTC days (oldest first), zero-filled so charts need
// no client-side gap handling. Served entirely by the form_visits
// primary key — at most `days` rows are scanned.
func (r *Repo) VisitsByDay(ctx context.Context, tenantID, formID string, days int) ([]VisitPoint, error) {
	if tenantID == "" || formID == "" {
		return nil, fmt.Errorf("forms: visit scope required")
	}
	if days <= 0 {
		days = 30
	}
	if days > maxVisitWindowDays {
		days = maxVisitWindowDays
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT to_char(day, 'YYYY-MM-DD'), count::int
  FROM form_visits
 WHERE tenant_id = $1::uuid AND form_id = $2::uuid
   AND day > ((now() AT TIME ZONE 'utc')::date - $3::int)
 ORDER BY day ASC`, tenantID, formID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			return nil, err
		}
		counts[d] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return fillVisitDays(time.Now().UTC(), days, counts), nil
}

// fillVisitDays zero-fills the (date -> count) map into `days` ordered
// points ending today (UTC). Pure function so the window alignment is
// unit-testable without a DB.
func fillVisitDays(now time.Time, days int, counts map[string]int) []VisitPoint {
	out := make([]VisitPoint, 0, days)
	start := now.AddDate(0, 0, -(days - 1))
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i).Format("2006-01-02")
		out = append(out, VisitPoint{Date: d, Count: counts[d]})
	}
	return out
}

// RecentSubmissionExists checks whether a submission for (formID,
// email) that made the same subscribe decision already exists within the
// windowSeconds window: one that asked to subscribe when subscribing is true
// (any status but received), a response only (received) when it is false.
// Used by the public submit handler to dedupe double-click / browser-
// prefetch double-POSTs (see C10 in PRODUCTION_READINESS.md).
// Caller supplies tenantID (already resolved via ByPublicSlug).
// Returns false on any error so a transient hiccup never blocks
// the public submit.
func (r *Repo) RecentSubmissionExists(ctx context.Context, tenantID, formID, email string, subscribing bool, windowSeconds int) (bool, error) {
	if tenantID == "" || formID == "" || email == "" || windowSeconds <= 0 {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(
  SELECT 1 FROM form_submissions
   WHERE form_id = $1::uuid
     AND email = $2
     AND submitted_at >= now() - ($3::int * INTERVAL '1 second')
     AND (status <> 'received') = $4::boolean
)`, formID, email, windowSeconds, subscribing).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// GetSubmission fetches a single submission's identity fields (email, token,
// status) for the per-submission admin actions (FORM-030). Returns ErrNotFound
// when the (formID, submissionID) pair is unknown to the tenant.
func (r *Repo) GetSubmission(ctx context.Context, tenantID, formID, submissionID string) (*Submission, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s Submission
	err = tx.QueryRow(ctx, `
SELECT id::text, form_id::text, email, COALESCE(confirmation_token, ''), status
FROM form_submissions
WHERE form_id::text = $1 AND id::text = $2`, formID, submissionID).
		Scan(&s.ID, &s.FormID, &s.Email, &s.ConfirmationToken, &s.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// DeleteSubmission removes one submission (FORM-030 — e.g. spam). Tenant-scoped
// via RLS + the explicit form_id/id predicate; ErrNotFound when nothing matched.
func (r *Repo) DeleteSubmission(ctx context.Context, tenantID, formID, submissionID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ct, err := tx.Exec(ctx,
		`DELETE FROM form_submissions WHERE form_id::text = $1 AND id::text = $2`,
		formID, submissionID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ListSubmissions returns the form's submissions newest-first with keyset
// pagination on (submitted_at, id). formID filters to one form. limit is the
// page size (caller clamps via pagination.ReadParamsWithDefault); a non-empty
// next cursor is returned when more rows remain.
func (r *Repo) ListSubmissions(ctx context.Context, tenantID, formID string, limit int, cursor pagination.Cursor) ([]Submission, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// $1 formID, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{formID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (submitted_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, form_id::text, email, custom_fields, status,
       host(ip)::text, user_agent, submitted_at, confirmed_at,
       COALESCE(confirmation_email_state, '')
FROM form_submissions
WHERE form_id::text = $1
`+keyset+`
ORDER BY submitted_at DESC, id DESC
LIMIT $2`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	out := []Submission{}
	for rows.Next() {
		var (
			s     Submission
			cfRaw []byte
			ip    *string
			ua    *string
		)
		if err := rows.Scan(&s.ID, &s.FormID, &s.Email, &cfRaw, &s.Status, &ip, &ua, &s.SubmittedAt, &s.ConfirmedAt, &s.ConfirmationEmail); err != nil {
			return nil, "", err
		}
		_ = json.Unmarshal(cfRaw, &s.CustomFields)
		s.IP = ip
		s.UserAgent = ua
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.SubmittedAt, ID: last.ID})
	}
	return out, next, nil
}

// ListAllSubmissions returns every submission for a form newest-first, up to
// the prior LIMIT 1000 ceiling. The CSV export needs the full set in one pass
// (it streams a single file, not a paginated UI), so it keeps the original
// unpaginated behavior rather than walking cursors.
func (r *Repo) ListAllSubmissions(ctx context.Context, tenantID, formID string) ([]Submission, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, form_id::text, email, custom_fields, status,
       host(ip)::text, user_agent, submitted_at, confirmed_at,
       COALESCE(confirmation_email_state, '')
FROM form_submissions
WHERE form_id::text = $1
ORDER BY submitted_at DESC, id DESC
LIMIT 1000`, formID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Submission{}
	for rows.Next() {
		var (
			s     Submission
			cfRaw []byte
			ip    *string
			ua    *string
		)
		if err := rows.Scan(&s.ID, &s.FormID, &s.Email, &cfRaw, &s.Status, &ip, &ua, &s.SubmittedAt, &s.ConfirmedAt, &s.ConfirmationEmail); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(cfRaw, &s.CustomFields)
		s.IP = ip
		s.UserAgent = ua
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// InsertSubmission writes a new submission row WITHOUT a tenant context (the
// public submit endpoint runs unauthenticated). The caller must have already
// looked up the form via ByPublicSlug to know the form_id + tenant_id. We bind
// those values so RLS can accept only this published form.
func (r *Repo) InsertSubmission(ctx context.Context, tenantID, formID string, s Submission) (string, error) {
	return r.InsertSubmissionWithSignup(ctx, tenantID, formID, s, SignupIntent{}, nil)
}

// InsertSubmissionWithSignup is InsertSubmission plus the submission's
// audience intent, in one transaction: the target lists are resolved through
// the tenant's list_id_map (an id the tenant does not own fails the whole
// insert with ErrTargetListNotFound), stored on the row, and an
// OutboxKindRecordSignup event is appended when out is non-nil. The signup
// therefore reaches the audience iff the submission commits.
func (r *Repo) InsertSubmissionWithSignup(ctx context.Context, tenantID, formID string, s Submission, signup SignupIntent, out OutboxAppender) (string, error) {
	if tenantID == "" || formID == "" {
		return "", fmt.Errorf("forms: public submission scope required")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('app.public_form_tenant_id', $1, true)`, tenantID); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('app.public_form_id', $1, true)`, formID); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", err
	}
	// Resolved even when the visitor is not subscribing, so a form aimed at
	// a list its workspace does not own is refused the same way for every
	// visitor; only a subscribing submission records the lists it joins.
	targets, err := resolveTargetListsInTx(ctx, tx, tenantID, signup.EngineListIDs)
	if err != nil {
		return "", err
	}
	s.TargetListIDs = make([]string, 0, len(targets))
	for _, target := range targets {
		if signup.Subscribe {
			s.TargetListIDs = append(s.TargetListIDs, target.ListID)
		}
	}

	cfBytes, _ := json.Marshal(s.CustomFields)
	var ip any = nil
	if s.IP != nil && *s.IP != "" {
		ip = *s.IP
	}
	var ua any = nil
	if s.UserAgent != nil && *s.UserAgent != "" {
		ua = *s.UserAgent
	}

	// X3 metadata bag: UTMs etc. Empty marshals to "{}" which matches
	// the column default — we always pass it so the SQL is uniform.
	mdBytes, _ := json.Marshal(s.Metadata)
	if len(mdBytes) == 0 || string(mdBytes) == "null" {
		mdBytes = []byte("{}")
	}

	// A pending submission's confirmation email is queued in this
	// transaction, so it is sent, retried or dead-lettered by the outbox and
	// never lost with the request.
	queueConfirmation := s.Status == SubmissionPending && out != nil
	row := tx.QueryRow(ctx, `
	INSERT INTO form_submissions (form_id, tenant_id, email, custom_fields, confirmation_token, status, ip, user_agent, metadata,
	                              confirmation_expires_at, name, signup_source, target_list_ids,
	                              confirmation_email_state, confirmation_email_at)
	VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb,
	        -- Set only when there is a token to expire. A consent-bearing link
	        -- that never ages out is a standing grant; see migration 1867.
	        CASE WHEN NULLIF($5,'') IS NOT NULL THEN now() + interval '30 days' END,
	        NULLIF(btrim($10), ''), NULLIF($11, ''), $12::uuid[],
	        CASE WHEN $13::boolean THEN 'queued' END, CASE WHEN $13::boolean THEN now() END)
	RETURNING id::text`,
		formID, tenantID, s.Email, cfBytes, nullableStr(s.ConfirmationToken), s.Status, ip, ua, string(mdBytes),
		s.Name, s.SignupSource, s.TargetListIDs, queueConfirmation)
	var id string
	if err := row.Scan(&id); err != nil {
		return "", err
	}
	if err := insertSubmissionConsent(ctx, tx, tenantID, formID, id, s); err != nil {
		return "", err
	}
	if out != nil {
		if _, err := out.Append(ctx, tx, OutboxAppendInput{
			TenantID: tenantID,
			Kind:     OutboxKindRecordSignup,
			Payload: signupRecordPayload{
				TenantID:     tenantID,
				FormID:       formID,
				SubmissionID: id,
				Subscribe:    signup.Subscribe,
				Consent:      signup.Consent,
			},
		}); err != nil {
			return "", fmt.Errorf("forms: append signup record: %w", err)
		}
	}
	if queueConfirmation {
		if err := appendConfirmationSend(ctx, tx, out, tenantID, formID, id); err != nil {
			return "", err
		}
	}
	return id, tx.Commit(ctx)
}

func insertSubmissionConsent(ctx context.Context, tx pgx.Tx, tenantID, formID, submissionID string, s Submission) error {
	action, ok := consentAction(s.Consent)
	if !ok {
		return nil
	}
	prefs := map[string]any{
		"form_id":       formID,
		"submission_id": submissionID,
		"consent_value": strings.TrimSpace(s.Consent),
		"status":        string(s.Status),
	}
	if len(s.Metadata) > 0 {
		prefs["metadata"] = s.Metadata
	}
	prefsBytes, err := json.Marshal(prefs)
	if err != nil {
		return fmt.Errorf("forms: marshal consent prefs: %w", err)
	}
	var ip any
	if s.IP != nil && *s.IP != "" {
		ip = *s.IP
	}
	var ua any
	if s.UserAgent != nil && *s.UserAgent != "" {
		ua = *s.UserAgent
	}
	// The evidence the handler wrote down names the form and the checkbox the
	// visitor ticked. Only a direct Repo caller that skipped that evaluation
	// falls back to naming the form's id.
	proof := strings.TrimSpace(s.ConsentEvidence)
	if proof == "" {
		proof = "Public form consent captured for form " + formID
	}
	_, err = tx.Exec(ctx, `
INSERT INTO consent_events
    (tenant_id, subject_type, subject_id, subject_email, channel, category, action,
     source, policy_version, preferences, proof_text, ip, user_agent)
VALUES
    ($1::uuid, 'subscriber', $2, $3, 'web', 'email_marketing', $4,
     'public_form', 'v1', $5::jsonb, $6, $7, $8)`,
		tenantID, submissionID, s.Email, action, string(prefsBytes),
		proof, ip, ua)
	if err != nil {
		return fmt.Errorf("forms: insert consent event: %w", err)
	}
	return nil
}

func consentAction(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return "", false
	case "1", "true", "yes", "y", "on", "checked", "granted", "accept", "accepted", "agree", "agreed":
		return "granted", true
	case "0", "false", "no", "n", "off", "unchecked", "denied", "declined", "reject", "rejected":
		return "denied", true
	default:
		// An arbitrary checkbox value is not evidence of affirmative consent.
		// The public handler rejects it before any subscriber or submission write;
		// this defensive result also prevents direct Repo callers from forging a
		// grant if they bypass that HTTP boundary.
		return "", false
	}
}

// ConfirmByToken flips the submission identified by `token` from pending ->
// confirmed and returns the (tenant_id, form_id, email) for downstream
// Listmonk wiring. Idempotent: a second call returns ErrAlreadyConfirmed.
func (r *Repo) ConfirmByToken(ctx context.Context, token string) (tenantID, formID, email string, err error) {
	return r.ConfirmByTokenWithOutbox(ctx, token, nil)
}

// OutboxAppender is the narrow interface the form-confirm path uses to
// enqueue an outbox event in the SAME transaction as the confirm flip.
// Implemented by *outbox.Repo; defining it locally keeps the forms
// package independent of outbox at the type level.
type OutboxAppender interface {
	Append(ctx context.Context, tx pgx.Tx, in OutboxAppendInput) (string, error)
}

// OutboxAppendInput mirrors outbox.Append. Re-declared locally so this
// package doesn't import outbox; main.go bridges via a thin adapter.
type OutboxAppendInput struct {
	TenantID    string
	Kind        string
	Payload     any
	MaxAttempts int
}

// ConfirmByTokenWithOutbox is ConfirmByToken plus a transactional-outbox
// append: when out is non-nil and the confirm UPDATE hits a row, an
// outbox event is inserted in the SAME tx so the side effect (enabling
// the Listmonk subscriber) is durable iff the confirm commits.
//
// This is the fix for the audit's "DOI confirm never enables Listmonk
// subscriber" finding. Without an outbox, the previous handler said
// "confirmed" while leaving the Listmonk subscriber disabled forever.
func (r *Repo) ConfirmByTokenWithOutbox(
	ctx context.Context,
	token string,
	out OutboxAppender,
) (tenantID, formID, email string, err error) {
	if token == "" {
		return "", "", "", ErrNotFound
	}
	tx, err2 := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err2 != nil {
		return "", "", "", err2
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_confirmation_token', $1, true)`, token); err != nil {
		return "", "", "", err
	}

	var submissionID string
	var confirmedAt time.Time
	row := tx.QueryRow(ctx, `
UPDATE form_submissions
   SET status='confirmed', confirmed_at=now()
 WHERE confirmation_token = $1 AND status = 'pending'
   AND (confirmation_expires_at IS NULL OR confirmation_expires_at > now())
RETURNING tenant_id::text, form_id::text, email, id::text, confirmed_at`, token)
	if err := row.Scan(&tenantID, &formID, &email, &submissionID, &confirmedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Either no such token (missing) or it was already confirmed.
			// Distinguish by re-reading.
			row2 := tx.QueryRow(ctx, `SELECT status::text FROM form_submissions WHERE confirmation_token = $1`, token)
			var status string
			if err2 := row2.Scan(&status); err2 != nil {
				return "", "", "", ErrNotFound
			}
			if status == "confirmed" {
				return "", "", "", ErrAlreadyConfirmed
			}
			// Still pending, so the UPDATE was blocked by the expiry predicate.
			// Reported distinctly because the two need different pages: a missing
			// token is a broken or tampered link, while an expired one is a real
			// submission the person can simply repeat — and "invalid link" for
			// that is both wrong and a dead end.
			// Gated on `pending`. The re-read above only special-cases
			// `confirmed`, so an UNSUBSCRIBED row previously fell through to this
			// probe and was reported as expired — telling someone who opted out to
			// "sign up again", and re-subscribing them if they did.
			var expired bool
			if err3 := tx.QueryRow(ctx, `
SELECT status = 'pending'
       AND confirmation_expires_at IS NOT NULL
       AND confirmation_expires_at <= now()
  FROM form_submissions WHERE confirmation_token = $1`, token).Scan(&expired); err3 == nil && expired {
				return "", "", "", ErrConfirmationExpired
			}
			return "", "", "", ErrNotFound
		}
		return "", "", "", err
	}

	if out != nil {
		// The outbox row needs app.tenant_id matching its tenant_id (RLS
		// WITH CHECK). We bind the GUC inside this same tx; the previous
		// app.public_confirmation_token GUC is unchanged.
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
			return "", "", "", err
		}
		// The payload names the submission, not the address: the handler
		// reloads it, so a confirmation erased before it runs takes its
		// personal data with it.
		if _, err := out.Append(ctx, tx, OutboxAppendInput{
			TenantID: tenantID,
			Kind:     OutboxKindEnableListmonk,
			Payload: confirmPayload{
				TenantID:     tenantID,
				FormID:       formID,
				SubmissionID: submissionID,
			},
		}); err != nil {
			return "", "", "", err
		}
		// Webhook fanout: tenants who registered for form.confirmed get
		// pinged when DOI completes. We piggyback on the same outbox tx
		// so the fan-out either commits with the confirmation or doesn't
		// happen at all — no orphaned webhook for an unconfirmed row.
		if _, err := out.Append(ctx, tx, OutboxAppendInput{
			TenantID: tenantID,
			Kind:     OutboxKindWebhookFanout,
			Payload: map[string]any{
				"event_type": "form.confirmed",
				"body": map[string]any{
					"tenant_id":     tenantID,
					"form_id":       formID,
					"submission_id": submissionID,
					"email":         email,
					"confirmed_at":  confirmedAt.UTC(),
				},
			},
		}); err != nil {
			return "", "", "", err
		}
	}

	return tenantID, formID, email, tx.Commit(ctx)
}

// OutboxKindEnableListmonk is the outbox event appended when a double opt-in
// is confirmed. Its handler (SignupAudience.RecordConfirmed) enables the
// subscriber with double opt-in consent, joins the lists the visitor signed
// up to, and projects both into Listmonk. The kind keeps its historical name
// so events already queued when it grew beyond Listmonk still drain.
// Registered in the composition root.
const OutboxKindEnableListmonk = "forms.confirm.enable_listmonk"

// OutboxKindWebhookFanout mirrors webhooks.FanoutKind. Re-declared here
// (with the same value) so this package doesn't have to import the
// webhooks package — they only share an outbox-row contract, not a
// type. If webhooks.FanoutKind ever changes, the outbox MustHave guard
// in main.go is the safety net that catches a drift.
const OutboxKindWebhookFanout = "webhook.fanout"

// ErrAlreadyConfirmed is returned by ConfirmByToken when the token was
// already redeemed.
var ErrAlreadyConfirmed = errors.New("forms: already confirmed")

// ErrConfirmationExpired is returned when the token exists and is still pending
// but its window has passed.
//
// Distinct from "no such token" on purpose: the two need different pages. A
// missing token is a broken or tampered link; an expired one is a real
// submission the person can simply repeat, and telling them "invalid link" for
// that is both wrong and a dead end. `preference_tokens` already draws this
// distinction and even renders a dedicated expired page.
var ErrConfirmationExpired = errors.New("forms: confirmation link expired")

// RefreshConfirmationWindow re-opens the confirmation window for a pending
// submission.
//
// An operator clicking "resend confirmation" is a fresh, deliberate act, so the
// re-sent link gets a full window. Without this the resend mailed the SAME
// token with its original expiry: on a 40-day-old pending submission the
// operator saw `{"ok":true,"resent_to":…}`, the recipient clicked, and the link
// was already dead. That is the only remedy the product offers besides
// re-submitting the form, so it silently failing is the worse half of the bug.
//
// Scoped to `pending` so a resend cannot revive a confirmed or unsubscribed row.
func (r *Repo) RefreshConfirmationWindow(ctx context.Context, tenantID, submissionID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE form_submissions
   SET confirmation_expires_at = now() + interval '30 days'
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'`,
		tenantID, submissionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---- helpers ----

func scanForm(ctx context.Context, tx pgx.Tx, where string, args ...any) (*Form, error) {
	// X3: also read the new `steps` jsonb column. COALESCE so older rows
	// without an explicit value (impossible due to DEFAULT '[]', but
	// defensive) round-trip as an empty list rather than NULL.
	q := `SELECT id::text, tenant_id::text, slug, name, opt_in_mode, structure, settings,
              COALESCE(steps, '[]'::jsonb), status, created_at, updated_at
            FROM forms WHERE ` + where + ` LIMIT 1`
	row := tx.QueryRow(ctx, q, args...)
	var (
		f          Form
		structRaw  []byte
		settingRaw []byte
		stepsRaw   []byte
	)
	if err := row.Scan(&f.ID, &f.TenantID, &f.Slug, &f.Name, &f.OptInMode,
		&structRaw, &settingRaw, &stepsRaw, &f.Status, &f.CreatedAt, &f.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	_ = json.Unmarshal(structRaw, &f.Structure)
	_ = json.Unmarshal(settingRaw, &f.Settings)
	if len(stepsRaw) > 0 {
		_ = json.Unmarshal(stepsRaw, &f.Steps)
	}
	if f.Steps == nil {
		f.Steps = []FormStep{}
	}
	f.StepCount = len(f.Steps)
	return &f, nil
}

func isUniqueViolation(err error) bool {
	// pgx wraps the underlying *pgconn.PgError. We match by SQLSTATE 23505.
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}

func isUniqueConstraintViolation(err error, constraint string) bool {
	var pgerr *pgconn.PgError
	return errors.As(err, &pgerr) &&
		pgerr.Code == "23505" &&
		pgerr.ConstraintName == constraint
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
