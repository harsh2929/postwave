// SPDX-License-Identifier: AGPL-3.0-only
//
// Package contentreports implements notice and action for hosted and displayed
// content: DSA Articles 16, 17 and 18, and the in-app reporting affordances
// Apple Guideline 1.2 and Google Play's UGC and generative-AI policies require.
//
// ONE MECHANISM, FOUR REGIMES. The 2026-09 compliance audit found the same hole
// in five obligations: Moosewave hosts publicly reachable customer content
// (signup forms, landing pages, the campaign archive, archive comments) and
// renders third-party content in its clients (inbound replies, helpdesk
// threads, model output), and no person — member of the public or signed-in
// user — had any way to report any of it. The DSA rows are legal exposure; the
// store rows gate distribution outright. Building two mechanisms would have
// produced two moderation queues and a race to see which one an operator
// forgot, so both channels write the same row and drain through the same queue.
//
// THE TWO CHANNELS.
//
//	Public   POST /api/public/content-reports — anonymous, no session, no API
//	         key. This is the Art. 16 mechanism and it must be usable by someone
//	         who has never heard of Moosewave.
//	In-app   POST /api/v1/content-reports — a signed-in user reporting content
//	         they are looking at. Tenant-scoped, ordinary RLS.
//
// WHAT THIS PACKAGE DELIBERATELY DOES NOT DO. It does not decide whether
// reported content is illegal, and it does not act on the content. A takedown
// is a human decision recorded through Decide, which produces the Art. 17
// statement of reasons. An automated triage that removed content would have to
// disclose itself under Art. 17(3)(c) and would need an accuracy claim nobody
// here can substantiate, so the machine's whole job is to receive the notice,
// start the clock and refuse to lose it.
package contentreports

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Errors the handlers map to status codes. Named rather than inlined so the
// intake path and its tests agree on what a rejection means.
var (
	ErrNotFound            = errors.New("contentreports: no such report")
	ErrExplanationTooShort = errors.New("contentreports: explanation must substantiate the report")
	ErrNotifierRequired    = errors.New("contentreports: a public notice requires the notifier's email")
	ErrGoodFaithRequired   = errors.New("contentreports: a public notice requires the good-faith declaration")
	ErrInvalidSubjectURL   = errors.New("contentreports: subject_url must be an absolute http(s) URL")
	ErrInvalidCategory     = errors.New("contentreports: unknown reason_category")
	ErrInvalidSubjectKind  = errors.New("contentreports: unknown subject_kind")
	ErrAlreadyDecided      = errors.New("contentreports: this report already has a statement of reasons")
)

// Explanation bounds mirror the CHECK constraints in migration 2041. Duplicated
// deliberately: the database is the guarantee, this is the error message.
const (
	minExplanationRunes = 20
	maxExplanationRunes = 10000
	maxSubjectURLBytes  = 2048
)

// reasonCategories are the Art. 16(2)(a) grounds a notifier can select.
//
// csam_or_child_safety is not a convenience label. Art. 16(2)(c) excuses the
// notifier's name and email specifically for offences under Articles 3-7 of
// Directive 2011/93/EU, so the category is what tells the intake path to stop
// requiring identity — see requireNotifierIdentity.
var reasonCategories = map[string]bool{
	"illegal_content":       true,
	"intellectual_property": true,
	"privacy_violation":     true,
	"harassment_or_hate":    true,
	"csam_or_child_safety":  true,
	"fraud_or_scam":         true,
	"spam_or_unsolicited":   true,
	"ai_output_harmful":     true,
	"other":                 true,
}

var subjectKinds = map[string]bool{
	"hosted_form":     true,
	"landing_page":    true,
	"archive_post":    true,
	"archive_comment": true,
	"inbound_message": true,
	"ai_output":       true,
	"other":           true,
}

// Origins.
const (
	OriginPublicNotice = "public_notice"
	OriginInAppUGC     = "in_app_ugc"
	OriginInAppAI      = "in_app_ai_output"
)

// Report is one notice.
type Report struct {
	ID                string    `json:"id"`
	Reference         string    `json:"reference"`
	TenantID          string    `json:"tenant_id,omitempty"`
	Origin            string    `json:"origin"`
	SubjectKind       string    `json:"subject_kind"`
	SubjectURL        string    `json:"subject_url"`
	SubjectRef        string    `json:"subject_ref,omitempty"`
	ReasonCategory    string    `json:"reason_category"`
	Explanation       string    `json:"explanation"`
	NotifierName      string    `json:"notifier_name,omitempty"`
	NotifierEmail     string    `json:"notifier_email,omitempty"`
	Status            string    `json:"status"`
	ActualKnowledgeAt time.Time `json:"actual_knowledge_at"`
	CreatedAt         time.Time `json:"created_at"`
	Decision          *Decision `json:"decision,omitempty"`
}

// Decision is the Art. 17 statement of reasons.
type Decision struct {
	Action              string     `json:"action"`
	Ground              string     `json:"ground"`
	Reasoning           string     `json:"reasoning"`
	AutomatedMeansUsed  bool       `json:"automated_means_used"`
	DecidedAt           time.Time  `json:"decided_at"`
	RecipientNotifiedAt *time.Time `json:"recipient_notified_at,omitempty"`
	NotifierNotifiedAt  *time.Time `json:"notifier_notified_at,omitempty"`
}

// PublicNotice is the validated Art. 16 submission.
type PublicNotice struct {
	SubjectKind       string
	SubjectURL        string
	ReasonCategory    string
	Explanation       string
	NotifierName      string
	NotifierEmail     string
	GoodFaithDeclared bool
}

// Receipt is what the notifier gets back. Art. 16(4) requires a confirmation of
// receipt without undue delay; the reference is what makes the later Art. 16(5)
// notification reachable for someone with no account.
type Receipt struct {
	Reference         string    `json:"reference"`
	ActualKnowledgeAt time.Time `json:"received_at"`
}

// TenantResolver maps a reported URL to the tenant that owns it, if any.
//
// An interface rather than a concrete lookup because the mapping is a property
// of the hosting layout (custom domains, archive slugs, form slugs) and will
// change independently of the notice mechanism. Returning ("", nil) is the
// normal case for a URL we do not recognise, and it is NOT an error: an
// unattributed notice is still a notice, still starts the clock, and still has
// to be triaged by a human.
type TenantResolver interface {
	TenantForURL(ctx context.Context, rawURL string) (string, error)
}

type Repo struct {
	Pool     *pgxpool.Pool
	Resolver TenantResolver
	Logger   *slog.Logger
}

// referenceAlphabet is Crockford base32 minus I, L, O and U: a receipt gets
// read back over the phone and typed into a form, and 0/O and 1/I/L are where
// that goes wrong. U is dropped so a random string cannot spell an obscenity.
const referenceAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newReference mints a receipt. 10 characters of a 32-symbol alphabet is 50
// bits, which is not a secret but is far too sparse to enumerate — and the
// status lookup returns nothing but the caller's own outcome even if guessed.
func newReference() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, len(buf))
	for i, b := range buf {
		out[i] = referenceAlphabet[int(b)%len(referenceAlphabet)]
	}
	return "PWR-" + string(out), nil
}

// requireNotifierIdentity reports whether Art. 16(2)(c) requires the notifier's
// name and email for this category.
//
// The exception is narrow and it matters: a person reporting child sexual abuse
// material must not be forced to identify themselves, and a validation rule
// that demanded an email would turn the mechanism into a reason not to report.
func requireNotifierIdentity(reasonCategory string) bool {
	return reasonCategory != "csam_or_child_safety"
}

// ValidatePublicNotice applies the Art. 16(2) elements.
//
// Separated from the handler so the rules are testable without HTTP and so the
// same validation covers any future intake (an email-to-notice bridge, an ops
// console form) rather than being re-implemented next to it.
func ValidatePublicNotice(n *PublicNotice) error {
	n.SubjectKind = strings.TrimSpace(n.SubjectKind)
	n.SubjectURL = strings.TrimSpace(n.SubjectURL)
	n.ReasonCategory = strings.TrimSpace(n.ReasonCategory)
	n.Explanation = strings.TrimSpace(n.Explanation)
	n.NotifierName = strings.TrimSpace(n.NotifierName)
	n.NotifierEmail = strings.TrimSpace(n.NotifierEmail)

	if !subjectKinds[n.SubjectKind] {
		return ErrInvalidSubjectKind
	}
	if !reasonCategories[n.ReasonCategory] {
		return ErrInvalidCategory
	}
	if err := validateSubjectURL(n.SubjectURL); err != nil {
		return err
	}
	if c := len([]rune(n.Explanation)); c < minExplanationRunes || c > maxExplanationRunes {
		return ErrExplanationTooShort
	}
	if !n.GoodFaithDeclared {
		return ErrGoodFaithRequired
	}
	if requireNotifierIdentity(n.ReasonCategory) {
		if n.NotifierEmail == "" {
			return ErrNotifierRequired
		}
		if _, err := mail.ParseAddress(n.NotifierEmail); err != nil {
			return ErrNotifierRequired
		}
	}
	return nil
}

// validateSubjectURL enforces Art. 16(2)(b): an exact electronic location.
//
// Absolute http(s) only. A relative path or a javascript: URL is not a location
// anyone can navigate to, and accepting one would put an unvalidated string in
// front of an operator who is about to click it.
func validateSubjectURL(raw string) error {
	if raw == "" || len(raw) > maxSubjectURLBytes {
		return ErrInvalidSubjectURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ErrInvalidSubjectURL
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ErrInvalidSubjectURL
	}
	if u.Host == "" {
		return ErrInvalidSubjectURL
	}
	return nil
}

// RecordPublicNotice stores an Art. 16 notice and returns the receipt.
//
// Goes through the SECURITY DEFINER function in migration 2041 because the
// caller is anonymous: there is no app.tenant_id for an RLS policy to compare
// against, and the notice may concern content we cannot attribute at all. The
// function accepts only origin='public_notice' and returns only the receipt, so
// the widened privilege buys exactly one INSERT and no reads.
func (r *Repo) RecordPublicNotice(ctx context.Context, n PublicNotice) (Receipt, error) {
	if err := ValidatePublicNotice(&n); err != nil {
		return Receipt{}, err
	}
	reference, err := newReference()
	if err != nil {
		return Receipt{}, err
	}

	// Attribution is best-effort and must never fail the intake. A notice we
	// cannot route is still a notice we have received, and losing it because a
	// slug lookup errored would be the worst possible failure mode for this
	// endpoint.
	var tenantID *string
	if r.Resolver != nil {
		if id, rerr := r.Resolver.TenantForURL(ctx, n.SubjectURL); rerr != nil {
			if r.Logger != nil {
				r.Logger.WarnContext(ctx, "content report tenant attribution failed",
					slog.String("reference", reference), slog.Any("error", rerr))
			}
		} else if strings.TrimSpace(id) != "" {
			trimmed := strings.TrimSpace(id)
			tenantID = &trimmed
		}
	}

	var receipt Receipt
	err = r.Pool.QueryRow(ctx, `
		SELECT reference, actual_knowledge_at
		  FROM public.record_public_content_report(
		           $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
		reference, tenantID, n.SubjectKind, n.SubjectURL, n.ReasonCategory,
		n.Explanation, nullIfEmpty(n.NotifierName), nullIfEmpty(n.NotifierEmail),
		n.GoodFaithDeclared,
	).Scan(&receipt.Reference, &receipt.ActualKnowledgeAt)
	if err != nil {
		return Receipt{}, fmt.Errorf("record public content report: %w", err)
	}
	return receipt, nil
}

// PublicStatus is the Art. 16(5) outcome a notifier can read back with nothing
// but their receipt.
type PublicStatus struct {
	Reference          string     `json:"reference"`
	Status             string     `json:"status"`
	ReceivedAt         time.Time  `json:"received_at"`
	DecisionAction     string     `json:"decision_action,omitempty"`
	DecisionReasoning  string     `json:"decision_reasoning,omitempty"`
	DecidedAt          *time.Time `json:"decided_at,omitempty"`
	AutomatedMeansUsed *bool      `json:"automated_means_used,omitempty"`
}

// LookupPublicStatus returns the outcome for one receipt.
//
// Deliberately narrow: no tenant, no subject URL, no notifier identity. A
// receipt reference travels in email and gets forwarded, and the person holding
// it is entitled to their own outcome and nothing else.
func (r *Repo) LookupPublicStatus(ctx context.Context, reference string) (PublicStatus, error) {
	out := PublicStatus{Reference: strings.TrimSpace(reference)}
	var (
		action    *string
		reasoning *string
		decidedAt *time.Time
		automated *bool
	)
	err := r.Pool.QueryRow(ctx, `
		SELECT status, actual_knowledge_at, decision_action, decision_reasoning,
		       decided_at, automated_means_used
		  FROM public.public_content_report_status($1)`, out.Reference,
	).Scan(&out.Status, &out.ReceivedAt, &action, &reasoning, &decidedAt, &automated)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PublicStatus{}, ErrNotFound
		}
		return PublicStatus{}, err
	}
	if action != nil {
		out.DecisionAction = *action
	}
	if reasoning != nil {
		out.DecisionReasoning = *reasoning
	}
	out.DecidedAt = decidedAt
	out.AutomatedMeansUsed = automated
	return out, nil
}

// InAppReport is a signed-in user reporting content in front of them.
type InAppReport struct {
	Origin         string
	SubjectKind    string
	SubjectURL     string
	SubjectRef     string
	ReasonCategory string
	Explanation    string
	ReportedByUser string
}

// RecordInAppReport stores a report from an authenticated user.
//
// Ordinary tenant-scoped INSERT: the reporter has a session, so RLS does the
// fencing and no definer function is needed. The Art. 16(2) identity and
// good-faith elements do not apply — those exist so an anonymous notice can be
// trusted, and a signed-in user is already identified — but the substantiation
// requirement does, because an unexplained report is not actionable by anyone.
func (r *Repo) RecordInAppReport(ctx context.Context, tenantID string, in InAppReport) (Receipt, error) {
	in.SubjectKind = strings.TrimSpace(in.SubjectKind)
	in.ReasonCategory = strings.TrimSpace(in.ReasonCategory)
	in.Explanation = strings.TrimSpace(in.Explanation)
	if in.Origin != OriginInAppUGC && in.Origin != OriginInAppAI {
		return Receipt{}, fmt.Errorf("contentreports: in-app origin must be %q or %q", OriginInAppUGC, OriginInAppAI)
	}
	if !subjectKinds[in.SubjectKind] {
		return Receipt{}, ErrInvalidSubjectKind
	}
	if !reasonCategories[in.ReasonCategory] {
		return Receipt{}, ErrInvalidCategory
	}
	if c := len([]rune(in.Explanation)); c < minExplanationRunes || c > maxExplanationRunes {
		return Receipt{}, ErrExplanationTooShort
	}
	// An in-app report names a row rather than a public URL, so the URL is
	// optional here — but when one is supplied it must still be navigable.
	if in.SubjectURL != "" {
		if err := validateSubjectURL(in.SubjectURL); err != nil {
			return Receipt{}, err
		}
	} else {
		in.SubjectURL = "app://" + in.SubjectKind + "/" + strings.TrimSpace(in.SubjectRef)
	}

	reference, err := newReference()
	if err != nil {
		return Receipt{}, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Receipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var receipt Receipt
	err = tx.QueryRow(ctx, `
		INSERT INTO content_reports (
			reference, tenant_id, origin, subject_kind, subject_url, subject_ref,
			reason_category, explanation, good_faith_declared, reported_by_user_id
		) VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7, $8, true, NULLIF($9, '')::uuid)
		RETURNING reference, actual_knowledge_at`,
		reference, tenantID, in.Origin, in.SubjectKind, in.SubjectURL, in.SubjectRef,
		in.ReasonCategory, in.Explanation, in.ReportedByUser,
	).Scan(&receipt.Reference, &receipt.ActualKnowledgeAt)
	if err != nil {
		return Receipt{}, err
	}
	return receipt, tx.Commit(ctx)
}

// DecisionInput is an operator's Art. 17 statement of reasons.
type DecisionInput struct {
	Action             string
	Ground             string
	Reasoning          string
	AutomatedMeansUsed bool
	DecidedByUser      string
}

var decisionActions = map[string]string{
	"content_removed":       "action_taken",
	"content_disabled":      "action_taken",
	"visibility_restricted": "action_taken",
	"account_suspended":     "action_taken",
	"account_terminated":    "action_taken",
	"no_action":             "no_action",
}

// Decide records the statement of reasons and moves the report to its terminal
// status.
//
// The report's status is DERIVED from the action rather than supplied
// separately: a caller that could set "no_action" alongside "content_removed"
// would eventually do so, and the queue would then disagree with the statement
// the recipient received.
func (r *Repo) Decide(ctx context.Context, tenantID, reportID string, in DecisionInput) (Decision, error) {
	in.Reasoning = strings.TrimSpace(in.Reasoning)
	status, ok := decisionActions[strings.TrimSpace(in.Action)]
	if !ok {
		return Decision{}, fmt.Errorf("contentreports: unknown action %q", in.Action)
	}
	if in.Ground != "illegal_content" && in.Ground != "terms_violation" {
		return Decision{}, fmt.Errorf("contentreports: ground must be illegal_content or terms_violation")
	}
	if c := len([]rune(in.Reasoning)); c < minExplanationRunes || c > maxExplanationRunes {
		return Decision{}, ErrExplanationTooShort
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Decision{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out Decision
	err = tx.QueryRow(ctx, `
		INSERT INTO content_report_decisions (
			report_id, tenant_id, action, ground, reasoning,
			automated_means_used, decided_by_user_id
		) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7, '')::uuid)
		RETURNING action, ground, reasoning, automated_means_used, decided_at`,
		reportID, tenantID, in.Action, in.Ground, in.Reasoning,
		in.AutomatedMeansUsed, in.DecidedByUser,
	).Scan(&out.Action, &out.Ground, &out.Reasoning, &out.AutomatedMeansUsed, &out.DecidedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return Decision{}, ErrAlreadyDecided
		}
		return Decision{}, err
	}

	tag, err := tx.Exec(ctx, `
		UPDATE content_reports
		   SET status = $3, updated_at = statement_timestamp()
		 WHERE id = $1::uuid AND tenant_id = $2::uuid`, reportID, tenantID, status)
	if err != nil {
		return Decision{}, err
	}
	if tag.RowsAffected() == 0 {
		return Decision{}, ErrNotFound
	}
	return out, tx.Commit(ctx)
}

// List returns the tenant's reports, newest knowledge first.
func (r *Repo) List(ctx context.Context, tenantID, status string, limit int) ([]Report, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT r.id::text, r.reference, COALESCE(r.tenant_id::text, ''), r.origin,
		       r.subject_kind, r.subject_url, COALESCE(r.subject_ref, ''),
		       r.reason_category, r.explanation, COALESCE(r.notifier_name, ''),
		       COALESCE(r.notifier_email, ''), r.status, r.actual_knowledge_at,
		       r.created_at,
		       d.action, d.ground, d.reasoning, d.automated_means_used, d.decided_at
		  FROM content_reports r
		  LEFT JOIN content_report_decisions d ON d.report_id = r.id
		 WHERE ($1 = '' OR r.status = $1)
		 ORDER BY r.actual_knowledge_at DESC
		 LIMIT $2`, strings.TrimSpace(status), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Report{}
	for rows.Next() {
		var rep Report
		var action, ground, reasoning *string
		var automated *bool
		var decidedAt *time.Time
		if err := rows.Scan(
			&rep.ID, &rep.Reference, &rep.TenantID, &rep.Origin,
			&rep.SubjectKind, &rep.SubjectURL, &rep.SubjectRef,
			&rep.ReasonCategory, &rep.Explanation, &rep.NotifierName,
			&rep.NotifierEmail, &rep.Status, &rep.ActualKnowledgeAt, &rep.CreatedAt,
			&action, &ground, &reasoning, &automated, &decidedAt,
		); err != nil {
			return nil, err
		}
		if action != nil && decidedAt != nil {
			rep.Decision = &Decision{
				Action:             *action,
				Ground:             deref(ground),
				Reasoning:          deref(reasoning),
				AutomatedMeansUsed: automated != nil && *automated,
				DecidedAt:          *decidedAt,
			}
		}
		out = append(out, rep)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func nullIfEmpty(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(s)
	return &trimmed
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "SQLSTATE 23505")
}
