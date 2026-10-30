// Package link_checker finds every link a campaign would send, and
// HEAD-requests each one to surface broken links before send.
package link_checker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// hrefRegex captures the value of every href="..." / href='...' attribute.
// We resist the temptation to over-parse — campaign HTML is always
// well-formed because we render it ourselves, and net/html is not in the
// gateway's go.mod. The regex looks for href followed by an =, optional
// whitespace, then a single- or double-quoted value.
var hrefRegex = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)

// bareURLRegex finds absolute links written out in a plain-text body, where
// there are no href attributes: "Read more: https://example.com/post."
var bareURLRegex = regexp.MustCompile(`(?i)\bhttps?://[^\s<>"'` + "`" + `]+`)

// Result is one row in the response.
type Result struct {
	URL    string `json:"url"`
	Status int    `json:"status"`
	OK     bool   `json:"ok"`
	// Error says, for the person reading the send review, why no status came
	// back. It is one of a fixed set of sentences, never the transport error:
	// that text names the resolver the API runs behind and the address a host
	// resolved to from inside our network.
	Error string `json:"error,omitempty"`
}

// ExtractURLs returns every absolute http(s) href found in the HTML body.
// Duplicates are dropped while preserving first-seen order.
func ExtractURLs(body string) []string {
	var links urlSet
	for _, m := range hrefRegex.FindAllStringSubmatch(body, -1) {
		if len(m) < 2 {
			continue
		}
		links.add(m[1])
	}
	return links.urls
}

// extractTextURLs returns the absolute links written out in a plain-text body.
func extractTextURLs(text string) []string {
	var links urlSet
	for _, match := range bareURLRegex.FindAllString(text, -1) {
		// Sentence punctuation right after a link belongs to the sentence.
		links.add(strings.TrimRight(match, ".,;:!?)]}"))
	}
	return links.urls
}

// urlSet collects checkable links in first-seen order without duplicates.
type urlSet struct {
	seen map[string]bool
	urls []string
}

// add keeps an absolute http(s) link. A link carrying personalization markup
// ("https://example.com/?u={{ .Subscriber.UUID }}") is different for every
// recipient, so the literal template is not a destination anyone receives and
// requesting it would report a false break.
func (s *urlSet) add(raw string) {
	href := strings.TrimSpace(raw)
	lower := strings.ToLower(href)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return
	}
	if strings.Contains(href, "{{") || strings.Contains(href, "{%") {
		return
	}
	if s.seen == nil {
		s.seen = map[string]bool{}
	}
	if s.seen[href] {
		return
	}
	s.seen[href] = true
	s.urls = append(s.urls, href)
}

func (s *urlSet) addAll(urls []string) {
	for _, u := range urls {
		s.add(u)
	}
}

// CheckOptions controls the HEAD sweep.
type CheckOptions struct {
	Timeout    time.Duration
	Concurrent int
	Client     *http.Client
}

// Check fans out HEAD requests with bounded concurrency and returns the
// per-URL results in the same order as urls.
func Check(ctx context.Context, urls []string, opts CheckOptions) []Result {
	if opts.Timeout == 0 {
		opts.Timeout = 5 * time.Second
	}
	if opts.Concurrent <= 0 {
		opts.Concurrent = 50
	}
	client := opts.Client
	if client == nil {
		// Secure transport: campaign HTML is tenant-authored content,
		// so the URL set comes from arbitrary input. Without dial-time
		// private-IP blocking, a campaign with `<a href="http://10.0.0.1/admin">`
		// turns the link-checker into a status-code oracle for the
		// internal network (audit finding H4, SSRF).
		client = outbound_webhooks.NewSecureHTTPClient(nil)
		client.Timeout = opts.Timeout
	}
	results := make([]Result, len(urls))
	sem := make(chan struct{}, opts.Concurrent)
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, u string) {
			defer wg.Done()
			defer func() { <-sem }()
			rctx, cancel := context.WithTimeout(ctx, opts.Timeout)
			defer cancel()
			results[i] = checkOne(rctx, client, u, opts.Timeout)
		}(i, u)
	}
	wg.Wait()
	return results
}

// checkOne requests one link. A HEAD answer is only trusted when it succeeds:
// many sites refuse HEAD outright (405), leave it unimplemented, or have a CDN
// or bot rule that answers it 403/404 while serving the page to every reader
// who clicks. Any failing HEAD is therefore retried as a GET for the first
// byte, and only that answer can call the link broken.
func checkOne(ctx context.Context, client *http.Client, u string, timeout time.Duration) Result {
	status, err := requestStatus(ctx, client, http.MethodHead, u)
	if err == nil && status >= 400 {
		status, err = requestStatus(ctx, client, http.MethodGet, u)
	}
	if err != nil {
		return Result{URL: u, OK: false, Error: publicLinkError(err, timeout)}
	}
	return Result{URL: u, Status: status, OK: status < 400}
}

func requestStatus(ctx context.Context, client *http.Client, method, u string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return 0, err
	}
	if method == http.MethodGet {
		req.Header.Set("Range", "bytes=0-0")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

// Deps wires the HTTP handler to a postgres pool.
type Deps struct {
	Pool   *db.Pool
	Client *http.Client
	Logger *slog.Logger
}

// MountRoutes hooks the handler under /api/v1/campaigns/{id}/check-links.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Post("/api/v1/campaigns/{id}/check-links", d.Check)
}

// Check loads the saved campaign, gathers every link it would send, and
// returns the per-link verdicts.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	content, err := loadCampaignContent(r.Context(), d.Pool, t.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	results := Check(r.Context(), content.links(), CheckOptions{Client: d.Client})
	writeJSON(w, http.StatusOK, results)
}

func writeJSON(w http.ResponseWriter, status int, b any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(b)
}
