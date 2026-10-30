// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebroker

import "testing"

func FuzzNormalizeSourceURLNeverAcceptsNonHTTPSOrCredentials(f *testing.F) {
	for _, seed := range []string{
		"https://images.example.com/a.png",
		"http://169.254.169.254/latest/meta-data",
		"https://user:pass@images.example.com/a.png",
		"https://[::1]/a.png",
		"javascript:alert(1)",
		"https://images.example.com/a/../secret",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		normalized, err := NormalizeSourceURL(raw)
		if err != nil {
			return
		}
		if len(normalized) < len("https://") || normalized[:len("https://")] != "https://" {
			t.Fatalf("accepted non-HTTPS URL %q as %q", raw, normalized)
		}
		second, err := NormalizeSourceURL(normalized)
		if err != nil || second != normalized {
			t.Fatalf("normalization is not idempotent: first=%q second=%q err=%v", normalized, second, err)
		}
	})
}

func FuzzReviewedSourceExtractionFailsClosed(f *testing.F) {
	f.Add(`<figure data-postwave-node="hero"><img src="https://images.example.com/a.png"></figure>`)
	f.Add(`<img srcset="https://images.example.com/a.png 2x">`)
	f.Add(`<style>body{background:url(https://169.254.169.254/x)}</style>`)
	f.Fuzz(func(t *testing.T, source string) {
		if len(source) > 1<<20 {
			t.Skip()
		}
		extracted, _, err := extractReviewedSources([]byte(source), []SourceReview{{NodeID: "hero", URL: "https://images.example.com/a.png"}}, 1<<20, 4)
		if err != nil {
			return
		}
		for _, item := range extracted {
			if item.nodeID != "hero" || item.normalized != "https://images.example.com/a.png" {
				t.Fatalf("extracted unreviewed source: %+v", item)
			}
		}
	})
}
