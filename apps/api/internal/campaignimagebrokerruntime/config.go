// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignimagebrokerruntime composes the production-only
// dependencies behind campaignimagebroker. It is intentionally separate from
// API startup so a caller must explicitly enable and inject the ready runtime.
package campaignimagebrokerruntime

import (
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

const (
	FeatureEnvironmentKey = "POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_IMAGE_BROKER"
	SandboxProfile        = "postwave.ocr.data-only.v1"
	ProtocolVersion       = "postwave.campaign-image-ipc.v1"

	defaultProtocolTimeout = 10 * time.Second
	defaultEvidenceTTL     = 30 * 24 * time.Hour
	defaultCacheTTL        = 14 * 24 * time.Hour
	defaultMaxRasterBytes  = int64(10 << 20)
	defaultMaxWireHeader   = 64 << 10
)

var (
	ErrDisabled             = errors.New("campaign image broker runtime: disabled")
	ErrInvalidConfiguration = errors.New("campaign image broker runtime: invalid configuration")
	ErrNotReady             = errors.New("campaign image broker runtime: not ready")
	methodIdentityPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,159}$`)
	bucketPattern           = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	kmsKeyARNPattern        = regexp.MustCompile(`^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]{1,128}$`)
)

type OCRConfig struct {
	SocketPath       string
	Engine           string
	Version          string
	Timeout          time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int
}

type ScannerConfig struct {
	SocketPath       string
	Engine           string
	Version          string
	Timeout          time.Duration
	MaxRequestBytes  int64
	MaxResponseBytes int
}

type EvidenceConfig struct {
	Bucket         string
	Prefix         string
	KMSKeyID       string
	MaxRasterBytes int64
	Retention      time.Duration
}

type Configuration struct {
	Enabled        bool
	AllowedHosts   []string
	OCR            OCRConfig
	Scanner        ScannerConfig
	Evidence       EvidenceConfig
	CacheRetention time.Duration
	Broker         campaignimagebroker.Configuration
}

// ConfigurationFromEnvironment parses only the image-broker namespace. When
// the feature is off, unrelated partially staged values are deliberately not
// validated and no dependency becomes reachable.
func ConfigurationFromEnvironment(getenv func(string) string) (Configuration, error) {
	if getenv == nil {
		return Configuration{}, fmt.Errorf("%w: environment reader is required", ErrInvalidConfiguration)
	}
	enabled, err := parseFeatureFlag(getenv(FeatureEnvironmentKey))
	if err != nil {
		return Configuration{}, err
	}
	if !enabled {
		return Configuration{}, nil
	}
	protocolTimeout, err := parseDurationEnvironment(
		getenv("POSTWAVE_CAMPAIGN_IMAGE_IPC_TIMEOUT"), defaultProtocolTimeout,
		100*time.Millisecond, time.Minute,
	)
	if err != nil {
		return Configuration{}, err
	}
	evidenceTTL, err := parseDurationEnvironment(
		getenv("POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_RETENTION"), defaultEvidenceTTL,
		time.Hour, 30*24*time.Hour,
	)
	if err != nil {
		return Configuration{}, err
	}
	cacheTTL, err := parseDurationEnvironment(
		getenv("POSTWAVE_CAMPAIGN_IMAGE_OCR_CACHE_RETENTION"), defaultCacheTTL,
		time.Hour, 30*24*time.Hour,
	)
	if err != nil {
		return Configuration{}, err
	}
	hostValue := getenv("POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS")
	hosts := []string(nil)
	if hostValue != "" {
		hosts = strings.Split(hostValue, ",")
	}
	configuration := Configuration{
		Enabled:      true,
		AllowedHosts: hosts,
		OCR: OCRConfig{
			SocketPath:       getenv("POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET"),
			Engine:           getenv("POSTWAVE_CAMPAIGN_IMAGE_OCR_ENGINE"),
			Version:          getenv("POSTWAVE_CAMPAIGN_IMAGE_OCR_VERSION"),
			Timeout:          protocolTimeout,
			MaxRequestBytes:  defaultMaxRasterBytes,
			MaxResponseBytes: defaultMaxWireHeader,
		},
		Scanner: ScannerConfig{
			SocketPath:       getenv("POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET"),
			Engine:           getenv("POSTWAVE_CAMPAIGN_IMAGE_SCANNER_ENGINE"),
			Version:          getenv("POSTWAVE_CAMPAIGN_IMAGE_SCANNER_VERSION"),
			Timeout:          protocolTimeout,
			MaxRequestBytes:  defaultMaxRasterBytes,
			MaxResponseBytes: defaultMaxWireHeader,
		},
		Evidence: EvidenceConfig{
			Bucket:         getenv("POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET"),
			Prefix:         getenv("POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_PREFIX"),
			KMSKeyID:       getenv("POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID"),
			MaxRasterBytes: defaultMaxRasterBytes,
			Retention:      evidenceTTL,
		},
		CacheRetention: cacheTTL,
	}
	configuration.Broker = campaignimagebroker.Configuration{
		AllowedHosts:       append([]string(nil), hosts...),
		EvidenceRetention:  evidenceTTL,
		RequireContentScan: true,
	}
	if err := configuration.Validate(); err != nil {
		return Configuration{}, err
	}
	return configuration, nil
}

func (c Configuration) Validate() error {
	if !c.Enabled {
		return nil
	}
	if len(c.AllowedHosts) == 0 || len(c.AllowedHosts) > 256 {
		return fmt.Errorf("%w: an exact image-host allowlist is required", ErrInvalidConfiguration)
	}
	seen := make(map[string]struct{}, len(c.AllowedHosts))
	for _, host := range c.AllowedHosts {
		if host == "" || strings.TrimSpace(host) != host || strings.ContainsAny(host, "* /:%") ||
			net.ParseIP(host) != nil || strings.HasSuffix(host, ".") || strings.ToLower(host) != host {
			return fmt.Errorf("%w: image hosts must be exact lowercase DNS names", ErrInvalidConfiguration)
		}
		if _, duplicate := seen[host]; duplicate {
			return fmt.Errorf("%w: duplicate image host", ErrInvalidConfiguration)
		}
		seen[host] = struct{}{}
	}
	if err := validateUnixService(c.OCR.SocketPath, c.OCR.Engine, c.OCR.Version,
		c.OCR.Timeout, c.OCR.MaxRequestBytes, c.OCR.MaxResponseBytes); err != nil {
		return fmt.Errorf("%w: OCR: %v", ErrInvalidConfiguration, err)
	}
	if err := validateUnixService(c.Scanner.SocketPath, c.Scanner.Engine, c.Scanner.Version,
		c.Scanner.Timeout, c.Scanner.MaxRequestBytes, c.Scanner.MaxResponseBytes); err != nil {
		return fmt.Errorf("%w: scanner: %v", ErrInvalidConfiguration, err)
	}
	if !bucketPattern.MatchString(c.Evidence.Bucket) || strings.Contains(c.Evidence.Bucket, "..") ||
		net.ParseIP(c.Evidence.Bucket) != nil {
		return fmt.Errorf("%w: private evidence bucket name is invalid", ErrInvalidConfiguration)
	}
	if c.Evidence.Prefix == "" || strings.TrimSpace(c.Evidence.Prefix) != c.Evidence.Prefix ||
		filepath.Clean(c.Evidence.Prefix) != c.Evidence.Prefix || filepath.IsAbs(c.Evidence.Prefix) ||
		strings.HasPrefix(c.Evidence.Prefix, ".") || strings.Contains(c.Evidence.Prefix, `\`) {
		return fmt.Errorf("%w: evidence prefix must be an exact relative object prefix", ErrInvalidConfiguration)
	}
	if !kmsKeyARNPattern.MatchString(c.Evidence.KMSKeyID) {
		return fmt.Errorf("%w: an exact evidence KMS key ARN is required", ErrInvalidConfiguration)
	}
	if c.Evidence.MaxRasterBytes < 1024 || c.Evidence.MaxRasterBytes > defaultMaxRasterBytes ||
		c.Evidence.Retention < time.Hour || c.Evidence.Retention > 30*24*time.Hour ||
		c.CacheRetention < time.Hour || c.CacheRetention > 30*24*time.Hour {
		return fmt.Errorf("%w: retention or raster bound is outside the reviewed range", ErrInvalidConfiguration)
	}
	if c.Broker.EvidenceRetention != c.Evidence.Retention || !c.Broker.RequireContentScan {
		return fmt.Errorf("%w: broker must use the reviewed evidence retention and scanner boundary", ErrInvalidConfiguration)
	}
	if c.Broker.SVGPolicy != "" && c.Broker.SVGPolicy != campaignimagebroker.SVGReject {
		return fmt.Errorf("%w: production runtime rejects SVG rather than delegating an unconfigured rasterizer", ErrInvalidConfiguration)
	}
	if len(c.Broker.AllowedHosts) != len(c.AllowedHosts) {
		return fmt.Errorf("%w: broker allowlist differs from runtime allowlist", ErrInvalidConfiguration)
	}
	for index := range c.AllowedHosts {
		if c.Broker.AllowedHosts[index] != c.AllowedHosts[index] {
			return fmt.Errorf("%w: broker allowlist differs from runtime allowlist", ErrInvalidConfiguration)
		}
	}
	if _, err := campaignimagebroker.New(c.Broker, campaignimagebroker.Dependencies{}); err != nil {
		return fmt.Errorf("%w: broker network policy: %v", ErrInvalidConfiguration, err)
	}
	return nil
}

func validateUnixService(path, engine, version string, timeout time.Duration, maxRequest int64, maxResponse int) error {
	if path == "" || strings.TrimSpace(path) != path || !filepath.IsAbs(path) || filepath.Clean(path) != path ||
		len(path) > 100 || strings.ContainsAny(path, "\r\n\x00") {
		return errors.New("an exact absolute Unix-domain socket path is required")
	}
	if !methodIdentityPattern.MatchString(engine) || !methodIdentityPattern.MatchString(version) {
		return errors.New("engine and version must be exact lowercase identities")
	}
	if timeout < 100*time.Millisecond || timeout > time.Minute || maxRequest < 1024 ||
		maxRequest > defaultMaxRasterBytes || maxResponse < 1024 || maxResponse > defaultMaxWireHeader {
		return errors.New("IPC timeout or size bound is outside the reviewed range")
	}
	return nil
}

func parseFeatureFlag(raw string) (bool, error) {
	switch raw {
	case "", "false":
		return false, nil
	case "true":
		return true, nil
	default:
		return false, fmt.Errorf("%w: %s must be exactly true or false", ErrInvalidConfiguration, FeatureEnvironmentKey)
	}
}

func parseDurationEnvironment(raw string, fallback, minimum, maximum time.Duration) (time.Duration, error) {
	if raw == "" {
		return fallback, nil
	}
	if strings.TrimSpace(raw) != raw {
		return 0, fmt.Errorf("%w: duration contains surrounding whitespace", ErrInvalidConfiguration)
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%w: invalid bounded duration %q", ErrInvalidConfiguration, raw)
	}
	return parsed, nil
}
