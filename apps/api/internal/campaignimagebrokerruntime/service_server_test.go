// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type fakeOCRServiceExecutor struct {
	mu       sync.Mutex
	identity ServiceIdentity
	output   OCRServiceOutput
	err      error
	inputs   []OCRServiceInput
	probes   int
}

func (executor *fakeOCRServiceExecutor) Identity(context.Context) (ServiceIdentity, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.probes++
	return executor.identity, nil
}

func (executor *fakeOCRServiceExecutor) Recognize(_ context.Context, input OCRServiceInput) (OCRServiceOutput, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	input.RasterPNG = append([]byte(nil), input.RasterPNG...)
	executor.inputs = append(executor.inputs, input)
	return executor.output, executor.err
}

type fakeScannerServiceExecutor struct {
	mu       sync.Mutex
	identity ServiceIdentity
	err      error
	bodies   [][]byte
	probes   int
}

func (executor *fakeScannerServiceExecutor) Identity(context.Context) (ServiceIdentity, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.probes++
	return executor.identity, nil
}

func (executor *fakeScannerServiceExecutor) Scan(_ context.Context, body []byte) error {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	executor.bodies = append(executor.bodies, append([]byte(nil), body...))
	return executor.err
}

func waitForServiceSocket(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if information, err := os.Lstat(path); err == nil && information.Mode()&os.ModeSocket != 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("service socket %s did not become ready", path)
}

func shortServiceDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "pw-img-service-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func runOCRServiceServer(t *testing.T, server *OCRServiceServer) string {
	t.Helper()
	server.server.environment = func() []string { return []string{"LANG=C.UTF-8"} }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe(ctx) }()
	waitForServiceSocket(t, server.server.path)
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("OCR service shutdown: %v", err)
		}
	})
	return server.server.path
}

func runScannerServiceServer(t *testing.T, server *ScannerServiceServer) string {
	t.Helper()
	server.server.environment = func() []string { return nil }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe(ctx) }()
	waitForServiceSocket(t, server.server.path)
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("scanner service shutdown: %v", err)
		}
	})
	return server.server.path
}

func TestOCRServiceEndToEndAuthenticatesAndPreservesIdentity(t *testing.T) {
	identity := ServiceIdentity{
		Engine:  TesseractEngine,
		Version: "5.5.0-eng.sha256." + strings.Repeat("a", 64),
	}
	confidence := 0.95
	executor := &fakeOCRServiceExecutor{
		identity: identity,
		output:   OCRServiceOutput{Text: "Doors close", Language: "en-US", Confidence: &confidence},
	}
	path := filepath.Join(shortServiceDirectory(t), "ocr.sock")
	server, err := NewOCRServiceServer(OCRServiceServerConfig{
		SocketPath: path, SocketMode: 0o600, AllowedClientUID: os.Geteuid(),
		ExpectedIdentity: identity, Executor: executor,
		Isolation:   DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
		CallTimeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	runOCRServiceServer(t, server)
	client, err := NewUnixOCREngine(OCRConfig{
		SocketPath: path, Engine: identity.Engine, Version: identity.Version,
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	pixels := testPNG(t, 2, 1)
	output, err := client.Recognize(context.Background(), campaignimagebroker.OCRInput{
		RasterPNG: pixels, AssetSHA256: strings.Repeat("b", 64), RasterSHA256: sha256Hex(pixels),
		Width: 2, Height: 1, LanguageHint: "en-US",
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Text != "Doors close" || output.Language != "en-US" ||
		output.Confidence == nil || *output.Confidence != confidence {
		t.Fatalf("output = %+v", output)
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.probes != 2 || len(executor.inputs) != 1 ||
		!bytes.Equal(executor.inputs[0].RasterPNG, pixels) || executor.inputs[0].LanguageTag != "en-US" {
		t.Fatalf("executor observations: probes=%d inputs=%+v", executor.probes, executor.inputs)
	}
}

func TestScannerServiceEndToEndClosesOnMalware(t *testing.T) {
	identity := ServiceIdentity{Engine: ClamAVEngine, Version: "1.4.3-db.27809"}
	executor := &fakeScannerServiceExecutor{identity: identity, err: rejectService("malware.detected", nil)}
	path := filepath.Join(shortServiceDirectory(t), "scanner.sock")
	server, err := NewScannerServiceServer(ScannerServiceServerConfig{
		SocketPath: path, SocketMode: 0o600, AllowedClientUID: os.Geteuid(),
		ExpectedIdentity: identity, Executor: executor,
		Isolation:   DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
		CallTimeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	runScannerServiceServer(t, server)
	client, err := NewUnixContentScanner(ScannerConfig{
		SocketPath: path, Engine: identity.Engine, Version: identity.Version,
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	body := []byte("malicious image bytes")
	err = client.Scan(context.Background(), campaignimagebroker.ScanInput{
		Body: body, MediaType: "image/png", AssetSHA256: sha256Hex(body),
	})
	if !errors.Is(err, ErrServiceRejected) || !strings.Contains(err.Error(), "malware.detected") {
		t.Fatalf("scan error = %v", err)
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.probes != 2 || len(executor.bodies) != 1 || !bytes.Equal(executor.bodies[0], body) {
		t.Fatalf("executor observations: probes=%d bodies=%q", executor.probes, executor.bodies)
	}
}

func TestServiceIdentityDriftFailsBeforeExecution(t *testing.T) {
	expected := ServiceIdentity{
		Engine:  TesseractEngine,
		Version: "5.5.0-eng.sha256." + strings.Repeat("a", 64),
	}
	executor := &fakeOCRServiceExecutor{identity: ServiceIdentity{
		Engine:  TesseractEngine,
		Version: "5.5.0-eng.sha256." + strings.Repeat("b", 64),
	}}
	path := filepath.Join(shortServiceDirectory(t), "ocr.sock")
	server, err := NewOCRServiceServer(OCRServiceServerConfig{
		SocketPath: path, AllowedClientUID: os.Geteuid(), ExpectedIdentity: expected,
		Executor: executor, Isolation: DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
		CallTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	runOCRServiceServer(t, server)
	client, err := NewUnixOCREngine(OCRConfig{
		SocketPath: path, Engine: expected.Engine, Version: expected.Version,
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); !errors.Is(err, ErrIPCProtocol) {
		t.Fatalf("readiness error = %v", err)
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.probes != 1 || len(executor.inputs) != 0 {
		t.Fatalf("identity drift reached executor: probes=%d inputs=%d", executor.probes, len(executor.inputs))
	}
}

func TestMalformedOperationCannotAmplifyIntoExecutableProbe(t *testing.T) {
	identity := ServiceIdentity{Engine: ClamAVEngine, Version: "1.4.3-db.27809"}
	executor := &fakeScannerServiceExecutor{identity: identity}
	server, err := NewScannerServiceServer(ScannerServiceServerConfig{
		SocketPath:       filepath.Join(shortServiceDirectory(t), "scanner.sock"),
		AllowedClientUID: os.Geteuid(), ExpectedIdentity: identity, Executor: executor,
		Isolation: DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := server.server.handleRequest(context.Background(), wireRequest{
		Protocol: ProtocolVersion, Operation: "operator-selected-command",
		Engine: identity.Engine, Version: identity.Version,
	}, nil)
	if response.Status != "error" || response.ReasonCode != "service.operation_unsupported" {
		t.Fatalf("response = %+v", response)
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.probes != 0 || len(executor.bodies) != 0 {
		t.Fatalf("malformed operation reached executable: probes=%d scans=%d",
			executor.probes, len(executor.bodies))
	}
}

func TestServiceRejectsWrongPeerUIDBeforeParsing(t *testing.T) {
	identity := ServiceIdentity{Engine: ClamAVEngine, Version: "1.4.3-db.27809"}
	executor := &fakeScannerServiceExecutor{identity: identity}
	path := filepath.Join(shortServiceDirectory(t), "scanner.sock")
	server, err := NewScannerServiceServer(ScannerServiceServerConfig{
		SocketPath: path, AllowedClientUID: os.Geteuid() + 1, ExpectedIdentity: identity,
		Executor: executor, Isolation: DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
		CallTimeout: 250 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	runScannerServiceServer(t, server)
	client, err := NewUnixContentScanner(ScannerConfig{
		SocketPath: path, Engine: identity.Engine, Version: identity.Version,
		Timeout: 250 * time.Millisecond, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err == nil {
		t.Fatal("wrong peer UID was accepted")
	}
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if executor.probes != 0 || len(executor.bodies) != 0 {
		t.Fatalf("unauthenticated peer reached executor: probes=%d scans=%d", executor.probes, len(executor.bodies))
	}
}

func TestImageServiceFramingRejectsDuplicateKeysAndTrailingBytes(t *testing.T) {
	header := []byte(`{"protocol":"postwave.campaign-image-ipc.v1","protocol":"postwave.campaign-image-ipc.v1","operation":"ready","engine":"clamav","version":"1.4.3-db.27809","payload_bytes":0}`)
	var frame bytes.Buffer
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	frame.Write(length[:])
	frame.Write(header)
	if _, _, err := readImageServiceRequest(&frame, 1024); !errors.Is(err, ErrIPCProtocol) {
		t.Fatalf("duplicate-key frame error = %v", err)
	}

	request := wireRequest{
		Protocol: ProtocolVersion, Operation: "ready", Engine: ClamAVEngine,
		Version: "1.4.3-db.27809",
	}
	header, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	frame.Reset()
	binary.BigEndian.PutUint32(length[:], uint32(len(header)))
	frame.Write(length[:])
	frame.Write(header)
	frame.WriteByte('x')
	if _, _, err := readImageServiceRequest(&frame, 1024); !errors.Is(err, ErrIPCProtocol) {
		t.Fatalf("trailing-byte frame error = %v", err)
	}
}

func TestImageServiceRejectsUnsafeSocketParentAndExistingPath(t *testing.T) {
	identity := ServiceIdentity{Engine: ClamAVEngine, Version: "1.4.3-db.27809"}
	executor := &fakeScannerServiceExecutor{identity: identity}
	unsafeParent := filepath.Join(shortServiceDirectory(t), "unsafe")
	if err := os.Mkdir(unsafeParent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unsafeParent, 0o770); err != nil {
		t.Fatal(err)
	}
	server, err := NewScannerServiceServer(ScannerServiceServerConfig{
		SocketPath: filepath.Join(unsafeParent, "scanner.sock"), AllowedClientUID: os.Geteuid(),
		ExpectedIdentity: identity, Executor: executor,
		Isolation: DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
	})
	if err != nil {
		t.Fatal(err)
	}
	server.server.environment = func() []string { return nil }
	if err := server.ListenAndServe(context.Background()); !errors.Is(err, ErrUnsafeSocket) {
		t.Fatalf("unsafe parent error = %v", err)
	}

	safeParent := shortServiceDirectory(t)
	path := filepath.Join(safeParent, "scanner.sock")
	if err := os.WriteFile(path, []byte("planted"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, err = NewScannerServiceServer(ScannerServiceServerConfig{
		SocketPath: path, AllowedClientUID: os.Geteuid(), ExpectedIdentity: identity,
		Executor: executor, Isolation: DataOnlyIsolationAttestation{seal: dataOnlyIsolationSeal},
	})
	if err != nil {
		t.Fatal(err)
	}
	server.server.environment = func() []string { return nil }
	if err := server.ListenAndServe(context.Background()); !errors.Is(err, ErrUnsafeSocket) {
		t.Fatalf("existing path error = %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "planted" {
		t.Fatalf("existing path was modified: body=%q err=%v", body, err)
	}
}
