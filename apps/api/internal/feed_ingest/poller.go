// SPDX-License-Identifier: AGPL-3.0-only
//
// poller.go — executes one feed poll (fetch → parse → dedupe → draft
// campaign) plus the background Scheduler that runs due daily/weekly
// sources (mirrors audience_destinations' sync_scheduler).
//
// DRAFTS ONLY — the poller NEVER sends. Every batch of new items
// becomes one DRAFT digest campaign the operator reviews and sends by
// hand. Auto-send ("poll → schedule immediately") is a deliberate
// future opt-in that must ship with its own guardrails (quiet hours,
// frequency caps, pre-send checklist); do not flip drafts to scheduled
// here.
package feed_ingest

import (
	"context"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// maxFeedBytes caps the fetched document so a hostile/buggy feed can't
// balloon memory. 2 MiB comfortably covers real newsletters' feeds.
const maxFeedBytes = 2 << 20

// maxDigestItems bounds one draft so a first poll against a deep
// archive produces a reviewable digest, not a 500-item monster.
const maxDigestItems = 20

// DraftCampaign is the narrow shape feed_ingest hands to the campaigns
// layer. ListID/SegmentID mirror campaigns' audience contract
// (audience_list_id bigint as string / segment uuid).
type DraftCampaign struct {
	Name      string
	Subject   string
	BodyHTML  string
	ListID    string
	SegmentID string
}

// CampaignCreator creates a DRAFT campaign and returns its id. main.go
// provides an adapter over campaigns.Repo (Create + SetABTestAudience
// for the audience columns) so this package never imports campaigns.
type CampaignCreator interface {
	CreateDraft(ctx context.Context, tenantID string, draft DraftCampaign) (campaignID string, err error)
}

// CampaignCreatorFunc adapts a closure to CampaignCreator (main.go
// wires a closure over campaigns.Repo so this package never imports
// campaigns).
type CampaignCreatorFunc func(ctx context.Context, tenantID string, draft DraftCampaign) (string, error)

func (f CampaignCreatorFunc) CreateDraft(ctx context.Context, tenantID string, draft DraftCampaign) (string, error) {
	return f(ctx, tenantID, draft)
}

// FetchFunc retrieves the raw feed document. The default is
// (*Poller).fetch over the SSRF-safe outbound-webhooks HTTP client;
// tests substitute a stub.
type FetchFunc func(ctx context.Context, feedURL string) ([]byte, error)

// store is the persistence surface Poll needs — satisfied by *Repo,
// faked in tests.
type store interface {
	GetSource(ctx context.Context, tenantID, id string) (*FeedSource, error)
	beginRun(ctx context.Context, tenantID, sourceID string) (string, error)
	finishRun(ctx context.Context, tenantID, runID, status string, itemsSeen, newItems int, campaignID, errMsg string) error
	markPolled(ctx context.Context, tenantID, sourceID, newestGUID string) error
	// finishRunAndMarkPolled commits the cursor advance (feed_sources)
	// and the run-finish (feed_source_runs) in ONE tenant transaction, so
	// a crash can never leave a run stuck 'running' after the cursor has
	// already moved (or vice-versa). Both tables are tenant-scoped under
	// the same app.tenant_id GUC, so they share a tx cleanly. newestGUID
	// "" leaves the cursor untouched (same semantics as markPolled).
	finishRunAndMarkPolled(ctx context.Context, tenantID, runID, sourceID, status string, itemsSeen, newItems int, campaignID, errMsg, newestGUID string) error
}

// PollResult is the outcome of one poll, also the response body of
// POST /api/v1/feed-sources/{id}/poll.
type PollResult struct {
	RunID      string `json:"run_id"`
	Status     string `json:"status"`
	ItemsSeen  int    `json:"items_seen"`
	NewItems   int    `json:"new_items"`
	CampaignID string `json:"campaign_id,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Poller executes polls. HTTPClient must be the hardened
// outbound-webhooks client in production (DNS-rebinding-safe dialer,
// redirect re-validation); Fetch overrides the whole fetch step for
// tests.
type Poller struct {
	Store      store
	Campaigns  CampaignCreator
	HTTPClient *http.Client
	Fetch      FetchFunc
	Logger     *slog.Logger
}

// Poll runs one fetch→draft cycle for a source. It returns an error
// only on infrastructure failures (ledger unwritable, source deleted
// mid-poll); fetch/parse/draft failures are recorded on the run row
// and returned as a PollResult with status "failed", mirroring
// audience-syncs' RunSync contract so the HTTP handler can render the
// outcome instead of a transport error.
func (p *Poller) Poll(ctx context.Context, tenantID, sourceID string) (*PollResult, error) {
	src, err := p.Store.GetSource(ctx, tenantID, sourceID)
	if err != nil {
		return nil, err
	}
	runID, err := p.Store.beginRun(ctx, tenantID, src.ID)
	if err != nil {
		return nil, err
	}
	res := &PollResult{RunID: runID, Status: RunStatusFailed}

	fail := func(stage string, cause error) (*PollResult, error) {
		res.Error = stage + ": " + cause.Error()
		if err := p.Store.finishRun(ctx, tenantID, runID, RunStatusFailed, res.ItemsSeen, res.NewItems, "", res.Error); err != nil {
			return nil, err
		}
		return res, nil
	}

	fetch := p.Fetch
	if fetch == nil {
		fetch = p.fetch
	}
	body, err := fetch(ctx, src.URL)
	if err != nil {
		return fail("fetch", err)
	}
	feed, err := ParseFeed(body)
	if err != nil {
		return fail("parse", err)
	}
	res.ItemsSeen = len(feed.Items)

	newItems := ItemsAfterGUID(feed.Items, src.LastItemGUID)
	if len(newItems) > maxDigestItems {
		newItems = newItems[:maxDigestItems]
	}
	res.NewItems = len(newItems)

	if len(newItems) == 0 {
		// Nothing new: stamp last_polled_at (keep the cursor) AND finish
		// the run in one tx, so a crash never orphans a 'running' row.
		res.Status = RunStatusSucceeded
		if err := p.Store.finishRunAndMarkPolled(ctx, tenantID, runID, src.ID, RunStatusSucceeded, res.ItemsSeen, 0, "", "", ""); err != nil {
			return nil, err
		}
		return res, nil
	}

	// One DRAFT digest per batch of new items. Never auto-send — see
	// the package-comment contract above.
	draft := DraftCampaign{
		Name:      draftName(src.Name),
		Subject:   RenderSubject(src.SubjectTemplate, src.Name, newItems),
		BodyHTML:  RenderDigestHTML(feed.Title, src.Name, newItems),
		ListID:    strOrEmpty(src.ListID),
		SegmentID: strOrEmpty(src.SegmentID),
	}
	campaignID, err := p.Campaigns.CreateDraft(ctx, tenantID, draft)
	if err != nil {
		return fail("draft", err)
	}
	res.CampaignID = campaignID

	// Advance the cursor to the newest item we just drafted AND finish the
	// run together in ONE transaction (feed_sources + feed_source_runs are
	// both app.tenant_id-scoped). This closes the two mid-poll crash
	// windows that previously used three separate transactions:
	//   - crash after markPolled-commit before finishRun → run stuck
	//     'running' forever (no sweeper);
	//   - the cursor advance and the terminal run status now commit
	//     atomically, so a completed run never looks stuck.
	//
	// NOTE: exactly-once draft creation across a crash is still NOT
	// guaranteed — the CreateDraft commit happens BEFORE this combined
	// commit, so a crash in the gap re-polls without an advanced cursor
	// and re-drafts the same batch. That is acceptable: drafts are never
	// auto-sent (see the package contract) and the operator reviews each
	// digest, so a duplicate draft is operator-visible, not a duplicate
	// send.
	res.Status = RunStatusSucceeded
	if err := p.Store.finishRunAndMarkPolled(ctx, tenantID, runID, src.ID, RunStatusSucceeded, res.ItemsSeen, res.NewItems, campaignID, "", newItems[0].GUID); err != nil {
		return nil, err
	}
	return res, nil
}

// fetch is the default FetchFunc: bounded GET over the configured
// (SSRF-hardened) client.
func (p *Poller) fetch(ctx context.Context, feedURL string) ([]byte, error) {
	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, feedURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Moosewave-FeedIngest/1.0")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("feed returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFeedBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxFeedBytes {
		return nil, fmt.Errorf("feed exceeds %d byte limit", maxFeedBytes)
	}
	return body, nil
}

// draftName labels the draft so the campaigns list reads sensibly.
func draftName(sourceName string) string {
	return fmt.Sprintf("%s — feed digest %s", sourceName, time.Now().UTC().Format("2006-01-02"))
}

// RenderSubject expands the source's subject_template. Placeholders:
//
//	{{title}} — title of the newest new item
//	{{name}}  — feed source name
//	{{count}} — number of new items in this digest
func RenderSubject(tmpl, sourceName string, newItems []Item) string {
	title := ""
	if len(newItems) > 0 {
		title = newItems[0].Title
	}
	out := tmpl
	out = strings.ReplaceAll(out, "{{title}}", title)
	out = strings.ReplaceAll(out, "{{name}}", sourceName)
	out = strings.ReplaceAll(out, "{{count}}", strconv.Itoa(len(newItems)))
	out = strings.TrimSpace(out)
	if out == "" {
		out = sourceName
	}
	return out
}

// RenderDigestHTML builds the simple digest body: one section per new
// item with linked title + summary. Everything feed-supplied is
// HTML-escaped — feeds are remote, attacker-influenceable input and
// this HTML lands in subscribers' inboxes.
func RenderDigestHTML(feedTitle, sourceName string, items []Item) string {
	heading := feedTitle
	if strings.TrimSpace(heading) == "" {
		heading = sourceName
	}
	var b strings.Builder
	b.WriteString("<div>\n")
	b.WriteString("  <h1>" + html.EscapeString(heading) + "</h1>\n")
	for _, it := range items {
		title := it.Title
		if strings.TrimSpace(title) == "" {
			title = it.Link
		}
		b.WriteString("  <div style=\"margin:0 0 24px 0\">\n")
		if link := safeItemLink(it.Link); link != "" {
			b.WriteString("    <h2 style=\"margin:0 0 8px 0\"><a href=\"" + html.EscapeString(link) + "\">" + html.EscapeString(title) + "</a></h2>\n")
		} else {
			b.WriteString("    <h2 style=\"margin:0 0 8px 0\">" + html.EscapeString(title) + "</h2>\n")
		}
		if s := strings.TrimSpace(it.Summary); s != "" {
			b.WriteString("    <p style=\"margin:0\">" + html.EscapeString(s) + "</p>\n")
		}
		b.WriteString("  </div>\n")
	}
	b.WriteString("</div>\n")
	return b.String()
}

// safeItemLink admits only absolute http(s) links into the digest
// (drops javascript:, data:, relative junk).
func safeItemLink(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	return raw
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

// schedulerTick is how often the due-scan runs.
const schedulerTick = time.Minute

// schedulerMaxPerTick bounds one tick so a backlog (e.g. after
// downtime) drains gradually instead of hammering feed hosts.
const schedulerMaxPerTick = 10

// Scheduler runs due daily/weekly feed polls in the background.
// Enumeration runs cross-tenant under db.WithWorkerScope (the
// feed_sources_worker_select policy from migration 0384); each due
// source then polls under its own tenant scope via Poller.Poll, so the
// draft + ledger writes stay behind tenant RLS.
//
// v1 limitation (same as audience syncs): no FOR UPDATE SKIP LOCKED
// claim row, so multi-replica deployments can double-poll in the
// minute before last_polled_at lands. A duplicate poll costs one
// duplicate DRAFT (operator-visible, never sent), not a duplicate
// send.
type Scheduler struct {
	Pool   *db.Pool
	Poller *Poller
	Logger *slog.Logger
}

// Run blocks until ctx is cancelled, scanning for due sources every
// schedulerTick.
func (s *Scheduler) Run(ctx context.Context) error {
	if s == nil || s.Pool == nil || s.Poller == nil {
		return nil
	}
	t := time.NewTicker(schedulerTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	due, err := s.findDue(ctx)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("feed_ingest: scheduler scan failed", "err", err.Error())
		}
		return
	}
	for _, d := range due {
		if ctx.Err() != nil {
			return
		}
		if _, err := s.Poller.Poll(ctx, d.tenantID, d.sourceID); err != nil {
			if s.Logger != nil {
				s.Logger.Warn("feed_ingest: scheduled poll failed",
					"feed_source_id", d.sourceID, "err", err.Error())
			}
		}
	}
}

type dueSource struct {
	sourceID string
	tenantID string
}

// findDue enumerates enabled scheduled sources whose last poll is older
// than their interval (or that never polled).
func (s *Scheduler) findDue(ctx context.Context) ([]dueSource, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text
  FROM feed_sources
 WHERE enabled
   AND schedule <> 'manual'
   AND (
         last_polled_at IS NULL
      OR (schedule = 'daily'  AND last_polled_at < now() - interval '24 hours')
      OR (schedule = 'weekly' AND last_polled_at < now() - interval '7 days')
   )
 ORDER BY last_polled_at ASC NULLS FIRST
 LIMIT $1`, schedulerMaxPerTick)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dueSource{}
	for rows.Next() {
		var d dueSource
		if err := rows.Scan(&d.sourceID, &d.tenantID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Read-only scan — rollback (deferred) is the close path.
	return out, nil
}
