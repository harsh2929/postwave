// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebroker

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/idna"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

const (
	defaultMaxHTMLBytes          = 8 << 20
	defaultMaxImages             = 64
	defaultMaxRedirects          = 3
	defaultMaxResponseBytes      = 8 << 20
	defaultMaxTotalResponseBytes = 32 << 20
	defaultMaxDimension          = 8192
	defaultMaxPixels             = 16_000_000
	defaultMaxTotalPixels        = 64_000_000
	defaultMaxFrames             = 16
	defaultMaxOCRTextBytes       = 16 << 10
	defaultMaxTotalOCRTextBytes  = 64 << 10
	defaultMaxDNSAnswers         = 16
	defaultMaxConcurrency        = 2
	defaultDialTimeout           = 3 * time.Second
	defaultHeaderTimeout         = 5 * time.Second
	defaultPerImageTimeout       = 12 * time.Second
	defaultCampaignTimeout       = 45 * time.Second
	defaultOCRTimeout            = 8 * time.Second
	defaultEvidenceRetention     = 30 * 24 * time.Hour
)

type Dependencies struct {
	Resolver      DNSResolver
	Dialer        *net.Dialer
	RoundTripper  http.RoundTripper // deterministic tests only; production leaves this nil
	OCREngine     OCREngine
	SVGRasterizer SVGRasterizer
	Scanner       ContentScanner
	Evidence      EvidenceStore
	Cache         OCRCache
}

type Broker struct {
	configuration Configuration
	allowedHosts  map[string]struct{}
	policyHash    string
	resolver      DNSResolver
	dialer        *net.Dialer
	client        *http.Client
	ocr           OCREngine
	rasterizer    SVGRasterizer
	scanner       ContentScanner
	evidence      EvidenceStore
	cache         OCRCache
	slots         chan struct{}
}

var _ Inspector = (*Broker)(nil)

func New(configuration Configuration, dependencies Dependencies) (*Broker, error) {
	normalized, hosts, policyHash, err := normalizeConfiguration(configuration)
	if err != nil {
		return nil, err
	}
	resolver := dependencies.Resolver
	if resolver == nil {
		resolver = NetResolver{}
	}
	dialer := dependencies.Dialer
	if dialer == nil {
		dialer = &net.Dialer{Timeout: normalized.DialTimeout, KeepAlive: 30 * time.Second}
	}
	b := &Broker{
		configuration: normalized, allowedHosts: hosts, policyHash: policyHash,
		resolver: resolver, dialer: dialer, ocr: dependencies.OCREngine,
		rasterizer: dependencies.SVGRasterizer, scanner: dependencies.Scanner,
		evidence: dependencies.Evidence, cache: dependencies.Cache,
		slots: make(chan struct{}, normalized.MaxConcurrency),
	}
	if dependencies.RoundTripper != nil {
		b.client = &http.Client{Transport: dependencies.RoundTripper}
	} else {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.DialContext = b.dialContext
		transport.DialTLSContext = nil
		transport.DisableCompression = true
		transport.ForceAttemptHTTP2 = false
		transport.MaxResponseHeaderBytes = 64 << 10
		transport.ResponseHeaderTimeout = normalized.ResponseHeaderTimeout
		transport.TLSHandshakeTimeout = normalized.DialTimeout
		transport.ExpectContinueTimeout = time.Second
		transport.MaxIdleConns = normalized.MaxConcurrency * 2
		transport.MaxIdleConnsPerHost = normalized.MaxConcurrency
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		b.client = &http.Client{Transport: transport}
	}
	return b, nil
}

func normalizeConfiguration(input Configuration) (Configuration, map[string]struct{}, string, error) {
	configuration := input
	defaults := []struct {
		value *int
		def   int
		max   int
	}{
		{&configuration.MaxHTMLBytes, defaultMaxHTMLBytes, defaultMaxHTMLBytes},
		{&configuration.MaxImages, defaultMaxImages, 512},
		{&configuration.MaxRedirects, defaultMaxRedirects, 8},
		{&configuration.MaxWidth, defaultMaxDimension, 16_384},
		{&configuration.MaxHeight, defaultMaxDimension, 16_384},
		{&configuration.MaxFrames, defaultMaxFrames, 64},
		{&configuration.MaxOCRTextBytes, defaultMaxOCRTextBytes, 32 << 10},
		{&configuration.MaxTotalOCRTextBytes, defaultMaxTotalOCRTextBytes, 96 << 10},
		{&configuration.MaxDNSAnswers, defaultMaxDNSAnswers, 64},
		{&configuration.MaxConcurrency, defaultMaxConcurrency, 16},
	}
	for _, item := range defaults {
		if *item.value == 0 {
			*item.value = item.def
		}
		if *item.value < 1 || *item.value > item.max {
			return Configuration{}, nil, "", ErrInvalidConfiguration
		}
	}
	if configuration.MaxResponseBytes == 0 {
		configuration.MaxResponseBytes = defaultMaxResponseBytes
	}
	if configuration.MaxTotalResponseBytes == 0 {
		configuration.MaxTotalResponseBytes = defaultMaxTotalResponseBytes
	}
	if configuration.MaxPixels == 0 {
		configuration.MaxPixels = defaultMaxPixels
	}
	if configuration.MaxTotalPixels == 0 {
		configuration.MaxTotalPixels = defaultMaxTotalPixels
	}
	if configuration.MaxResponseBytes < 1024 || configuration.MaxResponseBytes > 10<<20 ||
		configuration.MaxTotalResponseBytes < configuration.MaxResponseBytes || configuration.MaxTotalResponseBytes > 256<<20 ||
		configuration.MaxPixels < 1 || configuration.MaxPixels > 40_000_000 ||
		configuration.MaxTotalPixels < configuration.MaxPixels || configuration.MaxTotalPixels > 256_000_000 ||
		configuration.MaxTotalOCRTextBytes < configuration.MaxOCRTextBytes {
		return Configuration{}, nil, "", ErrInvalidConfiguration
	}
	durations := []struct {
		value *time.Duration
		def   time.Duration
		max   time.Duration
	}{
		{&configuration.DialTimeout, defaultDialTimeout, 30 * time.Second},
		{&configuration.ResponseHeaderTimeout, defaultHeaderTimeout, 30 * time.Second},
		{&configuration.PerImageTimeout, defaultPerImageTimeout, time.Minute},
		{&configuration.CampaignTimeout, defaultCampaignTimeout, 5 * time.Minute},
		{&configuration.OCRTimeout, defaultOCRTimeout, time.Minute},
		{&configuration.EvidenceRetention, defaultEvidenceRetention, 30 * 24 * time.Hour},
	}
	for _, item := range durations {
		if *item.value == 0 {
			*item.value = item.def
		}
		if *item.value < time.Millisecond || *item.value > item.max {
			return Configuration{}, nil, "", ErrInvalidConfiguration
		}
	}
	if configuration.PerImageTimeout > configuration.CampaignTimeout || configuration.OCRTimeout > configuration.PerImageTimeout {
		return Configuration{}, nil, "", ErrInvalidConfiguration
	}
	if configuration.Now == nil {
		configuration.Now = time.Now
	}
	if configuration.SVGPolicy == "" {
		configuration.SVGPolicy = SVGReject
	}
	if configuration.SVGPolicy != SVGReject && configuration.SVGPolicy != SVGSanitizeAndRasterize {
		return Configuration{}, nil, "", ErrInvalidConfiguration
	}
	if configuration.FramePolicy == "" {
		configuration.FramePolicy = AnimatedFirstFrame
	}
	if configuration.FramePolicy != AnimatedFirstFrame {
		return Configuration{}, nil, "", ErrInvalidConfiguration
	}
	if len(configuration.AllowedHosts) == 0 || len(configuration.AllowedHosts) > 256 {
		return Configuration{}, nil, "", fmt.Errorf("%w: exact allowed hosts required", ErrInvalidConfiguration)
	}
	hosts := make(map[string]struct{}, len(configuration.AllowedHosts))
	canonicalHosts := make([]string, 0, len(configuration.AllowedHosts))
	for _, value := range configuration.AllowedHosts {
		if strings.TrimSpace(value) != value || value == "" || strings.ContainsAny(value, "/:*%") || strings.HasSuffix(value, ".") || net.ParseIP(value) != nil {
			return Configuration{}, nil, "", fmt.Errorf("%w: allowed hosts must be exact DNS names", ErrInvalidConfiguration)
		}
		host, err := idna.Lookup.ToASCII(value)
		if err != nil || host == "" || len(host) > 253 || strings.Contains(host, "_") {
			return Configuration{}, nil, "", ErrInvalidConfiguration
		}
		host = strings.ToLower(host)
		if _, duplicate := hosts[host]; duplicate {
			return Configuration{}, nil, "", fmt.Errorf("%w: duplicate allowed host", ErrInvalidConfiguration)
		}
		hosts[host] = struct{}{}
		canonicalHosts = append(canonicalHosts, host)
	}
	sort.Strings(canonicalHosts)
	configuration.AllowedHosts = canonicalHosts
	policy := struct {
		Version               string        `json:"version"`
		AllowedHosts          []string      `json:"allowed_hosts"`
		MaxHTMLBytes          int           `json:"max_html_bytes"`
		MaxImages             int           `json:"max_images"`
		MaxRedirects          int           `json:"max_redirects"`
		MaxResponseBytes      int64         `json:"max_response_bytes"`
		MaxTotalResponseBytes int64         `json:"max_total_response_bytes"`
		MaxWidth              int           `json:"max_width"`
		MaxHeight             int           `json:"max_height"`
		MaxPixels             int64         `json:"max_pixels"`
		MaxTotalPixels        int64         `json:"max_total_pixels"`
		MaxFrames             int           `json:"max_frames"`
		MaxOCRTextBytes       int           `json:"max_ocr_text_bytes"`
		MaxTotalOCRTextBytes  int           `json:"max_total_ocr_text_bytes"`
		MaxDNSAnswers         int           `json:"max_dns_answers"`
		MaxConcurrency        int           `json:"max_concurrency"`
		DialTimeout           time.Duration `json:"dial_timeout_ns"`
		ResponseHeaderTimeout time.Duration `json:"response_header_timeout_ns"`
		PerImageTimeout       time.Duration `json:"per_image_timeout_ns"`
		CampaignTimeout       time.Duration `json:"campaign_timeout_ns"`
		OCRTimeout            time.Duration `json:"ocr_timeout_ns"`
		EvidenceRetention     time.Duration `json:"evidence_retention_ns"`
		SVGPolicy             SVGPolicy     `json:"svg_policy"`
		FramePolicy           FramePolicy   `json:"frame_policy"`
		RequireContentScan    bool          `json:"require_content_scan"`
	}{
		Version: BrokerVersion, AllowedHosts: canonicalHosts,
		MaxHTMLBytes: configuration.MaxHTMLBytes, MaxImages: configuration.MaxImages,
		MaxRedirects: configuration.MaxRedirects, MaxResponseBytes: configuration.MaxResponseBytes,
		MaxTotalResponseBytes: configuration.MaxTotalResponseBytes,
		MaxWidth:              configuration.MaxWidth, MaxHeight: configuration.MaxHeight,
		MaxPixels: configuration.MaxPixels, MaxTotalPixels: configuration.MaxTotalPixels,
		MaxFrames: configuration.MaxFrames, MaxOCRTextBytes: configuration.MaxOCRTextBytes,
		MaxTotalOCRTextBytes: configuration.MaxTotalOCRTextBytes,
		MaxDNSAnswers:        configuration.MaxDNSAnswers, MaxConcurrency: configuration.MaxConcurrency,
		DialTimeout: configuration.DialTimeout, ResponseHeaderTimeout: configuration.ResponseHeaderTimeout,
		PerImageTimeout: configuration.PerImageTimeout, CampaignTimeout: configuration.CampaignTimeout,
		OCRTimeout: configuration.OCRTimeout, EvidenceRetention: configuration.EvidenceRetention,
		SVGPolicy: configuration.SVGPolicy, FramePolicy: configuration.FramePolicy,
		RequireContentScan: configuration.RequireContentScan,
	}
	encoded, _ := json.Marshal(policy)
	return configuration, hosts, digest(encoded), nil
}

func (b *Broker) Inspect(ctx context.Context, request Request) (Report, error) {
	if b == nil || b.client == nil || b.resolver == nil || len(b.allowedHosts) == 0 {
		return Report{}, ErrInvalidConfiguration
	}
	if !validHash(request.FrozenSourceHash) || !validHash(request.ArtifactHash) || !validHash(request.HTMLHash) ||
		digest(request.HTML) != request.HTMLHash || !validTenantIdentity(request.TenantID) {
		return Report{}, fmt.Errorf("%w: frozen identity mismatch", ErrInvalidRequest)
	}
	locale, err := language.Parse(strings.TrimSpace(request.Locale))
	if err != nil || locale == language.Und {
		return Report{}, fmt.Errorf("%w: invalid language hint", ErrInvalidRequest)
	}
	started := b.configuration.Now()
	workContext, cancel := context.WithTimeout(ctx, b.configuration.CampaignTimeout)
	defer cancel()
	sources, rejected, err := extractReviewedSources(request.HTML, request.ReviewedSources,
		b.configuration.MaxHTMLBytes, b.configuration.MaxImages)
	if err != nil {
		return Report{}, err
	}
	bind := func(receipt *Receipt) {
		receipt.FrozenSourceHash = request.FrozenSourceHash
		receipt.ArtifactHash = request.ArtifactHash
		receipt.HTMLHash = request.HTMLHash
		receipt.OCRRuntimeVersion = OCRRuntimeVersion
	}
	for i := range rejected {
		bind(&rejected[i])
	}
	receipts := append([]Receipt(nil), rejected...)
	totalBytes, totalPixels, totalOCRBytes := int64(0), int64(0), 0
	for _, source := range sources {
		if err := context.Cause(workContext); err != nil {
			if context.Cause(ctx) != nil {
				return Report{}, context.Cause(ctx)
			}
			receipt := rejectedReceipt(source.nodeID, source.htmlLocation, "campaign_timeout")
			receipt.SourceURLSHA256 = source.digest
			bind(&receipt)
			receipts = append(receipts, receipt)
			continue
		}
		if totalBytes >= b.configuration.MaxTotalResponseBytes || totalPixels >= b.configuration.MaxTotalPixels ||
			totalOCRBytes >= b.configuration.MaxTotalOCRTextBytes {
			receipt := rejectedReceipt(source.nodeID, source.htmlLocation, "campaign_resource_limit")
			receipt.SourceURLSHA256 = source.digest
			bind(&receipt)
			receipts = append(receipts, receipt)
			continue
		}
		receipt, consumedBytes, consumedPixels, ocrBytes, inspectErr := b.inspectSource(
			workContext, request, locale.String(), source,
			b.configuration.MaxTotalResponseBytes-totalBytes,
			b.configuration.MaxTotalPixels-totalPixels,
			b.configuration.MaxTotalOCRTextBytes-totalOCRBytes,
		)
		if inspectErr != nil {
			if context.Cause(ctx) != nil {
				return Report{}, context.Cause(ctx)
			}
			return Report{}, inspectErr
		}
		bind(&receipt)
		totalBytes += consumedBytes
		totalPixels += consumedPixels
		totalOCRBytes += ocrBytes
		receipts = append(receipts, receipt)
	}
	sort.Slice(receipts, func(i, j int) bool {
		if receipts[i].NodeID != receipts[j].NodeID {
			return receipts[i].NodeID < receipts[j].NodeID
		}
		return receipts[i].HTMLLocation < receipts[j].HTMLLocation
	})
	report := Report{
		BrokerVersion: BrokerVersion, OCRRuntimeVersion: OCRRuntimeVersion,
		FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash,
		HTMLHash: request.HTMLHash, PolicyHash: b.policyHash,
		ReviewedSourceCount: len(request.ReviewedSources), ReceiptCount: len(receipts), Receipts: receipts,
		LatencyMS: durationMilliseconds(b.configuration.Now().Sub(started)),
	}
	for _, receipt := range receipts {
		if receipt.OCRStatus == OCRComplete {
			report.CompleteOCRCount++
		}
		if receipt.Status == StatusUnavailable || receipt.OCRStatus == OCRUnavailable {
			report.UnavailableCount++
		}
		if receipt.Status == StatusFailed || receipt.OCRStatus == OCRFailed {
			report.FailedCount++
		}
	}
	return report, nil
}

func (b *Broker) inspectSource(
	ctx context.Context,
	request Request,
	locale string,
	source extractedSource,
	remainingBytes int64,
	remainingPixels int64,
	remainingOCRBytes int,
) (Receipt, int64, int64, int, error) {
	started := b.configuration.Now()
	receipt := Receipt{
		NodeID: source.nodeID, HTMLLocation: source.htmlLocation, SourceURLSHA256: source.digest,
		Status: StatusUnavailable, OCRStatus: OCRUnavailable, OCRRuntimeVersion: OCRRuntimeVersion,
		SVGPolicy: b.configuration.SVGPolicy, FramePolicy: b.configuration.FramePolicy,
	}
	imageContext, cancel := context.WithTimeout(ctx, b.configuration.PerImageTimeout)
	defer cancel()
	select {
	case b.slots <- struct{}{}:
		defer func() { <-b.slots }()
	case <-imageContext.Done():
		receipt.FailureCode, receipt.OCRFailureCode = "concurrency_timeout", "concurrency_timeout"
		return receipt, 0, 0, 0, nil
	}
	fetched, err := b.fetch(imageContext, source.normalized, remainingBytes)
	if err != nil {
		receipt.Status = classifyFetchStatus(err)
		receipt.FailureCode = failureCode(err, "image_fetch_failed")
		receipt.OCRFailureCode = receipt.FailureCode
		receipt.EncodedBytes = fetched.consumedBytes
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, fetched.consumedBytes, 0, 0, nil
	}
	receipt.FinalURLSHA256 = fetched.finalURLHash
	receipt.RedirectURLSHA256s = fetched.redirectHashes
	receipt.EncodedBytes = int64(len(fetched.body))
	if b.configuration.RequireContentScan && b.scanner == nil {
		receipt.FailureCode = "content_scanner_unavailable"
		receipt.OCRFailureCode = receipt.FailureCode
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), 0, 0, nil
	}
	if b.scanner != nil {
		receipt.ScannerVersion = strings.TrimSpace(b.scanner.Identity())
		receipt.ScanInputSHA256 = digest(fetched.body)
		mediaType, mediaTypeErr := scanMediaType(fetched.contentType)
		if receipt.ScannerVersion == "" || mediaTypeErr != nil || b.scanner.Scan(imageContext, ScanInput{
			Body: append([]byte(nil), fetched.body...), MediaType: mediaType, AssetSHA256: receipt.ScanInputSHA256,
		}) != nil {
			receipt.Status = StatusFailed
			receipt.FailureCode = "content_scan_failed"
			receipt.OCRStatus = OCRFailed
			receipt.OCRFailureCode = receipt.FailureCode
			receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
			return receipt, int64(len(fetched.body)), 0, 0, nil
		}
	}
	prepared, err := prepareImage(imageContext, fetched.body, fetched.contentType, b.configuration, b.rasterizer)
	if err != nil {
		receipt.Status = classifyFetchStatus(err)
		receipt.FailureCode = failureCode(err, "image_validation_failed")
		receipt.OCRFailureCode = receipt.FailureCode
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), 0, 0, nil
	}
	receipt.Status = StatusVerified
	receipt.AssetSHA256 = prepared.assetSHA256
	receipt.RasterSHA256 = prepared.rasterSHA256
	receipt.MediaType = prepared.mediaType
	receipt.Width, receipt.Height = prepared.width, prepared.height
	receipt.FrameCount, receipt.SelectedFrame = prepared.frames, prepared.selectedFrame
	receipt.RasterizerVersion = prepared.rasterizer
	pixels := int64(prepared.width) * int64(prepared.height)
	if pixels > remainingPixels {
		receipt.Status = StatusFailed
		receipt.FailureCode = "campaign_pixel_limit"
		receipt.OCRFailureCode = "campaign_pixel_limit"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}

	if b.ocr == nil {
		receipt.OCRFailureCode = "ocr_engine_unavailable"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}
	identity := b.ocr.Identity()
	identity.Engine, identity.Version = strings.TrimSpace(identity.Engine), strings.TrimSpace(identity.Version)
	if !validMethodIdentity(identity.Engine, 100) || !validMethodIdentity(identity.Version, 160) {
		receipt.OCRFailureCode = "ocr_identity_invalid"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}
	receipt.OCREngine, receipt.OCREngineVersion = identity.Engine, identity.Version
	if b.evidence == nil {
		receipt.OCRFailureCode = "ocr_evidence_store_unavailable"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}
	expiresAt := b.configuration.Now().UTC().Add(b.configuration.EvidenceRetention)
	objectKey := "campaign-assurance/ocr/" + request.FrozenSourceHash + "/" + request.ArtifactHash + "/" +
		prepared.assetSHA256 + "/" + prepared.rasterSHA256 + ".png"
	objectRef, err := b.evidence.Put(imageContext, EvidencePutInput{
		TenantID: request.TenantID, ObjectKey: objectKey, MediaType: "image/png",
		ExpiresAt: expiresAt, Body: bytes.NewReader(prepared.rasterPNG),
	})
	if err != nil || !validObjectReference(objectRef) {
		receipt.OCRFailureCode = "ocr_evidence_persistence_failed"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}
	receipt.RasterObjectRef = strings.TrimSpace(objectRef)
	receipt.RasterExpiresAt = &expiresAt
	cacheKey := CacheKey{
		TenantID: request.TenantID, AssetSHA256: prepared.assetSHA256, RasterSHA256: prepared.rasterSHA256,
		OCRRuntimeVersion: OCRRuntimeVersion, Engine: identity.Engine, EngineVersion: identity.Version,
		LanguageHint: locale,
	}
	var output OCROutput
	cacheHit := false
	if b.cache != nil {
		cached, found, cacheErr := b.cache.Get(imageContext, cacheKey)
		switch {
		case cacheErr != nil:
			receipt.CacheStatus = "read_error"
		case found:
			output, cacheHit, receipt.CacheStatus = cached, true, "hit"
		default:
			receipt.CacheStatus = "miss"
		}
	}
	if !cacheHit {
		ocrContext, ocrCancel := context.WithTimeout(imageContext, b.configuration.OCRTimeout)
		output, err = b.ocr.Recognize(ocrContext, OCRInput{
			RasterPNG: append([]byte(nil), prepared.rasterPNG...), AssetSHA256: prepared.assetSHA256,
			RasterSHA256: prepared.rasterSHA256, Width: prepared.width, Height: prepared.height,
			LanguageHint: locale,
		})
		ocrCancel()
		if err != nil {
			receipt.OCRStatus = OCRFailed
			if isCancellation(err) {
				receipt.OCRFailureCode = "ocr_timeout"
			} else {
				receipt.OCRFailureCode = "ocr_execution_failed"
			}
			receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
			return receipt, int64(len(fetched.body)), pixels, 0, nil
		}
	}
	normalized, err := normalizeOCROutput(output, b.configuration.MaxOCRTextBytes)
	if err != nil {
		receipt.OCRStatus = OCRFailed
		receipt.OCRFailureCode = failureCode(err, "ocr_output_invalid")
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, 0, nil
	}
	if len(normalized.Text) > remainingOCRBytes {
		receipt.OCRStatus = OCRFailed
		receipt.OCRFailureCode = "campaign_ocr_text_limit"
		receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
		return receipt, int64(len(fetched.body)), pixels, len(normalized.Text), nil
	}
	if !cacheHit && b.cache != nil && normalized.Text != "" {
		if err := b.cache.Put(imageContext, cacheKey, normalized); err != nil {
			receipt.CacheStatus = "write_error"
		} else if receipt.CacheStatus == "" {
			receipt.CacheStatus = "stored"
		}
	} else if !cacheHit && b.cache != nil {
		if receipt.CacheStatus == "" || receipt.CacheStatus == "miss" {
			receipt.CacheStatus = "bypassed_no_text"
		}
	}
	receipt.OCRStatus = OCRComplete
	receipt.OCRText = normalized.Text
	receipt.OCRTextSHA256 = digest([]byte(normalized.Text))
	receipt.OCRLanguage = normalized.Language
	receipt.OCRConfidence = normalized.Confidence
	receipt.LatencyMS = durationMilliseconds(b.configuration.Now().Sub(started))
	return receipt, int64(len(fetched.body)), pixels, len(normalized.Text), nil
}

type fetchedImage struct {
	body           []byte
	contentType    string
	finalURLHash   string
	redirectHashes []string
	consumedBytes  int64
}

func (b *Broker) fetch(ctx context.Context, rawURL string, remainingBytes int64) (fetchedImage, error) {
	parsed, err := b.validateURL(ctx, rawURL)
	if err != nil {
		return fetchedImage{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), http.NoBody)
	if err != nil {
		return fetchedImage{}, failImage("request_construction_failed", ErrSourceRejected)
	}
	request.Header.Set("Accept", "image/png,image/jpeg,image/gif,image/webp,image/svg+xml")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "PostwaveCampaignImageBroker/1.0")
	redirects := make([]string, 0, b.configuration.MaxRedirects)
	client := *b.client
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) > b.configuration.MaxRedirects {
			return failImage("redirect_limit_exceeded", ErrSourceRejected)
		}
		validated, validationErr := b.validateURL(next.Context(), next.URL.String())
		if validationErr != nil {
			return validationErr
		}
		next.URL = validated
		next.Header.Del("Authorization")
		next.Header.Del("Cookie")
		next.Header.Del("Referer")
		next.Header.Set("Accept", request.Header.Get("Accept"))
		next.Header.Set("Accept-Encoding", "identity")
		next.Header.Set("User-Agent", request.Header.Get("User-Agent"))
		redirects = append(redirects, digest([]byte(validated.String())))
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		if isCancellation(err) {
			return fetchedImage{}, failImage("fetch_timeout", ErrSourceUnavailable)
		}
		if errors.Is(err, ErrSourceRejected) || errors.Is(err, ErrSourceUnavailable) {
			return fetchedImage{}, err
		}
		return fetchedImage{}, failImage("fetch_transport_failed", ErrSourceUnavailable)
	}
	defer drainAndClose(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusTooEarly ||
			response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			return fetchedImage{}, failImage("upstream_temporarily_unavailable", ErrSourceUnavailable)
		}
		return fetchedImage{}, failImage("upstream_response_rejected", ErrSourceRejected)
	}
	if encoding := strings.TrimSpace(response.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return fetchedImage{}, failImage("content_encoding_rejected", ErrInvalidImage)
	}
	maximum := b.configuration.MaxResponseBytes
	if remainingBytes < maximum {
		maximum = remainingBytes
	}
	if maximum < 1 || response.ContentLength > maximum {
		return fetchedImage{consumedBytes: maximum}, failImage("response_byte_limit_exceeded", ErrResourceLimit)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return fetchedImage{consumedBytes: int64(len(body))}, failImage("response_read_failed", ErrSourceUnavailable)
	}
	if int64(len(body)) > maximum {
		return fetchedImage{consumedBytes: int64(len(body))}, failImage("response_byte_limit_exceeded", ErrResourceLimit)
	}
	finalURL, err := NormalizeSourceURL(response.Request.URL.String())
	if err != nil {
		return fetchedImage{}, failImage("final_url_rejected", ErrSourceRejected)
	}
	return fetchedImage{
		body: body, contentType: response.Header.Get("Content-Type"),
		finalURLHash: digest([]byte(finalURL)), redirectHashes: redirects, consumedBytes: int64(len(body)),
	}, nil
}

func (b *Broker) validateURL(ctx context.Context, rawURL string) (*url.URL, error) {
	normalized, err := NormalizeSourceURL(rawURL)
	if err != nil {
		return nil, err
	}
	parsed, _ := url.Parse(normalized)
	if _, exists := b.allowedHosts[parsed.Hostname()]; !exists {
		return nil, failImage("host_not_allowlisted", ErrSourceRejected)
	}
	if _, err := b.resolvePublic(ctx, parsed.Hostname()); err != nil {
		return nil, err
	}
	return parsed, nil
}

func (b *Broker) dialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port != "443" {
		return nil, failImage("dial_port_rejected", ErrSourceRejected)
	}
	host, err = idna.Lookup.ToASCII(host)
	if err != nil {
		return nil, failImage("dial_host_rejected", ErrSourceRejected)
	}
	host = strings.ToLower(host)
	if _, exists := b.allowedHosts[host]; !exists {
		return nil, failImage("dial_host_rejected", ErrSourceRejected)
	}
	addresses, err := b.resolvePublic(ctx, host)
	if err != nil {
		return nil, err
	}
	var failures []error
	for _, candidate := range addresses {
		connection, dialErr := b.dialer.DialContext(ctx, network, net.JoinHostPort(candidate.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		failures = append(failures, dialErr)
	}
	return nil, failImage("dial_failed", fmt.Errorf("%w: %v", ErrSourceUnavailable, errors.Join(failures...)))
}

func (b *Broker) resolvePublic(ctx context.Context, host string) ([]netip.Addr, error) {
	if _, exists := b.allowedHosts[strings.ToLower(host)]; !exists {
		return nil, failImage("host_not_allowlisted", ErrSourceRejected)
	}
	resolved, err := b.resolver.LookupIPAddr(ctx, host)
	if err != nil || len(resolved) == 0 {
		return nil, failImage("dns_unavailable", ErrSourceUnavailable)
	}
	if len(resolved) > b.configuration.MaxDNSAnswers {
		return nil, failImage("dns_answer_limit_exceeded", ErrSourceRejected)
	}
	addresses := make([]netip.Addr, 0, len(resolved))
	seen := make(map[netip.Addr]struct{}, len(resolved))
	for _, item := range resolved {
		address, ok := publicAddress(item.IP, item.Zone)
		if !ok {
			return nil, failImage("dns_non_public_address", ErrSourceRejected)
		}
		if _, duplicate := seen[address]; duplicate {
			continue
		}
		seen[address] = struct{}{}
		addresses = append(addresses, address)
	}
	if len(addresses) == 0 {
		return nil, failImage("dns_unavailable", ErrSourceUnavailable)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].Less(addresses[j]) })
	return addresses, nil
}

func normalizeOCROutput(output OCROutput, maximum int) (OCROutput, error) {
	if !utf8.ValidString(output.Text) || len(output.Text) > maximum {
		return OCROutput{}, failImage("ocr_output_limit", ErrResourceLimit)
	}
	for _, r := range output.Text {
		if r == 0 || unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return OCROutput{}, failImage("ocr_output_control_character", ErrInvalidImage)
		}
	}
	text := strings.Join(strings.Fields(norm.NFC.String(output.Text)), " ")
	if len(text) > maximum {
		return OCROutput{}, failImage("ocr_output_limit", ErrResourceLimit)
	}
	if text == "" {
		if output.Text != "" || strings.TrimSpace(output.Language) != "" || output.Confidence != nil {
			return OCROutput{}, failImage("ocr_empty_output_metadata_invalid", ErrInvalidImage)
		}
		return OCROutput{}, nil
	}
	tag, err := language.Parse(strings.TrimSpace(output.Language))
	if err != nil || tag == language.Und {
		return OCROutput{}, failImage("ocr_language_unavailable", ErrInvalidImage)
	}
	if output.Confidence != nil && (math.IsNaN(*output.Confidence) || math.IsInf(*output.Confidence, 0) || *output.Confidence < 0 || *output.Confidence > 1) {
		return OCROutput{}, failImage("ocr_confidence_invalid", ErrInvalidImage)
	}
	return OCROutput{Text: text, Language: tag.String(), Confidence: output.Confidence}, nil
}

func scanMediaType(value string) (string, error) {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	mediaType = strings.ToLower(mediaType)
	switch mediaType {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml":
		return mediaType, nil
	default:
		return "", ErrInvalidImage
	}
}

func classifyFetchStatus(err error) Status {
	if errors.Is(err, ErrSourceUnavailable) || isCancellation(err) {
		return StatusUnavailable
	}
	return StatusFailed
}

func validHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' && r < 'a' || r > 'f' {
			return false
		}
	}
	return true
}

func validTenantIdentity(value string) bool {
	if len(value) < 1 || len(value) > 200 || strings.TrimSpace(value) != value {
		return false
	}
	return !hasControl(value)
}

func validMethodIdentity(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value && !hasControl(value)
}

func validObjectReference(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 2048 && !hasControl(value) && !strings.Contains(value, "http://") && !strings.Contains(value, "https://")
}

func durationMilliseconds(value time.Duration) int64 {
	if value <= 0 {
		return 0
	}
	return value.Milliseconds()
}
