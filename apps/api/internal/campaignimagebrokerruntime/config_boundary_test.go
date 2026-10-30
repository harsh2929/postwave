package campaignimagebrokerruntime

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

// Configuration.Validate() holds the production boundary for campaign image
// fetching: which hosts may be reached, that every image is content-scanned,
// that SVG is rejected rather than handed to an unconfigured rasterizer, and
// that the broker's own allowlist cannot diverge from the runtime's.
//
// None of it was covered. The existing config tests drive
// ConfigurationFromEnvironment and fail on earlier env-parsing errors, so they
// never reach these branches with an ENABLED, otherwise-valid configuration.
// Verified by mutation: deleting the content-scan requirement, the SVG rule,
// the element-wise allowlist comparison, the IP-literal rejection and the
// wildcard rejection each left the package green.
//
// The host rules are the SSRF control — an image URL is fetched server-side, so
// "no IP literals, no wildcards, exact lowercase DNS" is what keeps a campaign
// from pointing the fetcher at an internal address.
func validImageBrokerConfiguration() Configuration {
	hosts := []string{"cdn.example.com"}
	return Configuration{
		Enabled:      true,
		AllowedHosts: hosts,
		OCR: OCRConfig{
			SocketPath: "/var/run/pw-ocr.sock", Engine: "tesseract", Version: "5.3.0",
			Timeout: 5 * time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 32 << 10,
		},
		Scanner: ScannerConfig{
			SocketPath: "/var/run/pw-scan.sock", Engine: "clamav", Version: "1.0.0",
			Timeout: 5 * time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 32 << 10,
		},
		Evidence: EvidenceConfig{
			Bucket: "postwave-evidence", Prefix: "evidence",
			KMSKeyID:       "arn:aws:kms:eu-north-1:123456789012:key/00000000-0000-0000-0000-000000000001",
			MaxRasterBytes: 1 << 20, Retention: 24 * time.Hour,
		},
		CacheRetention: 24 * time.Hour,
		Broker: campaignimagebroker.Configuration{
			AllowedHosts: append([]string(nil), hosts...), EvidenceRetention: 24 * time.Hour,
			RequireContentScan: true,
		},
	}
}

func TestValidateAcceptsTheReviewedProductionShape(t *testing.T) {
	// Guard the guard. Every rejection below is only meaningful because this
	// baseline passes; a Validate() that refused everything would satisfy them
	// all while making the feature unbootable.
	if err := validImageBrokerConfiguration().Validate(); err != nil {
		t.Fatalf("the reviewed production configuration was rejected: %v", err)
	}
}

func TestValidateRejectsWeakenedProductionBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Configuration)
		want   string
	}{
		{
			// Without this an image is fetched and stored with no malware scan.
			name:   "content scanning switched off",
			mutate: func(c *Configuration) { c.Broker.RequireContentScan = false },
			want:   "scanner boundary",
		},
		{
			// The broker does the fetching; if its allowlist can differ from the
			// runtime's, the reviewed list is decorative.
			name:   "broker allowlist diverges from the runtime allowlist",
			mutate: func(c *Configuration) { c.Broker.AllowedHosts = []string{"attacker.example"} },
			want:   "broker allowlist differs",
		},
		{
			name:   "broker allowlist is a different length",
			mutate: func(c *Configuration) { c.Broker.AllowedHosts = []string{"cdn.example.com", "extra.example"} },
			want:   "broker allowlist differs",
		},
		{
			// The SSRF control: an IP literal points the fetcher straight at an
			// address rather than a name someone reviewed.
			name: "an IP literal is allowlisted",
			mutate: func(c *Configuration) {
				c.AllowedHosts = []string{"169.254.169.254"}
				c.Broker.AllowedHosts = []string{"169.254.169.254"}
			},
			want: "exact lowercase DNS names",
		},
		{
			name: "a wildcard host is allowlisted",
			mutate: func(c *Configuration) {
				c.AllowedHosts = []string{"*.example.com"}
				c.Broker.AllowedHosts = []string{"*.example.com"}
			},
			want: "exact lowercase DNS names",
		},
		{
			name: "an uppercase host is allowlisted",
			mutate: func(c *Configuration) {
				c.AllowedHosts = []string{"CDN.example.com"}
				c.Broker.AllowedHosts = []string{"CDN.example.com"}
			},
			want: "exact lowercase DNS names",
		},
		{
			name:   "the allowlist is empty",
			mutate: func(c *Configuration) { c.AllowedHosts = nil; c.Broker.AllowedHosts = nil },
			want:   "exact image-host allowlist is required",
		},
		{
			// Delegating SVG to an unconfigured rasterizer is how a vector file
			// becomes code execution in whatever renders it.
			name:   "SVG is delegated rather than rejected",
			mutate: func(c *Configuration) { c.Broker.SVGPolicy = "rasterize" },
			want:   "rejects SVG",
		},
		{
			name:   "evidence retention disagrees with the broker's",
			mutate: func(c *Configuration) { c.Broker.EvidenceRetention = 48 * time.Hour },
			want:   "reviewed evidence retention",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := validImageBrokerConfiguration()
			tc.mutate(&c)
			err := c.Validate()
			if err == nil {
				t.Fatalf("accepted a configuration that %s", tc.name)
			}
			if !errors.Is(err, ErrInvalidConfiguration) {
				t.Errorf("error should wrap ErrInvalidConfiguration, got %v", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.want)
			}
		})
	}
}
