// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebroker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const testImageHost = "images.example.com"

type resolverFunc func(context.Context, string) ([]IPAddr, error)

func (f resolverFunc) LookupIPAddr(ctx context.Context, host string) ([]IPAddr, error) {
	return f(ctx, host)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

type ocrEngineStub struct {
	identity OCRIdentity
	output   OCROutput
	err      error
	called   atomic.Int64
	input    OCRInput
	wait     bool
	mu       sync.Mutex
}

func (e *ocrEngineStub) Identity() OCRIdentity { return e.identity }

func (e *ocrEngineStub) Recognize(ctx context.Context, input OCRInput) (OCROutput, error) {
	e.called.Add(1)
	e.mu.Lock()
	e.input = input
	e.mu.Unlock()
	if e.wait {
		<-ctx.Done()
		return OCROutput{}, ctx.Err()
	}
	return e.output, e.err
}

type evidenceStoreStub struct {
	called atomic.Int64
	input  EvidencePutInput
	body   []byte
	err    error
	ref    string
	mu     sync.Mutex
}

func (s *evidenceStoreStub) Put(_ context.Context, input EvidencePutInput) (string, error) {
	s.called.Add(1)
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.input, s.body = input, body
	s.mu.Unlock()
	if s.err != nil {
		return "", s.err
	}
	if s.ref == "" {
		return "tenant/assurance/ocr/raster.png", nil
	}
	return s.ref, nil
}

type cacheStub struct {
	key      CacheKey
	output   OCROutput
	found    bool
	getErr   error
	putErr   error
	getCalls atomic.Int64
	putCalls atomic.Int64
}

func (c *cacheStub) Get(_ context.Context, key CacheKey) (OCROutput, bool, error) {
	c.getCalls.Add(1)
	c.key = key
	return c.output, c.found, c.getErr
}

func (c *cacheStub) Put(_ context.Context, key CacheKey, output OCROutput) error {
	c.putCalls.Add(1)
	c.key, c.output = key, output
	return c.putErr
}

func publicResolver() DNSResolver {
	return resolverFunc(func(_ context.Context, host string) ([]IPAddr, error) {
		if host != testImageHost && host != "redirect.example.com" {
			return nil, errors.New("unexpected host")
		}
		return []IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	})
}

func validConfiguration() Configuration {
	return Configuration{AllowedHosts: []string{testImageHost}}
}

func validRequest(body []byte) Request {
	htmlBody := []byte(`<html><body><figure data-postwave-node="hero"><img src="https://images.example.com/offer.png?campaign=summer" alt="Offer"></figure></body></html>`)
	return Request{
		TenantID:         "00000000-0000-4000-8000-000000000001",
		FrozenSourceHash: strings.Repeat("a", 64), ArtifactHash: strings.Repeat("b", 64),
		HTMLHash: digest(htmlBody), HTML: htmlBody, Locale: "en-US",
		ReviewedSources: []SourceReview{{NodeID: "hero", URL: "https://IMAGES.example.com:443/offer.png?campaign=summer"}},
	}
}

func pngImage(width, height int) []byte {
	canvas := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			canvas.Set(x, y, color.NRGBA{R: uint8(x + 1), G: uint8(y + 2), B: 3, A: 255})
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		panic(err)
	}
	return output.Bytes()
}

func imageResponse(request *http.Request, body []byte, mediaType string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{mediaType}},
		Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: request,
	}
}

func TestBrokerProducesFrozenEvidenceBoundOCRReceipt(t *testing.T) {
	imageBody := pngImage(2, 3)
	engine := &ocrEngineStub{
		identity: OCRIdentity{Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-10"},
		output:   OCROutput{Text: "  Doors\nclose at 5 PM  ", Language: "en-us", Confidence: floatPtr(0.97)},
	}
	evidence := &evidenceStoreStub{}
	cache := &cacheStub{}
	transportCalls := atomic.Int64{}
	broker, err := New(validConfiguration(), Dependencies{
		Resolver: publicResolver(), OCREngine: engine, Evidence: evidence, Cache: cache,
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			transportCalls.Add(1)
			if request.URL.String() != "https://images.example.com/offer.png?campaign=summer" ||
				request.Header.Get("Accept-Encoding") != "identity" || request.Header.Get("Authorization") != "" {
				t.Fatalf("unsafe or non-canonical request: %s headers=%v", request.URL, request.Header)
			}
			return imageResponse(request, imageBody, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := validRequest(imageBody)
	report, err := broker.Inspect(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if transportCalls.Load() != 1 || engine.called.Load() != 1 || evidence.called.Load() != 1 ||
		report.CompleteOCRCount != 1 || report.UnavailableCount != 0 || report.FailedCount != 0 || len(report.Receipts) != 1 {
		t.Fatalf("unexpected execution counts: report=%+v transport=%d engine=%d evidence=%d",
			report, transportCalls.Load(), engine.called.Load(), evidence.called.Load())
	}
	receipt := report.Receipts[0]
	if receipt.Status != StatusVerified || receipt.OCRStatus != OCRComplete || receipt.OCRText != "Doors close at 5 PM" ||
		receipt.OCRLanguage != "en-US" || receipt.FrozenSourceHash != request.FrozenSourceHash ||
		receipt.ArtifactHash != request.ArtifactHash || receipt.HTMLHash != request.HTMLHash ||
		receipt.SourceURLSHA256 != digest([]byte("https://images.example.com/offer.png?campaign=summer")) ||
		receipt.AssetSHA256 != digest(imageBody) || receipt.RasterObjectRef == "" || receipt.RasterExpiresAt == nil {
		t.Fatalf("receipt is not evidence-bound: %+v", receipt)
	}
	engine.mu.Lock()
	ocrInput := engine.input
	engine.mu.Unlock()
	if len(ocrInput.RasterPNG) == 0 || ocrInput.AssetSHA256 != receipt.AssetSHA256 ||
		ocrInput.RasterSHA256 != receipt.RasterSHA256 || ocrInput.LanguageHint != "en-US" {
		t.Fatalf("OCR received wrong data-only input: %+v", ocrInput)
	}
	evidence.mu.Lock()
	storedBody, storedInput := append([]byte(nil), evidence.body...), evidence.input
	evidence.mu.Unlock()
	if !bytes.Equal(storedBody, ocrInput.RasterPNG) || storedInput.MediaType != "image/png" ||
		!strings.Contains(storedInput.ObjectKey, receipt.AssetSHA256) || strings.Contains(storedInput.ObjectKey, "images.example.com") {
		t.Fatalf("durable evidence differs from OCR raster: input=%+v", storedInput)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("campaign=summer")) || bytes.Contains(encoded, []byte("images.example.com")) {
		t.Fatalf("receipt leaked raw source URL: %s", encoded)
	}
	if cache.key.AssetSHA256 != receipt.AssetSHA256 || cache.key.RasterSHA256 != receipt.RasterSHA256 ||
		cache.key.Engine != "sandboxed-ocr" || cache.key.TenantID != request.TenantID {
		t.Fatalf("cache key is not content/method/tenant bound: %+v", cache.key)
	}
}

func TestBrokerRecordsSuccessfulNoTextOCRWithoutDegradingCapability(t *testing.T) {
	imageBody := pngImage(2, 2)
	engine := &ocrEngineStub{
		identity: OCRIdentity{Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-13"},
		output:   OCROutput{},
	}
	cache := &cacheStub{}
	broker, err := New(validConfiguration(), Dependencies{
		Resolver: publicResolver(), OCREngine: engine, Evidence: &evidenceStoreStub{}, Cache: cache,
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, imageBody, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.CompleteOCRCount != 1 || report.UnavailableCount != 0 || report.FailedCount != 0 || len(report.Receipts) != 1 {
		t.Fatalf("successful no-text OCR degraded report: %+v", report)
	}
	receipt := report.Receipts[0]
	if receipt.Status != StatusVerified || receipt.OCRStatus != OCRComplete || receipt.OCRFailureCode != "" ||
		receipt.OCRText != "" || receipt.OCRTextSHA256 != digest(nil) || receipt.OCRLanguage != "" ||
		receipt.OCRConfidence != nil || receipt.CacheStatus != "bypassed_no_text" || cache.putCalls.Load() != 0 {
		t.Fatalf("no-text completion receipt is ambiguous or false-failed: %+v cache_puts=%d", receipt, cache.putCalls.Load())
	}
}

func TestBrokerRejectsUnreviewedAndAlternateImageSourcesWithoutFetching(t *testing.T) {
	tests := []struct {
		name string
		html string
	}{
		{"unreviewed URL", `<figure data-postwave-node="hero"><img src="https://images.example.com/other.png"></figure>`},
		{"missing node", `<img src="https://images.example.com/offer.png?campaign=summer">`},
		{"srcset", `<figure data-postwave-node="hero"><img src="https://images.example.com/offer.png?campaign=summer" srcset="https://images.example.com/2x.png 2x"></figure>`},
		{"background URL", `<figure data-postwave-node="hero" style="background:url(https://images.example.com/bg.png)"><img src="https://images.example.com/offer.png?campaign=summer"></figure>`},
		{"style element URL", `<style>.hero{background-image:url(https://images.example.com/bg.png)}</style><figure data-postwave-node="hero"><img src="https://images.example.com/offer.png?campaign=summer"></figure>`},
		{"style import", `<style>@import "https://images.example.com/mail.css";</style><figure data-postwave-node="hero"><img src="https://images.example.com/offer.png?campaign=summer"></figure>`},
		{"picture source", `<picture data-postwave-node="hero"><source srcset="https://images.example.com/a.webp"><img src="https://images.example.com/offer.png?campaign=summer"></picture>`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := atomic.Int64{}
			broker, err := New(validConfiguration(), Dependencies{
				Resolver: publicResolver(),
				RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					calls.Add(1)
					return imageResponse(request, pngImage(1, 1), "image/png"), nil
				}),
			})
			if err != nil {
				t.Fatal(err)
			}
			request := validRequest(nil)
			request.HTML = []byte(test.html)
			request.HTMLHash = digest(request.HTML)
			report, err := broker.Inspect(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			if report.FailedCount == 0 {
				t.Fatalf("unsafe source did not produce a failure receipt: %+v", report)
			}
			if calls.Load() != 0 {
				t.Fatalf("unsafe source was fetched %d times", calls.Load())
			}
		})
	}
}

func TestBrokerBlocksPrivateMetadataAndMixedDNSAnswers(t *testing.T) {
	addresses := []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "fd00:ec2::254", "2001:db8::1"}
	for _, address := range addresses {
		t.Run(address, func(t *testing.T) {
			calls := atomic.Int64{}
			broker, err := New(validConfiguration(), Dependencies{
				Resolver: resolverFunc(func(context.Context, string) ([]IPAddr, error) {
					return []IPAddr{{IP: net.ParseIP(address)}}, nil
				}),
				RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					calls.Add(1)
					return imageResponse(request, pngImage(1, 1), "image/png"), nil
				}),
			})
			if err != nil {
				t.Fatal(err)
			}
			report, err := broker.Inspect(context.Background(), validRequest(nil))
			if err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 0 || len(report.Receipts) != 1 || report.Receipts[0].FailureCode != "dns_non_public_address" {
				t.Fatalf("address was not blocked before transport: calls=%d report=%+v", calls.Load(), report)
			}
		})
	}
	t.Run("mixed public and private", func(t *testing.T) {
		broker, err := New(validConfiguration(), Dependencies{Resolver: resolverFunc(func(context.Context, string) ([]IPAddr, error) {
			return []IPAddr{{IP: net.ParseIP("93.184.216.34")}, {IP: net.ParseIP("169.254.169.254")}}, nil
		})})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := broker.validateURL(context.Background(), "https://images.example.com/a.png"); !errors.Is(err, ErrSourceRejected) {
			t.Fatalf("mixed DNS answer accepted: %v", err)
		}
	})
}

func TestDialRevalidatesDNSAndBlocksRebinding(t *testing.T) {
	var lookups atomic.Int64
	broker, err := New(validConfiguration(), Dependencies{Resolver: resolverFunc(func(context.Context, string) ([]IPAddr, error) {
		if lookups.Add(1) == 1 {
			return []IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
		}
		return []IPAddr{{IP: net.ParseIP("169.254.169.254")}}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.validateURL(context.Background(), "https://images.example.com/a.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.dialContext(context.Background(), "tcp", "images.example.com:443"); !errors.Is(err, ErrSourceRejected) {
		t.Fatalf("DNS rebinding was not blocked at dial: %v", err)
	}
}

func TestRedirectDestinationIsRevalidatedAndHeadersAreStripped(t *testing.T) {
	var calls atomic.Int64
	configuration := validConfiguration()
	configuration.AllowedHosts = append(configuration.AllowedHosts, "redirect.example.com")
	broker, err := New(configuration, Dependencies{
		Resolver: publicResolver(),
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			call := calls.Add(1)
			if call == 1 {
				return &http.Response{
					StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://redirect.example.com/final.png"}},
					Body: io.NopCloser(strings.NewReader("")), Request: request,
				}, nil
			}
			if request.URL.Host != "redirect.example.com" || request.Header.Get("Authorization") != "" ||
				request.Header.Get("Cookie") != "" || request.Header.Get("Referer") != "" {
				t.Fatalf("redirect leaked authority or headers: %s %v", request.URL, request.Header)
			}
			return imageResponse(request, pngImage(1, 1), "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(report.Receipts) != 1 || len(report.Receipts[0].RedirectURLSHA256s) != 1 ||
		report.Receipts[0].FinalURLSHA256 != digest([]byte("https://redirect.example.com/final.png")) {
		t.Fatalf("redirect provenance missing: calls=%d report=%+v", calls.Load(), report)
	}
}

func TestImageMediaPixelFrameSVGAndByteLimits(t *testing.T) {
	twoFrameGIF := func() []byte {
		palette := color.Palette{color.Black, color.White}
		first := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
		second := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
		var output bytes.Buffer
		if err := gif.EncodeAll(&output, &gif.GIF{Image: []*image.Paletted{first, second}, Delay: []int{0, 0}, Config: image.Config{Width: 2, Height: 2, ColorModel: palette}}); err != nil {
			panic(err)
		}
		return output.Bytes()
	}
	tests := []struct {
		name, mediaType, wantCode string
		body                      []byte
		configure                 func(*Configuration)
	}{
		{"MIME mismatch", "image/jpeg", "media_type_signature_mismatch", pngImage(2, 2), nil},
		{"pixel limit", "image/png", "pixel_limit_exceeded", pngImage(2, 2), func(c *Configuration) { c.MaxPixels = 1; c.MaxTotalPixels = 1 }},
		{"frame limit", "image/gif", "frame_limit_exceeded", twoFrameGIF(), func(c *Configuration) { c.MaxFrames = 1 }},
		{"SVG rejected", "image/svg+xml", "svg_policy_rejected", []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>`), nil},
		{"SVG script", "image/svg+xml", "svg_active_content_rejected", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), func(c *Configuration) { c.SVGPolicy = SVGSanitizeAndRasterize }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configuration := validConfiguration()
			if test.configure != nil {
				test.configure(&configuration)
			}
			dependencies := Dependencies{
				Resolver: publicResolver(), SVGRasterizer: &rasterizerStub{body: pngImage(2, 2)},
				RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					return imageResponse(request, test.body, test.mediaType), nil
				}),
			}
			broker, err := New(configuration, dependencies)
			if err != nil {
				t.Fatal(err)
			}
			report, err := broker.Inspect(context.Background(), validRequest(nil))
			if err != nil {
				t.Fatal(err)
			}
			if len(report.Receipts) != 1 || report.Receipts[0].FailureCode != test.wantCode || report.Receipts[0].OCRStatus == OCRComplete {
				t.Fatalf("limit/policy did not fail closed: %+v", report)
			}
		})
	}
}

type rasterizerStub struct {
	body   []byte
	called atomic.Int64
}

func (r *rasterizerStub) Identity() string { return "safe-svg-rasterizer.v1" }
func (r *rasterizerStub) Rasterize(context.Context, SVGInput) ([]byte, error) {
	r.called.Add(1)
	return append([]byte(nil), r.body...), nil
}

func TestSafeSVGAndAnimatedGIFUseExplicitSingleFrameRasterPolicy(t *testing.T) {
	validSVG := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect x="0" y="0" width="2" height="2" fill="#000"/></svg>`)
	rasterizer := &rasterizerStub{body: pngImage(2, 2)}
	configuration := validConfiguration()
	configuration.SVGPolicy = SVGSanitizeAndRasterize
	broker, err := New(configuration, Dependencies{
		Resolver: publicResolver(), SVGRasterizer: rasterizer,
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, validSVG, "image/svg+xml"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if rasterizer.called.Load() != 1 || len(report.Receipts) != 1 || report.Receipts[0].Status != StatusVerified ||
		report.Receipts[0].MediaType != "image/svg+xml" || report.Receipts[0].RasterizerVersion == "" ||
		report.Receipts[0].OCRStatus != OCRUnavailable {
		t.Fatalf("safe SVG policy result=%+v rasterizer calls=%d", report, rasterizer.called.Load())
	}

	palette := color.Palette{color.Black, color.White}
	first := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
	second := image.NewPaletted(image.Rect(0, 0, 2, 2), palette)
	var animation bytes.Buffer
	if err := gif.EncodeAll(&animation, &gif.GIF{
		Image: []*image.Paletted{first, second}, Delay: []int{0, 0},
		Config: image.Config{Width: 2, Height: 2, ColorModel: palette},
	}); err != nil {
		t.Fatal(err)
	}
	broker, err = New(validConfiguration(), Dependencies{
		Resolver: publicResolver(),
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, animation.Bytes(), "image/gif"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err = broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.Receipts[0].Status != StatusVerified || report.Receipts[0].FrameCount != 2 ||
		report.Receipts[0].SelectedFrame != 0 || report.Receipts[0].FramePolicy != AnimatedFirstFrame {
		t.Fatalf("animated selected-frame policy missing: %+v", report.Receipts[0])
	}
}

type scannerStub struct {
	called atomic.Int64
	err    error
	input  ScanInput
	mu     sync.Mutex
}

func (s *scannerStub) Identity() string { return "content-scanner.v1" }
func (s *scannerStub) Scan(_ context.Context, input ScanInput) error {
	s.called.Add(1)
	input.Body = append([]byte(nil), input.Body...)
	s.mu.Lock()
	s.input = input
	s.mu.Unlock()
	return s.err
}

func TestContentScannerReceivesExactFetchedBytesBeforeImageParsing(t *testing.T) {
	original := []byte("not-a-decodable-png\x00with-untrusted-payload")
	configuration := validConfiguration()
	configuration.RequireContentScan = true
	engine := &ocrEngineStub{
		identity: OCRIdentity{Engine: "sandboxed-ocr", Version: "v1"},
		output:   OCROutput{Text: "should not run", Language: "en"},
	}
	build := func(scanner *scannerStub) *Broker {
		t.Helper()
		broker, err := New(configuration, Dependencies{
			Resolver: publicResolver(), Scanner: scanner, OCREngine: engine, Evidence: &evidenceStoreStub{},
			RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return imageResponse(request, original, "image/png"), nil
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		return broker
	}
	missingScanner, err := New(configuration, Dependencies{
		Resolver: publicResolver(), OCREngine: engine, Evidence: &evidenceStoreStub{},
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, original, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	missing, err := missingScanner.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if missing.Receipts[0].Status != StatusUnavailable ||
		missing.Receipts[0].FailureCode != "content_scanner_unavailable" || engine.called.Load() != 0 {
		t.Fatalf("required scanner absence reached the image parser: %+v", missing.Receipts[0])
	}

	rejectedScanner := &scannerStub{err: errors.New("malware detected")}
	rejected, err := build(rejectedScanner).Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	rejectedScanner.mu.Lock()
	rejectedInput := rejectedScanner.input
	rejectedScanner.mu.Unlock()
	rejectedReceipt := rejected.Receipts[0]
	if rejectedScanner.called.Load() != 1 || !bytes.Equal(rejectedInput.Body, original) ||
		rejectedInput.AssetSHA256 != digest(original) || rejectedInput.MediaType != "image/png" ||
		rejectedReceipt.ScanInputSHA256 != digest(original) || rejectedReceipt.AssetSHA256 != "" ||
		rejectedReceipt.Status != StatusFailed || rejectedReceipt.FailureCode != "content_scan_failed" ||
		rejectedReceipt.OCRStatus != OCRFailed || engine.called.Load() != 0 {
		t.Fatalf("scanner rejection did not stop the original bytes before parsing: receipt=%+v input=%+v", rejectedReceipt, rejectedInput)
	}

	cleanScanner := &scannerStub{}
	decoded, err := build(cleanScanner).Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	decodedReceipt := decoded.Receipts[0]
	if cleanScanner.called.Load() != 1 || decodedReceipt.ScanInputSHA256 != digest(original) ||
		decodedReceipt.Status != StatusFailed || decodedReceipt.FailureCode != "image_decode_failed" ||
		decodedReceipt.OCRStatus != OCRUnavailable || engine.called.Load() != 0 {
		t.Fatalf("clean scan did not precede the fail-closed decoder: %+v", decodedReceipt)
	}
}

func TestRequiredContentScanAndEvidencePersistenceFailClosed(t *testing.T) {
	imageBody := pngImage(1, 1)
	engine := &ocrEngineStub{
		identity: OCRIdentity{Engine: "sandboxed-ocr", Version: "v1"},
		output:   OCROutput{Text: "Offer", Language: "en"},
	}
	configuration := validConfiguration()
	configuration.RequireContentScan = true
	baseDependencies := func() Dependencies {
		return Dependencies{
			Resolver: publicResolver(), OCREngine: engine, Evidence: &evidenceStoreStub{},
			RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return imageResponse(request, imageBody, "image/png"), nil
			}),
		}
	}
	broker, err := New(configuration, baseDependencies())
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if engine.called.Load() != 0 || report.Receipts[0].OCRFailureCode != "content_scanner_unavailable" {
		t.Fatalf("required scanner absence did not fail closed: %+v", report.Receipts[0])
	}

	dependencies := baseDependencies()
	scanner := &scannerStub{err: errors.New("malware scan rejected")}
	dependencies.Scanner = scanner
	broker, err = New(configuration, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	report, err = broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if scanner.called.Load() != 1 || engine.called.Load() != 0 || report.Receipts[0].OCRFailureCode != "content_scan_failed" {
		t.Fatalf("failed scan did not prevent OCR: %+v", report.Receipts[0])
	}

	dependencies = baseDependencies()
	dependencies.Scanner = &scannerStub{}
	dependencies.Evidence = &evidenceStoreStub{err: errors.New("storage unavailable")}
	broker, err = New(configuration, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	report, err = broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if engine.called.Load() != 0 || report.Receipts[0].OCRFailureCode != "ocr_evidence_persistence_failed" {
		t.Fatalf("evidence persistence failure did not prevent OCR: %+v", report.Receipts[0])
	}
}

func TestCampaignAggregateByteLimitStopsLaterImageBeforeDecode(t *testing.T) {
	// Deterministic high-entropy pixels keep the encoded response large enough
	// to exercise the campaign total independently of the per-image limit.
	canvas := image.NewNRGBA(image.Rect(0, 0, 96, 96))
	state := uint32(1)
	for index := range canvas.Pix {
		state = state*1664525 + 1013904223
		canvas.Pix[index] = byte(state >> 24)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatal(err)
	}
	body := encoded.Bytes()
	if len(body) < 1024 {
		t.Fatalf("test image unexpectedly small: %d", len(body))
	}
	configuration := validConfiguration()
	configuration.MaxResponseBytes = int64(len(body) + 1)
	configuration.MaxTotalResponseBytes = int64(len(body) + len(body)/2)
	request := validRequest(nil)
	request.HTML = []byte(`<html><body><figure data-postwave-node="a"><img src="https://images.example.com/a.png"></figure><figure data-postwave-node="b"><img src="https://images.example.com/b.png"></figure></body></html>`)
	request.HTMLHash = digest(request.HTML)
	request.ReviewedSources = []SourceReview{
		{NodeID: "a", URL: "https://images.example.com/a.png"},
		{NodeID: "b", URL: "https://images.example.com/b.png"},
	}
	var calls atomic.Int64
	broker, err := New(configuration, Dependencies{
		Resolver: publicResolver(),
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			return imageResponse(request, body, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(report.Receipts) != 2 || report.Receipts[0].Status != StatusVerified ||
		report.Receipts[1].FailureCode != "response_byte_limit_exceeded" ||
		report.Receipts[1].EncodedBytes > configuration.MaxTotalResponseBytes-int64(len(body)) {
		t.Fatalf("campaign byte ceiling not enforced: calls=%d report=%+v", calls.Load(), report)
	}
}

func TestOCRCannotRunWithoutDurableEvidenceAndCacheUsesImmutableHash(t *testing.T) {
	imageBody := pngImage(1, 1)
	engine := &ocrEngineStub{
		identity: OCRIdentity{Engine: "sandboxed-ocr", Version: "v1"},
		output:   OCROutput{Text: "Offer", Language: "en"},
	}
	broker, err := New(validConfiguration(), Dependencies{
		Resolver: publicResolver(), OCREngine: engine,
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, imageBody, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err := broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if engine.called.Load() != 0 || report.Receipts[0].OCRFailureCode != "ocr_evidence_store_unavailable" {
		t.Fatalf("OCR ran without durable evidence: calls=%d receipt=%+v", engine.called.Load(), report.Receipts[0])
	}

	cache := &cacheStub{found: true, output: OCROutput{Text: "Cached offer", Language: "en"}}
	evidence := &evidenceStoreStub{}
	broker, err = New(validConfiguration(), Dependencies{
		Resolver: publicResolver(), OCREngine: engine, Evidence: evidence, Cache: cache,
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			return imageResponse(request, imageBody, "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	report, err = broker.Inspect(context.Background(), validRequest(nil))
	if err != nil {
		t.Fatal(err)
	}
	if engine.called.Load() != 0 || cache.getCalls.Load() != 1 || evidence.called.Load() != 1 ||
		report.Receipts[0].OCRText != "Cached offer" || cache.key.AssetSHA256 == "" || cache.key.RasterSHA256 == "" {
		t.Fatalf("content-addressed cache path invalid: receipt=%+v key=%+v", report.Receipts[0], cache.key)
	}
}

func TestOCRTimeoutAndInvalidOutputNeverBecomeComplete(t *testing.T) {
	imageBody := pngImage(1, 1)
	tests := []struct {
		name, want string
		engine     *ocrEngineStub
	}{
		{"timeout", "ocr_timeout", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, wait: true}},
		{"missing language", "ocr_language_unavailable", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, output: OCROutput{Text: "Offer"}}},
		{"whitespace-only text", "ocr_empty_output_metadata_invalid", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, output: OCROutput{Text: " \n\t"}}},
		{"empty with language", "ocr_empty_output_metadata_invalid", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, output: OCROutput{Language: "en"}}},
		{"empty with confidence", "ocr_empty_output_metadata_invalid", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, output: OCROutput{Confidence: floatPtr(0.99)}}},
		{"control character", "ocr_output_control_character", &ocrEngineStub{identity: OCRIdentity{Engine: "sandboxed", Version: "v1"}, output: OCROutput{Text: "Offer\x00hidden", Language: "en"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			configuration := validConfiguration()
			if test.name == "timeout" {
				configuration.OCRTimeout = 5 * time.Millisecond
				configuration.PerImageTimeout = 50 * time.Millisecond
				configuration.CampaignTimeout = 100 * time.Millisecond
			}
			broker, err := New(configuration, Dependencies{
				Resolver: publicResolver(), OCREngine: test.engine, Evidence: &evidenceStoreStub{},
				RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					return imageResponse(request, imageBody, "image/png"), nil
				}),
			})
			if err != nil {
				t.Fatal(err)
			}
			report, err := broker.Inspect(context.Background(), validRequest(nil))
			if err != nil {
				t.Fatal(err)
			}
			if report.Receipts[0].OCRStatus != OCRFailed || report.Receipts[0].OCRFailureCode != test.want || report.CompleteOCRCount != 0 {
				t.Fatalf("invalid OCR became success: %+v", report)
			}
		})
	}
}

func TestOCRInterfaceContainsNoFetchOrToolCapability(t *testing.T) {
	typeOfInput := reflect.TypeFor[OCRInput]()
	for i := 0; i < typeOfInput.NumField(); i++ {
		field := typeOfInput.Field(i)
		name := strings.ToLower(field.Name)
		typeName := strings.ToLower(field.Type.String())
		for _, forbidden := range []string{"url", "http", "client", "transport", "credential", "token", "tool", "browser"} {
			if strings.Contains(name, forbidden) || strings.Contains(typeName, forbidden) {
				t.Fatalf("OCR sandbox input exposes %q capability through %s %s", forbidden, field.Name, field.Type)
			}
		}
	}
}

func TestBrokerGlobalConcurrencyLimit(t *testing.T) {
	configuration := validConfiguration()
	configuration.MaxConcurrency = 1
	var active, maximum atomic.Int64
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	broker, err := New(configuration, Dependencies{
		Resolver: publicResolver(),
		RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			current := active.Add(1)
			for {
				prior := maximum.Load()
				if current <= prior || maximum.CompareAndSwap(prior, current) {
					break
				}
			}
			entered <- struct{}{}
			<-release
			active.Add(-1)
			return imageResponse(request, pngImage(1, 1), "image/png"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	wait.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wait.Done()
			_, _ = broker.Inspect(context.Background(), validRequest(nil))
		}()
	}
	<-entered
	select {
	case <-entered:
		t.Fatal("second fetch crossed the global concurrency limit")
	case <-time.After(10 * time.Millisecond):
	}
	release <- struct{}{}
	<-entered
	release <- struct{}{}
	wait.Wait()
	if maximum.Load() != 1 {
		t.Fatalf("maximum concurrent transports = %d, want 1", maximum.Load())
	}
}

func floatPtr(value float64) *float64 { return &value }
