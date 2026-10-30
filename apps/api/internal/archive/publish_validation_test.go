package archive

import (
	"errors"
	"strings"
	"testing"
)

// strPtr — tiny helper that lets the test table express "explicit
// empty string (clear column)" distinctly from "nil (leave alone)".
func strPtr(s string) *string { return &s }

// TestValidatePublishInput_Lengths — per-field length caps for the
// non-slug SEO knobs accepted by AdminPublish/PublishCampaign.
//
// Boundary-tested: each field's cap is exercised at exactly the limit
// (nil error) and exactly limit+1 (error). The error variable
// returned is the field-specific sentinel so the handler can map it
// to a per-field `invalid_<field>` JSON code.
func TestValidatePublishInput_Lengths(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		in      PublishInput
		wantErr error
	}{
		// Excerpt boundaries.
		{"excerpt empty", PublishInput{Excerpt: ""}, nil},
		{"excerpt at limit", PublishInput{Excerpt: strings.Repeat("a", PublishExcerptMaxLen)}, nil},
		{"excerpt over limit", PublishInput{Excerpt: strings.Repeat("a", PublishExcerptMaxLen+1)}, errPublishExcerptTooLong},

		// Meta description boundaries — nil leaves column alone,
		// empty string clears, non-empty is bounded.
		{"meta_description nil leaves alone", PublishInput{}, nil},
		{"meta_description empty clears", PublishInput{MetaDescription: strPtr("")}, nil},
		{"meta_description at limit", PublishInput{MetaDescription: strPtr(strings.Repeat("a", PublishMetaDescriptionMaxLen))}, nil},
		{"meta_description over limit", PublishInput{MetaDescription: strPtr(strings.Repeat("a", PublishMetaDescriptionMaxLen+1))}, errPublishMetaDescriptionTooLong},

		// Author name boundaries.
		{"author_name nil leaves alone", PublishInput{}, nil},
		{"author_name empty clears", PublishInput{AuthorName: strPtr("")}, nil},
		{"author_name at limit", PublishInput{AuthorName: strPtr(strings.Repeat("a", PublishAuthorNameMaxLen))}, nil},
		{"author_name over limit", PublishInput{AuthorName: strPtr(strings.Repeat("a", PublishAuthorNameMaxLen+1))}, errPublishAuthorNameTooLong},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := validatePublishInput(tc.in)
			if !errors.Is(got, tc.wantErr) {
				t.Fatalf("validatePublishInput(%+v) = %v, want %v", tc.in, got, tc.wantErr)
			}
		})
	}
}

// TestValidatePublishInput_URLs — og_image / hero_image SSRF + shape
// guards. Load-bearing: pre-fix these inputs were accepted as opaque
// strings and rendered straight into the `<meta property="og:image">`
// tag, which Facebook/Twitter/Slack unfurl bots dereference, and which
// operator-side image proxies (often deployed in front of newsletters)
// would also dereference, opening an SSRF pivot to AWS IMDS
// (169.254.169.254) and other internal services.
func TestValidatePublishInput_URLs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		in      PublishInput
		wantErr error
	}{
		// og_image — happy paths.
		{"og_image nil leaves alone", PublishInput{}, nil},
		{"og_image empty clears", PublishInput{OGImage: strPtr("")}, nil},
		{"og_image whitespace-only treated as clear", PublishInput{OGImage: strPtr("   ")}, nil},
		{"og_image https public host", PublishInput{OGImage: strPtr("https://cdn.example.com/og.png")}, nil},
		{"og_image http public host", PublishInput{OGImage: strPtr("http://example.org/og.png")}, nil},
		{"og_image public IPv4 literal", PublishInput{OGImage: strPtr("https://8.8.8.8/og.png")}, nil},
		{"og_image valid explicit port", PublishInput{OGImage: strPtr("https://cdn.example.com:8443/og.png")}, nil},

		// og_image — SSRF cases.
		{"og_image AWS IMDS link-local", PublishInput{OGImage: strPtr("http://169.254.169.254/latest/meta-data/")}, errPublishOGImageInvalid},
		{"og_image loopback", PublishInput{OGImage: strPtr("http://127.0.0.1/og.png")}, errPublishOGImageInvalid},
		{"og_image localhost IPv6", PublishInput{OGImage: strPtr("http://[::1]/og.png")}, errPublishOGImageInvalid},
		{"og_image RFC1918 10/8", PublishInput{OGImage: strPtr("http://10.0.0.1/og.png")}, errPublishOGImageInvalid},
		{"og_image RFC1918 192.168/16", PublishInput{OGImage: strPtr("http://192.168.1.1/og.png")}, errPublishOGImageInvalid},
		{"og_image RFC1918 172.16/12", PublishInput{OGImage: strPtr("http://172.16.0.1/og.png")}, errPublishOGImageInvalid},
		{"og_image 0.0.0.0 unspecified", PublishInput{OGImage: strPtr("http://0.0.0.0/og.png")}, errPublishOGImageInvalid},
		{"og_image multicast", PublishInput{OGImage: strPtr("http://224.0.0.1/og.png")}, errPublishOGImageInvalid},

		// og_image — shape failures.
		{"og_image relative path rejected", PublishInput{OGImage: strPtr("/relative/og.png")}, errPublishOGImageInvalid},
		{"og_image protocol-relative rejected", PublishInput{OGImage: strPtr("//cdn.example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image file scheme rejected", PublishInput{OGImage: strPtr("file:///etc/passwd")}, errPublishOGImageInvalid},
		{"og_image data scheme rejected", PublishInput{OGImage: strPtr("data:image/png;base64,iVBOR")}, errPublishOGImageInvalid},
		{"og_image ftp scheme rejected", PublishInput{OGImage: strPtr("ftp://example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image javascript scheme rejected", PublishInput{OGImage: strPtr("javascript:alert(1)")}, errPublishOGImageInvalid},
		{"og_image credentials rejected", PublishInput{OGImage: strPtr("https://user:pass@cdn.example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image username rejected", PublishInput{OGImage: strPtr("https://user@cdn.example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image empty port rejected", PublishInput{OGImage: strPtr("https://cdn.example.com:/og.png")}, errPublishOGImageInvalid},
		{"og_image zero port rejected", PublishInput{OGImage: strPtr("https://cdn.example.com:0/og.png")}, errPublishOGImageInvalid},
		{"og_image out-of-range port rejected", PublishInput{OGImage: strPtr("https://cdn.example.com:65536/og.png")}, errPublishOGImageInvalid},
		{"og_image nonnumeric port rejected", PublishInput{OGImage: strPtr("https://cdn.example.com:notaport/og.png")}, errPublishOGImageInvalid},
		{"og_image malformed IPv6 host rejected", PublishInput{OGImage: strPtr("https://[2001:4860::8888/og.png")}, errPublishOGImageInvalid},
		{"og_image empty DNS label rejected", PublishInput{OGImage: strPtr("https://cdn..example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image underscore host rejected", PublishInput{OGImage: strPtr("https://cdn_bad.example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image leading hyphen host rejected", PublishInput{OGImage: strPtr("https://-cdn.example.com/og.png")}, errPublishOGImageInvalid},
		{"og_image single-label host rejected", PublishInput{OGImage: strPtr("https://localhost/og.png")}, errPublishOGImageInvalid},
		{"og_image ambiguous numeric host rejected", PublishInput{OGImage: strPtr("https://127.1/og.png")}, errPublishOGImageInvalid},
		{"og_image escaped CRLF path rejected", PublishInput{OGImage: strPtr("https://cdn.example.com/og%0d%0aSet-Cookie.png")}, errPublishOGImageInvalid},
		{"og_image escaped NUL query rejected", PublishInput{OGImage: strPtr("https://cdn.example.com/og.png?x=%00")}, errPublishOGImageInvalid},
		{"og_image escaped DEL fragment rejected", PublishInput{OGImage: strPtr("https://cdn.example.com/og.png#%7f")}, errPublishOGImageInvalid},
		{"og_image malformed query escape rejected", PublishInput{OGImage: strPtr("https://cdn.example.com/og.png?x=%zz")}, errPublishOGImageInvalid},
		{"og_image raw control rejected", PublishInput{OGImage: strPtr("https://cdn.example.com/og.png\nnext")}, errPublishOGImageInvalid},

		// hero_image — mirror coverage for the second URL field.
		{"hero_image public host", PublishInput{HeroImage: strPtr("https://cdn.example.com/hero.png")}, nil},
		{"hero_image AWS IMDS rejected", PublishInput{HeroImage: strPtr("http://169.254.169.254/")}, errPublishHeroImageInvalid},
		{"hero_image loopback rejected", PublishInput{HeroImage: strPtr("http://127.0.0.1/")}, errPublishHeroImageInvalid},
		{"hero_image data scheme rejected", PublishInput{HeroImage: strPtr("data:image/png;base64,iVBOR")}, errPublishHeroImageInvalid},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := validatePublishInput(tc.in)
			if !errors.Is(got, tc.wantErr) {
				t.Fatalf("validatePublishInput(%+v) = %v, want %v", tc.in, got, tc.wantErr)
			}
		})
	}
}
