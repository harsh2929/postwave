// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignimagebroker is the network isolation boundary between a
// frozen Campaign Assurance artifact and image/OCR analysis. The broker owns
// URL review, outbound fetching, image decoding, raster normalization, and
// durable raster evidence. OCR engines receive bytes and immutable hashes
// only; they are never given a URL, HTTP client, credential, or tool surface.
package campaignimagebroker

import (
	"context"
	"errors"
	"io"
	"time"
)

const (
	BrokerVersion     = "postwave.campaign-image-broker.v2"
	OCRRuntimeVersion = "postwave.campaign-ocr-runtime.v2"

	StatusVerified    Status = "verified"
	StatusFailed      Status = "failed"
	StatusUnavailable Status = "unavailable"

	OCRComplete    OCRStatus = "complete"
	OCRFailed      OCRStatus = "failed"
	OCRUnavailable OCRStatus = "unavailable"

	SVGReject               SVGPolicy   = "reject"
	SVGSanitizeAndRasterize SVGPolicy   = "sanitize_and_rasterize"
	AnimatedFirstFrame      FramePolicy = "first_frame"
)

var (
	ErrInvalidConfiguration = errors.New("campaign image broker: invalid configuration")
	ErrInvalidRequest       = errors.New("campaign image broker: invalid request")
	ErrSourceRejected       = errors.New("campaign image broker: source rejected")
	ErrSourceUnavailable    = errors.New("campaign image broker: source unavailable")
	ErrResourceLimit        = errors.New("campaign image broker: resource limit exceeded")
	ErrInvalidImage         = errors.New("campaign image broker: invalid image")
)

type Status string
type OCRStatus string
type SVGPolicy string
type FramePolicy string

// DNSResolver is deliberately small so DNS rebinding behavior can be tested
// without using the process-wide resolver.
type DNSResolver interface {
	LookupIPAddr(context.Context, string) ([]IPAddr, error)
}

// IPAddr is the resolver value understood by the broker. net.IPAddr is
// adapted by NetResolver; keeping this type small prevents a test resolver
// from acquiring any unrelated network capability.
type IPAddr struct {
	IP   []byte
	Zone string
}

// SourceReview is the allowlist derived from the already-frozen, effective
// semantic revision. The broker will fetch an <img> only when the rendered
// node identity and normalized URL exactly match this review.
type SourceReview struct {
	NodeID string
	URL    string
}

type Request struct {
	TenantID         string
	FrozenSourceHash string
	ArtifactHash     string
	HTMLHash         string
	Locale           string
	HTML             []byte
	ReviewedSources  []SourceReview
}

// OCRIdentity is frozen into every successful or failed OCR receipt.
type OCRIdentity struct {
	Engine  string `json:"engine"`
	Version string `json:"version"`
}

// OCRInput is the complete OCR sandbox input. RasterPNG is a canonical,
// single-frame PNG. No source URL or network primitive is present.
type OCRInput struct {
	RasterPNG    []byte
	AssetSHA256  string
	RasterSHA256 string
	Width        int
	Height       int
	LanguageHint string
}

// OCROutput represents both recognized text and a successful no-text result.
// The latter is the zero value returned without an error. Non-empty text
// requires a language; no-text results must not invent language or confidence.
type OCROutput struct {
	Text       string
	Language   string
	Confidence *float64
}

// OCREngine implementations must run without network, tools, browser access,
// or credentials. Production composition must enforce that sandbox; this
// package also prevents URL/fetch capability from crossing the interface.
type OCREngine interface {
	Identity() OCRIdentity
	Recognize(context.Context, OCRInput) (OCROutput, error)
}

type SVGInput struct {
	SanitizedSVG []byte
	AssetSHA256  string
	MaxWidth     int
	MaxHeight    int
	MaxPixels    int64
}

// SVGRasterizer is optional. Scripts, external references, fonts, animation,
// styles, and active XML constructs are rejected before this interface runs.
// Its output is decoded and canonicalized again before OCR.
type SVGRasterizer interface {
	Identity() string
	Rasterize(context.Context, SVGInput) ([]byte, error)
}

type ScanInput struct {
	Body        []byte
	MediaType   string
	AssetSHA256 string
}

// ContentScanner is an optional malware/content scan boundary. Body is the
// exact fetched response body, before any image decoder, SVG/XML parser, or
// sanitizer receives it. When RequireContentScan is true, absence or failure
// of this dependency prevents parsing and produces a fail-closed receipt.
type ContentScanner interface {
	Identity() string
	Scan(context.Context, ScanInput) error
}

type EvidencePutInput struct {
	TenantID  string
	ObjectKey string
	MediaType string
	ExpiresAt time.Time
	Body      io.Reader
}

// EvidenceStore persists the exact sanitized single-frame raster that was
// supplied to OCR. Put must be idempotent for ObjectKey.
type EvidenceStore interface {
	Put(context.Context, EvidencePutInput) (string, error)
}

type CacheKey struct {
	TenantID          string
	AssetSHA256       string
	RasterSHA256      string
	OCRRuntimeVersion string
	Engine            string
	EngineVersion     string
	LanguageHint      string
}

// OCRCache is keyed by immutable content and method identity, never a URL.
// Cache failures are recorded in provenance but do not create a false OCR
// success or prevent a safe live execution.
type OCRCache interface {
	Get(context.Context, CacheKey) (OCROutput, bool, error)
	Put(context.Context, CacheKey, OCROutput) error
}

type Configuration struct {
	AllowedHosts          []string
	MaxHTMLBytes          int
	MaxImages             int
	MaxRedirects          int
	MaxResponseBytes      int64
	MaxTotalResponseBytes int64
	MaxWidth              int
	MaxHeight             int
	MaxPixels             int64
	MaxTotalPixels        int64
	MaxFrames             int
	MaxOCRTextBytes       int
	MaxTotalOCRTextBytes  int
	MaxDNSAnswers         int
	MaxConcurrency        int
	DialTimeout           time.Duration
	ResponseHeaderTimeout time.Duration
	PerImageTimeout       time.Duration
	CampaignTimeout       time.Duration
	OCRTimeout            time.Duration
	EvidenceRetention     time.Duration
	SVGPolicy             SVGPolicy
	FramePolicy           FramePolicy
	RequireContentScan    bool
	Now                   func() time.Time
}

type Receipt struct {
	NodeID             string      `json:"node_id,omitempty"`
	HTMLLocation       string      `json:"html_location,omitempty"`
	Status             Status      `json:"status"`
	FailureCode        string      `json:"failure_code,omitempty"`
	FrozenSourceHash   string      `json:"frozen_source_hash"`
	ArtifactHash       string      `json:"artifact_hash"`
	HTMLHash           string      `json:"html_hash"`
	SourceURLSHA256    string      `json:"source_url_sha256,omitempty"`
	FinalURLSHA256     string      `json:"final_url_sha256,omitempty"`
	RedirectURLSHA256s []string    `json:"redirect_url_sha256s,omitempty"`
	AssetSHA256        string      `json:"asset_sha256,omitempty"`
	RasterSHA256       string      `json:"raster_sha256,omitempty"`
	RasterObjectRef    string      `json:"raster_object_ref,omitempty"`
	RasterExpiresAt    *time.Time  `json:"raster_expires_at,omitempty"`
	MediaType          string      `json:"media_type,omitempty"`
	EncodedBytes       int64       `json:"encoded_bytes,omitempty"`
	Width              int         `json:"width,omitempty"`
	Height             int         `json:"height,omitempty"`
	FrameCount         int         `json:"frame_count,omitempty"`
	SelectedFrame      int         `json:"selected_frame,omitempty"`
	FramePolicy        FramePolicy `json:"frame_policy,omitempty"`
	SVGPolicy          SVGPolicy   `json:"svg_policy,omitempty"`
	RasterizerVersion  string      `json:"rasterizer_version,omitempty"`
	ScannerVersion     string      `json:"scanner_version,omitempty"`
	ScanInputSHA256    string      `json:"scan_input_sha256,omitempty"`
	OCRStatus          OCRStatus   `json:"ocr_status"`
	OCRFailureCode     string      `json:"ocr_failure_code,omitempty"`
	OCRText            string      `json:"ocr_text,omitempty"`
	OCRTextSHA256      string      `json:"ocr_text_sha256,omitempty"`
	OCRLanguage        string      `json:"ocr_language,omitempty"`
	OCRConfidence      *float64    `json:"ocr_confidence,omitempty"`
	OCREngine          string      `json:"ocr_engine,omitempty"`
	OCREngineVersion   string      `json:"ocr_engine_version,omitempty"`
	OCRRuntimeVersion  string      `json:"ocr_runtime_version"`
	CacheStatus        string      `json:"cache_status,omitempty"`
	LatencyMS          int64       `json:"latency_ms"`
}

type Report struct {
	BrokerVersion       string    `json:"broker_version"`
	OCRRuntimeVersion   string    `json:"ocr_runtime_version"`
	FrozenSourceHash    string    `json:"frozen_source_hash"`
	ArtifactHash        string    `json:"artifact_hash"`
	HTMLHash            string    `json:"html_hash"`
	PolicyHash          string    `json:"policy_hash"`
	ReviewedSourceCount int       `json:"reviewed_source_count"`
	ReceiptCount        int       `json:"receipt_count"`
	CompleteOCRCount    int       `json:"complete_ocr_count"`
	UnavailableCount    int       `json:"unavailable_count"`
	FailedCount         int       `json:"failed_count"`
	LatencyMS           int64     `json:"latency_ms"`
	Receipts            []Receipt `json:"receipts"`
}

// Inspector is the narrow worker seam. Implementations return per-source
// failure receipts for remote, parsing, policy, scanning, persistence, and OCR
// failures. A non-nil error is reserved for an invalid request or cancellation.
type Inspector interface {
	Inspect(context.Context, Request) (Report, error)
}
