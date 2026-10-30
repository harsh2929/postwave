// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type protocolCall struct {
	request wireRequest
	raw     []byte
	payload []byte
}

type protocolHandler func(protocolCall) ([]byte, error)

func startUnixProtocolServer(t *testing.T, mode os.FileMode, handler protocolHandler) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "pw-img-ipc-")
	if err != nil {
		t.Fatalf("create short Unix socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	path := filepath.Join(directory, "sandbox.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen Unix socket: %v", err)
	}
	if err := os.Chmod(path, mode); err != nil {
		_ = listener.Close()
		t.Fatalf("chmod Unix socket: %v", err)
	}
	failures := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			call, readErr := readProtocolCall(connection)
			if readErr != nil {
				select {
				case failures <- readErr:
				default:
				}
				_ = connection.Close()
				continue
			}
			response, responseErr := handler(call)
			if responseErr == nil {
				var length [4]byte
				binary.BigEndian.PutUint32(length[:], uint32(len(response)))
				responseErr = writeFull(connection, length[:])
				if responseErr == nil {
					responseErr = writeFull(connection, response)
				}
			}
			if responseErr != nil {
				select {
				case failures <- responseErr:
				default:
				}
			}
			_ = connection.Close()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-done
		select {
		case failure := <-failures:
			t.Errorf("Unix protocol server: %v", failure)
		default:
		}
	})
	return path
}

func readProtocolCall(reader io.Reader) (protocolCall, error) {
	var length [4]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return protocolCall{}, err
	}
	headerLength := int(binary.BigEndian.Uint32(length[:]))
	if headerLength < 2 || headerLength > maxWireRequestHeader {
		return protocolCall{}, errors.New("invalid request header length")
	}
	header := make([]byte, headerLength)
	if _, err := io.ReadFull(reader, header); err != nil {
		return protocolCall{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(header))
	decoder.DisallowUnknownFields()
	var request wireRequest
	if err := decoder.Decode(&request); err != nil {
		return protocolCall{}, err
	}
	payload := make([]byte, request.PayloadBytes)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return protocolCall{}, err
	}
	return protocolCall{request: request, raw: header, payload: payload}, nil
}

func responseJSON(response wireResponse) []byte {
	body, err := json.Marshal(response)
	if err != nil {
		panic(err)
	}
	return body
}

func explicitFalse() *bool {
	value := false
	return &value
}

func TestUnixOCREngineUsesDataOnlyBoundedProtocol(t *testing.T) {
	observed := make(chan protocolCall, 1)
	socket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		switch call.request.Operation {
		case "ready":
			return responseJSON(wireResponse{
				Protocol: ProtocolVersion, Operation: "ready", Status: "ready",
				Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-10",
				SandboxProfile: SandboxProfile, Network: explicitFalse(), Browser: explicitFalse(),
				Tools: explicitFalse(), Shell: explicitFalse(),
			}), nil
		case "recognize":
			observed <- call
			confidence := 0.98
			return responseJSON(wireResponse{
				Protocol: ProtocolVersion, Operation: "recognize", Status: "complete",
				Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-10",
				Text: "Doors close at 5 PM", Language: "en-US", Confidence: &confidence,
			}), nil
		default:
			return nil, fmt.Errorf("unexpected operation %q", call.request.Operation)
		}
	})
	engine, err := NewUnixOCREngine(OCRConfig{
		SocketPath: socket, Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-10",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Ready(context.Background()); err != nil {
		t.Fatalf("readiness: %v", err)
	}
	raster := append([]byte("\x89PNG\r\n\x1a\n"), []byte("canonical-raster")...)
	output, err := engine.Recognize(context.Background(), campaignimagebroker.OCRInput{
		RasterPNG: raster, AssetSHA256: strings.Repeat("a", 64), RasterSHA256: sha256Hex(raster),
		Width: 4, Height: 3, LanguageHint: "en-US",
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Text != "Doors close at 5 PM" || output.Language != "en-US" ||
		output.Confidence == nil || *output.Confidence != 0.98 {
		t.Fatalf("unexpected OCR output: %+v", output)
	}
	call := <-observed
	if !bytes.Equal(call.payload, raster) || call.request.PayloadSHA256 != sha256Hex(raster) ||
		call.request.AssetSHA256 != strings.Repeat("a", 64) || call.request.MediaType != "image/png" {
		t.Fatalf("wrong data-only request: %+v", call.request)
	}
	lower := strings.ToLower(string(call.raw))
	for _, forbidden := range []string{"http://", "https://", `"url"`, `"tool"`, `"browser"`, `"shell"`, "credential", "token"} {
		if strings.Contains(lower, forbidden) {
			t.Errorf("OCR request leaked forbidden capability %q: %s", forbidden, call.raw)
		}
	}
}

func TestUnixOCREngineRepresentsCompleteNoTextResult(t *testing.T) {
	socket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		response := wireResponse{
			Protocol: ProtocolVersion, Operation: call.request.Operation,
			Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-13",
		}
		if call.request.Operation == "ready" {
			response.Status = "ready"
			response.SandboxProfile = SandboxProfile
			response.Network, response.Browser = explicitFalse(), explicitFalse()
			response.Tools, response.Shell = explicitFalse(), explicitFalse()
		} else {
			response.Status = "complete"
		}
		return responseJSON(response), nil
	})
	engine, err := NewUnixOCREngine(OCRConfig{
		SocketPath: socket, Engine: "sandboxed-ocr", Version: "sandboxed-ocr.2026-08-13",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	raster := append([]byte("\x89PNG\r\n\x1a\n"), []byte("canonical-raster")...)
	output, err := engine.Recognize(context.Background(), campaignimagebroker.OCRInput{
		RasterPNG: raster, AssetSHA256: strings.Repeat("a", 64), RasterSHA256: sha256Hex(raster),
		Width: 4, Height: 3, LanguageHint: "en-US",
	})
	if err != nil {
		t.Fatal(err)
	}
	if output.Text != "" || output.Language != "" || output.Confidence != nil {
		t.Fatalf("complete no-text result gained invented metadata: %+v", output)
	}
}

func TestUnixOCRRejectsUnknownResponseAndUnsafeSocket(t *testing.T) {
	socket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		return []byte(`{"protocol":"postwave.campaign-image-ipc.v1","operation":"ready","status":"ready","engine":"ocr","version":"v1","sandbox_profile":"postwave.ocr.data-only.v1","network":false,"browser":false,"tools":false,"shell":false,"unexpected":true}`), nil
	})
	engine, err := NewUnixOCREngine(OCRConfig{SocketPath: socket, Engine: "ocr", Version: "v1",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10})
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Ready(context.Background()); !errors.Is(err, ErrIPCProtocol) {
		t.Fatalf("unknown response error = %v, want ErrIPCProtocol", err)
	}

	unsafeSocket := startUnixProtocolServer(t, 0o666, func(protocolCall) ([]byte, error) {
		return nil, errors.New("unsafe socket should not be contacted")
	})
	unsafeEngine, err := NewUnixOCREngine(OCRConfig{SocketPath: unsafeSocket, Engine: "ocr", Version: "v1",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10})
	if err != nil {
		t.Fatal(err)
	}
	if err := unsafeEngine.Ready(context.Background()); !errors.Is(err, ErrUnsafeSocket) {
		t.Fatalf("unsafe socket error = %v, want ErrUnsafeSocket", err)
	}
}

func TestUnixContentScannerRequiresReadinessAndClosedVerdict(t *testing.T) {
	socket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		status := "clean"
		response := wireResponse{
			Protocol: ProtocolVersion, Operation: call.request.Operation, Status: status,
			Engine: "scanner", Version: "scanner.20260810",
		}
		if call.request.Operation == "ready" {
			response.Status = "ready"
			response.SandboxProfile = ScannerSandboxProfile
			response.Network, response.Browser = explicitFalse(), explicitFalse()
			response.Tools, response.Shell = explicitFalse(), explicitFalse()
		}
		return responseJSON(response), nil
	})
	scanner, err := NewUnixContentScanner(ScannerConfig{
		SocketPath: socket, Engine: "scanner", Version: "scanner.20260810",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("safe-image-bytes")
	input := campaignimagebroker.ScanInput{Body: body, MediaType: "image/png", AssetSHA256: sha256Hex(body)}
	if err := scanner.Scan(context.Background(), input); !errors.Is(err, ErrNotReady) {
		t.Fatalf("pre-readiness scan error = %v, want ErrNotReady", err)
	}
	if err := scanner.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := scanner.Scan(context.Background(), input); err != nil {
		t.Fatal(err)
	}
}

func TestUnixContentScannerRejectsMalwareVerdict(t *testing.T) {
	socket := startUnixProtocolServer(t, 0o600, func(call protocolCall) ([]byte, error) {
		response := wireResponse{
			Protocol: ProtocolVersion, Operation: call.request.Operation,
			Engine: "scanner", Version: "scanner.20260810",
		}
		if call.request.Operation == "ready" {
			response.Status = "ready"
			response.SandboxProfile = ScannerSandboxProfile
			response.Network, response.Browser = explicitFalse(), explicitFalse()
			response.Tools, response.Shell = explicitFalse(), explicitFalse()
		} else {
			response.Status, response.ReasonCode = "rejected", "malware.detected"
		}
		return responseJSON(response), nil
	})
	scanner, err := NewUnixContentScanner(ScannerConfig{
		SocketPath: socket, Engine: "scanner", Version: "scanner.20260810",
		Timeout: time.Second, MaxRequestBytes: 1 << 20, MaxResponseBytes: 64 << 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scanner.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	body := []byte("malicious-image-bytes")
	err = scanner.Scan(context.Background(), campaignimagebroker.ScanInput{
		Body: body, MediaType: "image/png", AssetSHA256: sha256Hex(body),
	})
	if !errors.Is(err, ErrServiceRejected) {
		t.Fatalf("malware verdict error = %v, want ErrServiceRejected", err)
	}
}
