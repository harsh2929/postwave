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
	"math"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/text/language"
)

type imageServiceKind uint8

const (
	imageServiceOCR imageServiceKind = iota + 1
	imageServiceScanner
)

type imageServiceServer struct {
	kind             imageServiceKind
	path             string
	mode             os.FileMode
	allowedClientUID int
	identity         ServiceIdentity
	isolation        DataOnlyIsolationAttestation
	ocr              OCRServiceExecutor
	scanner          ScannerServiceExecutor
	callTimeout      time.Duration
	maxRequestBytes  int64
	maxResponseBytes int
	maxConcurrent    int
	environment      func() []string
}

type OCRServiceServer struct{ server *imageServiceServer }
type ScannerServiceServer struct{ server *imageServiceServer }

func NewOCRServiceServer(configuration OCRServiceServerConfig) (*OCRServiceServer, error) {
	mode, timeout, maxRequest, maxResponse, concurrency, err := normalizeServiceServerConfig(
		configuration.SocketPath, configuration.SocketMode, configuration.AllowedClientUID,
		configuration.ExpectedIdentity, configuration.Isolation, configuration.CallTimeout,
		configuration.MaxRequestBytes, configuration.MaxResponseBytes, configuration.MaxConcurrent,
	)
	if err != nil || configuration.Executor == nil || configuration.ExpectedIdentity.Engine != TesseractEngine {
		return nil, ErrInvalidConfiguration
	}
	return &OCRServiceServer{server: &imageServiceServer{
		kind: imageServiceOCR, path: configuration.SocketPath, mode: mode,
		allowedClientUID: configuration.AllowedClientUID,
		identity:         configuration.ExpectedIdentity, isolation: configuration.Isolation,
		ocr: configuration.Executor, callTimeout: timeout,
		maxRequestBytes: maxRequest, maxResponseBytes: maxResponse, maxConcurrent: concurrency,
		environment: os.Environ,
	}}, nil
}

func NewScannerServiceServer(configuration ScannerServiceServerConfig) (*ScannerServiceServer, error) {
	mode, timeout, maxRequest, maxResponse, concurrency, err := normalizeServiceServerConfig(
		configuration.SocketPath, configuration.SocketMode, configuration.AllowedClientUID,
		configuration.ExpectedIdentity, configuration.Isolation, configuration.CallTimeout,
		configuration.MaxRequestBytes, configuration.MaxResponseBytes, configuration.MaxConcurrent,
	)
	if err != nil || configuration.Executor == nil || configuration.ExpectedIdentity.Engine != ClamAVEngine {
		return nil, ErrInvalidConfiguration
	}
	return &ScannerServiceServer{server: &imageServiceServer{
		kind: imageServiceScanner, path: configuration.SocketPath, mode: mode,
		allowedClientUID: configuration.AllowedClientUID,
		identity:         configuration.ExpectedIdentity, isolation: configuration.Isolation,
		scanner: configuration.Executor, callTimeout: timeout,
		maxRequestBytes: maxRequest, maxResponseBytes: maxResponse, maxConcurrent: concurrency,
		environment: os.Environ,
	}}, nil
}

func (server *OCRServiceServer) ListenAndServe(ctx context.Context) error {
	if server == nil || server.server == nil || server.server.ocr == nil {
		return ErrInvalidConfiguration
	}
	return server.server.listenAndServe(ctx)
}

func (server *ScannerServiceServer) ListenAndServe(ctx context.Context) error {
	if server == nil || server.server == nil || server.server.scanner == nil {
		return ErrInvalidConfiguration
	}
	return server.server.listenAndServe(ctx)
}

// listenAndServe creates, owns, and removes one mode-0600 Unix socket. It
// authenticates the kernel-reported peer UID before parsing bytes and accepts
// exactly one bounded request per connection. Existing paths are never
// unlinked, so a symlink or socket planted by another process fails closed.
func (server *imageServiceServer) listenAndServe(ctx context.Context) error {
	if server == nil || !server.isolation.valid() || ctx == nil || server.environment == nil {
		return ErrInvalidConfiguration
	}
	if err := RejectImageSandboxCredentialEnvironment(server.environment()); err != nil {
		return err
	}
	if err := server.validateSocketParent(); err != nil {
		return err
	}
	if _, err := os.Lstat(server.path); err == nil || !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return fmt.Errorf("%w: service socket path already exists", ErrUnsafeSocket)
		}
		return fmt.Errorf("%w: inspect service socket path", ErrUnsafeSocket)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: server.path, Net: "unix"})
	if err != nil {
		return fmt.Errorf("%w: listen on image service socket", ErrNotReady)
	}
	defer func() { _ = listener.Close() }()
	listener.SetUnlinkOnClose(true)
	if err := os.Chmod(server.path, server.mode); err != nil {
		return fmt.Errorf("%w: protect image service socket", ErrUnsafeSocket)
	}
	if err := server.validateCreatedSocket(); err != nil {
		return err
	}

	stop := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = listener.Close()
		case <-stop:
		}
	}()
	defer close(stop)

	semaphore := make(chan struct{}, server.maxConcurrent)
	var active sync.WaitGroup
	defer active.Wait()
	for {
		connection, acceptErr := listener.AcceptUnix()
		if acceptErr != nil {
			if context.Cause(ctx) != nil {
				return nil
			}
			return fmt.Errorf("%w: accept image service connection", ErrNotReady)
		}
		select {
		case semaphore <- struct{}{}:
			active.Add(1)
			go func() {
				defer active.Done()
				defer func() { <-semaphore }()
				server.handleConnection(ctx, connection)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func (server *imageServiceServer) handleConnection(parent context.Context, connection *net.UnixConn) {
	defer func() { _ = connection.Close() }()
	uid, err := imageServicePeerUID(connection)
	if err != nil || uid != server.allowedClientUID {
		return
	}
	deadline := time.Now().Add(server.callTimeout)
	if parentDeadline, exists := parent.Deadline(); exists && parentDeadline.Before(deadline) {
		deadline = parentDeadline
	}
	if connection.SetDeadline(deadline) != nil {
		return
	}
	request, payload, err := readImageServiceRequest(connection, server.maxRequestBytes)
	if err != nil {
		return
	}
	response := server.handleRequest(parent, request, payload)
	body, err := json.Marshal(response)
	if err != nil || len(body) < 2 || len(body) > server.maxResponseBytes {
		response = server.errorResponse(request.Operation, "service.response_too_large")
		body, err = json.Marshal(response)
	}
	if err != nil || len(body) < 2 || len(body) > server.maxResponseBytes {
		return
	}
	_ = writeImageServiceFrame(connection, body, server.maxResponseBytes)
	_ = connection.CloseWrite()
}

func readImageServiceRequest(reader io.Reader, maxPayload int64) (wireRequest, []byte, error) {
	var length [4]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return wireRequest{}, nil, err
	}
	headerLength := int(binary.BigEndian.Uint32(length[:]))
	if headerLength < 2 || headerLength > maxWireRequestHeader {
		return wireRequest{}, nil, ErrIPCProtocol
	}
	header := make([]byte, headerLength)
	if _, err := io.ReadFull(reader, header); err != nil {
		return wireRequest{}, nil, err
	}
	if err := rejectImageServiceDuplicateJSONKeys(header); err != nil {
		return wireRequest{}, nil, ErrIPCProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(header))
	decoder.DisallowUnknownFields()
	var request wireRequest
	if err := decoder.Decode(&request); err != nil || decoder.Decode(new(any)) != io.EOF {
		return wireRequest{}, nil, ErrIPCProtocol
	}
	if request.PayloadBytes < 0 || int64(request.PayloadBytes) > maxPayload {
		return wireRequest{}, nil, ErrIPCProtocol
	}
	payload := make([]byte, request.PayloadBytes)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return wireRequest{}, nil, err
	}
	var trailing [1]byte
	if read, err := reader.Read(trailing[:]); read != 0 || !errors.Is(err, io.EOF) {
		return wireRequest{}, nil, ErrIPCProtocol
	}
	return request, payload, nil
}

func writeImageServiceFrame(writer io.Writer, body []byte, maximum int) error {
	if len(body) < 2 || len(body) > maximum {
		return ErrIPCProtocol
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(body)))
	if err := writeFull(writer, length[:]); err != nil {
		return err
	}
	return writeFull(writer, body)
}

func (server *imageServiceServer) handleRequest(
	parent context.Context,
	request wireRequest,
	payload []byte,
) wireResponse {
	if request.Protocol != ProtocolVersion || request.Engine != server.identity.Engine ||
		request.Version != server.identity.Version || request.Operation == "" ||
		request.PayloadBytes != len(payload) {
		return server.errorResponse(request.Operation, "service.request_invalid")
	}
	// Validate the complete closed operation shape before spawning even a
	// version probe. An authenticated but malformed request must not be able to
	// amplify into executable work.
	switch request.Operation {
	case "ready":
		if len(payload) != 0 || !emptyImageServiceRequestMetadata(request) {
			return server.errorResponse(request.Operation, "service.request_invalid")
		}
	case "recognize":
		if server.kind != imageServiceOCR || !validOCRServiceRequest(request, payload) {
			return server.errorResponse(request.Operation, "ocr.request_invalid")
		}
	case "scan":
		if server.kind != imageServiceScanner || !validScannerServiceRequest(request, payload) {
			return server.rejectedResponse(request.Operation, "scanner.request_invalid")
		}
	default:
		return server.errorResponse(request.Operation, "service.operation_unsupported")
	}
	operationContext, cancel := context.WithTimeout(parent, server.callTimeout)
	defer cancel()
	actualIdentity, identityErr := server.actualIdentity(operationContext)
	if identityErr != nil {
		return server.errorResponse(request.Operation, "service.identity_unavailable")
	}
	if actualIdentity != server.identity {
		return server.errorResponse(request.Operation, "service.identity_drift")
	}
	switch request.Operation {
	case "ready":
		response := server.baseResponse("ready", "ready")
		profile := SandboxProfile
		if server.kind == imageServiceScanner {
			profile = ScannerSandboxProfile
		}
		response.SandboxProfile = profile
		response.Network, response.Browser = imageServiceFalse(), imageServiceFalse()
		response.Tools, response.Shell = imageServiceFalse(), imageServiceFalse()
		return response
	case "recognize":
		output, err := server.ocr.Recognize(operationContext, OCRServiceInput{
			RasterPNG: payload, Width: request.Width, Height: request.Height,
			LanguageTag: request.LanguageHint,
		})
		if err != nil {
			return server.errorResponse(request.Operation, serviceRejectionCode(err, "ocr.execution_failed"))
		}
		if context.Cause(operationContext) != nil {
			return server.errorResponse(request.Operation, "ocr.timeout")
		}
		if !validOCRServiceOutput(output) {
			return server.errorResponse(request.Operation, "ocr.output_invalid")
		}
		response := server.baseResponse("recognize", "complete")
		response.Text, response.Language, response.Confidence = output.Text, output.Language, output.Confidence
		return response
	case "scan":
		if err := server.scanner.Scan(operationContext, payload); err != nil {
			return server.rejectedResponse(request.Operation,
				serviceRejectionCode(err, "scanner.execution_failed"))
		}
		if context.Cause(operationContext) != nil {
			return server.rejectedResponse(request.Operation, "scanner.timeout")
		}
		return server.baseResponse("scan", "clean")
	}
	return server.errorResponse(request.Operation, "service.operation_unsupported")
}

func (server *imageServiceServer) actualIdentity(ctx context.Context) (ServiceIdentity, error) {
	if server.kind == imageServiceOCR {
		return server.ocr.Identity(ctx)
	}
	return server.scanner.Identity(ctx)
}

func (server *imageServiceServer) baseResponse(operation, status string) wireResponse {
	return wireResponse{
		Protocol: ProtocolVersion, Operation: operation, Status: status,
		Engine: server.identity.Engine, Version: server.identity.Version,
	}
}

func (server *imageServiceServer) errorResponse(operation, code string) wireResponse {
	response := server.baseResponse(operation, "error")
	response.ReasonCode = code
	return response
}

func (server *imageServiceServer) rejectedResponse(operation, code string) wireResponse {
	response := server.baseResponse(operation, "rejected")
	response.ReasonCode = code
	return response
}

func emptyImageServiceRequestMetadata(request wireRequest) bool {
	return request.AssetSHA256 == "" && request.RasterSHA256 == "" && request.MediaType == "" &&
		request.Width == 0 && request.Height == 0 && request.LanguageHint == "" &&
		request.PayloadBytes == 0 && request.PayloadSHA256 == ""
}

func validOCRServiceRequest(request wireRequest, payload []byte) bool {
	if request.MediaType != "image/png" || len(payload) == 0 ||
		!bytes.HasPrefix(payload, []byte("\x89PNG\r\n\x1a\n")) ||
		!validSHA256(request.AssetSHA256) || !validSHA256(request.RasterSHA256) ||
		request.PayloadSHA256 != request.RasterSHA256 || sha256Hex(payload) != request.RasterSHA256 ||
		request.Width < 1 || request.Height < 1 || request.Width > 16_384 || request.Height > 16_384 ||
		int64(request.Width)*int64(request.Height) > 40_000_000 {
		return false
	}
	tag, err := language.Parse(request.LanguageHint)
	return err == nil && tag != language.Und && tag.String() == request.LanguageHint
}

func validScannerServiceRequest(request wireRequest, payload []byte) bool {
	return len(payload) != 0 && validSHA256(request.AssetSHA256) &&
		request.RasterSHA256 == "" && request.Width == 0 && request.Height == 0 &&
		request.LanguageHint == "" && validMediaType(request.MediaType) &&
		request.PayloadSHA256 == request.AssetSHA256 && sha256Hex(payload) == request.AssetSHA256
}

func validOCRServiceOutput(output OCRServiceOutput) bool {
	if !validBoundedOCRText(output.Text, maximumOCRText) ||
		output.Text == "" && (output.Language != "" || output.Confidence != nil) ||
		output.Text != "" && !validBoundedText(output.Language, 64) ||
		output.Confidence != nil && (math.IsNaN(*output.Confidence) || math.IsInf(*output.Confidence, 0) ||
			*output.Confidence < 0 || *output.Confidence > 1) {
		return false
	}
	if output.Text == "" {
		return true
	}
	tag, err := language.Parse(output.Language)
	return err == nil && tag != language.Und && tag.String() == output.Language
}

func imageServiceFalse() *bool {
	value := false
	return &value
}

func rejectImageServiceDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := scanImageServiceJSONValue(decoder); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrIPCProtocol
	}
	return nil
}

func scanImageServiceJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return ErrIPCProtocol
			}
			if _, duplicate := seen[key]; duplicate {
				return ErrIPCProtocol
			}
			seen[key] = struct{}{}
			if err := scanImageServiceJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return ErrIPCProtocol
		}
	case '[':
		for decoder.More() {
			if err := scanImageServiceJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return ErrIPCProtocol
		}
	default:
		return ErrIPCProtocol
	}
	return nil
}

func (server *imageServiceServer) validateSocketParent() error {
	parent := filepath.Dir(server.path)
	information, err := os.Lstat(parent)
	if err != nil || !information.IsDir() || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%w: socket parent must be a non-writable owned directory", ErrUnsafeSocket)
	}
	uid, ok := imageServiceFileOwnerUID(information)
	if !ok || uid != os.Geteuid() {
		return fmt.Errorf("%w: socket parent ownership", ErrUnsafeSocket)
	}
	return nil
}

func (server *imageServiceServer) validateCreatedSocket() error {
	information, err := os.Lstat(server.path)
	if err != nil || information.Mode()&os.ModeSocket == 0 || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm() != server.mode {
		return fmt.Errorf("%w: created service socket", ErrUnsafeSocket)
	}
	uid, ok := imageServiceFileOwnerUID(information)
	if !ok || uid != os.Geteuid() {
		return fmt.Errorf("%w: created service socket ownership", ErrUnsafeSocket)
	}
	return nil
}
