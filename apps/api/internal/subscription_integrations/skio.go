// SPDX-License-Identifier: AGPL-3.0-only
//
// skio.go — native Skio provider runtime.
//
// Skio is the modern Shopify subscription platform (the Recharge challenger).
// Unlike Recharge's REST API, Skio exposes a Hasura GraphQL endpoint, so this
// puller POSTs a GraphQL query (limit/offset pagination) rather than a REST GET
// — the GraphQL shape is the only twist. It lands canonical SubscriptionInput
// rows dispatched via Deps.providerPull, exactly like Recharge.
package subscription_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	skioDefaultAPIBaseURL = "https://graphql.skio.com/v1/graphql"
	skioDefaultUserAgent  = "Moosewave Skio Integration"
	skioResponseMaxBytes  = 8 << 20
	skioDefaultPageSize   = 100
	skioMaxPageSize       = 250
	skioCursorPrefix      = "skio:"
	skioCursorComplete    = "skio:complete"

	skioSubscriptionsQuery = `query Subscriptions($limit: Int!, $offset: Int!) {
  Subscriptions(limit: $limit, offset: $offset, order_by: {updatedAt: desc}) {
    id
    status
    StorefrontUser { email }
  }
}`
)

type SkioCredentials struct {
	APIKey     string
	APIBaseURL string
	UserAgent  string
}

type SkioCredentialResolver interface {
	ResolveSkio(ctx context.Context, tenantID string, integration Integration) (SkioCredentials, error)
}

type skioCredentialPayload struct {
	APIKey     string `json:"api_key"`
	Token      string `json:"token"`
	APIBaseURL string `json:"api_base_url"`
	UserAgent  string `json:"user_agent"`
}

func (p skioCredentialPayload) credentials() (SkioCredentials, error) {
	key := strings.TrimSpace(firstString(p.APIKey, p.Token))
	if key == "" {
		return SkioCredentials{}, fmt.Errorf("skio api_key is required")
	}
	return SkioCredentials{APIKey: key, APIBaseURL: strings.TrimRight(strings.TrimSpace(p.APIBaseURL), "/"), UserAgent: strings.TrimSpace(p.UserAgent)}, nil
}

type SkioSecretsCredentialResolver struct {
	Secrets SubscriptionRuntimeSecretResolver
}

func (r SkioSecretsCredentialResolver) ResolveSkio(ctx context.Context, _ string, integration Integration) (SkioCredentials, error) {
	if r.Secrets == nil {
		return SkioCredentials{}, fmt.Errorf("skio credential resolver is not configured")
	}
	ref := strings.TrimSpace(firstString(integration.CredentialsRef, settingString(integration.Settings, "credentials_ref")))
	if ref == "" {
		return SkioCredentials{}, fmt.Errorf("skio credentials_ref is required")
	}
	var payload skioCredentialPayload
	if err := r.Secrets.GetJSON(ctx, ref, &payload); err == nil {
		if creds, cerr := payload.credentials(); cerr == nil {
			return creds, nil
		}
	}
	raw, err := r.Secrets.Get(ctx, ref)
	if err != nil {
		return SkioCredentials{}, fmt.Errorf("resolve skio credentials %q: %w", ref, err)
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "{") {
		if err := json.Unmarshal([]byte(raw), &payload); err == nil {
			if creds, cerr := payload.credentials(); cerr == nil {
				return creds, nil
			}
		}
	}
	return skioCredentialPayload{APIKey: raw}.credentials()
}

type SkioBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type SkioGraphQLBackfiller struct {
	HTTPClient  *http.Client
	Credentials SkioCredentialResolver
	APIBaseURL  string
	UserAgent   string
	PageSize    int
}

type skioSubscription struct {
	ID             string `json:"id"`
	Status         string `json:"status"`
	StorefrontUser struct {
		Email string `json:"email"`
	} `json:"StorefrontUser"`
}

func (b SkioGraphQLBackfiller) BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	if integration.Provider != ProviderSkio {
		return SyncRequest{}, fmt.Errorf("skio backfill requires a Skio integration")
	}
	if b.Credentials == nil {
		return SyncRequest{}, fmt.Errorf("skio credential resolver is not configured")
	}
	offset, done := skioOffsetCursor(cursor)
	if done {
		return SyncRequest{RunMode: "backfill", Cursor: skioCursorComplete}, nil
	}
	creds, err := b.Credentials.ResolveSkio(ctx, tenantID, integration)
	if err != nil {
		return SyncRequest{}, err
	}
	client := subscriptionEgressClient(b.HTTPClient, ProviderSkio, 30*time.Second)
	limit := skioPageSize(firstString(settingString(integration.Settings, "page_size"), strconv.Itoa(b.PageSize)))
	endpoint := firstString(strings.TrimRight(b.APIBaseURL, "/"), strings.TrimRight(creds.APIBaseURL, "/"), skioDefaultAPIBaseURL)

	var out struct {
		Data struct {
			Subscriptions []skioSubscription `json:"Subscriptions"`
		} `json:"data"`
	}
	variables := map[string]any{"limit": limit, "offset": offset}
	if err := skioDoGraphQL(ctx, client, endpoint, creds, b.UserAgent, skioSubscriptionsQuery, variables, &out); err != nil {
		return SyncRequest{}, err
	}
	subs := make([]SubscriptionInput, 0, len(out.Data.Subscriptions))
	for _, s := range out.Data.Subscriptions {
		if mapped, ok := mapSkioSubscription(s); ok {
			subs = append(subs, mapped)
		}
	}
	nextCursor := skioCursorComplete
	if len(out.Data.Subscriptions) >= limit {
		nextCursor = skioCursorPrefix + strconv.Itoa(offset+limit)
	}
	return SyncRequest{RunMode: "backfill", Subscriptions: subs, Cursor: nextCursor}, nil
}

func mapSkioSubscription(s skioSubscription) (SubscriptionInput, bool) {
	email := strings.ToLower(strings.TrimSpace(s.StorefrontUser.Email))
	if email == "" {
		return SubscriptionInput{}, false
	}
	id := strings.TrimSpace(s.ID)
	return SubscriptionInput{
		SourceID:       "skio://subscription/" + id,
		Email:          email,
		SubscriptionID: id,
		Status:         strings.ToLower(strings.TrimSpace(s.Status)),
		Properties:     map[string]any{"skio_subscription_id": id},
	}, true
}

func skioDoGraphQL(ctx context.Context, client *http.Client, endpoint string, creds SkioCredentials, userAgent, query string, variables map[string]any, out any) error {
	payload, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", skioAuthorization(creds.APIKey))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", firstString(userAgent, creds.UserAgent, skioDefaultUserAgent))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, skioResponseMaxBytes))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("skio graphql failed %d: %s", resp.StatusCode, skioTruncate(string(body), 500))
	}
	// GraphQL returns 200 with an `errors` array on failure; surface it.
	var envelope struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && len(envelope.Errors) > 0 {
		msgs := make([]string, 0, len(envelope.Errors))
		for _, e := range envelope.Errors {
			msgs = append(msgs, e.Message)
		}
		return fmt.Errorf("skio graphql error: %s", strings.Join(msgs, "; "))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode skio response: %w", err)
	}
	return nil
}

// skioAuthorization formats the API key as Skio's required "API <token>"
// Authorization header, tolerating a key that already carries the prefix.
func skioAuthorization(apiKey string) string {
	key := strings.TrimSpace(apiKey)
	if key == "" {
		return ""
	}
	if strings.HasPrefix(key, "API ") {
		return key
	}
	return "API " + key
}

func skioOffsetCursor(cursor string) (int, bool) {
	cursor = strings.TrimSpace(cursor)
	if cursor == skioCursorComplete {
		return 0, true
	}
	if cursor == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(cursor, skioCursorPrefix))
	if err != nil || n < 0 {
		return 0, false
	}
	return n, false
}

func skioPageSize(raw string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(raw))
	if n <= 0 {
		return skioDefaultPageSize
	}
	if n > skioMaxPageSize {
		return skioMaxPageSize
	}
	return n
}

func skioTruncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}
