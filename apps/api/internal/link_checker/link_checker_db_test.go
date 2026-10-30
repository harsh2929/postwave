// SPDX-License-Identifier: AGPL-3.0-only

package link_checker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The Links row of the send review said "No links found in the saved body —
// nothing was checked" for a draft whose Button block linked to a live page:
// the sweep read campaigns.body, the archive's copy, which no draft has.
// These drive POST /api/v1/campaigns/{id}/check-links against saved campaign
// rows, as the RLS-bound application role.

func linkCheckerDB(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping link checker database proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type linkFixture struct {
	pool     *db.Pool
	tenantID string
}

func newLinkFixture(t *testing.T) linkFixture {
	t.Helper()
	pool := linkCheckerDB(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'link checker', $2, 'studio')`, tenantID, "link-checker-"+tenantID[:8]); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			t.Errorf("cleanup tx: %v", err)
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		for _, stmt := range []string{
			`DELETE FROM campaign_variants WHERE tenant_id = $1::uuid`,
			`DELETE FROM campaigns WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := cleanup.Exec(context.Background(), stmt, tenantID); err != nil {
				t.Errorf("cleanup: %v", err)
				return
			}
		}
		_ = cleanup.Commit(context.Background())
	})
	return linkFixture{pool: pool, tenantID: tenantID}
}

// draft inserts a draft campaign. body (the archive copy) is left NULL, as it
// is for every campaign that has not been published to the archive.
func (f linkFixture) draft(t *testing.T, sourceMode, bodyHTML, plainText, contentBlocks, variants string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	schemaVersion := 1
	if sourceMode == semanticSourceMode {
		schemaVersion = 2
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, plain_text,
                       source_mode, content_schema_version, content_blocks, variants)
VALUES ($1::uuid, 'links', 'Links', 'draft', NULLIF($2, ''), NULLIF($3, ''),
        $4, $5, $6::jsonb, $7::jsonb)
RETURNING id::text`, f.tenantID, bodyHTML, plainText, sourceMode, schemaVersion, contentBlocks, variants).Scan(&id); err != nil {
		t.Fatalf("insert draft: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit draft: %v", err)
	}
	return id
}

// variant inserts an A/B variant the way the A/B test editor stores one: a
// campaign_variants row, which is what the send path joins for each
// recipient's body.
func (f linkFixture) variant(t *testing.T, campaignID, label, bodyHTML string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_variants (campaign_id, tenant_id, variant_label, subject, body_html)
VALUES ($1::uuid, $2::uuid, $3, $3, NULLIF($4, ''))`, campaignID, f.tenantID, label, bodyHTML); err != nil {
		t.Fatalf("insert variant %s: %v", label, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit variant: %v", err)
	}
}

func (f linkFixture) check(t *testing.T, client *http.Client, campaignID string) []Result {
	t.Helper()
	d := &Deps{Pool: f.pool, Client: client}
	r := chi.NewRouter()
	d.MountRoutes(r)
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: f.tenantID})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/campaigns/"+campaignID+"/check-links", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("check-links: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var results []Result
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("decode results: %v", err)
	}
	return results
}

// linkSite answers 200 for every path except those ending in /missing (404),
// /no-head (405 to HEAD, 200 to GET) and /bot-rule (403 to HEAD, as a CDN bot
// rule might, 200 to GET), recording the paths it was asked for.
type linkSite struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
}

func newLinkSite(t *testing.T) *linkSite {
	t.Helper()
	site := &linkSite{}
	site.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site.mu.Lock()
		site.paths = append(site.paths, r.Method+" "+r.URL.Path)
		site.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/missing"):
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/no-head" && r.Method == http.MethodHead:
			w.WriteHeader(http.StatusMethodNotAllowed)
		case r.URL.Path == "/bot-rule" && r.Method == http.MethodHead:
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(site.Close)
	return site
}

func byURL(results []Result) map[string]Result {
	out := make(map[string]Result, len(results))
	for _, r := range results {
		out[r.URL] = r
	}
	return out
}

// A block-editor draft saves its Button block into body_html. That is what is
// sent, so that is what is checked — along with every link in the plain-text
// part and in each A/B variant's own body.
//
// The variant bodies recipients receive are campaign_variants rows. The
// campaigns.variants JSON is passthrough the send path never reads, so a link
// that lives only there is not sent and must not be checked (or reported).
func TestCheckLinksReadsTheSavedDraftBodyAndVariants(t *testing.T) {
	f := newLinkFixture(t)
	site := newLinkSite(t)
	unsent, _ := json.Marshal([]map[string]any{{
		"id": "b", "subject": "B", "body_html": `<p><a href="` + site.URL + `/unsent">B</a></p>`,
	}})
	id := f.draft(t, "legacy_html",
		`<table><tr><td><a href="`+site.URL+`/button" class="btn">Shop now</a></td></tr></table>`+
			`<p><a href="`+site.URL+`/missing">Old offer</a> · <a href="{{ unsubscribe_url }}">Unsubscribe</a></p>`,
		"Shop now: "+site.URL+"/button\nRead the story at "+site.URL+"/story.\nPersonal page: "+site.URL+"/u/{{ .Subscriber.UUID }}",
		`[{"type":"button","url":"`+site.URL+`/button"}]`, string(unsent))
	f.variant(t, id, "A", "")
	f.variant(t, id, "B", `<p><a href="`+site.URL+`/variant">B</a> or <a href="`+site.URL+`/variant/missing">the old page</a></p>`)

	results := byURL(f.check(t, &http.Client{}, id))

	for _, path := range []string{"/button", "/story", "/variant"} {
		if r, ok := results[site.URL+path]; !ok || !r.OK || r.Status != http.StatusOK {
			t.Fatalf("%s: result %+v (present=%t), want a 200 OK; all results: %+v", path, r, ok, results)
		}
	}
	for _, path := range []string{"/missing", "/variant/missing"} {
		if r, ok := results[site.URL+path]; !ok || r.OK || r.Status != http.StatusNotFound {
			t.Fatalf("%s = %+v (present=%t), want a broken 404", path, r, ok)
		}
	}
	if r, ok := results[site.URL+"/unsent"]; ok {
		t.Fatalf("/unsent = %+v: a link only campaigns.variants holds is never sent and must not be checked", r)
	}
	if len(results) != 5 {
		t.Fatalf("results = %+v, want exactly the five sent, absolute, non-personalized links", results)
	}
	site.mu.Lock()
	defer site.mu.Unlock()
	for _, p := range site.paths {
		if strings.HasSuffix(p, " /unsent") {
			t.Fatalf("requested %q; paths: %v", p, site.paths)
		}
	}
}

// A semantic campaign persists its node tree, not HTML; the tree is walked.
func TestCheckLinksWalksASemanticCampaignsNodes(t *testing.T) {
	f := newLinkFixture(t)
	site := newLinkSite(t)
	nodes := `[{"id":"blk_cta","type":"action","role":"primary_action","version":2,` +
		`"content":{"action":{"action_id":"act_go","label":"Go","canonical_url":"` + site.URL + `/semantic"}},` +
		`"conditions":[],"localizations":{},"provenance":{"source":"user"}}]`
	id := f.draft(t, semanticSourceMode, "", "", nodes, `[]`)

	results := f.check(t, &http.Client{}, id)

	if len(results) != 1 || results[0].URL != site.URL+"/semantic" || !results[0].OK {
		t.Fatalf("results = %+v, want the action's canonical URL checked OK", results)
	}
}

// Sites that refuse HEAD — outright (405) or through a CDN bot rule (403) —
// serve the page to every reader who clicks, so neither answer may call the
// link broken. A link that is really gone still fails on the GET.
func TestCheckLinksRetriesAFailingHEADAsGET(t *testing.T) {
	f := newLinkFixture(t)
	site := newLinkSite(t)
	id := f.draft(t, "legacy_html",
		`<a href="`+site.URL+`/no-head">page</a> <a href="`+site.URL+`/bot-rule">shop</a> <a href="`+site.URL+`/gone/missing">old</a>`,
		"", `[]`, `[]`)

	results := byURL(f.check(t, &http.Client{}, id))

	for _, path := range []string{"/no-head", "/bot-rule"} {
		if r := results[site.URL+path]; !r.OK || r.Status != http.StatusOK {
			t.Fatalf("%s = %+v, want a 200 from the GET retry", path, r)
		}
	}
	if r := results[site.URL+"/gone/missing"]; r.OK || r.Status != http.StatusNotFound {
		t.Fatalf("/gone/missing = %+v, want broken: the GET retry must confirm, not excuse", r)
	}
	site.mu.Lock()
	defer site.mu.Unlock()
	if !slices.Contains(site.paths, "GET /gone/missing") {
		t.Fatalf("paths = %v, want the missing link confirmed by a GET", site.paths)
	}
}

// A link the sweep cannot reach is explained in the sender's terms, and the
// explanation never carries what the transport saw: the resolver's address or
// the internal address a name resolved to.
func TestCheckLinksExplainsFailuresWithoutNetworkInternals(t *testing.T) {
	f := newLinkFixture(t)
	site := newLinkSite(t)
	id := f.draft(t, "legacy_html",
		`<a href="http://no-such-host.invalid/page">gone</a> <a href="`+site.URL+`/internal">internal</a>`,
		"", `[]`, `[]`)

	// The production client: loopback destinations are refused at dial time.
	results := byURL(f.check(t, nil, id))

	gone := results["http://no-such-host.invalid/page"]
	if gone.OK || gone.Error != "The link's domain doesn't exist." {
		t.Fatalf("unresolvable link = %+v, want the not-found explanation", gone)
	}
	internal := results[site.URL+"/internal"]
	if internal.OK || internal.Error == "" {
		t.Fatalf("loopback link = %+v, want a refused, explained result", internal)
	}
	for _, r := range results {
		for _, leak := range []string{"127.0.0.1", "lookup", "dial tcp", ":53", "private or reserved"} {
			if strings.Contains(r.Error, leak) {
				t.Fatalf("result for %s leaks %q: %q", r.URL, leak, r.Error)
			}
		}
	}
	site.mu.Lock()
	defer site.mu.Unlock()
	if len(site.paths) != 0 {
		t.Fatalf("the SSRF-safe client reached a loopback server: %v", site.paths)
	}
}

func TestCheckLinksAnswersNotFoundForAnotherTenantsCampaign(t *testing.T) {
	owner := newLinkFixture(t)
	stranger := newLinkFixture(t)
	id := owner.draft(t, "legacy_html", `<a href="https://example.test/">x</a>`, "", `[]`, `[]`)

	d := &Deps{Pool: stranger.pool, Client: &http.Client{}}
	r := chi.NewRouter()
	d.MountRoutes(r)
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: stranger.tenantID})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/campaigns/"+id+"/check-links", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s, want 404 for a campaign in another workspace", rec.Code, rec.Body.String())
	}
}
