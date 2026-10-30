// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

const testDeploymentIdentity = "campaign-image-fetch-broker.test.v1"

type inspectorFunc func(context.Context, campaignimagebroker.Request) (campaignimagebroker.Report, error)

func (f inspectorFunc) Inspect(ctx context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
	return f(ctx, request)
}

func shortSocketDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "pw-img-broker-")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		_ = os.RemoveAll(directory)
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func testServerConfig(socket string, limits Limits) ServerConfig {
	identity := CurrentProcessIdentity()
	return ServerConfig{
		SocketPath: socket, DeploymentIdentity: testDeploymentIdentity,
		ServerIdentity: identity, SocketOwner: identity, SocketMode: 0o600,
		AllowedClients: []PeerIdentity{identity}, Limits: limits,
	}
}

func testClientConfig(socket string, limits Limits) ClientConfig {
	identity := CurrentProcessIdentity()
	return ClientConfig{
		SocketPath: socket, DeploymentIdentity: testDeploymentIdentity,
		ExpectedServer: identity, ExpectedSocketOwner: identity, Limits: limits,
	}
}

func startTestBoundary(
	t *testing.T,
	inspector campaignimagebroker.Inspector,
	serverLimits Limits,
	clientLimits Limits,
) (*Client, string) {
	t.Helper()
	socket := filepath.Join(shortSocketDirectory(t), "broker.sock")
	server, err := NewServer(testServerConfig(socket, serverLimits), inspector)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := server.Listen()
	if err != nil {
		t.Fatal(err)
	}
	serverContext, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(serverContext, listener) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve boundary: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("boundary server did not stop")
		}
	})
	client, err := NewClient(testClientConfig(socket, clientLimits))
	if err != nil {
		t.Fatal(err)
	}
	return client, socket
}

func testInspectionRequest() campaignimagebroker.Request {
	html := []byte(`<html><body><div data-postwave-node="hero"><img src="https://cdn.example.test/offer.png"></div></body></html>`)
	return campaignimagebroker.Request{
		TenantID:         "00000000-0000-4000-8000-000000000001",
		FrozenSourceHash: strings.Repeat("a", 64), ArtifactHash: strings.Repeat("b", 64),
		HTMLHash: sha256Hex(html), Locale: "en-US", HTML: html,
		ReviewedSources: []campaignimagebroker.SourceReview{{
			NodeID: "hero", URL: "https://cdn.example.test/offer.png",
		}},
	}
}

func validTestReport(request campaignimagebroker.Request) campaignimagebroker.Report {
	confidence := 0.96
	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	text := "Doors close at 5 PM"
	sourceHash, _ := campaignimagebroker.SourceURLSHA256(request.ReviewedSources[0].URL)
	receipt := campaignimagebroker.Receipt{
		NodeID: "hero", HTMLLocation: "/html/images/0", Status: campaignimagebroker.StatusVerified,
		FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash,
		SourceURLSHA256: sourceHash, FinalURLSHA256: sourceHash,
		AssetSHA256: strings.Repeat("c", 64), RasterSHA256: strings.Repeat("d", 64),
		RasterObjectRef: "campaign-image-raster/00000000-0000-4000-8000-000000000099",
		RasterExpiresAt: &expires, MediaType: "image/png", EncodedBytes: 100,
		Width: 10, Height: 10, FrameCount: 1, SelectedFrame: 0,
		FramePolicy: campaignimagebroker.AnimatedFirstFrame, SVGPolicy: campaignimagebroker.SVGReject,
		ScannerVersion: "scanner@scanner.20260830", ScanInputSHA256: strings.Repeat("c", 64),
		OCRStatus: campaignimagebroker.OCRComplete, OCRText: text, OCRTextSHA256: sha256Hex([]byte(text)),
		OCRLanguage: "en-US", OCRConfidence: &confidence, OCREngine: "sandboxed-ocr",
		OCREngineVersion: "sandboxed-ocr.20260830", OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		CacheStatus: "miss", LatencyMS: 2,
	}
	return campaignimagebroker.Report{
		BrokerVersion: campaignimagebroker.BrokerVersion, OCRRuntimeVersion: campaignimagebroker.OCRRuntimeVersion,
		FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash,
		PolicyHash: strings.Repeat("e", 64), ReviewedSourceCount: 1, ReceiptCount: 1,
		CompleteOCRCount: 1, LatencyMS: 3, Receipts: []campaignimagebroker.Receipt{receipt},
	}
}

func TestBoundaryDelegatesToBrokerAndReturnsDataOnlyReport(t *testing.T) {
	observed := make(chan campaignimagebroker.Request, 1)
	client, _ := startTestBoundary(t, inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		observed <- request
		return validTestReport(request), nil
	}), Limits{}, Limits{})
	if err := client.Ready(context.Background()); err != nil {
		t.Fatalf("ready: %v", err)
	}
	request := testInspectionRequest()
	report, err := client.Inspect(context.Background(), request)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	got := <-observed
	if !bytes.Equal(got.HTML, request.HTML) || got.TenantID != request.TenantID ||
		len(got.ReviewedSources) != 1 || got.ReviewedSources[0] != request.ReviewedSources[0] {
		t.Fatalf("broker received a changed frozen request: %+v", got)
	}
	if report.Receipts[0].OCRText != "Doors close at 5 PM" ||
		report.Receipts[0].RasterObjectRef == "" || report.Receipts[0].RasterSHA256 == "" {
		t.Fatalf("missing safe response data: %+v", report.Receipts[0])
	}
	raw, err := json.Marshal(wireResponse{
		Protocol: ProtocolVersion, Operation: "inspect", RequestID: strings.Repeat("1", 32),
		DeploymentIdentity: testDeploymentIdentity, BoundaryProfile: BoundaryProfile,
		BrokerVersion: campaignimagebroker.BrokerVersion, Status: "ok", Report: &report,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		request.ReviewedSources[0].URL, request.TenantID, `"reviewed_sources"`, `"html_bytes"`,
		`"socket_path"`, `"network"`, `"http_client"`, `"credential"`, `"browser"`, `"tool"`, `"shell"`,
	} {
		if bytes.Contains(bytes.ToLower(raw), bytes.ToLower([]byte(forbidden))) {
			t.Errorf("response leaked forbidden broker/request capability %q: %s", forbidden, raw)
		}
	}
}

func TestClientRequiresReadinessAndRejectsLocalUnboundedRequest(t *testing.T) {
	var calls atomic.Int32
	limits := Limits{MaxHTMLBytes: 32}
	client, _ := startTestBoundary(t, inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		calls.Add(1)
		return validTestReport(request), nil
	}), limits, limits)
	request := testInspectionRequest()
	if _, err := client.Inspect(context.Background(), request); !errors.Is(err, ErrNotReady) {
		t.Fatalf("pre-readiness error = %v, want ErrNotReady", err)
	}
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Inspect(context.Background(), request); !errors.Is(err, campaignimagebroker.ErrInvalidRequest) {
		t.Fatalf("oversize request error = %v, want broker ErrInvalidRequest", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("unbounded request reached broker %d times", calls.Load())
	}
}

func TestClientRejectsUnsafeSocketAndWrongServerPeer(t *testing.T) {
	inspector := inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		return validTestReport(request), nil
	})
	t.Run("world writable socket", func(t *testing.T) {
		socket := filepath.Join(shortSocketDirectory(t), "broker.sock")
		server, err := NewServer(testServerConfig(socket, Limits{}), inspector)
		if err != nil {
			t.Fatal(err)
		}
		listener, err := server.Listen()
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = listener.Close() }()
		if err := os.Chmod(socket, 0o666); err != nil {
			t.Fatal(err)
		}
		client, err := NewClient(testClientConfig(socket, Limits{}))
		if err != nil {
			t.Fatal(err)
		}
		if err := client.Ready(context.Background()); !errors.Is(err, ErrUnsafeSocket) {
			t.Fatalf("unsafe socket error = %v, want ErrUnsafeSocket", err)
		}
	})
	t.Run("unexpected server identity", func(t *testing.T) {
		client, socket := startTestBoundary(t, inspector, Limits{}, Limits{})
		configuration := testClientConfig(socket, Limits{})
		configuration.ExpectedServer.UID++
		wrongPeerClient, err := NewClient(configuration)
		if err != nil {
			t.Fatal(err)
		}
		if err := wrongPeerClient.Ready(context.Background()); !errors.Is(err, ErrUnauthorizedPeer) {
			t.Fatalf("wrong-peer error = %v, want ErrUnauthorizedPeer", err)
		}
		if client.IsReady() {
			t.Fatal("unused correct client unexpectedly ready")
		}
	})
}

func TestServerRejectsUnauthorizedClientPeer(t *testing.T) {
	socket := filepath.Join(shortSocketDirectory(t), "broker.sock")
	configuration := testServerConfig(socket, Limits{})
	configuration.AllowedClients = []PeerIdentity{{UID: configuration.SocketOwner.UID + 1, GID: configuration.SocketOwner.GID}}
	server, err := NewServer(configuration, inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		return validTestReport(request), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := server.Listen()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	defer func() {
		cancel()
		<-done
	}()
	client, err := NewClient(testClientConfig(socket, Limits{}))
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unauthorized-client error = %v, want ErrUnavailable", err)
	}
}

func TestBoundaryMapsDeadlineAndRedactsInternalFailure(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		client, _ := startTestBoundary(t, inspectorFunc(func(ctx context.Context, _ campaignimagebroker.Request) (campaignimagebroker.Report, error) {
			<-ctx.Done()
			return campaignimagebroker.Report{}, context.Cause(ctx)
		}), Limits{RequestTimeout: 100 * time.Millisecond}, Limits{RequestTimeout: time.Second})
		if err := client.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := client.Inspect(context.Background(), testInspectionRequest()); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("deadline error = %v", err)
		}
	})
	t.Run("internal detail", func(t *testing.T) {
		const secret = "provider-secret-key-and-private-host"
		client, _ := startTestBoundary(t, inspectorFunc(func(context.Context, campaignimagebroker.Request) (campaignimagebroker.Report, error) {
			return campaignimagebroker.Report{}, errors.New(secret)
		}), Limits{}, Limits{})
		if err := client.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err := client.Inspect(context.Background(), testInspectionRequest())
		if !errors.Is(err, ErrRemoteFailure) || strings.Contains(err.Error(), secret) {
			t.Fatalf("internal failure was not safely mapped: %v", err)
		}
	})
}

func TestBoundaryRejectsReportWithArbitraryPath(t *testing.T) {
	client, _ := startTestBoundary(t, inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		report := validTestReport(request)
		report.Receipts[0].RasterObjectRef = "/etc/passwd"
		return report, nil
	}), Limits{}, Limits{})
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := client.Inspect(context.Background(), testInspectionRequest())
	if !errors.Is(err, ErrRemoteFailure) || strings.Contains(err.Error(), "/etc/passwd") {
		t.Fatalf("unsafe response was not contained: %v", err)
	}
}

func TestProtocolPreservesCompleteNoTextOCRProvenance(t *testing.T) {
	request := testInspectionRequest()
	report := validTestReport(request)
	report.Receipts[0].OCRText = ""
	report.Receipts[0].OCRTextSHA256 = sha256Hex(nil)
	report.Receipts[0].OCRLanguage = ""
	report.Receipts[0].OCRConfidence = nil
	wire := wireRequest{
		Protocol: ProtocolVersion, Operation: "inspect", RequestID: strings.Repeat("1", 32),
		DeploymentIdentity: testDeploymentIdentity, TenantID: request.TenantID,
		FrozenSourceHash: request.FrozenSourceHash, ArtifactHash: request.ArtifactHash,
		HTMLHash: request.HTMLHash, Locale: request.Locale, HTMLBytes: len(request.HTML),
		ReviewedSources: request.ReviewedSources,
	}
	if err := validateReport(report, wire, normalizeTestLimits(t, Limits{})); err != nil {
		t.Fatalf("complete no-text report rejected: %v", err)
	}
}

func normalizeTestLimits(t *testing.T, input Limits) Limits {
	t.Helper()
	limits, err := normalizeLimits(input)
	if err != nil {
		t.Fatal(err)
	}
	return limits
}

func TestProtocolRejectsUnknownJSONAndOversizeFrameBeforeAllocation(t *testing.T) {
	var request wireRequest
	if err := decodeStrict([]byte(`{"protocol":"x","unknown":true}`), &request); !errors.Is(err, ErrProtocol) {
		t.Fatalf("unknown-field error = %v, want ErrProtocol", err)
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], 4097)
	if _, err := readFrame(bytes.NewReader(prefix[:]), 4096); !errors.Is(err, ErrProtocol) {
		t.Fatalf("oversize-frame error = %v, want ErrProtocol", err)
	}
}

func TestEnvironmentConstructorsProduceExactProcessRoles(t *testing.T) {
	identity := CurrentProcessIdentity()
	socket := filepath.Join(shortSocketDirectory(t), "broker.sock")
	values := map[string]string{
		SocketEnvironmentKey: socket, DeploymentIdentityEnvironmentKey: testDeploymentIdentity,
		ServerUIDEnvironmentKey:  strconv.FormatUint(uint64(identity.UID), 10),
		ServerGIDEnvironmentKey:  strconv.FormatUint(uint64(identity.GID), 10),
		SocketUIDEnvironmentKey:  strconv.FormatUint(uint64(identity.UID), 10),
		SocketGIDEnvironmentKey:  strconv.FormatUint(uint64(identity.GID), 10),
		SocketModeEnvironmentKey: "0660", AllowedClientsEnvironmentKey: strconv.FormatUint(uint64(identity.UID), 10) + ":" + strconv.FormatUint(uint64(identity.GID), 10),
		MaxConcurrencyEnvironmentKey: "7", RequestTimeoutEnvironmentKey: "2s",
	}
	getenv := func(key string) string { return values[key] }
	serverConfiguration, err := ServerConfigFromEnvironment(getenv)
	if err != nil {
		t.Fatal(err)
	}
	clientConfiguration, err := ClientConfigFromEnvironment(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if serverConfiguration.ServerIdentity != identity || serverConfiguration.SocketOwner != identity ||
		serverConfiguration.SocketMode != 0o660 || len(serverConfiguration.AllowedClients) != 1 ||
		serverConfiguration.Limits.MaxConcurrency != 7 || serverConfiguration.Limits.RequestTimeout != 2*time.Second {
		t.Fatalf("wrong server process configuration: %+v", serverConfiguration)
	}
	if clientConfiguration.ExpectedServer != identity || clientConfiguration.ExpectedSocketOwner != identity ||
		clientConfiguration.SocketPath != socket || clientConfiguration.Limits.MaxConcurrency != 7 {
		t.Fatalf("wrong socket-only client configuration: %+v", clientConfiguration)
	}
	if _, err := NewClientFromEnvironment(getenv); err != nil {
		t.Fatalf("construct environment client: %v", err)
	}

	values[ServerUIDEnvironmentKey] = "0" + values[ServerUIDEnvironmentKey]
	if _, err := ServerConfigFromEnvironment(getenv); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("non-canonical uid error = %v", err)
	}
	values[ServerUIDEnvironmentKey] = strconv.FormatUint(uint64(identity.UID), 10)
	values[SocketModeEnvironmentKey] = "0666"
	if _, err := ServerConfigFromEnvironment(getenv); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("unsafe environment mode error = %v", err)
	}
}

func TestServerRefusesEveryPreexistingSocketPathWithoutRemovingIt(t *testing.T) {
	inspector := inspectorFunc(func(_ context.Context, request campaignimagebroker.Request) (campaignimagebroker.Report, error) {
		return validTestReport(request), nil
	})
	tests := []struct {
		name   string
		create func(*testing.T, string) func()
	}{
		{
			name: "regular file",
			create: func(t *testing.T, path string) func() {
				if err := os.WriteFile(path, []byte("do-not-replace"), 0o600); err != nil {
					t.Fatal(err)
				}
				return func() {}
			},
		},
		{
			name: "symlink",
			create: func(t *testing.T, path string) func() {
				target := filepath.Join(filepath.Dir(path), "target")
				if err := os.WriteFile(target, []byte("target"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
				return func() {}
			},
		},
		{
			name: "stale Unix socket",
			create: func(t *testing.T, path string) func() {
				listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
				if err != nil {
					t.Fatal(err)
				}
				listener.SetUnlinkOnClose(false)
				return func() { _ = listener.Close() }
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(shortSocketDirectory(t), "broker.sock")
			cleanup := test.create(t, path)
			defer cleanup()
			server, err := NewServer(testServerConfig(path, Limits{}), inspector)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := server.Listen(); !errors.Is(err, ErrUnsafeSocket) {
				t.Fatalf("pre-existing path error = %v, want ErrUnsafeSocket", err)
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatalf("server removed or replaced pre-existing path: %v", err)
			}
		})
	}
}
