package affiliates

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Deps bundles handler dependencies so main.go can wire everything in one
// struct literal — same shape as forms.Deps.
type Deps struct {
	// Logger is used by httperror.WriteInternal to log unexpected
	// failures with tenant_id + request_id + err context. nil is safe
	// (no logging) but production should always wire this.
	Logger       *slog.Logger
	Repo         *Repo
	CookieConfig CookieConfig
	// MarketingHomeURL is the fallback redirect for /track when no `landing`
	// query param is supplied.
	MarketingHomeURL string
	// AdminNotifyEmail is logged on new signups so we can send a real
	// notification email. Empty disables.
	AdminNotifyEmail string
	// AdminNotifier sends the signup-review email. It is best-effort and
	// never blocks or fails public signup.
	AdminNotifier AffiliateSignupNotifier
	// AllowDevAdminRoleHeader enables the X-Postwave-Role fallback. It is
	// intended for local development only and must default closed.
	AllowDevAdminRoleHeader bool
	// StripeWebhookSecret signs legacy internal affiliate webhook traffic. The
	// main billing webhook is preferred; this path stays closed when unset.
	StripeWebhookSecret string
	// StripeConnect, when non-nil, fires a Transfer to the affiliate's
	// connected account whenever AdminCreatePayout creates a payout
	// with PayoutMethod=stripe_connect. Nil disables (payout rows
	// remain in 'pending' for manual reconciliation).
	StripeConnect *StripeConnectClient
}

// AffiliateSignupNotifier is the narrow notification hook main.go adapts to
// SES/dev mailer. Keeping it here avoids coupling this package to mailer.
type AffiliateSignupNotifier interface {
	NotifyAffiliateSignup(ctx context.Context, in AffiliateSignupNotice) error
}

// AffiliateSignupNotice is the rendered data needed for an admin review mail.
type AffiliateSignupNotice struct {
	To           string
	AffiliateID  string
	Slug         string
	Email        string
	Name         string
	Country      string
	Website      string
	AudienceSize int
	AudienceDesc string
	Status       Status
}

const affiliateJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// ---------- ADMIN routes (require role check) ----------

// requireAdmin accepts native-auth users with role 'owner'/'admin'. The
// X-Postwave-Role fallback is local-dev-only and requires an explicit flag.
func requireAdmin(allowDevAdminRoleHeader bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role := ""
			if u, ok := middleware.UserFromContext(r.Context()); ok {
				role = strings.ToLower(u.Role)
			}
			if role == "" && allowDevAdminRoleHeader {
				role = strings.ToLower(r.Header.Get("X-Postwave-Role"))
			}
			if role != "owner" && role != "admin" {
				writeAffiliatesRoleDenial(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// MountAdminRoutes registers the admin sub-tree under /api/v1/admin/affiliates.
func (d *Deps) MountAdminRoutes(r chi.Router) {
	if !OperationallyAvailable() {
		return
	}
	r.Route("/api/v1/admin/affiliates", func(r chi.Router) {
		r.Use(requireAdmin(d.AllowDevAdminRoleHeader))
		r.Get("/", d.AdminList)
		r.Post("/", d.AdminCreate)
		r.Get("/program", d.AdminProgram)
		r.Get("/{id}", d.AdminGet)
		r.Patch("/{id}", d.AdminUpdate)
		r.Get("/{id}/conversions", d.AdminListConversions)
		r.Patch("/{id}/conversions/{conversionId}", d.AdminUpdateConversionStatus)
		r.Post("/{id}/payouts", d.AdminCreatePayout)
		r.Get("/{id}/payouts", d.AdminListPayouts)
		r.Patch("/{id}/payouts/{payoutId}", d.AdminMarkPayoutSent)
	})
}

func (d *Deps) AdminProgram(w http.ResponseWriter, r *http.Request) {
	page := 1
	if parsed, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && parsed > 0 {
		page = parsed
	}
	perPage := 50
	if parsed, err := strconv.Atoi(r.URL.Query().Get("per_page")); err == nil && parsed > 0 && parsed <= 100 {
		perPage = parsed
	}
	// BILL-030: honour the same status[]/country/sort filters AdminList
	// accepts so the program table can filter/sort, with an accurate total.
	q := r.URL.Query()
	filters := ListFilters{
		Country: q.Get("country"),
		SortBy:  q.Get("sort"),
		Limit:   perPage,
		Offset:  (page - 1) * perPage,
	}
	for _, s := range q["status"] {
		filters.Status = append(filters.Status, Status(s))
	}
	affiliates, err := d.Repo.ListAffiliates(r.Context(), filters)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	total, err := d.Repo.CountAffiliatesFiltered(r.Context(), filters)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	overview, err := d.Repo.AffiliateProgramOverview(r.Context())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	ids := make([]string, 0, len(affiliates))
	for _, affiliate := range affiliates {
		ids = append(ids, affiliate.ID)
	}
	stats, err := d.Repo.StatsForAffiliates(r.Context(), ids)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	programRows := make([]AffiliateProgramRow, 0, len(affiliates))
	for _, affiliate := range affiliates {
		row := stats[affiliate.ID]
		row.Affiliate = affiliate
		programRows = append(programRows, row)
	}
	writeJSON(w, http.StatusOK, AffiliateProgramPage{
		Rows: programRows, Overview: overview, Total: total, Page: page, PerPage: perPage,
	})
}

// MountPublicRoutes registers /api/public/affiliates/{signup,track,pixel.gif}.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	if !OperationallyAvailable() {
		return
	}
	r.Post("/api/public/affiliates/signup", d.PublicSignup)
	r.Get("/api/public/affiliates/track", d.PublicTrack)
	r.Get("/api/public/affiliates/pixel.gif", d.PublicPixel)
}

// AdminList GET /api/v1/admin/affiliates
func (d *Deps) AdminList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := ListFilters{
		Country: q.Get("country"),
		SortBy:  q.Get("sort"),
	}
	for _, s := range q["status"] {
		f.Status = append(f.Status, Status(s))
	}
	if l, err := strconv.Atoi(q.Get("limit")); err == nil {
		f.Limit = l
	}
	if o, err := strconv.Atoi(q.Get("offset")); err == nil {
		f.Offset = o
	}
	rows, err := d.Repo.ListAffiliates(r.Context(), f)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// AdminGet GET /api/v1/admin/affiliates/{id}
func (d *Deps) AdminGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	a, err := d.Repo.GetAffiliateByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "no such affiliate")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	stats30, _ := d.Repo.Stats(r.Context(), id, 30)
	stats90, _ := d.Repo.Stats(r.Context(), id, 90)
	stats365, _ := d.Repo.Stats(r.Context(), id, 365)
	statsLifetime, _ := d.Repo.Stats(r.Context(), id, 0)
	monthly, _ := d.Repo.MonthlyCommission(r.Context(), id, 12)
	writeJSON(w, http.StatusOK, map[string]any{
		"affiliate": a,
		"stats": map[string]any{
			"last30":   stats30,
			"last90":   stats90,
			"last365":  stats365,
			"lifetime": statsLifetime,
		},
		"monthly": monthly,
	})
}

// AdminCreate POST /api/v1/admin/affiliates
func (d *Deps) AdminCreate(w http.ResponseWriter, r *http.Request) {
	var in SignupInput
	if err := decodeLimitedJSON(w, r, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	a, err := d.createFromSignup(r.Context(), in, true /*adminCreated*/)
	if err != nil {
		d.writeSignupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

// AdminUpdate PATCH /api/v1/admin/affiliates/{id}
func (d *Deps) AdminUpdate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := decodeLimitedJSON(w, r, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	a, err := d.Repo.UpdateAffiliate(r.Context(), id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "no such affiliate")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// AdminListConversions GET /api/v1/admin/affiliates/{id}/conversions
func (d *Deps) AdminListConversions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var status []ConversionStatus
	for _, s := range r.URL.Query()["status"] {
		status = append(status, ConversionStatus(s))
	}
	limit := 500
	if parsed, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && parsed > 0 && parsed <= 500 {
		limit = parsed
	}
	offset := 0
	if parsed, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && parsed > 0 {
		offset = parsed
	}
	rows, err := d.Repo.ListConversions(r.Context(), id, status, limit, offset)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// AdminCreatePayout POST /api/v1/admin/affiliates/{id}/payouts
//
// Aggregates all approved+pending conversions into a single payout row,
// flips them to status='paid', returns the new payout.
func (d *Deps) AdminCreatePayout(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	a, err := d.Repo.GetAffiliateByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	p := &AffiliatePayout{
		AffiliateID:  a.ID,
		Currency:     "USD",
		PayoutMethod: a.PayoutMethod,
	}
	// Atomic: payout INSERT + conversions UPDATE commit together.
	// Audit finding H1 — the prior two-step pattern allowed two
	// simultaneous admin clicks to create two payout rows for the
	// same conversion set, leaving the local ledger overstating
	// paid amounts even when Stripe's outbound Idempotency-Key
	// (below) correctly collapsed the transfer to one.
	ids, err := d.Repo.CreatePayoutForOutstanding(r.Context(), p)
	if errors.Is(err, ErrNoPayoutBalance) {
		writeJSONError(w, http.StatusBadRequest, "no_balance", "no approved or pending conversions to pay out")
		return
	}
	if errors.Is(err, ErrPayoutBelowMinimum) {
		writeJSONError(w, http.StatusUnprocessableEntity, "payout_below_minimum", "affiliate payouts require at least $100")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Stripe Connect execution: when configured + the affiliate is on
	// stripe_connect + has a connected account id stored in
	// payout_email (we re-use the column for the acct_... id), fire
	// the Transfer immediately. Failure is logged but does NOT roll
	// back the local payout row — operators can retry via the
	// MarkPayoutSent reconcile path.
	//
	// Idempotency-key derivation: derive from the AFFILIATE id + the
	// sorted conversion-id set (NOT the local payout row id). Two
	// concurrent AdminCreatePayout calls aggregating the same
	// conversions produce the same key, so Stripe collapses both
	// requests into one transfer — preventing double-payment even
	// when MarkConversionPaid races on the local DB side.
	if d.StripeConnect != nil && a.PayoutMethod == PayoutStripeConnect && a.PayoutEmail != "" {
		acctID := strings.TrimSpace(a.PayoutEmail)
		// Sanitize slug to a safe charset for the description string.
		safeSlug := sanitizeSlugForDesc(a.Slug)
		desc := fmt.Sprintf("Moosewave affiliate payout (slug=%s)", safeSlug)
		idempotencyKey := deterministicPayoutIdempotencyKey(a.ID, ids)
		tr, terr := d.StripeConnect.ExecuteTransfer(r.Context(),
			acctID, p.AmountCents, "usd", desc, idempotencyKey)
		if terr != nil {
			slog.Warn("affiliates: stripe connect transfer failed",
				"payout_id", p.ID, "affiliate", a.Slug, "err", terr.Error())
		} else if tr != nil {
			if err := d.Repo.MarkPayoutSent(r.Context(), p.ID, tr.ID); err != nil {
				slog.Warn("affiliates: payout sent but not marked",
					"payout_id", p.ID, "transfer_id", tr.ID, "err", err)
			} else {
				p.Status = PayoutSent
				p.PayoutReference = tr.ID
			}
		}
	}

	writeJSON(w, http.StatusCreated, p)
}

// deterministicPayoutIdempotencyKey returns a stable Stripe
// idempotency key for an (affiliate, conversion-set) pair. Two
// concurrent admin clicks computing the same set get the same key
// so Stripe collapses both requests into one Transfer.
//
// Format: "affpay_<affiliate-suffix>_<sha256-prefix-of-sorted-ids>".
// Stripe accepts up to 255 characters; we cap well below that.
func deterministicPayoutIdempotencyKey(affiliateID string, ids []int64) string {
	sorted := append([]int64(nil), ids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	h := sha256.New()
	h.Write([]byte(affiliateID))
	h.Write([]byte{0})
	for _, id := range sorted {
		var buf [8]byte
		binary.BigEndian.PutUint64(buf[:], uint64(id))
		h.Write(buf[:])
	}
	digest := hex.EncodeToString(h.Sum(nil))[:24]
	// Take a short affiliate suffix so the key remains operator-
	// readable in Stripe's dashboard.
	suffix := affiliateID
	if len(suffix) > 8 {
		suffix = suffix[len(suffix)-8:]
	}
	return "affpay_" + suffix + "_" + digest
}

// sanitizeSlugForDesc strips characters that would break log lines or
// downstream JSON rendering (newlines, tabs, control bytes). Keeps
// alphanumerics + dashes + underscores, the conventional slug set.
func sanitizeSlugForDesc(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s) && i < 64; i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-' || c == '_':
			out = append(out, c)
		}
	}
	return string(out)
}

// AdminListPayouts GET /api/v1/admin/affiliates/{id}/payouts
func (d *Deps) AdminListPayouts(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rows, err := d.Repo.ListPayouts(r.Context(), id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// ---------- PUBLIC routes ----------

// PublicSignup POST /api/public/affiliates/signup
func (d *Deps) PublicSignup(w http.ResponseWriter, r *http.Request) {
	var in SignupInput
	if err := decodeLimitedJSON(w, r, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !in.AgreedToToS {
		writeJSONError(w, http.StatusBadRequest, "tos_required",
			"you must agree to the Affiliate Terms of Service")
		return
	}
	a, err := d.createFromSignup(r.Context(), in, false)
	if err != nil {
		d.writeSignupError(w, r, err)
		return
	}
	d.notifyAffiliateSignup(a)
	writeJSON(w, http.StatusCreated, map[string]any{
		"affiliateId": a.ID,
		"slug":        a.Slug,
		"status":      a.Status,
	})
}

func (d *Deps) notifyAffiliateSignup(a *Affiliate) {
	if d == nil || a == nil || strings.TrimSpace(d.AdminNotifyEmail) == "" {
		return
	}
	notice := AffiliateSignupNotice{
		To:           strings.TrimSpace(d.AdminNotifyEmail),
		AffiliateID:  a.ID,
		Slug:         a.Slug,
		Email:        a.Email,
		Name:         a.Name,
		Country:      a.Country,
		Website:      a.Website,
		AudienceSize: a.AudienceSize,
		AudienceDesc: a.AudienceDesc,
		Status:       a.Status,
	}
	if d.AdminNotifier == nil {
		slog.Info("affiliate signup pending review",
			"affiliate_id", a.ID, "email_redacted", observability.RedactEmail(a.Email),
			"notify", notice.To)
		return
	}
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("affiliate signup notification panic recovered",
					"affiliate_id", notice.AffiliateID,
					"notify", notice.To,
					"panic", fmt.Sprint(rec))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := d.AdminNotifier.NotifyAffiliateSignup(ctx, notice); err != nil {
			slog.Warn("affiliate signup notification failed",
				"affiliate_id", a.ID, "notify", notice.To, "err", err)
		}
	}()
}

// PublicTrack GET /api/public/affiliates/track?ref=<slug>&landing=...
//
// Records the click, sets the cookie, redirects to `landing` (or the
// configured marketing home).
func (d *Deps) PublicTrack(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimSpace(r.URL.Query().Get("ref"))
	if slug == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_ref", "ref is required")
		return
	}
	if _, err := RecordClickFromRequest(r.Context(), d.Repo, d.CookieConfig, w, r, slug); err != nil {
		// Treat all attribution failures as a soft error — still redirect
		// the user; we don't want a tracking outage to break landing pages.
		slog.Warn("affiliate track failed", "slug", slug, "err", err)
	}
	dest := r.URL.Query().Get("landing")
	dest = safeAffiliateLandingURL(dest, d.MarketingHomeURL, r.Host)
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, dest, http.StatusFound)
}

// PublicPixel GET /api/public/affiliates/pixel.gif?ref=<slug>
//
// Email-friendly tracking pixel. Records click, sets cookie, returns a 1x1
// transparent GIF.
func (d *Deps) PublicPixel(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("ref")
	if slug != "" {
		if _, err := RecordClickFromRequest(r.Context(), d.Repo, d.CookieConfig, w, r, slug); err != nil {
			slog.Warn("affiliate pixel failed", "slug", slug, "err", err)
		}
	}
	w.Header().Set("Content-Type", "image/gif")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Length", strconv.Itoa(len(transparentGIF)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(transparentGIF)
}

// transparentGIF is the canonical 1x1 fully-transparent GIF89a (43 bytes).
// Embedded as a constant so we don't ship a binary asset.
var transparentGIF = []byte{
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00,
	0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
	0x44, 0x01, 0x00, 0x3B,
}

// ---------- helpers ----------

var (
	slugAllowed   = regexp.MustCompile(`[^a-z0-9-]+`)
	emailRoughOK  = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	countryFormat = regexp.MustCompile(`^[A-Z]{2}(-[A-Z0-9]{1,3})?$`)
)

// createFromSignup is shared between PublicSignup and AdminCreate. The
// adminCreated flag controls auto-approval (admins typically create
// pre-approved partners).
func (d *Deps) createFromSignup(ctx context.Context, in SignupInput, adminCreated bool) (*Affiliate, error) {
	in.Email = strings.TrimSpace(strings.ToLower(in.Email))
	in.Name = strings.TrimSpace(in.Name)
	in.Country = strings.ToUpper(strings.TrimSpace(in.Country))
	in.Slug = strings.TrimSpace(strings.ToLower(in.Slug))

	if in.Email == "" || !emailRoughOK.MatchString(in.Email) {
		return nil, fieldErr("bad_email", "invalid email address")
	}
	if in.Name == "" {
		return nil, fieldErr("missing_name", "name is required")
	}
	if in.Country != "" && !countryFormat.MatchString(in.Country) {
		return nil, fieldErr("bad_country",
			"country must be ISO-3166-1 alpha-2 (e.g. 'US', 'IN', 'GB-ENG')")
	}
	if in.Slug == "" {
		in.Slug = slugify(in.Name)
	}
	in.Slug = slugAllowed.ReplaceAllString(in.Slug, "-")
	in.Slug = strings.Trim(in.Slug, "-")
	if in.Slug == "" {
		return nil, fieldErr("bad_slug", "could not derive slug from name")
	}
	if len(in.Slug) > 80 {
		in.Slug = in.Slug[:80]
	}

	// Reject obvious dup before we try to insert (cheaper UX).
	if existing, err := d.Repo.GetAffiliateByEmail(ctx, in.Email); err == nil && existing != nil {
		return nil, fieldErr("email_taken", "an affiliate already exists for that email")
	}
	if existing, err := d.Repo.GetAffiliateBySlug(ctx, in.Slug); err == nil && existing != nil {
		return nil, fieldErr("slug_taken", "that slug is already in use")
	}

	a := &Affiliate{
		Slug:         in.Slug,
		Email:        in.Email,
		Name:         in.Name,
		Country:      in.Country,
		Status:       StatusPending,
		Website:      strings.TrimSpace(in.Website),
		AudienceSize: in.AudienceSize,
		AudienceDesc: strings.TrimSpace(in.AudienceDesc),
	}
	if adminCreated {
		a.Status = StatusApproved
	}
	if err := d.Repo.CreateAffiliate(ctx, a); err != nil {
		return nil, err
	}
	return a, nil
}

// slugify is a small URL-safe slugger; mirrors the TS one in forms-types.ts
// so admins / public pages produce identical slugs from the same name.
func slugify(name string) string {
	out := strings.ToLower(strings.TrimSpace(name))
	out = strings.NewReplacer("'", "", `"`, "").Replace(out)
	b := strings.Builder{}
	last := byte('-')
	for i := 0; i < len(out); i++ {
		c := out[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteByte(c)
			last = c
		} else if last != '-' {
			b.WriteByte('-')
			last = '-'
		}
	}
	return strings.Trim(b.String(), "-")
}

func safeAffiliateLandingURL(raw, fallback, requestHost string) string {
	fallback = safeAffiliateFallbackURL(fallback)
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeRedirectBytes(raw) {
		return fallback
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fallback
	}
	if !parsed.IsAbs() {
		if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") {
			u, err := url.Parse(raw)
			if err != nil || u.User != nil || u.Fragment != "" {
				return fallback
			}
			return u.String()
		}
		return fallback
	}
	if parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fallback
	}
	parsed.Fragment = ""
	allowed := map[string]bool{}
	if fb, err := url.Parse(fallback); err == nil && fb.Host != "" {
		allowed[strings.ToLower(fb.Host)] = true
	}
	if requestHost != "" {
		allowed[strings.ToLower(requestHost)] = true
	}
	if allowed[strings.ToLower(parsed.Host)] {
		return parsed.String()
	}
	return fallback
}

func safeAffiliateFallbackURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || containsUnsafeRedirectBytes(raw) {
		return "https://moosewave.com"
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.User != nil || parsed.Host == "" {
		return "https://moosewave.com"
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "https://moosewave.com"
	}
	parsed.Fragment = ""
	return parsed.String()
}

func containsUnsafeRedirectBytes(raw string) bool {
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "%0d") || strings.Contains(lower, "%0a") {
		return true
	}
	return strings.ContainsAny(raw, "\x00\r\n")
}

// fieldErr creates an error that writeSignupError can translate to a
// 400 response with the provided code.
type signupErr struct {
	Code    string
	Message string
}

func (e *signupErr) Error() string { return e.Code + ": " + e.Message }
func fieldErr(code, msg string) error {
	return &signupErr{Code: code, Message: msg}
}

func (d *Deps) writeSignupError(w http.ResponseWriter, r *http.Request, err error) {
	var se *signupErr
	if errors.As(err, &se) {
		writeJSONError(w, http.StatusBadRequest, se.Code, se.Message)
		return
	}
	if errors.Is(err, ErrSlugConflict) {
		httperror.Write(w, http.StatusConflict, "slug_taken",
			"that slug is already in use")
		return
	}
	if errors.Is(err, ErrEmailConflict) {
		httperror.Write(w, http.StatusConflict, "email_taken",
			"an affiliate already exists for that email")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

// AdminMarkPayoutSent PATCH /admin/affiliates/{id}/payouts/{payoutId} — records
// a pending payout as sent with an external reference (BILL-004). Completes the
// payout lifecycle the create-payout dialog copy already promises.
func (d *Deps) AdminMarkPayoutSent(w http.ResponseWriter, r *http.Request) {
	payoutID := chi.URLParam(r, "payoutId")
	var in struct {
		Reference string `json:"reference"`
	}
	if err := decodeLimitedJSON(w, r, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	ref := strings.TrimSpace(in.Reference)
	if ref == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_reference", "a payout reference is required")
		return
	}
	if err := d.Repo.MarkPayoutSent(r.Context(), payoutID, ref); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSONError(w, http.StatusNotFound, "not_found", "no pending payout with that id")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":               payoutID,
		"status":           "sent",
		"payout_reference": ref,
	})
}

// AdminUpdateConversionStatus PATCH /admin/affiliates/{id}/conversions/{conversionId}
// — moderates a single conversion (approve / reverse / dispute) (BILL-033).
func (d *Deps) AdminUpdateConversionStatus(w http.ResponseWriter, r *http.Request) {
	affiliateID := chi.URLParam(r, "id")
	conversionID, err := strconv.ParseInt(chi.URLParam(r, "conversionId"), 10, 64)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_id", "invalid conversion id")
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := decodeLimitedJSON(w, r, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	to := ConversionStatus(strings.ToLower(strings.TrimSpace(in.Status)))
	updated, err := d.Repo.UpdateConversionStatus(r.Context(), affiliateID, conversionID, to)
	switch {
	case errors.Is(err, ErrNotFound):
		writeJSONError(w, http.StatusNotFound, "not_found", "no such conversion")
		return
	case errors.Is(err, ErrIllegalConversionTransition):
		writeJSONError(w, http.StatusUnprocessableEntity, "illegal_transition", err.Error())
		return
	case err != nil:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func decodeLimitedJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	return httpbody.DecodeJSON(w, r, affiliateJSONMaxBodyBytes, dst)
}

// writeAffiliatesRoleDenial refuses an affiliate admin action to a lower role.
//
// The code stays "forbidden" because that is what clients already match on;
// what changes is that the refusal now says WHICH role, so the UI can name it
// instead of guessing.
func writeAffiliatesRoleDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "affiliates",
		Reason:       entitlement.ReasonRole,
		Code:         "forbidden",
		Message:      "admin role required",
		RequiredRole: "admin",
	})
}
