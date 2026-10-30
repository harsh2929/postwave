// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	previewTestSourceURL     = "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/emails/example.png"
	auraPreviewTestSourceURL = "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
		"storage/v1/object/public/preview-images/shared-code-previews/" +
		"b2b-jewelry-compliance-29-preview-1766401942064.jpeg"
)

func TestPreviewSourceGuardRejectsAllowlistedHostResolvingPrivate(t *testing.T) {
	guard := NewPreviewSourceGuard(&previewTestResolver{
		answers: [][]net.IPAddr{{{IP: net.ParseIP("127.0.0.1")}}},
	})
	_, err := guard.Validate(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewSourceRejected) {
		t.Fatalf("error = %v, want source rejected", err)
	}
}

func TestPreviewFetcherRevalidatesDNSOnRedirect(t *testing.T) {
	resolver := &previewTestResolver{answers: [][]net.IPAddr{
		{{IP: net.ParseIP("93.184.216.34")}},
		{{IP: net.ParseIP("169.254.169.254")}},
	}}
	fetcher := NewPreviewFetcher(resolver)
	var roundTrips int
	fetcher.Client = &http.Client{Transport: previewRoundTripFunc(func(*http.Request) (*http.Response, error) {
		roundTrips++
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": []string{previewTestSourceURL + "?redirected=1"}},
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	})}

	_, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewSourceRejected) {
		t.Fatalf("error = %v, want redirect DNS rejection", err)
	}
	if got := resolver.CallCount(); got != 2 {
		t.Fatalf("DNS calls = %d, want initial + redirect revalidation", got)
	}
	if roundTrips != 1 {
		t.Fatalf("round trips = %d, private redirect must not be followed", roundTrips)
	}
}

func TestPreviewFetcherRejectsWrongMIME(t *testing.T) {
	body := previewTestPNG(t, 4, 5)
	fetcher := previewTestFetcher(http.StatusOK, "text/html; charset=utf-8", body)
	_, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewWrongMIME) {
		t.Fatalf("error = %v, want wrong MIME", err)
	}
}

func TestPreviewFetcherRejectsChunkedOversizeBody(t *testing.T) {
	fetcher := previewTestFetcher(http.StatusOK, "image/png", bytes.Repeat([]byte{'x'}, 129))
	fetcher.MaxBytes = 128
	fetcher.Client.Transport = previewRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			Header:        http.Header{"Content-Type": []string{"image/png"}},
			Body:          io.NopCloser(bytes.NewReader(bytes.Repeat([]byte{'x'}, 129))),
			ContentLength: -1,
		}, nil
	})
	_, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewOversize) {
		t.Fatalf("error = %v, want oversize", err)
	}
}

func TestPreviewFetcherBoundsElapsedTime(t *testing.T) {
	fetcher := NewPreviewFetcher(previewPublicResolver())
	fetcher.Timeout = 20 * time.Millisecond
	fetcher.Client = &http.Client{Transport: previewRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	started := time.Now()
	_, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewSourceUnavailable) {
		t.Fatalf("error = %v, want source unavailable", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded fetch took %s", elapsed)
	}
}

func TestPreviewFetcherBoundsDNSLookupTime(t *testing.T) {
	fetcher := NewPreviewFetcher(previewResolverFunc(func(ctx context.Context, _ string) ([]net.IPAddr, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}))
	fetcher.Timeout = 20 * time.Millisecond
	started := time.Now()
	_, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if !errors.Is(err, ErrPreviewSourceUnavailable) {
		t.Fatalf("error = %v, want source unavailable", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded DNS lookup took %s", elapsed)
	}
}

func TestPreviewFetcherStoresOnlySanitizedBytes(t *testing.T) {
	const secret = "private-upstream-preview-metadata"
	body := previewPNGWithText(t, previewTestPNG(t, 8, 9), secret)
	fetcher := previewTestFetcher(http.StatusOK, "image/png", body)
	got, err := fetcher.Fetch(context.Background(), PreviewProviderReallyGoodEmails, previewTestSourceURL)
	if err != nil {
		t.Fatal(err)
	}
	if got.MIME != "image/png" || got.Width != 8 || got.Height != 9 {
		t.Fatalf("fetched image = %q %dx%d", got.MIME, got.Width, got.Height)
	}
	if bytes.Contains(got.Body, []byte(secret)) {
		t.Fatal("sanitized preview retained upstream metadata")
	}
}

func TestPreviewFetcherAcceptsAllowlistedAuraObject(t *testing.T) {
	body := previewTestPNG(t, 8, 9)
	fetcher := previewTestFetcher(http.StatusOK, "image/png", body)
	got, err := fetcher.Fetch(
		context.Background(), PreviewProviderAuraBuild, auraPreviewTestSourceURL+"?t=1766401942064",
	)
	if err != nil {
		t.Fatal(err)
	}
	if got.MIME != "image/png" || got.Width != 8 || got.Height != 9 {
		t.Fatalf("fetched image = %q %dx%d", got.MIME, got.Width, got.Height)
	}
}

func TestPreviewWorkerDeduplicatesSanitizedContent(t *testing.T) {
	body := previewTestPNG(t, 8, 9)
	store := &previewMemoryStore{jobs: []PreviewAssetJob{
		{
			ID: "job-1", TemplateID: "template-1", Variant: "desktop",
			SourceProvider: PreviewProviderReallyGoodEmails, SourceURL: previewTestSourceURL,
			Attempts: 1, MaxAttempts: 6,
		},
		{
			ID: "job-2", TemplateID: "template-2", Variant: "desktop",
			SourceProvider: PreviewProviderReallyGoodEmails, SourceURL: previewTestSourceURL,
			Attempts: 1, MaxAttempts: 6,
		},
	}}
	storage := &previewRecordingStorage{}
	worker := &PreviewAssetWorker{
		Store: store, Storage: storage,
		Fetcher: previewTestFetcher(http.StatusOK, "image/png", body),
		Owner:   "preview-worker-1",
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if processed != 2 {
		t.Fatalf("processed = %d, want 2", processed)
	}
	if storage.PutCalls != 1 {
		t.Fatalf("storage puts = %d, identical sanitized images must share one blob", storage.PutCalls)
	}
	if len(store.ready) != 2 || len(store.blobs) != 1 {
		t.Fatalf("ready=%d blobs=%d, want two attachments and one blob", len(store.ready), len(store.blobs))
	}
	if !strings.Contains(storage.LastKey, "/sha256/") {
		t.Fatalf("storage key %q is not content-addressed", storage.LastKey)
	}
}

func TestPreviewWorkerRetriesTransientFailureWithExponentialBackoff(t *testing.T) {
	now := time.Date(2026, 7, 29, 10, 0, 0, 0, time.UTC)
	store := &previewMemoryStore{jobs: []PreviewAssetJob{{
		ID: "job-retry", TemplateID: "template-1", Variant: "mobile",
		SourceProvider: PreviewProviderReallyGoodEmails, SourceURL: previewTestSourceURL,
		Attempts: 3, MaxAttempts: 6,
	}}}
	worker := &PreviewAssetWorker{
		Store: store, Storage: &previewRecordingStorage{},
		Fetcher: previewTestFetcher(http.StatusServiceUnavailable, "", nil),
		Owner:   "preview-worker-1", Now: func() time.Time { return now },
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 || len(store.retries) != 1 || len(store.failed) != 0 {
		t.Fatalf("processed=%d retries=%d failed=%d", processed, len(store.retries), len(store.failed))
	}
	want := now.Add(2 * time.Minute)
	if !store.retries[0].RetryAt.Equal(want) {
		t.Fatalf("retry at = %s, want %s", store.retries[0].RetryAt, want)
	}
}

func TestPreviewWorkerRetainsBlobWhenSourceDisappears(t *testing.T) {
	store := &previewMemoryStore{jobs: []PreviewAssetJob{{
		ID: "job-missing", TemplateID: "template-1", Variant: "card",
		SourceProvider: PreviewProviderReallyGoodEmails, SourceURL: previewTestSourceURL,
		BlobID: "last-known-good", Attempts: 2, MaxAttempts: 6,
	}}}
	worker := &PreviewAssetWorker{
		Store: store, Storage: &previewRecordingStorage{},
		Fetcher: previewTestFetcher(http.StatusGone, "", nil),
		Owner:   "preview-worker-1",
	}
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.missing) != 1 {
		t.Fatalf("source-missing transitions = %d, want 1", len(store.missing))
	}
	if store.jobs[0].BlobID != "last-known-good" {
		t.Fatal("worker cleared the retained blob")
	}
}

func TestPreviewClaimSQLPinsConcurrentLeaseContract(t *testing.T) {
	for _, required := range []string{
		"FOR UPDATE SKIP LOCKED",
		"status = 'fetching'",
		"lease_expires_at <= now()",
		"attempts < max_attempts",
		"WHEN preview.status = 'fetching' THEN preview.attempts",
	} {
		if !strings.Contains(previewAssetClaimSQL, required) {
			t.Fatalf("claim SQL no longer contains %q", required)
		}
	}
}

func TestPreviewSourceStructureUsesStrictProviderBucketAndPrefix(t *testing.T) {
	for name, tc := range map[string]struct {
		provider string
		url      string
	}{
		"wrong provider": {
			provider: "other",
			url:      previewTestSourceURL,
		},
		"wrong host": {
			provider: PreviewProviderReallyGoodEmails,
			url:      "https://reallygoodemails.com/emails/example.png",
		},
		"metadata target": {
			provider: PreviewProviderReallyGoodEmails,
			url:      "https://169.254.169.254/emails/example.png",
		},
		"wrong prefix": {
			provider: PreviewProviderReallyGoodEmails,
			url:      "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/private/example.png",
		},
		"path traversal": {
			provider: PreviewProviderReallyGoodEmails,
			url:      "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/emails/../private.png",
		},
		"explicit port": {
			provider: PreviewProviderReallyGoodEmails,
			url:      "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com:443/emails/example.png",
		},
		"Aura provider on RGE bucket": {
			provider: PreviewProviderAuraBuild,
			url:      previewTestSourceURL,
		},
		"RGE provider on Aura bucket": {
			provider: PreviewProviderReallyGoodEmails,
			url:      auraPreviewTestSourceURL,
		},
		"Aura sibling bucket": {
			provider: PreviewProviderAuraBuild,
			url: "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
				"storage/v1/object/public/assets/assets/example.png",
		},
		"Aura image transform endpoint": {
			provider: PreviewProviderAuraBuild,
			url: "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
				"storage/v1/render/image/public/preview-images/example.png",
		},
		"Aura arbitrary subdomain": {
			provider: PreviewProviderAuraBuild,
			url: "https://attacker.hoirqrkdgbmvpwutwuwj.supabase.co/" +
				"storage/v1/object/public/preview-images/example.png",
		},
		"Aura unsupported query": {
			provider: PreviewProviderAuraBuild,
			url:      auraPreviewTestSourceURL + "?download=1",
		},
		"Aura non-decimal cache buster": {
			provider: PreviewProviderAuraBuild,
			url:      auraPreviewTestSourceURL + "?t=latest",
		},
		"Aura duplicate cache buster": {
			provider: PreviewProviderAuraBuild,
			url:      auraPreviewTestSourceURL + "?t=1&t=2",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validatePreviewSourceStructure(tc.provider, tc.url); !errors.Is(err, ErrPreviewSourceRejected) {
				t.Fatalf("error = %v, want source rejected", err)
			}
		})
	}
}

func TestPreviewSourceStructureAllowsOnlyAuraCatalogObjectPrefixes(t *testing.T) {
	for name, sourceURL := range map[string]string{
		"preview images":              auraPreviewTestSourceURL,
		"preview images cache buster": auraPreviewTestSourceURL + "?t=1766401942064",
		"chat thumbnails": "https://hoirqrkdgbmvpwutwuwj.supabase.co/" +
			"storage/v1/object/public/chat-thumbnails/" +
			"9109ecbb-cdc4-4815-981e-2ea83be13765/" +
			"react-project-28aad9b8-d552-4d8d-833a-46dc92bcda2c_800w.jpg",
		"legacy Aura host": "https://hoirqrkdgbmvpwutwuwj-all.supabase.co/" +
			"storage/v1/object/public/preview-images/example.png",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validatePreviewSourceStructure(PreviewProviderAuraBuild, sourceURL); err != nil {
				t.Fatalf("validate source: %v", err)
			}
		})
	}
}

func TestPreviewSourceStructureCanonicalizesAuraLegacyHost(t *testing.T) {
	legacy := "https://hoirqrkdgbmvpwutwuwj-all.supabase.co/" +
		"storage/v1/object/public/preview-images/personal-resume-15.png?t=1759053310591"
	parsed, err := validatePreviewSourceStructure(PreviewProviderAuraBuild, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Hostname() != auraBuildPreviewHost {
		t.Fatalf("canonical host = %q, want %q", parsed.Hostname(), auraBuildPreviewHost)
	}
	if parsed.Path != "/storage/v1/object/public/preview-images/personal-resume-15.png" ||
		parsed.RawQuery != "t=1759053310591" {
		t.Fatalf("canonical URL changed object identity: %q", parsed.String())
	}
}

type previewTestResolver struct {
	mu      sync.Mutex
	answers [][]net.IPAddr
	calls   int
	err     error
}

func (r *previewTestResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	index := r.calls - 1
	if index >= len(r.answers) {
		index = len(r.answers) - 1
	}
	if index < 0 {
		return nil, nil
	}
	return r.answers[index], nil
}

func (r *previewTestResolver) CallCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func previewPublicResolver() *previewTestResolver {
	return &previewTestResolver{answers: [][]net.IPAddr{{{IP: net.ParseIP("93.184.216.34")}}}}
}

type previewRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn previewRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type previewResolverFunc func(context.Context, string) ([]net.IPAddr, error)

func (fn previewResolverFunc) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return fn(ctx, host)
}

func previewTestFetcher(status int, contentType string, body []byte) *PreviewFetcher {
	fetcher := NewPreviewFetcher(previewPublicResolver())
	fetcher.Client = &http.Client{Transport: previewRoundTripFunc(func(*http.Request) (*http.Response, error) {
		header := make(http.Header)
		if contentType != "" {
			header.Set("Content-Type", contentType)
		}
		return &http.Response{
			StatusCode:    status,
			Header:        header,
			Body:          io.NopCloser(bytes.NewReader(body)),
			ContentLength: int64(len(body)),
		}, nil
	})}
	return fetcher
}

func previewTestPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.White)
	var body bytes.Buffer
	if err := png.Encode(&body, img); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func previewPNGWithText(t *testing.T, body []byte, text string) []byte {
	t.Helper()
	iend := bytes.LastIndex(body, []byte("IEND")) - 4
	if iend < 8 {
		t.Fatal("PNG has no IEND")
	}
	data := []byte("Comment\x00" + text)
	chunk := make([]byte, 12+len(data))
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(data)))
	copy(chunk[4:8], "tEXt")
	copy(chunk[8:], data)
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	out := append([]byte{}, body[:iend]...)
	out = append(out, chunk...)
	out = append(out, body[iend:]...)
	return out
}

type previewMemoryStore struct {
	jobs     []PreviewAssetJob
	claimed  bool
	blobs    map[string]PreviewBlob
	ready    []string
	retries  []previewRetryRecord
	failed   []string
	missing  []string
	nextBlob int
}

type previewRetryRecord struct {
	JobID   string
	RetryAt time.Time
}

func (s *previewMemoryStore) Claim(context.Context, string, time.Duration, int) ([]PreviewAssetJob, error) {
	if s.claimed {
		return nil, ErrNoPreviewAssets
	}
	s.claimed = true
	return append([]PreviewAssetJob(nil), s.jobs...), nil
}

func (s *previewMemoryStore) FindBlob(_ context.Context, hash string) (*PreviewBlob, error) {
	if blob, ok := s.blobs[hash]; ok {
		copy := blob
		return &copy, nil
	}
	return nil, ErrPreviewBlobMiss
}

func (s *previewMemoryStore) MarkReady(_ context.Context, jobID, _ string, blob PreviewBlob) (*PreviewBlob, error) {
	if s.blobs == nil {
		s.blobs = make(map[string]PreviewBlob)
	}
	if existing, ok := s.blobs[blob.ContentSHA256]; ok {
		blob = existing
	} else {
		s.nextBlob++
		if blob.ID == "" {
			blob.ID = "blob-" + strconv.Itoa(s.nextBlob)
		}
		s.blobs[blob.ContentSHA256] = blob
	}
	s.ready = append(s.ready, jobID)
	copy := blob
	return &copy, nil
}

func (*previewMemoryStore) Renew(context.Context, string, string, time.Duration) error {
	return nil
}

func (s *previewMemoryStore) MarkRetry(_ context.Context, jobID, _ string, _ string, retryAt time.Time) error {
	s.retries = append(s.retries, previewRetryRecord{JobID: jobID, RetryAt: retryAt})
	return nil
}

func (s *previewMemoryStore) MarkFailed(_ context.Context, jobID, _ string, _ string) error {
	s.failed = append(s.failed, jobID)
	return nil
}

func (s *previewMemoryStore) MarkSourceMissing(_ context.Context, jobID, _ string, _ string) error {
	s.missing = append(s.missing, jobID)
	return nil
}

type previewRecordingStorage struct {
	PutCalls int
	LastKey  string
	LastMIME string
	LastBody []byte
}

func (s *previewRecordingStorage) Put(_ context.Context, key, mime string, body []byte) (string, error) {
	s.PutCalls++
	s.LastKey = key
	s.LastMIME = mime
	s.LastBody = append([]byte(nil), body...)
	return "https://assets.example.test/assets/" + key, nil
}

func (*previewRecordingStorage) Open(context.Context, string) (io.ReadCloser, string, error) {
	return nil, "", errors.New("not implemented")
}

func (*previewRecordingStorage) Delete(context.Context, string) error { return nil }
