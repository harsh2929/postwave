// SPDX-License-Identifier: AGPL-3.0-only
//
// loyalty.go — native Smile.io + LoyaltyLion loyalty provider pullers.
//
// Loyalty programs feed points balances and VIP tiers into subscriber profiles so
// lifecycle automations (tier-up emails, points-expiry nudges, VIP segments) can
// fire. Both add the provider-facing layer the loyalty_integrations foundation
// lacked: credential resolvers + REST pullers dispatched via Deps.providerPull,
// landing canonical MemberInput rows (points -> custom fields, VIP tier -> tag).
// The LoyaltyLion webhook verifier already exists (signatures.go).
package loyalty_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	smileDefaultAPIBaseURL       = "https://api.smile.io"
	loyaltyLionDefaultAPIBaseURL = "https://api.loyaltylion.com"
	loyaltyDefaultUserAgent      = "Moosewave Loyalty Integration"
	loyaltyResponseMaxBytes      = 16 << 20
	loyaltyDefaultPageSize       = 50
)

var errNotJSONSecret = errors.New("loyalty_integrations: secret is not JSON")

type LoyaltyRESTError struct {
	Operation  string
	StatusCode int
	RetryAfter time.Duration
	Snippet    string
}

func (e LoyaltyRESTError) Error() string {
	operation := strings.TrimSpace(e.Operation)
	if operation == "" {
		operation = "loyalty provider request"
	}
	msg := fmt.Sprintf("%s failed %d", operation, e.StatusCode)
	if e.RetryAfter > 0 {
		msg += " retry_after=" + e.RetryAfter.String()
	}
	if strings.TrimSpace(e.Snippet) != "" {
		msg += ": " + strings.TrimSpace(e.Snippet)
	}
	return msg
}

// LoyaltyRuntimeSecretResolver is the trusted secrets backend.
type LoyaltyRuntimeSecretResolver interface {
	Get(ctx context.Context, ref string) (string, error)
	GetJSON(ctx context.Context, ref string, out any) error
}

// LoyaltyBackfiller pulls a single page of loyalty members from a provider.
type LoyaltyBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

func loyaltyPageCursor(cursor, prefix, complete string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == complete {
		return 0, true
	}
	if cursor == "" {
		return 1, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, prefix))
	if err != nil || n <= 0 {
		return 1, false
	}
	return n, false
}

func loyaltyPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return loyaltyDefaultPageSize
	}
	if n > 100 {
		return 100
	}
	return n
}

func loyaltyCredentialRef(integration Integration) string {
	return strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
}

// ---------------- Smile.io ----------------

const (
	smileCursorPrefix   = "smile:"
	smileCursorComplete = "smile:complete"
	smilePointsCursor   = "smile:points"
	smilePointsPrefix   = "smile:points:"
	smileRewardsCursor  = "smile:rewards"
	smileRewardsPrefix  = "smile:rewards:"
)

type smileEventCursorState struct {
	Cursor       string `json:"cursor,omitempty"`
	UpdatedAtMin string `json:"updated_at_min,omitempty"`
}

type SmileCredentials struct {
	APIToken   string
	APIBaseURL string
	UserAgent  string
}

type SmileCredentialResolver interface {
	ResolveSmile(ctx context.Context, tenantID string, integration Integration) (SmileCredentials, error)
}

type smileCredentialPayload struct {
	APIToken   string `json:"api_token"`
	Token      string `json:"token"`
	PrivateKey string `json:"private_key"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p smileCredentialPayload) credentials() (SmileCredentials, error) {
	token := strings.TrimSpace(firstString(p.APIToken, p.Token, p.PrivateKey))
	if token == "" {
		return SmileCredentials{}, fmt.Errorf("smile.io api_token is required")
	}
	return SmileCredentials{APIToken: token, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type SmileSecretsCredentialResolver struct {
	Secrets LoyaltyRuntimeSecretResolver
}

func (r SmileSecretsCredentialResolver) ResolveSmile(ctx context.Context, _ string, integration Integration) (SmileCredentials, error) {
	if r.Secrets == nil {
		return SmileCredentials{}, fmt.Errorf("smile.io credential resolver is not configured")
	}
	ref := loyaltyCredentialRef(integration)
	if ref == "" {
		return SmileCredentials{}, fmt.Errorf("smile.io credentials_ref is required")
	}
	var payload smileCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SmileCredentials{}, fmt.Errorf("resolve smile.io credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return smileCredentialPayload{APIToken: raw}.credentials()
}

type SmileRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials SmileCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type smileCustomer struct {
	ID            int    `json:"id"`
	Email         string `json:"email"`
	FirstName     string `json:"first_name"`
	LastName      string `json:"last_name"`
	State         string `json:"state"`
	PointsBalance int    `json:"points_balance"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	VIPTier       struct {
		Name string `json:"name"`
	} `json:"vip_tier"`
	VIPStatus struct {
		VIPTier struct {
			Name string `json:"name"`
		} `json:"vip_tier"`
	} `json:"vip_status"`
}

type smilePointsTransaction struct {
	ID           int    `json:"id"`
	CustomerID   int    `json:"customer_id"`
	PointsChange int    `json:"points_change"`
	Description  string `json:"description"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

type smileRewardFulfillment struct {
	ID                 int    `json:"id"`
	Name               string `json:"name"`
	Code               string `json:"code"`
	CustomerID         int    `json:"customer_id"`
	FulfillmentStatus  string `json:"fulfillment_status"`
	UsageStatus        string `json:"usage_status"`
	UsageInstructions  string `json:"usage_instructions"`
	TermsAndConditions string `json:"terms_and_conditions"`
	ExpiresAt          string `json:"expires_at"`
	UsedAt             string `json:"used_at"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

type smilePaginationMetadata struct {
	NextCursor string `json:"next_cursor"`
}

func (b SmileRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSmile {
		return SyncRequest{}, fmt.Errorf("smile.io backfill requires a Smile.io integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("smile.io credential resolver is not configured")
	}
	if state, ok := decodeSmilePointsCursorState(cursor); ok {
		return b.backfillPointsTransactions(ctx, tenantID, integration, state)
	}
	if state, ok := decodeSmileRewardsCursorState(cursor); ok {
		return b.backfillRewardFulfillments(ctx, tenantID, integration, state)
	}
	page, done := loyaltyPageCursor(cursor, smileCursorPrefix, smileCursorComplete)
	if done {
		return b.backfillPointsTransactions(ctx, tenantID, integration, smileIncrementalEventCursorState(integration))
	}
	creds, err := b.Credentials.ResolveSmile(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyEgressClient(b.HTTPClient, ProviderSmile, 30*time.Second)
	perPage := loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("page_size", strconv.Itoa(perPage))

	var out struct {
		Customers []smileCustomer `json:"customers"`
	}
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIToken)}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), smileDefaultAPIBaseURL)
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/customers", query, headers, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	members := make([]MemberInput, 0, len(out.Customers))
	for _, c := range out.Customers {
		if mapped, ok := mapSmileCustomer(c); ok {
			members = append(members, mapped)
		}
	}
	nextCursor := smileCursorComplete
	if len(out.Customers) >= perPage {
		nextCursor = smileCursorPrefix + strconv.Itoa(page+1)
	} else if !settingDisabled(integration.Settings, "sync_points_transactions") {
		if len(members) == 0 {
			return b.backfillPointsTransactions(ctx, tenantID, integration, smileEventCursorState{})
		}
		nextCursor = smilePointsCursor
	}
	return SyncRequest{RunMode: "backfill", Members: members, Cursor: nextCursor}, nil
}

func (b SmileRESTBackfiller) backfillPointsTransactions(ctx context.Context, tenantID string, integration Integration, state smileEventCursorState) (SyncRequest, error) {
	creds, err := b.Credentials.ResolveSmile(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyEgressClient(b.HTTPClient, ProviderSmile, 30*time.Second)
	limit := loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	state = normalizeSmileEventCursorState(state)
	if state.Cursor != "" {
		query.Set("cursor", state.Cursor)
	}
	if state.UpdatedAtMin != "" {
		query.Set("updated_at_min", state.UpdatedAtMin)
	}
	var out struct {
		PointsTransactions []smilePointsTransaction `json:"points_transactions"`
		Metadata           smilePaginationMetadata  `json:"metadata"`
	}
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIToken)}
	userAgent := firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), smileDefaultAPIBaseURL)
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/points_transactions", query, headers, userAgent, &out); err != nil {
		return SyncRequest{}, err
	}
	customerCache := map[int]smileCustomer{}
	events := make([]LoyaltyEventInput, 0, len(out.PointsTransactions))
	members := make([]MemberInput, 0, len(out.PointsTransactions))
	seenMembers := map[string]bool{}
	for _, tx := range out.PointsTransactions {
		customer, ok, err := b.smileCustomerByID(ctx, client, baseURL, headers, userAgent, tx.CustomerID, customerCache)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		members = appendSmileMemberRefresh(members, seenMembers, customer)
		if event, ok := mapSmilePointsTransaction(tx, customer); ok {
			events = append(events, event)
		}
	}
	nextCursor := smileCursorComplete
	if strings.TrimSpace(out.Metadata.NextCursor) != "" {
		nextCursor = encodeSmilePointsCursorState(smileEventCursorState{Cursor: out.Metadata.NextCursor, UpdatedAtMin: state.UpdatedAtMin})
	} else if !settingDisabled(integration.Settings, "sync_reward_fulfillments") {
		if len(members)+len(events) == 0 {
			return b.backfillRewardFulfillments(ctx, tenantID, integration, smileEventCursorState{UpdatedAtMin: state.UpdatedAtMin})
		}
		nextCursor = encodeSmileRewardsCursorState(smileEventCursorState{UpdatedAtMin: state.UpdatedAtMin})
	}
	return SyncRequest{RunMode: "backfill", Members: members, Events: events, Cursor: nextCursor}, nil
}

func (b SmileRESTBackfiller) backfillRewardFulfillments(ctx context.Context, tenantID string, integration Integration, state smileEventCursorState) (SyncRequest, error) {
	creds, err := b.Credentials.ResolveSmile(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyEgressClient(b.HTTPClient, ProviderSmile, 30*time.Second)
	limit := loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("limit", strconv.Itoa(limit))
	state = normalizeSmileEventCursorState(state)
	if state.Cursor != "" {
		query.Set("cursor", state.Cursor)
	}
	if state.UpdatedAtMin != "" {
		query.Set("updated_at_min", state.UpdatedAtMin)
	}
	var out struct {
		RewardFulfillments []smileRewardFulfillment `json:"reward_fulfillments"`
		Metadata           smilePaginationMetadata  `json:"metadata"`
	}
	headers := map[string]string{"Authorization": "Bearer " + strings.TrimSpace(creds.APIToken)}
	userAgent := firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent)
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), smileDefaultAPIBaseURL)
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/reward_fulfillments", query, headers, userAgent, &out); err != nil {
		return SyncRequest{}, err
	}
	customerCache := map[int]smileCustomer{}
	events := make([]LoyaltyEventInput, 0, len(out.RewardFulfillments))
	members := make([]MemberInput, 0, len(out.RewardFulfillments))
	seenMembers := map[string]bool{}
	for _, reward := range out.RewardFulfillments {
		customer, ok, err := b.smileCustomerByID(ctx, client, baseURL, headers, userAgent, reward.CustomerID, customerCache)
		if err != nil {
			return SyncRequest{}, err
		}
		if !ok {
			continue
		}
		members = appendSmileMemberRefresh(members, seenMembers, customer)
		if event, ok := mapSmileRewardFulfillment(reward, customer); ok {
			events = append(events, event)
		}
	}
	nextCursor := smileCursorComplete
	if strings.TrimSpace(out.Metadata.NextCursor) != "" {
		nextCursor = encodeSmileRewardsCursorState(smileEventCursorState{Cursor: out.Metadata.NextCursor, UpdatedAtMin: state.UpdatedAtMin})
	}
	return SyncRequest{RunMode: "backfill", Members: members, Events: events, Cursor: nextCursor}, nil
}

func (b SmileRESTBackfiller) smileCustomerByID(ctx context.Context, client *http.Client, baseURL string, headers map[string]string, userAgent string, id int, cache map[int]smileCustomer) (smileCustomer, bool, error) {
	if id <= 0 {
		return smileCustomer{}, false, nil
	}
	if customer, ok := cache[id]; ok {
		return customer, true, nil
	}
	var out struct {
		Customer smileCustomer `json:"customer"`
	}
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v1/customers/"+strconv.Itoa(id), nil, headers, userAgent, &out); err != nil {
		return smileCustomer{}, false, err
	}
	if strings.TrimSpace(out.Customer.Email) == "" {
		return smileCustomer{}, false, nil
	}
	cache[id] = out.Customer
	return out.Customer, true, nil
}

func mapSmileCustomer(c smileCustomer) (MemberInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return MemberInput{}, false
	}
	return MemberInput{
		SourceID:      "smile://customer/" + strconv.Itoa(c.ID),
		Email:         email,
		FirstName:     strings.TrimSpace(c.FirstName),
		LastName:      strings.TrimSpace(c.LastName),
		PointsBalance: c.PointsBalance,
		VIPTier:       strings.TrimSpace(firstString(c.VIPTier.Name, c.VIPStatus.VIPTier.Name)),
		UpdatedAt:     parseSmileTime(firstString(c.UpdatedAt, c.CreatedAt)),
	}, true
}

func appendSmileMemberRefresh(out []MemberInput, seen map[string]bool, customer smileCustomer) []MemberInput {
	member, ok := mapSmileCustomer(customer)
	if !ok {
		return out
	}
	key := member.SourceID
	if key == "" {
		key = member.Email
	}
	if seen[key] {
		return out
	}
	seen[key] = true
	return append(out, member)
}

func mapSmilePointsTransaction(tx smilePointsTransaction, customer smileCustomer) (LoyaltyEventInput, bool) {
	member, ok := mapSmileCustomer(customer)
	if !ok || tx.ID <= 0 {
		return LoyaltyEventInput{}, false
	}
	eventName := smilePointsTransactionEventName(tx.PointsChange)
	props := map[string]any{
		"smile_customer_id":           tx.CustomerID,
		"smile_points_transaction_id": tx.ID,
	}
	if description := strings.TrimSpace(tx.Description); description != "" {
		props["description"] = description
	}
	return LoyaltyEventInput{
		SourceID:   "smile://points_transaction/" + strconv.Itoa(tx.ID),
		Email:      member.Email,
		EventName:  eventName,
		Points:     tx.PointsChange,
		VIPTier:    member.VIPTier,
		Properties: props,
		OccurredAt: parseSmileTime(firstString(tx.CreatedAt, tx.UpdatedAt)),
	}, true
}

func mapSmileRewardFulfillment(reward smileRewardFulfillment, customer smileCustomer) (LoyaltyEventInput, bool) {
	member, ok := mapSmileCustomer(customer)
	if !ok || reward.ID <= 0 {
		return LoyaltyEventInput{}, false
	}
	props := map[string]any{
		"smile_customer_id":               reward.CustomerID,
		"smile_reward_fulfillment_id":     reward.ID,
		"smile_fulfillment_status":        strings.TrimSpace(reward.FulfillmentStatus),
		"smile_reward_usage_status":       strings.TrimSpace(reward.UsageStatus),
		"smile_reward_expires_at":         strings.TrimSpace(reward.ExpiresAt),
		"smile_reward_used_at":            strings.TrimSpace(reward.UsedAt),
		"smile_reward_usage_instructions": strings.TrimSpace(reward.UsageInstructions),
	}
	if code := strings.TrimSpace(reward.Code); code != "" {
		props["reward_code"] = code
	}
	if terms := strings.TrimSpace(reward.TermsAndConditions); terms != "" {
		props["terms_and_conditions"] = terms
	}
	return LoyaltyEventInput{
		SourceID:   "smile://reward_fulfillment/" + strconv.Itoa(reward.ID),
		Email:      member.Email,
		EventName:  smileRewardFulfillmentEventName(reward),
		RewardID:   strconv.Itoa(reward.ID),
		RewardName: strings.TrimSpace(reward.Name),
		VIPTier:    member.VIPTier,
		Properties: props,
		OccurredAt: parseSmileTime(firstString(reward.UsedAt, reward.CreatedAt, reward.UpdatedAt)),
	}, true
}

func smilePointsTransactionEventName(points int) string {
	switch {
	case points > 0:
		return "loyalty.points_earned"
	case points < 0:
		return "loyalty.points_redeemed"
	default:
		return "loyalty.points_adjusted"
	}
}

func smileRewardFulfillmentEventName(reward smileRewardFulfillment) string {
	switch strings.ToLower(strings.TrimSpace(reward.UsageStatus)) {
	case "used":
		return "loyalty.reward_redeemed"
	}
	switch strings.ToLower(strings.TrimSpace(reward.FulfillmentStatus)) {
	case "cancelled":
		return "loyalty.reward_cancelled"
	case "failed":
		return "loyalty.reward_failed"
	case "pending":
		return "loyalty.reward_pending"
	default:
		return "loyalty.reward_issued"
	}
}

func smileIncrementalEventCursorState(integration Integration) smileEventCursorState {
	if integration.LastSyncAt == nil || integration.LastSyncAt.IsZero() {
		return smileEventCursorState{}
	}
	return smileEventCursorState{UpdatedAtMin: integration.LastSyncAt.UTC().Format(time.RFC3339)}
}

func normalizeSmileEventCursorState(state smileEventCursorState) smileEventCursorState {
	return smileEventCursorState{
		Cursor:       strings.TrimSpace(state.Cursor),
		UpdatedAtMin: strings.TrimSpace(state.UpdatedAtMin),
	}
}

func decodeSmilePointsCursor(cursor string) (string, bool) {
	state, ok := decodeSmilePointsCursorState(cursor)
	return state.Cursor, ok
}

func decodeSmilePointsCursorState(cursor string) (smileEventCursorState, bool) {
	return decodeSmileEventCursorState(cursor, smilePointsCursor, smilePointsPrefix)
}

func encodeSmilePointsCursor(cursor string) string {
	return encodeSmilePointsCursorState(smileEventCursorState{Cursor: cursor})
}

func encodeSmilePointsCursorState(state smileEventCursorState) string {
	return encodeSmileEventCursorState(state, smilePointsCursor, smilePointsPrefix)
}

func decodeSmileRewardsCursor(cursor string) (string, bool) {
	state, ok := decodeSmileRewardsCursorState(cursor)
	return state.Cursor, ok
}

func decodeSmileRewardsCursorState(cursor string) (smileEventCursorState, bool) {
	return decodeSmileEventCursorState(cursor, smileRewardsCursor, smileRewardsPrefix)
}

func encodeSmileRewardsCursor(cursor string) string {
	return encodeSmileRewardsCursorState(smileEventCursorState{Cursor: cursor})
}

func encodeSmileRewardsCursorState(state smileEventCursorState) string {
	return encodeSmileEventCursorState(state, smileRewardsCursor, smileRewardsPrefix)
}

func decodeSmileEventCursorState(cursor, bareCursor, prefix string) (smileEventCursorState, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == bareCursor {
		return smileEventCursorState{}, true
	}
	if !strings.HasPrefix(cursor, prefix) {
		return smileEventCursorState{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(cursor, prefix))
	if err != nil {
		return smileEventCursorState{}, true
	}
	var state smileEventCursorState
	if err := json.Unmarshal(raw, &state); err == nil && (state.Cursor != "" || state.UpdatedAtMin != "") {
		return normalizeSmileEventCursorState(state), true
	}
	return smileEventCursorState{Cursor: strings.TrimSpace(string(raw))}, true
}

func encodeSmileEventCursorState(state smileEventCursorState, bareCursor, prefix string) string {
	state = normalizeSmileEventCursorState(state)
	if state.Cursor == "" && state.UpdatedAtMin == "" {
		return bareCursor
	}
	if state.UpdatedAtMin == "" {
		return prefix + base64.RawURLEncoding.EncodeToString([]byte(state.Cursor))
	}
	raw, _ := json.Marshal(state)
	return prefix + base64.RawURLEncoding.EncodeToString(raw)
}

func parseSmileTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, value); err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	return nil
}

// ---------------- LoyaltyLion ----------------

const (
	loyaltyLionCursorPrefix   = "loyaltylion:"
	loyaltyLionCursorComplete = "loyaltylion:complete"
)

type LoyaltyLionCredentials struct {
	Token      string
	Secret     string
	APIBaseURL string
	UserAgent  string
}

type LoyaltyLionCredentialResolver interface {
	ResolveLoyaltyLion(ctx context.Context, tenantID string, integration Integration) (LoyaltyLionCredentials, error)
}

type loyaltyLionCredentialPayload struct {
	Token      string `json:"token"`
	Secret     string `json:"secret"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p loyaltyLionCredentialPayload) credentials() (LoyaltyLionCredentials, error) {
	token := strings.TrimSpace(p.Token)
	secret := strings.TrimSpace(p.Secret)
	if token == "" || secret == "" {
		return LoyaltyLionCredentials{}, fmt.Errorf("loyaltylion token and secret are required")
	}
	return LoyaltyLionCredentials{Token: token, Secret: secret, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type LoyaltyLionSecretsCredentialResolver struct {
	Secrets LoyaltyRuntimeSecretResolver
}

func (r LoyaltyLionSecretsCredentialResolver) ResolveLoyaltyLion(ctx context.Context, _ string, integration Integration) (LoyaltyLionCredentials, error) {
	if r.Secrets == nil {
		return LoyaltyLionCredentials{}, fmt.Errorf("loyaltylion credential resolver is not configured")
	}
	ref := loyaltyCredentialRef(integration)
	if ref == "" {
		return LoyaltyLionCredentials{}, fmt.Errorf("loyaltylion credentials_ref is required")
	}
	var payload loyaltyLionCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return LoyaltyLionCredentials{}, fmt.Errorf("resolve loyaltylion credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return LoyaltyLionCredentials{}, fmt.Errorf("loyaltylion requires a JSON {token, secret} secret")
}

type LoyaltyLionRESTBackfiller struct {
	HTTPClient  *http.Client
	Credentials LoyaltyLionCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type loyaltyLionCustomer struct {
	ID             int    `json:"id"`
	Email          string `json:"email"`
	PointsApproved int    `json:"points_approved"`
	TierMembership struct {
		Tier struct {
			Name string `json:"name"`
		} `json:"tier"`
	} `json:"loyalty_tier_membership"`
}

func (b LoyaltyLionRESTBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderLoyaltyLion {
		return SyncRequest{}, fmt.Errorf("loyaltylion backfill requires a LoyaltyLion integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("loyaltylion credential resolver is not configured")
	}
	page, done := loyaltyPageCursor(cursor, loyaltyLionCursorPrefix, loyaltyLionCursorComplete)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: loyaltyLionCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveLoyaltyLion(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := loyaltyEgressClient(b.HTTPClient, ProviderLoyaltyLion, 30*time.Second)
	perPage := loyaltyPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	query := url.Values{}
	query.Set("page", strconv.Itoa(page))
	query.Set("per_page", strconv.Itoa(perPage))

	var out struct {
		Customers []loyaltyLionCustomer `json:"customers"`
	}
	basic := base64.StdEncoding.EncodeToString([]byte(creds.Token + ":" + creds.Secret))
	headers := map[string]string{"Authorization": "Basic " + basic}
	baseURL := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), loyaltyLionDefaultAPIBaseURL)
	if err := loyaltyDoJSON(ctx, client, baseURL, "/v2/customers", query, headers, firstString(b.UserAgent, creds.UserAgent, loyaltyDefaultUserAgent), &out); err != nil {
		return SyncRequest{}, err
	}
	members := make([]MemberInput, 0, len(out.Customers))
	for _, c := range out.Customers {
		if mapped, ok := mapLoyaltyLionCustomer(c); ok {
			members = append(members, mapped)
		}
	}
	nextCursor := loyaltyLionCursorComplete
	if len(out.Customers) >= perPage {
		nextCursor = loyaltyLionCursorPrefix + strconv.Itoa(page+1)
	}
	return SyncRequest{RunMode: "backfill", Members: members, Cursor: nextCursor}, nil
}

func mapLoyaltyLionCustomer(c loyaltyLionCustomer) (MemberInput, bool) {
	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return MemberInput{}, false
	}
	return MemberInput{
		SourceID:      "loyaltylion://customer/" + strconv.Itoa(c.ID),
		Email:         email,
		PointsBalance: c.PointsApproved,
		VIPTier:       strings.TrimSpace(c.TierMembership.Tier.Name),
	}, true
}

// ---------------- shared ----------------

func loyaltyDoJSON(ctx context.Context, client *http.Client, baseURL, path string, query url.Values, headers map[string]string, userAgent string, out any) error {
	u, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return fmt.Errorf("parse loyalty API base URL: %w", err)
	}
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, loyaltyResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return LoyaltyRESTError{
			Operation:  "loyalty REST " + path,
			StatusCode: resp.StatusCode,
			RetryAfter: parseLoyaltyRetryAfter(resp.Header.Get("Retry-After")),
			Snippet:    loyaltyTruncate(string(body), 300),
		}
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode loyalty response %s: %w", path, err)
	}
	return nil
}

func parseLoyaltyRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	when, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	delay := time.Until(when)
	if delay <= 0 {
		return 0
	}
	return delay
}

func loyaltyTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
