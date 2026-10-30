// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-053 — DSAR fan-out automation across connected stores.
//
// When an ACCESS request is created with fan-out enabled, this orchestrator:
//   1. enumerates the tenant's connected commerce stores (commerce_integrations),
//   2. for each integration, searches the provider for the data subject by email
//      (via the store_adapters sub-package),
//   3. returns the matching data as a read-only receipt. Legacy auto-delete
//      policy is deliberately ignored for access requests,
//   4. returns a per-store response list that the caller (sar.Create / the
//      subscriber data-export wrapper) merges into the SAR bundle under
//      "store_responses" AND persists into dsar_store_responses (0537).
//
// Provider clients do not use the transaction, although the current
// synchronous handler keeps its transaction open while collection runs. The
// returned StoreResponse slice is persisted by PersistStoreResponses so the
// receipts commit atomically with the bundle.
//
// Adapter resolution is indirected through adapterFor (a package var) so tests
// can inject fakes without standing up provider HTTP servers.

package sar

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/sar/store_adapters"
)

// StoreResponse is one per-store DSAR outcome. It is both the bundle entry
// (merged under store_responses) and the row shape persisted to
// dsar_store_responses.
type StoreResponse struct {
	Provider      string         `json:"provider"`
	Status        string         `json:"status"` // found|returned|deleted|ack_required|not_found|error
	FoundCustomer string         `json:"customer_id,omitempty"`
	ActionTaken   string         `json:"action_taken"` // return_only|auto_delete|ack_required|none
	ReceiptURL    string         `json:"receipt_url,omitempty"`
	ResponseBody  map[string]any `json:"response,omitempty"`
}

// dsarPolicy is the per-provider decision read from dsar_policies. Absent =>
// the conservative default (return-only, no auto-delete, no ack).
type dsarPolicy struct {
	policyType  string
	autoDelete  bool
	ackRequired bool
	expired     bool
}

// adapterFor resolves a provider name to an Adapter. Indirected as a var so
// tests can swap in fakes.
var adapterFor = store_adapters.For

// FanoutToStores runs an explicitly typed DSAR fan-out for a subject email
// across the tenant's connected stores and returns the per-store responses.
// It uses the supplied
// tx only to READ commerce_integrations + dsar_policies (both tenant-scoped);
// the provider network calls are made with the adapters' own HTTP clients.
//
// Errors enumerating integrations are returned; per-store failures are
// captured as an "error" StoreResponse rather than aborting the whole fan-out,
// so one broken store does not block the rest of the DSAR.
func FanoutToStores(ctx context.Context, tx pgx.Tx, tenantID, email, kind string) ([]StoreResponse, error) {
	if kind != kindAccess && kind != kindErase {
		return nil, fmt.Errorf("unsupported DSAR kind %q", kind)
	}
	integrations, err := loadConnectedStores(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if len(integrations) == 0 {
		return []StoreResponse{}, nil
	}
	// Access collection must not even consult destructive policy. Erasure
	// policy remains available to the internal operation-specific helper for a
	// future durable provider-erasure worker; the synchronous HTTP endpoint
	// currently rejects erase+fanout.
	policies := map[string]dsarPolicy{}
	if kind == kindErase {
		policies = loadDSARPolicies(ctx, tx, tenantID)
	}

	out := make([]StoreResponse, 0, len(integrations))
	for _, integ := range integrations {
		out = append(out, fanoutOne(ctx, kind, integ, policies[integ.provider], email))
	}
	return out, nil
}

type storeIntegration struct {
	provider    string
	shopDomain  string
	accessToken string
	apiSecret   string
}

// fanoutOne runs one operation-specific store lookup. Access always returns
// before destructive policy is evaluated, which makes DeleteCustomer
// unreachable even when a legacy auto_delete policy is present.
func fanoutOne(ctx context.Context, kind string, integ storeIntegration, policy dsarPolicy, email string) StoreResponse {
	resp := StoreResponse{Provider: integ.provider, ActionTaken: "none"}
	adapter, err := adapterFor(integ.provider)
	if err != nil {
		resp.Status = "error"
		resp.ResponseBody = map[string]any{"error": err.Error()}
		return resp
	}
	cfg := store_adapters.Config{
		ShopDomain:  integ.shopDomain,
		AccessToken: integ.accessToken,
		APISecret:   integ.apiSecret,
	}
	match, err := adapter.SearchCustomer(ctx, cfg, email)
	if err != nil {
		resp.Status = "error"
		resp.ResponseBody = map[string]any{"error": err.Error()}
		return resp
	}
	if !match.Found {
		resp.Status = "not_found"
		return resp
	}
	resp.FoundCustomer = match.CustomerID
	resp.ResponseBody = match.Raw
	if kind == kindAccess {
		resp.Status = "returned"
		resp.ActionTaken = "return_only"
		return resp
	}
	if kind != kindErase {
		resp.Status = "error"
		resp.ResponseBody = map[string]any{"error": "unsupported DSAR operation"}
		return resp
	}

	// Erasure-only policy path. The synchronous HTTP endpoint does not invoke
	// this path; it is retained for a future reviewed provider-erasure worker.
	if policy.autoDelete && !policy.expired {
		if policy.ackRequired {
			// Destructive action held pending an explicit operator ack.
			resp.Status = "ack_required"
			resp.ActionTaken = "ack_required"
			return resp
		}
		del, derr := adapter.DeleteCustomer(ctx, cfg, match.CustomerID)
		if derr != nil {
			resp.Status = "error"
			resp.ActionTaken = "auto_delete"
			resp.ResponseBody = map[string]any{"error": derr.Error()}
			return resp
		}
		resp.Status = "deleted"
		resp.ActionTaken = "auto_delete"
		resp.ReceiptURL = del.ReceiptURL
		if del.Raw != nil {
			resp.ResponseBody = del.Raw
		}
		return resp
	}

	// Default: return-only — the data is exported into the bundle, nothing
	// destructive happens at the store.
	resp.Status = "returned"
	resp.ActionTaken = "return_only"
	return resp
}

// loadConnectedStores enumerates the tenant's connected commerce integrations.
// Best-effort: a missing table (older deploy) yields an empty slice rather than
// failing the SAR.
func loadConnectedStores(ctx context.Context, tx pgx.Tx, tenantID string) ([]storeIntegration, error) {
	if _, err := tx.Exec(ctx, "SAVEPOINT dsar_stores"); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT provider,
       COALESCE(shop_domain, ''),
       COALESCE(settings ->> 'access_token', ''),
       COALESCE(settings ->> 'api_secret', '')
  FROM commerce_integrations
 WHERE tenant_id = $1::uuid
   AND status = 'connected'
 ORDER BY provider`, tenantID)
	if err != nil {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT dsar_stores")
		return []storeIntegration{}, nil
	}
	defer rows.Close()
	out := []storeIntegration{}
	for rows.Next() {
		var s storeIntegration
		if err := rows.Scan(&s.provider, &s.shopDomain, &s.accessToken, &s.apiSecret); err != nil {
			continue
		}
		out = append(out, s)
	}
	rows.Close()
	_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT dsar_stores")
	return out, nil
}

// loadDSARPolicies reads the tenant's per-provider DSAR policies. Best-effort —
// a missing table yields an empty map, so every provider falls back to the
// conservative return-only default.
func loadDSARPolicies(ctx context.Context, tx pgx.Tx, tenantID string) map[string]dsarPolicy {
	out := map[string]dsarPolicy{}
	if _, err := tx.Exec(ctx, "SAVEPOINT dsar_policies"); err != nil {
		return out
	}
	rows, err := tx.Query(ctx, `
SELECT provider, policy_type, auto_delete, ack_required,
       (expires_at IS NOT NULL AND expires_at < now()) AS expired
  FROM dsar_policies
 WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT dsar_policies")
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var provider string
		var p dsarPolicy
		if err := rows.Scan(&provider, &p.policyType, &p.autoDelete, &p.ackRequired, &p.expired); err != nil {
			continue
		}
		out[provider] = p
	}
	rows.Close()
	_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT dsar_policies")
	return out
}

// PersistStoreResponses writes the per-store DSAR receipts into
// dsar_store_responses, inside the supplied (SAR) tx, so the receipts commit
// atomically with the bundle. requestID is the sar_bundles id.
func PersistStoreResponses(ctx context.Context, tx pgx.Tx, tenantID, requestID string, responses []StoreResponse) error {
	for _, r := range responses {
		payload, _ := json.Marshal(nonNilStoreMap(r.ResponseBody))
		if _, err := tx.Exec(ctx, `
INSERT INTO dsar_store_responses
       (tenant_id, request_id, provider, customer_id, status, receipt_url, response_payload)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
			tenantID, requestID, r.Provider, r.FoundCustomer, r.Status, r.ReceiptURL, string(payload)); err != nil {
			return err
		}
	}
	return nil
}

func nonNilStoreMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// StoreResponseRow is one persisted dsar_store_responses row, returned by the
// admin read endpoint.
type StoreResponseRow struct {
	ID           string         `json:"id"`
	Provider     string         `json:"provider"`
	CustomerID   string         `json:"customer_id,omitempty"`
	Status       string         `json:"status"`
	ReceiptURL   string         `json:"receipt_url,omitempty"`
	ResponseBody map[string]any `json:"response,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
}

// listStoreResponses reads the persisted per-store receipts for a SAR request.
func listStoreResponses(ctx context.Context, tx pgx.Tx, tenantID, requestID string) ([]StoreResponseRow, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, provider, customer_id, status, receipt_url,
       COALESCE(response_payload::text, '{}'), created_at
  FROM dsar_store_responses
 WHERE tenant_id = $1::uuid AND request_id = $2::uuid
 ORDER BY provider`, tenantID, requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StoreResponseRow{}
	for rows.Next() {
		var r StoreResponseRow
		var payload string
		if err := rows.Scan(&r.ID, &r.Provider, &r.CustomerID, &r.Status, &r.ReceiptURL, &payload, &r.CreatedAt); err != nil {
			continue
		}
		if strings.TrimSpace(payload) != "" {
			_ = json.Unmarshal([]byte(payload), &r.ResponseBody)
		}
		out = append(out, r)
	}
	return out, nil
}
