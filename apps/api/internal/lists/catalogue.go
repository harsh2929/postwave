package lists

// catalogue.go — GET /api/v1/lists: Listmonk's list rows, seen through this
// tenant's list identities.
//
// The handler used to forward Listmonk's /api/lists response verbatim. Three
// things were wrong with that, and every list surface in every client
// inherited them:
//
//   - No row carried postwave_uuid. The mapping existed — Create persists it —
//     but nothing joined it, so every list's Overview read "Not mapped" and the
//     desktop Webhooks tab was disabled for every list. A row's own `uuid` is
//     Listmonk's list uuid, a third identity that must never be mistaken for
//     the Moosewave one; it is passed through untouched.
//   - subscriber_count was Listmonk's count of its own subscriber_lists, while
//     the Members tab — and campaign sends — use Moosewave's list_subscribers.
//     Nothing keeps the two stores in step, so a list's card read "0
//     subscribers" beside a Members tab listing its members. subscriber_count is
//     now the Moosewave member count, computed with the Members tab's own
//     predicate; Listmonk's numbers stay available as engine_subscriber_count
//     and engine_subscriber_statuses.
//   - No per_page was sent, so Listmonk returned its default page of 20 and
//     every list past the twentieth was missing from every picker.
//
// A row this tenant has no identity for is adopted when it is the sole tenant
// and hidden otherwise (see engine_tenancy.go). Decoration is all-or-nothing:
// if identities cannot be read the request fails rather than returning rows
// that look complete and are not.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// errCatalogueShape marks an engine catalogue response that is not the
// {"data":{"results":[...]}} envelope with positive integer ids.
var errCatalogueShape = errors.New("lists: engine catalogue response has an unexpected shape")

// catalogueIdentity is what this tenant knows about one engine list.
type catalogueIdentity struct {
	UUID    string
	Members int64
}

// cataloguePage is a decoded engine catalogue. Rows are kept as raw JSON
// field maps so every field Listmonk sends — including ones added in a later
// release — reaches the client unchanged except for the ones decorated here.
type cataloguePage struct {
	envelope  map[string]json.RawMessage
	data      map[string]json.RawMessage
	rows      []map[string]json.RawMessage
	engineIDs []int64
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	// ?q= / ?query= is forwarded as Listmonk's ?query= (a substring search
	// across name and description). The desktop UI sends `query`; older
	// callers send `q`.
	body, status, err := d.proxy(r, http.MethodGet, catalogueUpstreamPath(listsearch.ReadQuery(r.URL.Query())), nil)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if status < 200 || status > 299 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}
	page, err := decodeCataloguePage(body)
	if err != nil {
		// 502, not 500: the engine answered, with something this contract
		// cannot attribute. The detail stays in the log.
		d.logger().Error("lists catalogue: undecodable engine response",
			"tenant_id", tenant.ID, "upstream_status", status, "err", err)
		httperror.Write(w, http.StatusBadGateway, "upstream_invalid_response", httperror.MessageInternal)
		return
	}
	identities, err := d.catalogueIdentitiesWithAdoption(r.Context(), tenant.ID, page)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	out, hidden, err := page.project(identities)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if hidden > 0 {
		// Expected on a shared engine: other tenants' lists are here too.
		d.logger().Debug("lists catalogue: hid engine lists without an identity in this tenant",
			"tenant_id", tenant.ID, "hidden", hidden)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(out)
}

// catalogueIdentitiesWithAdoption reads this tenant's identities for the
// page's engine lists, adopting any the tenant has none for when it is the
// sole tenant.
func (d *Deps) catalogueIdentitiesWithAdoption(ctx context.Context, tenantID string, page *cataloguePage) (map[int64]catalogueIdentity, error) {
	identities, err := d.Repo.catalogueIdentities(ctx, tenantID, page.engineIDs)
	if err != nil {
		return nil, err
	}
	unmapped := make([]int64, 0)
	for _, id := range page.engineIDs {
		if _, ok := identities[id]; !ok {
			unmapped = append(unmapped, id)
		}
	}
	if len(unmapped) == 0 {
		return identities, nil
	}
	adopted, proven, err := d.Repo.adoptEngineLists(ctx, tenantID, unmapped)
	if err != nil {
		return nil, err
	}
	if !proven {
		return identities, nil
	}
	for _, identity := range adopted {
		audit.EmitOrLog(ctx, d.auditPool(), "list.identity_adopted", "list", identity.UUID, nil, nil,
			map[string]any{"engine_id": identity.EngineID, "reason": "sole_tenant_engine_list"})
	}
	// Re-read rather than merge: a concurrent catalogue read may have adopted
	// some of these ids first, and its uuid is the one that won.
	return d.Repo.catalogueIdentities(ctx, tenantID, page.engineIDs)
}

// catalogueUpstreamPath asks the engine for its whole catalogue.
func catalogueUpstreamPath(query string) string {
	params := url.Values{}
	params.Set("per_page", "all")
	if query != "" {
		params.Set("query", query)
	}
	return "/api/lists?" + params.Encode()
}

func decodeCataloguePage(body []byte) (*cataloguePage, error) {
	page := &cataloguePage{}
	if err := json.Unmarshal(body, &page.envelope); err != nil || page.envelope == nil {
		return nil, fmt.Errorf("%w: envelope: %v", errCatalogueShape, err)
	}
	rawData, ok := page.envelope["data"]
	if !ok {
		return nil, fmt.Errorf("%w: no data object", errCatalogueShape)
	}
	if err := json.Unmarshal(rawData, &page.data); err != nil || page.data == nil {
		return nil, fmt.Errorf("%w: data: %v", errCatalogueShape, err)
	}
	if rawResults, ok := page.data["results"]; ok {
		if err := json.Unmarshal(rawResults, &page.rows); err != nil {
			return nil, fmt.Errorf("%w: results: %v", errCatalogueShape, err)
		}
	}
	page.engineIDs = make([]int64, 0, len(page.rows))
	for i, row := range page.rows {
		var id int64
		if err := json.Unmarshal(row["id"], &id); err != nil || id <= 0 {
			return nil, fmt.Errorf("%w: row %d has no positive integer id", errCatalogueShape, i)
		}
		page.engineIDs = append(page.engineIDs, id)
	}
	return page, nil
}

// project decorates the rows this tenant has an identity for, drops the rest,
// and re-encodes the envelope. It returns the number of rows dropped.
func (p *cataloguePage) project(identities map[int64]catalogueIdentity) ([]byte, int, error) {
	kept := make([]map[string]json.RawMessage, 0, len(p.rows))
	for i, row := range p.rows {
		identity, ok := identities[p.engineIDs[i]]
		if !ok {
			continue
		}
		if engineCount, present := row["subscriber_count"]; present {
			row["engine_subscriber_count"] = engineCount
		}
		if engineStatuses, present := row["subscriber_statuses"]; present {
			row["engine_subscriber_statuses"] = engineStatuses
			delete(row, "subscriber_statuses")
		}
		members, err := json.Marshal(identity.Members)
		if err != nil {
			return nil, 0, err
		}
		row["subscriber_count"] = members
		postwaveUUID, err := json.Marshal(identity.UUID)
		if err != nil {
			return nil, 0, err
		}
		row["postwave_uuid"] = postwaveUUID
		kept = append(kept, row)
	}
	results, err := json.Marshal(kept)
	if err != nil {
		return nil, 0, err
	}
	p.data["results"] = results
	total, err := json.Marshal(len(kept))
	if err != nil {
		return nil, 0, err
	}
	p.data["total"] = total
	data, err := json.Marshal(p.data)
	if err != nil {
		return nil, 0, err
	}
	p.envelope["data"] = data
	out, err := json.Marshal(p.envelope)
	if err != nil {
		return nil, 0, err
	}
	return out, len(p.rows) - len(kept), nil
}

// catalogueIdentities returns this tenant's live identity and active member
// count for each of engineIDs that has one. Retired identities (deleted lists)
// are invisible to the application role and therefore absent.
//
// Every list picker reads this route, so each count must stay cheap: both of
// its sides can be answered by index-only scans, of the partial index of
// active memberships (list_subscribers_active_list_idx, migration 2051) and of
// the subscribers (tenant_id, id) index.
func (r *Repo) catalogueIdentities(ctx context.Context, tenantID string, engineIDs []int64) (map[int64]catalogueIdentity, error) {
	out := make(map[int64]catalogueIdentity, len(engineIDs))
	if len(engineIDs) == 0 {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT m.listmonk_bigint_id,
       m.postwave_uuid::text,
       (SELECT count(*)
          FROM `+activeMembersFrom+`
         WHERE ls.tenant_id = m.tenant_id
           AND ls.list_id = m.postwave_uuid
           AND `+activeMemberPredicate+`)
  FROM list_id_map m
 WHERE m.tenant_id = $1::uuid
   AND m.listmonk_bigint_id = ANY($2::bigint[])`, tenantID, engineIDs)
	if err != nil {
		return nil, fmt.Errorf("lists: read catalogue identities: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var engineID int64
		var identity catalogueIdentity
		if err := rows.Scan(&engineID, &identity.UUID, &identity.Members); err != nil {
			return nil, fmt.Errorf("lists: scan catalogue identity: %w", err)
		}
		out[engineID] = identity
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lists: read catalogue identities: %w", err)
	}
	return out, tx.Commit(ctx)
}

func (d *Deps) logger() *slog.Logger {
	if d != nil && d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}
