// Package render drives cross-client email rendering via HTMLCSStoImage
// (HCTI). The Pillar 2 cross-client preview surfaces what a campaign will
// look like in the 10 mailbox environments newsletter readers actually use,
// so authors can fix layout regressions *before* sending.
//
// Implementation notes:
//   - Each environment carries a CSS prefix that emulates client-specific
//     constraints (Outlook desktop's lack of flexbox, Apple Mail dark-mode
//     auto-invert, Gmail's clip styles). HCTI receives html = prefix + html.
//   - Real client rendering is not 1:1 reproducible from a screenshot service —
//     we treat HCTI as a fast directional preview and rely on the static
//     checks (`static_checks.go`) to flag the things screenshots cannot show
//     (e.g. Outlook 2019 ignoring CSS even when it visually looks fine in
//     HCTI).
//   - HCTI renders are cached behind a small interface. Production wires a
//     durable Postgres cache; local/dev falls back to the in-process cache.
package render

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Renderer is the surface used by handlers and (eventually) the editor
// preview workflow. Implementations: HCTIClient (production) and
// MockRenderer (dev + tests).
type Renderer interface {
	Render(ctx context.Context, html string, environments []Environment) ([]Render, error)
}

// RenderCache stores rendered screenshot metadata by content hash. The cache
// stores HCTI output URLs, not the source HTML, so persistent cache rows do not
// duplicate customer campaign bodies.
type RenderCache interface {
	Get(ctx context.Context, key string) (Render, bool, error)
	Set(ctx context.Context, key string, render Render, ttl time.Duration) error
}

// Environment captures the rendering target — viewport, UA, dark-mode flag,
// and the CSS prefix injected to emulate the client's quirks.
type Environment struct {
	Name           string `json:"name"`
	ViewportWidth  int    `json:"viewport_width"`
	ViewportHeight int    `json:"viewport_height"`
	UserAgent      string `json:"user_agent"`
	DarkMode       bool   `json:"dark_mode"`
	// CSSPrefix is prepended to the user HTML to approximate the rendering
	// engine. Outlook's MSO conditional comments, dark-mode auto-invert,
	// Gmail's <style> stripping behavior — each environment has tuned CSS.
	CSSPrefix string `json:"-"`
}

// Render is one screenshot output for a single Environment.
type Render struct {
	Environment Environment `json:"environment"`
	ImageURL    string      `json:"image_url"`
	Width       int         `json:"width"`
	Height      int         `json:"height"`
	// Issues are environment-specific findings — populated from
	// static_checks before rendering. Empty list = clean.
	Issues []string `json:"issues"`
}

// AllEnvironments is the canonical 10-environment matrix Moosewave previews.
// Order matters: the UI grid expects this iteration order.
//
// The CSS prefixes are deliberately small — they approximate the most
// common breakages (Outlook 2019 ignoring flexbox/grid, Apple Mail
// dark-mode auto-invert, Gmail web stripping background-image on body)
// without trying to be a perfect MSO renderer.
var AllEnvironments = []Environment{
	{
		Name:           "outlook_2019_desktop",
		ViewportWidth:  900,
		ViewportHeight: 1200,
		UserAgent:      "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.13901; Pro)",
		DarkMode:       false,
		// Outlook 2019 desktop uses Word's HTML engine: no flexbox/grid,
		// limited CSS, table-based layout only. We strip flex/grid + inline
		// fallback box-sizing so we *show* the breakage rather than papering
		// over it with browser CSS.
		CSSPrefix: `<style>
*{display:revert!important;}
.flex,[style*="display:flex"],[style*="display: flex"]{display:block!important;}
.grid,[style*="display:grid"],[style*="display: grid"]{display:block!important;}
[style*="position:absolute"],[style*="position: absolute"]{position:static!important;}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
body{font-family:Calibri,Arial,sans-serif;background:#fff;}
</style>`,
	},
	{
		Name:           "outlook_365_web",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Outlook-Web/16.0",
		DarkMode:       false,
		CSSPrefix:      `<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#faf9f8;}</style>`,
	},
	{
		Name:           "outlook_macos",
		ViewportWidth:  900,
		ViewportHeight: 1200,
		UserAgent:      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Outlook/16.83",
		DarkMode:       false,
		CSSPrefix:      `<style>body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;}</style>`,
	},
	{
		Name:           "apple_mail_macos_light",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Mail/16.0",
		DarkMode:       false,
		CSSPrefix:      `<style>body{font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;background:#fff;color:#000;}</style>`,
	},
	{
		Name:           "apple_mail_macos_dark",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Mail/16.0",
		DarkMode:       true,
		// Apple Mail dark-mode "intelligent" inversion: backgrounds with
		// pure white auto-invert; explicit color-scheme:dark hints opt-out.
		// We force the canvas dark and rely on the user's CSS to handle
		// inversion or not.
		CSSPrefix: `<style>:root{color-scheme:dark;}body{background:#1c1c1e!important;color:#f2f2f7!important;font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;}</style>`,
	},
	{
		Name:           "apple_mail_ios",
		ViewportWidth:  390,
		ViewportHeight: 844,
		UserAgent:      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
		DarkMode:       false,
		CSSPrefix:      `<style>body{font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:none;}</style>`,
	},
	{
		Name:           "gmail_web_promotions",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 (X11; Linux x86_64) Gmail-Web",
		DarkMode:       false,
		// Gmail supports a documented subset of CSS and media queries. A
		// generic browser cannot prove which rules the mailbox will retain.
		CSSPrefix: `<style>body{background:#fff;font-family:Arial,sans-serif;}</style>`,
	},
	{
		Name:           "gmail_ios",
		ViewportWidth:  390,
		ViewportHeight: 844,
		UserAgent:      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Gmail/iOS 6.0.240428",
		DarkMode:       false,
		CSSPrefix:      `<style>body{font-family:Roboto,Arial,sans-serif;-webkit-text-size-adjust:none;}</style>`,
	},
	{
		Name:           "yahoo_web",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Yahoo-Mail/Web",
		DarkMode:       false,
		// Yahoo strips most <style> blocks; behaviour close to Gmail web.
		CSSPrefix: `<style>body{background:#fff;font-family:Helvetica,Arial,sans-serif;}</style>`,
	},
	{
		Name:           "proton_mail_web",
		ViewportWidth:  1024,
		ViewportHeight: 1400,
		UserAgent:      "Mozilla/5.0 ProtonMail/Web 5.0",
		DarkMode:       false,
		// Proton blocks remote images by default + strips trackers; we
		// approximate by hiding all remote <img> when no `data:` src.
		CSSPrefix: `<style>body{background:#fff;font-family:'Inter',Arial,sans-serif;}img:not([src^="data:"]){opacity:0.4;outline:1px dashed #c00;}</style>`,
	},
}

// LookupEnvironment returns an environment by name. Used by handler input
// validation.
func LookupEnvironment(name string) (Environment, bool) {
	for _, e := range AllEnvironments {
		if e.Name == name {
			return e, true
		}
	}
	return Environment{}, false
}

// HCTIClient is the production Renderer — calls https://hcti.io/v1/image.
type HCTIClient struct {
	UserID     string
	APIKey     string
	HTTP       *http.Client
	Endpoint   string        // override for tests; default https://hcti.io/v1/image
	Timeout    time.Duration // per-call timeout; default 30s
	CacheTTL   time.Duration // default 24h
	Cache      RenderCache   // optional durable cache; memory cache remains fallback
	cacheMu    sync.RWMutex
	cache      map[string]cachedRender
	StaticChks func(env Environment, html string) []string // injected; defaults to RunStaticChecks
}

type cachedRender struct {
	render    Render
	expiresAt time.Time
}

// NewHCTIClient constructs a real client. Returns nil + error if creds
// are absent so the caller can decide to fall back to MockRenderer.
func NewHCTIClient(userID, apiKey string) (*HCTIClient, error) {
	if userID == "" || apiKey == "" {
		return nil, errors.New("hcti: HCTI_USER_ID and HCTI_API_KEY are required")
	}
	return &HCTIClient{
		UserID:     userID,
		APIKey:     apiKey,
		HTTP:       &http.Client{Timeout: 30 * time.Second},
		Endpoint:   "https://hcti.io/v1/image",
		Timeout:    30 * time.Second,
		CacheTTL:   24 * time.Hour,
		cache:      make(map[string]cachedRender),
		StaticChks: RunStaticChecks,
	}, nil
}

// Render runs all environments concurrently. On any per-env error we
// surface the env's issues with the error message so the UI is never
// completely blank.
func (c *HCTIClient) Render(ctx context.Context, html string, envs []Environment) ([]Render, error) {
	if len(envs) == 0 {
		envs = AllEnvironments
	}
	out := make([]Render, len(envs))
	type job struct {
		idx int
		env Environment
	}
	jobs := make(chan job)
	var wg sync.WaitGroup
	const concurrency = 4
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				out[j.idx] = c.renderOne(ctx, html, j.env)
			}
		}()
	}
	for i, env := range envs {
		jobs <- job{idx: i, env: env}
	}
	close(jobs)
	wg.Wait()
	return out, nil
}

func (c *HCTIClient) renderOne(ctx context.Context, html string, env Environment) Render {
	staticChks := c.StaticChks
	if staticChks == nil {
		staticChks = RunStaticChecks
	}
	issues := staticChks(env, html)

	key := contentHash(env.Name, html)
	if cached, ok := c.lookupCache(ctx, key); ok {
		cached.Issues = issues // static checks are cheap; refresh
		return cached
	}

	prefixed := env.CSSPrefix + html
	body := map[string]any{
		"html":            prefixed,
		"viewport_width":  env.ViewportWidth,
		"viewport_height": env.ViewportHeight,
		"ms_delay":        500,
		"device_scale":    1,
	}
	buf, _ := json.Marshal(body)

	cctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(cctx, http.MethodPost, c.Endpoint, strings.NewReader(string(buf)))
	if err != nil {
		return Render{Environment: env, Issues: append(issues, "render: "+err.Error())}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Basic "+basicAuth(c.UserID, c.APIKey))
	req.Header.Set("User-Agent", env.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Render{Environment: env, Issues: append(issues, "render: "+err.Error())}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return Render{Environment: env, Issues: append(issues, fmt.Sprintf("render: hcti %d: %s", resp.StatusCode, truncate(string(b), 200)))}
	}
	var parsed struct {
		URL string `json:"url"`
	}
	if err := decodeJSONLimited(resp.Body, 1<<20, &parsed); err != nil {
		return Render{Environment: env, Issues: append(issues, "render: decode: "+err.Error())}
	}
	r := Render{
		Environment: env,
		ImageURL:    parsed.URL,
		Width:       env.ViewportWidth,
		Height:      env.ViewportHeight,
		Issues:      issues,
	}
	c.storeCache(ctx, key, r)
	return r
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return fmt.Errorf("response body too large")
	}
	return json.Unmarshal(buf, out)
}

func (c *HCTIClient) lookupCache(ctx context.Context, key string) (Render, bool) {
	if c.Cache != nil {
		if v, ok, err := c.Cache.Get(ctx, key); err == nil && ok {
			return v, true
		}
	}
	c.cacheMu.RLock()
	defer c.cacheMu.RUnlock()
	v, ok := c.cache[key]
	if !ok || time.Now().After(v.expiresAt) {
		return Render{}, false
	}
	return v.render, true
}

func (c *HCTIClient) storeCache(ctx context.Context, key string, r Render) {
	ttl := c.CacheTTL
	if ttl == 0 {
		ttl = 24 * time.Hour
	}
	if c.Cache != nil {
		_ = c.Cache.Set(ctx, key, r, ttl)
	}
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cache[key] = cachedRender{render: r, expiresAt: time.Now().Add(ttl)}
}

// CacheHit reports whether the (env, html) pair is currently cached.
// Used by handlers to set the response's `cache_hit` flag.
func (c *HCTIClient) CacheHit(env Environment, html string) bool {
	_, ok := c.lookupCache(context.Background(), contentHash(env.Name, html))
	return ok
}

// MockRenderer returns deterministic placehold.co URLs and the real static
// checks. Used in dev (no HCTI creds) and tests.
type MockRenderer struct {
	StaticChks func(env Environment, html string) []string
}

// Render implements Renderer with stable placeholder URLs.
func (m MockRenderer) Render(_ context.Context, html string, envs []Environment) ([]Render, error) {
	if len(envs) == 0 {
		envs = AllEnvironments
	}
	staticChks := m.StaticChks
	if staticChks == nil {
		staticChks = RunStaticChecks
	}
	out := make([]Render, len(envs))
	for i, env := range envs {
		hash := contentHash(env.Name, html)[:6]
		out[i] = Render{
			Environment: env,
			ImageURL:    fmt.Sprintf("https://placehold.co/%dx%d/png?text=%s", env.ViewportWidth, env.ViewportHeight/2, env.Name+"-"+hash),
			Width:       env.ViewportWidth,
			Height:      env.ViewportHeight / 2,
			Issues:      staticChks(env, html),
		}
	}
	return out, nil
}

// --- helpers

func contentHash(envName, html string) string {
	h := sha256.New()
	h.Write([]byte(envName))
	h.Write([]byte{0})
	h.Write([]byte(html))
	return hex.EncodeToString(h.Sum(nil))
}

func basicAuth(user, key string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + key))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
