// SPDX-License-Identifier: AGPL-3.0-only
//
// loyalty_more.go — native Rivo + ReferralCandy loyalty provider pullers.
//
// Two more pullers on the loyalty_integrations foundation, mirroring the
// Smile.io/LoyaltyLion pattern. Rivo is a native Shopify loyalty app (Bearer
// key, points + VIP tier). ReferralCandy is a referral program whose API uses
// MD5 signed-parameter auth (the ReferralCandySignature helper already lives in
// signatures.go). Both land canonical MemberInput rows via Deps.providerPull —
// points into custom fields, VIP tier into a loyalty-tier-<slug> tag, referral
// code preserved.
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ---------------- Rivo ----------------

const (
	rivoDefaultAPIBaseURL = "https://developer-api.rivo.io"
	rivoCursorPrefix      = "rivo:"
	rivoCursorComplete    = "rivo:complete"
)

type RivoCredentials struct {
	APIToken   string
	APIBaseURL string
	UserAgent  string
}

type RivoCredentialResolver interface {
	ResolveRivo(ctx context.Context, tenantID string, integration Integration) (RivoCredentials, error)
}

type rivoCredentialPayload struct {
	APIToken   string `json:"api_token"`
	Token      string `json:"token"`
	APIKey     string `json:"api_key"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p rivoCredentialPayload) credentials() (RivoCredentials, error) {
	token := strings.TrimSpace(firstString(p.APIToken, p.Token, p.APIKey))
	if token == "" {
		return RivoCredentials{}, fmt.Errorf("rivo api_token is required")
	}
	return RivoCredentials{APIToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type RivoSecretsCredentialResolver struct {
	Secrets LoyaltyRuntimeSecretResolver
}

func (r RivoSecretsCredentialResolver) ResolveRivo(ctx context.Context, _ string, integration Integration) (RivoCredentials, error) {
	if r.Secrets == nil {
		return RivoCredentials{}, fmt.Errorf("rivo credential resolver is not configured")
	}
	ref := loyaltyCredentialRef(integration)
	if ref == "" {
		return RivoCredentials{}, fmt.Errorf("rivo credentials_ref is required")
	}
	var payload rivoCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return RivoCredentials{}, fmt.Errorf("resolve rivo credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return rivoCredentialPayload{APIToken: raw}.credentials()
}

type RivoRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials RivoCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type rivoCustomer struct {
	ID            json.Number `json:"id"`
	Email         string      `json:"email"`
	FirstName     string      `json:"first_name"`
	LastName      string      `json:"last_name"`
	PointsBalance int         `json:"points_balance"`
	Points        int         `json:"points"`
	VIPTier       struct {
		Name string `json:"name"`
	} `json:"vip_tier"`
}

func (b RivoRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderRivo {
		return SyncRequest{}, fmt.Errorf("rivo backfill requires a Rivo integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("rivo credential resolver is not configured")
	}
	page, done := loyaltyPageCursor(cursor, rivoCursorPrefix, rivoCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: rivoCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveRivo(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyHTTPClient(b.HTTPClient, ProviderRivo)
	perPage := loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("limit", strconv.Itoa(perPage))
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIToken)}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), rivoDefaultAPIBaseURL)

	var out struct {
		Customers []rivoCustomer `json:"customers"`
	}
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/customers", query, headers, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	members := make([]MemberInput, 0, len(out.Customers))
	for _, c := range out.Customers {
		if mapped, ok := mapRivoCustomer(c); ok {
			members = append(members, mapped)
		}
	}
	nextCursor := rivoCursorComplete
	if len(out.Customers) >= perPage {
		nextCursor = rivoCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Members: members, Cursor: nextCursor}, nil
}

func mapRivoCustomer(c rivoCustomer) (MemberInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return MemberInput{}, false
	}
	points := c.PointsBalance
	if points == 0 {
		points = c.Points
	}
	return MemberInput{
		SourceID:      "rivo://customer/" + strings.TrimSpace(c.ID.String()),
		Email:         email,
		FirstName:     strings.TrimSpace(c.FirstName),
		LastName:      strings.TrimSpace(c.LastName),
		PointsBalance: points,
		VIPTier:       strings.TrimSpace(c.VIPTier.Name),
	}, true
}

// ---------------- ReferralCandy ----------------

const (
	referralCandyDefaultAPIBaseURL = "https://my.referralcandy.com"
	referralCandyCursorPrefix      = "referralcandy:"
	referralCandyCursorComplete    = "referralcandy:complete"
)

type ReferralCandyCredentials struct {
	AccessID   string
	SecretKey  string
	APIBaseURL string
	UserAgent  string
}

type ReferralCandyCredentialResolver interface {
	ResolveReferralCandy(ctx context.Context, tenantID string, integration Integration) (ReferralCandyCredentials, error)
}

type referralCandyCredentialPayload struct {
	AccessID   string `json:"access_id"`
	SecretKey  string `json:"secret_key"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p referralCandyCredentialPayload) credentials() (ReferralCandyCredentials, error) {
	accessID := strings.TrimSpace(p.AccessID)
	secret := strings.TrimSpace(p.SecretKey)
	if accessID == "" || secret == "" {
		return ReferralCandyCredentials{}, fmt.Errorf("referralcandy access_id and secret_key are required")
	}
	return ReferralCandyCredentials{AccessID: accessID, SecretKey: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type ReferralCandySecretsCredentialResolver struct {
	Secrets LoyaltyRuntimeSecretResolver
}

func (r ReferralCandySecretsCredentialResolver) ResolveReferralCandy(ctx context.Context, _ string, integration Integration) (ReferralCandyCredentials, error) {
	if r.Secrets == nil {
		return ReferralCandyCredentials{}, fmt.Errorf("referralcandy credential resolver is not configured")
	}
	ref := loyaltyCredentialRef(integration)
	if ref == "" {
		return ReferralCandyCredentials{}, fmt.Errorf("referralcandy credentials_ref is required")
	}
	var payload referralCandyCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return ReferralCandyCredentials{}, fmt.Errorf("resolve referralcandy credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return ReferralCandyCredentials{}, fmt.Errorf("referralcandy requires a JSON {access_id, secret_key} secret")
}

type ReferralCandyRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials ReferralCandyCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
	Now         func() time.Time
}

type referralCandyReferrer struct {
	Email        string      `json:"email"`
	Name         string      `json:"name"`
	ReferralCode string      `json:"referral_code"`
	Referralcode string      `json:"referralcode"`
	RewardsCount int         `json:"rewards_count"`
	ID           json.Number `json:"id"`
}

func (b ReferralCandyRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderReferralCandy {
		return SyncRequest{}, fmt.Errorf("referralcandy backfill requires a ReferralCandy integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("referralcandy credential resolver is not configured")
	}
	page, done := loyaltyPageCursor(cursor, referralCandyCursorPrefix, referralCandyCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: referralCandyCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveReferralCandy(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyHTTPClient(b.HTTPClient, ProviderReferralCandy)
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	// ReferralCandy authenticates each request with accessID + timestamp +
	// MD5 signature over the remaining parameters (see signatures.go).
	params := map[string]string{
		"accessID":  creds.AccessID,
		"timestamp": strconv.FormatInt(now().UTC().Unix(), 10),
		"page":      strconv.Itoa(page),
	}
	query := url.Values{}
	for k, v := range params {
		query.Set(k, v)
	}
	query.Set("signature", ReferralCandyParameterSignature(creds.SecretKey, params))
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), referralCandyDefaultAPIBaseURL)

	var out struct {
		Referrers []referralCandyReferrer `json:"referrers"`
	}
	if err := loyaltyDoJSON(ctx, client, baseURL, "/api/v1/referrers", query, nil, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	members := make([]MemberInput, 0, len(out.Referrers))
	for _, ref := range out.Referrers {
		if mapped, ok := mapReferralCandyReferrer(ref); ok {
			members = append(members, mapped)
		}
	}
	// ReferralCandy's referrers endpoint sends no page-size param, so the only
	// safe termination is an empty page (a short page is not necessarily the last).
	nextCursor := referralCandyCursorComplete
	if len(out.Referrers) > 0 {
		nextCursor = referralCandyCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Members: members, Cursor: nextCursor}, nil
}

func mapReferralCandyReferrer(ref referralCandyReferrer) (MemberInput, bool) {
	email := strings.ToLower(strings.TrimSpace(ref.Email))
	if email == "" {
		return MemberInput{}, false
	}
	return MemberInput{
		SourceID:     "referralcandy://referrer/" + email,
		Email:        email,
		FullName:     strings.TrimSpace(ref.Name),
		ReferralCode: strings.TrimSpace(firstString(ref.ReferralCode, ref.Referralcode)),
		RewardsCount: ref.RewardsCount,
	}, true
}

func loyaltyHTTPClient(c *http.Client, provider string) *http.Client {
	return loyaltyEgressClient(c, provider, 30*time.Second)
}
