package ingest

import (
	"context"
	"fmt"
	"net/netip"
	"testing"
)

type resolverFunc func(ctx context.Context, network, host string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

func TestValidateParamsRejectsUnsafeRSSURLs(t *testing.T) {
	resolver := resolverFunc(func(_ context.Context, _ string, host string) ([]netip.Addr, error) {
		return nil, fmt.Errorf("unexpected lookup for %s", host)
	})

	for _, feedURL := range []string{
		"http://localhost/feed.xml",
		"http://127.0.0.1/feed.xml",
		"http://10.0.0.8/feed.xml",
		"http://198.51.100.9/feed.xml",
		"http://[::1]/feed.xml",
		"file:///tmp/feed.xml",
	} {
		t.Run(feedURL, func(t *testing.T) {
			err := validateParams(context.Background(), resolver, SourceBlogRSS, IngestParams{FeedURL: feedURL})
			if err == nil {
				t.Fatalf("expected validation error")
			}
		})
	}
}

func TestValidateParamsRejectsRSSHostResolvingPrivate(t *testing.T) {
	resolver := resolverFunc(func(_ context.Context, _ string, host string) ([]netip.Addr, error) {
		if host != "feed.example" {
			t.Fatalf("lookup host = %q, want feed.example", host)
		}
		return []netip.Addr{netip.MustParseAddr("10.0.0.9")}, nil
	})

	err := validateParams(context.Background(), resolver, SourceBlogRSS, IngestParams{FeedURL: "https://feed.example/rss"})
	if err == nil {
		t.Fatalf("expected validation error")
	}
}

func TestValidateParamsAllowsPublicRSSURL(t *testing.T) {
	resolver := resolverFunc(func(_ context.Context, _ string, host string) ([]netip.Addr, error) {
		if host != "feed.example" {
			t.Fatalf("lookup host = %q, want feed.example", host)
		}
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	})

	err := validateParams(context.Background(), resolver, SourceBlogRSS, IngestParams{FeedURL: "https://feed.example/rss"})
	if err != nil {
		t.Fatalf("ValidateParams: %v", err)
	}
}

func TestValidateParamsRejectsUnsafeArchivePaths(t *testing.T) {
	for _, archivePath := range []string{
		"../tweets.js",
		"uploads/../tweets.js",
		"/etc/passwd",
		`C:\Windows\win.ini`,
		"https://example.com/tweets.js",
		"tweets.js\x00",
	} {
		t.Run(archivePath, func(t *testing.T) {
			err := validateParams(context.Background(), nil, SourceTwitter, IngestParams{ArchivePath: archivePath})
			if err == nil {
				t.Fatalf("expected validation error")
			}
		})
	}
}

func TestValidateParamsAllowsRelativeArchivePath(t *testing.T) {
	err := validateParams(context.Background(), nil, SourceTwitter, IngestParams{ArchivePath: "uploads/tenant-1/tweets.js"})
	if err != nil {
		t.Fatalf("ValidateParams: %v", err)
	}
}

func TestValidateParamsAllowsTwitterAPIUsername(t *testing.T) {
	err := validateParams(context.Background(), nil, SourceTwitter, IngestParams{
		Extra: map[string]string{"mode": "api", "username": "postwave"},
	})
	if err != nil {
		t.Fatalf("ValidateParams: %v", err)
	}
}

func TestValidateParamsRejectsTwitterAPIMissingIdentity(t *testing.T) {
	err := validateParams(context.Background(), nil, SourceTwitter, IngestParams{
		Extra: map[string]string{"mode": "api"},
	})
	if err == nil {
		t.Fatalf("expected validation error")
	}
}

func TestValidateParamsRejectsTwitterMissingArchiveOrAPIIdentity(t *testing.T) {
	err := validateParams(context.Background(), nil, SourceTwitter, IngestParams{})
	if err == nil {
		t.Fatalf("expected validation error")
	}
}

func TestValidateParamsAppliesArchiveRulesToLinkedInExports(t *testing.T) {
	if err := validateParams(context.Background(), nil, SourceLinkedInExport, IngestParams{}); err == nil {
		t.Fatal("expected missing csv source to be rejected")
	}
	if err := validateParams(context.Background(), nil, SourceLinkedInExport, IngestParams{ArchivePath: "../linkedin.csv"}); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
	if err := validateParams(context.Background(), nil, SourceLinkedInExport, IngestParams{ArchivePath: "uploads/tenant-1/linkedin.csv"}); err != nil {
		t.Fatalf("ValidateParams: %v", err)
	}
	if err := validateParams(context.Background(), nil, SourceLinkedInExport, IngestParams{RawText: "Date,Text\n2026-05-01,Hello"}); err != nil {
		t.Fatalf("ValidateParams raw csv: %v", err)
	}
}

func TestValidateParamsRejectsMissingRawTextSources(t *testing.T) {
	for _, sourceType := range []SourceType{SourcePasteIn, SourcePodcastTranscript} {
		t.Run(string(sourceType), func(t *testing.T) {
			err := validateParams(context.Background(), nil, sourceType, IngestParams{RawText: "   "})
			if err == nil {
				t.Fatalf("expected validation error")
			}
		})
	}
}
