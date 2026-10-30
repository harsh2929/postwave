package discounts

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
)

// CouponAllocationAvailable is the compile-time production containment gate.
// Keep false until provider authority, reservation expiry/release, durable
// entitlement auditing, abuse controls, and reconciliation are certified.
// Composition roots must not wire an allocator while this is false.
//
// Four of those five prerequisites are now BUILT — reservation expiry/release
// (Repo.ExpireCouponReservations, Repo.ReleaseCouponAssignment,
// Repo.ConfirmCouponReservation), durable entitlement auditing
// (coupon_entitlement_events, written by database triggers, migration 1970),
// abuse controls (per-subscriber and per-campaign bounds enforced by
// coupon_assignment_quota_guard), and reconciliation (Repo.ReconcileCouponPool,
// read-only by construction). Built is not certified. Flipping this constant
// hands out real money and stays a human decision made against the evidence
// those four produce; see coupon_allocation_certification.go for exactly what a
// human still has to establish and why no test in this repository can establish
// it for them.
const CouponAllocationAvailable = false

type CouponPoolCodeType string

const (
	CouponPoolStatic    CouponPoolCodeType = "static"
	CouponPoolImported  CouponPoolCodeType = "imported"
	CouponPoolGenerated CouponPoolCodeType = "generated"
)

type CouponPoolStatus string

const (
	CouponPoolDraft    CouponPoolStatus = "draft"
	CouponPoolActive   CouponPoolStatus = "active"
	CouponPoolPaused   CouponPoolStatus = "paused"
	CouponPoolArchived CouponPoolStatus = "archived"
)

type CouponCodeStatus string

const (
	CouponCodeAvailable CouponCodeStatus = "available"
	CouponCodeReserved  CouponCodeStatus = "reserved"
	CouponCodeAssigned  CouponCodeStatus = "assigned"
	CouponCodeRedeemed  CouponCodeStatus = "redeemed"
	CouponCodeExpired   CouponCodeStatus = "expired"
	CouponCodeDisabled  CouponCodeStatus = "disabled"
)

type CouponAssignmentStatus string

const (
	CouponAssignmentReserved CouponAssignmentStatus = "reserved"
	CouponAssignmentAssigned CouponAssignmentStatus = "assigned"
	CouponAssignmentRedeemed CouponAssignmentStatus = "redeemed"
	CouponAssignmentReleased CouponAssignmentStatus = "released"
	CouponAssignmentExpired  CouponAssignmentStatus = "expired"
)

// ErrCouponExhausted means the pool is active but has no allocatable code.
var ErrCouponExhausted = errors.New("discounts: coupon pool exhausted")

type CouponPool struct {
	ID          string             `json:"id"`
	TenantID    string             `json:"tenant_id"`
	DiscountID  string             `json:"discount_id,omitempty"`
	Name        string             `json:"name"`
	Description string             `json:"description"`
	Provider    string             `json:"provider"`
	ProviderRef string             `json:"provider_ref,omitempty"`
	CodeType    CouponPoolCodeType `json:"code_type"`
	Status      CouponPoolStatus   `json:"status"`
	DefaultCode string             `json:"default_code,omitempty"`
	ExpiresAt   *time.Time         `json:"expires_at,omitempty"`
	Settings    map[string]any     `json:"settings,omitempty"`
	// Abuse-control bounds (migration 1970). See CouponPoolInput for what each
	// one is protecting against.
	MaxCodesPerSubscriber    int       `json:"max_codes_per_subscriber"`
	MaxCodesPerCampaign      int       `json:"max_codes_per_campaign"`
	MaxReservationTTLSeconds int       `json:"max_reservation_ttl_seconds"`
	AvailableCodes           int       `json:"available_codes"`
	AssignedCodes            int       `json:"assigned_codes"`
	RedeemedCodes            int       `json:"redeemed_codes"`
	CreatedAt                time.Time `json:"created_at"`
	UpdatedAt                time.Time `json:"updated_at"`
}

type CouponPoolInput struct {
	Name         string             `json:"name"`
	Description  string             `json:"description,omitempty"`
	Provider     string             `json:"provider,omitempty"`
	ProviderRef  string             `json:"provider_ref,omitempty"`
	CodeType     CouponPoolCodeType `json:"code_type,omitempty"`
	Status       CouponPoolStatus   `json:"status,omitempty"`
	DefaultCode  string             `json:"default_code,omitempty"`
	DiscountCode string             `json:"discount_code,omitempty"`
	ExpiresAt    *time.Time         `json:"expires_at,omitempty"`
	Settings     map[string]any     `json:"settings,omitempty"`

	// MaxCodesPerSubscriber bounds how many live codes one recipient may hold
	// from this pool. The existing partial unique indexes already stop a replay
	// that reuses the same context_key; they do nothing about a loop that varies
	// it, which is the shape that empties a pool.
	//
	// MaxCodesPerCampaign bounds one sending scope (campaign_id when the caller
	// names one, otherwise context_key). It is a blast radius, not a business
	// limit: raise it deliberately before a large send rather than leaving it
	// unbounded and finding out from a finance report.
	//
	// MaxReservationTTLSeconds caps how long a caller may withhold inventory.
	//
	// All three are pointers so an omitted field on upsert keeps the stored
	// value instead of silently resetting a deliberately raised bound to the
	// column default.
	MaxCodesPerSubscriber    *int `json:"max_codes_per_subscriber,omitempty"`
	MaxCodesPerCampaign      *int `json:"max_codes_per_campaign,omitempty"`
	MaxReservationTTLSeconds *int `json:"max_reservation_ttl_seconds,omitempty"`
}

// Bounds accepted for the coupon-pool abuse controls. They mirror the CHECK
// constraints added by migration 1970 so a bad value is a 400 rather than a
// constraint violation surfaced as a 500.
const (
	couponMaxCodesPerSubscriberCeiling = 1000
	couponMaxCodesPerCampaignCeiling   = 10000000
	couponMinReservationTTLSeconds     = 60
	couponMaxReservationTTLSeconds     = 2592000
)

type CouponPoolsPage struct {
	Items    []CouponPool `json:"items"`
	PageInfo PageInfoLike `json:"page_info"`
}

type PageInfoLike struct {
	Total   int `json:"total"`
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

type CouponCode struct {
	ID              string           `json:"id"`
	TenantID        string           `json:"tenant_id"`
	PoolID          string           `json:"pool_id"`
	Code            string           `json:"code"`
	Status          CouponCodeStatus `json:"status"`
	SubscriberID    string           `json:"subscriber_id,omitempty"`
	SubscriberEmail string           `json:"subscriber_email,omitempty"`
	ContextKey      string           `json:"context_key,omitempty"`
	AssignedAt      *time.Time       `json:"assigned_at,omitempty"`
	ReservedUntil   *time.Time       `json:"reserved_until,omitempty"`
	RedeemedAt      *time.Time       `json:"redeemed_at,omitempty"`
	ExpiresAt       *time.Time       `json:"expires_at,omitempty"`
	Metadata        map[string]any   `json:"metadata,omitempty"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

type CouponCodesPage struct {
	Items    []CouponCode `json:"items"`
	PageInfo PageInfoLike `json:"page_info"`
}

type CouponCodeImportInput struct {
	Codes     []string       `json:"codes"`
	ExpiresAt *time.Time     `json:"expires_at,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type CouponCodeImportSummary struct {
	PoolID     string    `json:"pool_id"`
	Seen       int       `json:"seen"`
	Imported   int       `json:"imported"`
	Duplicates int       `json:"duplicates"`
	ImportedAt time.Time `json:"imported_at"`
}

type CouponAssignmentInput struct {
	SubscriberID    string `json:"subscriber_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
	ContextKey      string `json:"context_key,omitempty"`
	RenderKey       string `json:"render_key,omitempty"`
	Channel         string `json:"channel,omitempty"`
	Surface         string `json:"surface,omitempty"`
	// CampaignID names the sending scope the per-campaign abuse bound is
	// applied to. When empty the bound falls back to ContextKey, which is what
	// flow nodes and render surfaces already set.
	CampaignID            string         `json:"campaign_id,omitempty"`
	ReservationTTLSeconds int            `json:"reservation_ttl_seconds,omitempty"`
	Metadata              map[string]any `json:"metadata,omitempty"`
}

type CouponAssignment struct {
	ID              string                 `json:"id"`
	TenantID        string                 `json:"tenant_id"`
	PoolID          string                 `json:"pool_id"`
	CodeID          string                 `json:"code_id,omitempty"`
	Code            string                 `json:"code"`
	SubscriberID    string                 `json:"subscriber_id,omitempty"`
	SubscriberEmail string                 `json:"subscriber_email,omitempty"`
	ContextKey      string                 `json:"context_key,omitempty"`
	RenderKey       string                 `json:"render_key,omitempty"`
	Channel         string                 `json:"channel,omitempty"`
	Surface         string                 `json:"surface,omitempty"`
	Status          CouponAssignmentStatus `json:"status"`
	AssignedAt      time.Time              `json:"assigned_at"`
	ReservedUntil   *time.Time             `json:"reserved_until,omitempty"`
	RedeemedAt      *time.Time             `json:"redeemed_at,omitempty"`
	ExpiresAt       *time.Time             `json:"expires_at,omitempty"`
	Metadata        map[string]any         `json:"metadata,omitempty"`
	CreatedAt       time.Time              `json:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at"`
}

type CouponAssignmentsPage struct {
	Items    []CouponAssignment `json:"items"`
	PageInfo PageInfoLike       `json:"page_info"`
}

type CouponRenderReservation struct {
	ID              string         `json:"id"`
	TenantID        string         `json:"tenant_id"`
	PoolID          string         `json:"pool_id"`
	AssignmentID    string         `json:"assignment_id"`
	SubscriberID    string         `json:"subscriber_id,omitempty"`
	SubscriberEmail string         `json:"subscriber_email,omitempty"`
	ContextKey      string         `json:"context_key,omitempty"`
	RenderKey       string         `json:"render_key"`
	Channel         string         `json:"channel,omitempty"`
	Surface         string         `json:"surface,omitempty"`
	Code            string         `json:"code"`
	ExpiresAt       *time.Time     `json:"expires_at,omitempty"`
	Metadata        map[string]any `json:"metadata,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
}

type CouponAssignmentResult struct {
	Assignment        CouponAssignment         `json:"assignment"`
	RenderReservation *CouponRenderReservation `json:"render_reservation,omitempty"`
}

func (in *CouponPoolInput) NormalizeAndValidate() error {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	in.ProviderRef = strings.TrimSpace(in.ProviderRef)
	in.DefaultCode = normalizeCouponCode(in.DefaultCode)
	in.DiscountCode = normalizeCouponCode(in.DiscountCode)
	if in.Name == "" {
		return fmt.Errorf("%w: coupon pool name is required", ErrInvalidInput)
	}
	if in.Provider == "" {
		in.Provider = "postwave"
	}
	switch in.Provider {
	case "postwave", "shopify", "woocommerce", "manual":
	default:
		return fmt.Errorf("%w: provider must be postwave|shopify|woocommerce|manual", ErrInvalidInput)
	}
	if in.CodeType == "" {
		if in.DefaultCode != "" || in.DiscountCode != "" {
			in.CodeType = CouponPoolStatic
		} else {
			in.CodeType = CouponPoolImported
		}
	}
	switch in.CodeType {
	case CouponPoolStatic, CouponPoolImported, CouponPoolGenerated:
	default:
		return fmt.Errorf("%w: code_type must be static|imported|generated", ErrInvalidInput)
	}
	if in.Status == "" {
		in.Status = CouponPoolActive
	}
	switch in.Status {
	case CouponPoolDraft, CouponPoolActive, CouponPoolPaused, CouponPoolArchived:
	default:
		return fmt.Errorf("%w: status must be draft|active|paused|archived", ErrInvalidInput)
	}
	if in.CodeType == CouponPoolStatic && in.DefaultCode == "" && in.DiscountCode == "" {
		return fmt.Errorf("%w: static coupon pools require default_code or discount_code", ErrInvalidInput)
	}
	if in.MaxCodesPerSubscriber != nil &&
		(*in.MaxCodesPerSubscriber < 1 || *in.MaxCodesPerSubscriber > couponMaxCodesPerSubscriberCeiling) {
		return fmt.Errorf("%w: max_codes_per_subscriber must be in [1,%d]",
			ErrInvalidInput, couponMaxCodesPerSubscriberCeiling)
	}
	if in.MaxCodesPerCampaign != nil &&
		(*in.MaxCodesPerCampaign < 1 || *in.MaxCodesPerCampaign > couponMaxCodesPerCampaignCeiling) {
		return fmt.Errorf("%w: max_codes_per_campaign must be in [1,%d]",
			ErrInvalidInput, couponMaxCodesPerCampaignCeiling)
	}
	if in.MaxReservationTTLSeconds != nil &&
		(*in.MaxReservationTTLSeconds < couponMinReservationTTLSeconds ||
			*in.MaxReservationTTLSeconds > couponMaxReservationTTLSeconds) {
		return fmt.Errorf("%w: max_reservation_ttl_seconds must be in [%d,%d]",
			ErrInvalidInput, couponMinReservationTTLSeconds, couponMaxReservationTTLSeconds)
	}
	if in.Settings == nil {
		in.Settings = map[string]any{}
	}
	return nil
}

func (in *CouponCodeImportInput) NormalizeAndValidate() ([]string, error) {
	if len(in.Codes) == 0 {
		return nil, fmt.Errorf("%w: codes are required", ErrInvalidInput)
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in.Codes))
	for _, raw := range in.Codes {
		code := normalizeCouponCode(raw)
		if code == "" {
			continue
		}
		if strings.ContainsAny(code, " \t\r\n") {
			return nil, fmt.Errorf("%w: coupon codes cannot contain whitespace", ErrInvalidInput)
		}
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}
		out = append(out, code)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: at least one non-empty code is required", ErrInvalidInput)
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	return out, nil
}

func (in *CouponAssignmentInput) NormalizeAndValidate() error {
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.SubscriberEmail = strings.ToLower(strings.TrimSpace(in.SubscriberEmail))
	in.ContextKey = strings.TrimSpace(in.ContextKey)
	in.RenderKey = strings.TrimSpace(in.RenderKey)
	in.Channel = strings.TrimSpace(in.Channel)
	in.Surface = strings.TrimSpace(in.Surface)
	in.CampaignID = strings.TrimSpace(in.CampaignID)
	if in.SubscriberID == "" && in.SubscriberEmail == "" {
		return fmt.Errorf("%w: subscriber_id or subscriber_email is required", ErrInvalidInput)
	}
	if in.CampaignID != "" {
		if _, err := uuid.Parse(in.CampaignID); err != nil {
			return fmt.Errorf("%w: campaign_id must be a UUID", ErrInvalidInput)
		}
	}
	if in.ContextKey == "" {
		in.ContextKey = "default"
	}
	if in.ReservationTTLSeconds < 0 {
		return fmt.Errorf("%w: reservation_ttl_seconds cannot be negative", ErrInvalidInput)
	}
	if in.ReservationTTLSeconds > 0 && in.ReservationTTLSeconds < couponMinReservationTTLSeconds {
		return fmt.Errorf("%w: reservation_ttl_seconds must be at least %d",
			ErrInvalidInput, couponMinReservationTTLSeconds)
	}
	if in.ReservationTTLSeconds > couponMaxReservationTTLSeconds {
		return fmt.Errorf("%w: reservation_ttl_seconds must be at most %d",
			ErrInvalidInput, couponMaxReservationTTLSeconds)
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	return nil
}

func normalizeCouponCode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

func generatedCouponCode(settings map[string]any) (string, error) {
	prefix := ""
	if v, ok := settings["prefix"].(string); ok {
		prefix = normalizeCouponCode(v)
	}
	length := 12
	if v, ok := settings["length"].(float64); ok && v >= 6 && v <= 32 {
		length = int(v)
	}
	if v, ok := settings["length"].(int); ok && v >= 6 && v <= 32 {
		length = v
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	bodyLen := length - len(prefix)
	if bodyLen < 6 {
		bodyLen = 6
	}
	var b strings.Builder
	b.WriteString(prefix)
	for i := 0; i < bodyLen; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		b.WriteByte(alphabet[n.Int64()])
	}
	return b.String(), nil
}
