// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

// Server owns only a Unix listener and an injected data-only executor. It has
// no repository, object-storage, mailbox, delivery, browser, tool, or action
// collaborator. Its injected executor is the credential-free Unix provider
// gateway client, while the separate gateway executable constructs the
// provider adapter and receives the provider credential.
type Server struct {
	path             string
	mode             os.FileMode
	allowedClientUID int
	executor         campaignassuranceworker.ModelExecutor
	identity         campaignassuranceworker.ModelExecutorIdentity
	networkIsolation NetworkIsolationEnforcer
	callTimeout      time.Duration
	maxRequestBytes  int
	maxResponseBytes int
	maxConcurrent    int
	protocol         string
	serviceID        string
	serviceVersion   string
	capabilities     func() wireCapabilities
}

func NewServer(configuration ServerConfig) (*Server, error) {
	if configuration.SocketMode == 0 {
		configuration.SocketMode = 0o600
	}
	if configuration.AllowedClientUID == 0 && os.Geteuid() != 0 {
		configuration.AllowedClientUID = os.Geteuid()
	}
	if configuration.CallTimeout == 0 {
		configuration.CallTimeout = defaultTimeout
	}
	if configuration.MaxRequestBytes == 0 {
		configuration.MaxRequestBytes = defaultRequestBytes
	}
	if configuration.MaxResponseBytes == 0 {
		configuration.MaxResponseBytes = defaultResponseBytes
	}
	if configuration.MaxConcurrent == 0 {
		configuration.MaxConcurrent = defaultConcurrency
	}
	if err := validateTransportConfiguration(
		configuration.SocketPath, configuration.CallTimeout,
		configuration.MaxRequestBytes, configuration.MaxResponseBytes,
	); err != nil || configuration.SocketMode.Perm() != 0o600 ||
		configuration.AllowedClientUID < 0 || configuration.Executor == nil ||
		configuration.NetworkIsolation == nil ||
		configuration.MaxConcurrent < 1 || configuration.MaxConcurrent > maximumConcurrency {
		return nil, ErrInvalidConfiguration
	}
	identity := configuration.Executor.Identity()
	if !validExecutorIdentity(identity) {
		return nil, ErrInvalidConfiguration
	}
	return &Server{
		path: configuration.SocketPath, mode: configuration.SocketMode.Perm(),
		allowedClientUID: configuration.AllowedClientUID,
		executor:         configuration.Executor, identity: identity,
		networkIsolation: configuration.NetworkIsolation,
		callTimeout:      configuration.CallTimeout,
		maxRequestBytes:  configuration.MaxRequestBytes,
		maxResponseBytes: configuration.MaxResponseBytes,
		maxConcurrent:    configuration.MaxConcurrent,
		protocol:         ProtocolVersion, serviceID: ServiceID, serviceVersion: ServiceVersion,
		capabilities: fixedCapabilities,
	}, nil
}

// ProviderGatewayServer is the credentialed provider-egress process. It uses
// the same closed model-data schema but a distinct protocol/service identity
// and never claims no-network isolation.
type ProviderGatewayServer struct{ server *Server }

func NewProviderGatewayServer(configuration ProviderGatewayServerConfig) (*ProviderGatewayServer, error) {
	if configuration.SocketMode == 0 {
		configuration.SocketMode = 0o600
	}
	if configuration.AllowedClientUID == 0 && os.Geteuid() != 0 {
		configuration.AllowedClientUID = os.Geteuid()
	}
	if configuration.CallTimeout == 0 {
		configuration.CallTimeout = defaultTimeout
	}
	if configuration.MaxRequestBytes == 0 {
		configuration.MaxRequestBytes = defaultRequestBytes
	}
	if configuration.MaxResponseBytes == 0 {
		configuration.MaxResponseBytes = defaultResponseBytes
	}
	if configuration.MaxConcurrent == 0 {
		configuration.MaxConcurrent = defaultConcurrency
	}
	if err := validateTransportConfiguration(
		configuration.SocketPath, configuration.CallTimeout,
		configuration.MaxRequestBytes, configuration.MaxResponseBytes,
	); err != nil || configuration.SocketMode.Perm() != 0o600 ||
		configuration.AllowedClientUID < 0 || configuration.Executor == nil ||
		configuration.MaxConcurrent < 1 || configuration.MaxConcurrent > maximumConcurrency {
		return nil, ErrInvalidConfiguration
	}
	identity := configuration.Executor.Identity()
	if !validExecutorIdentity(identity) {
		return nil, ErrInvalidConfiguration
	}
	return &ProviderGatewayServer{server: &Server{
		path: configuration.SocketPath, mode: configuration.SocketMode.Perm(),
		allowedClientUID: configuration.AllowedClientUID,
		executor:         configuration.Executor, identity: identity,
		callTimeout:      configuration.CallTimeout,
		maxRequestBytes:  configuration.MaxRequestBytes,
		maxResponseBytes: configuration.MaxResponseBytes,
		maxConcurrent:    configuration.MaxConcurrent,
		protocol:         GatewayProtocolVersion, serviceID: GatewayServiceID,
		serviceVersion: GatewayServiceVersion, capabilities: gatewayCapabilities,
	}}, nil
}

// ListenAndServe creates a mode-0600 Unix socket, authenticates every peer by
// kernel-reported UID before parsing bytes, serves one bounded request per
// connection, and removes its own socket on shutdown. An existing path is
// never unlinked or replaced.
func (server *Server) ListenAndServe(ctx context.Context) error {
	if server == nil || server.executor == nil || server.networkIsolation == nil {
		return ErrInvalidConfiguration
	}
	if err := RejectSandboxCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	attestation, err := server.networkIsolation.Enforce(ctx)
	if err != nil || !attestation.valid() {
		return fmt.Errorf("%w: no-network attestation", ErrNetworkIsolation)
	}
	return server.listenAndServe(ctx)
}

func (gateway *ProviderGatewayServer) ListenAndServe(ctx context.Context) error {
	if gateway == nil || gateway.server == nil || gateway.server.executor == nil {
		return ErrInvalidConfiguration
	}
	if err := RejectApplicationCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	return gateway.server.listenAndServe(ctx)
}

func (server *Server) listenAndServe(ctx context.Context) error {
	if err := server.validateSocketParent(); err != nil {
		return err
	}
	if _, err := os.Lstat(server.path); err == nil || !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return fmt.Errorf("%w: socket path already exists", ErrUnsafeSocket)
		}
		return fmt.Errorf("%w: inspect socket path", ErrUnsafeSocket)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: server.path, Net: "unix"})
	if err != nil {
		return fmt.Errorf("%w: listen", ErrNotReady)
	}
	defer func() { _ = listener.Close() }()
	listener.SetUnlinkOnClose(true)
	if err := os.Chmod(server.path, server.mode); err != nil {
		_ = listener.Close()
		return fmt.Errorf("%w: protect socket", ErrUnsafeSocket)
	}
	if err := server.validateCreatedSocket(); err != nil {
		_ = listener.Close()
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
			return fmt.Errorf("%w: accept", ErrNotReady)
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
			// Capacity rejection happens before any request bytes or provider
			// call. The client treats the closed transport as retryable and a
			// durable orchestrator may redeliver later without double charging.
			_ = connection.Close()
		}
	}
}

func (server *Server) handleConnection(parent context.Context, connection *net.UnixConn) {
	defer func() { _ = connection.Close() }()
	uid, err := unixPeerUID(connection)
	if err != nil || uid != server.allowedClientUID {
		return
	}
	deadline := time.Now().Add(server.callTimeout)
	if parentDeadline, ok := parent.Deadline(); ok && parentDeadline.Before(deadline) {
		deadline = parentDeadline
	}
	if connection.SetDeadline(deadline) != nil {
		return
	}
	body, err := readFrame(connection, server.maxRequestBytes)
	if err != nil {
		return
	}
	// Clients half-close after one frame. Refusing trailing bytes prevents a
	// second hidden operation from being smuggled onto an authenticated call.
	var trailing [1]byte
	if read, trailingErr := connection.Read(trailing[:]); read != 0 || !errors.Is(trailingErr, io.EOF) {
		return
	}
	request, err := decodeWireEnvelope(body, server.protocol)
	if err != nil {
		return
	}
	response := server.handleRequest(parent, request)
	responseBody, err := json.Marshal(response)
	if err != nil || len(responseBody) > server.maxResponseBytes {
		response = server.failureResponse(request, "sandbox_response_too_large", campaignassuranceworker.ModelFailureError)
		responseBody, err = json.Marshal(response)
	}
	if err != nil || len(responseBody) > server.maxResponseBytes {
		return
	}
	_ = writeFrame(connection, responseBody, server.maxResponseBytes)
	_ = connection.CloseWrite()
}

func (server *Server) handleRequest(parent context.Context, request wireEnvelope) wireResponse {
	base := wireResponse{
		Protocol: server.protocol, Operation: request.Operation, RequestID: request.RequestID,
		ServiceID: server.serviceID, ServiceVersion: server.serviceVersion, Identity: server.identity,
	}
	if server.executor.Identity() != server.identity {
		return server.failureResponse(request, "sandbox_identity_drift", campaignassuranceworker.ModelFailureUnavailable)
	}
	switch request.Operation {
	case "ready":
		if request.Input != nil || request.InputHash != "" {
			return server.failureResponse(request, "sandbox_request_invalid", campaignassuranceworker.ModelFailureError)
		}
		if readyExecutor, ok := server.executor.(interface{ Ready(context.Context) error }); ok {
			readyContext, cancel := context.WithTimeout(parent, server.callTimeout)
			readyErr := readyExecutor.Ready(readyContext)
			cancel()
			if readyErr != nil {
				return server.failureResponse(request, "provider_gateway_unavailable", campaignassuranceworker.ModelFailureUnavailable)
			}
		}
		capabilities := server.capabilities()
		base.Status, base.Capabilities = "ready", &capabilities
		return base
	case "execute":
		if request.Input == nil || request.RequestID != request.Input.InvocationID {
			return server.failureResponse(request, "sandbox_request_invalid", campaignassuranceworker.ModelFailureError)
		}
		canonicalInput, err := json.Marshal(request.Input)
		if err != nil || request.InputHash != sha256Hex(canonicalInput) ||
			validateModelInput(*request.Input, server.identity) != nil {
			return server.failureResponse(request, "sandbox_request_invalid", campaignassuranceworker.ModelFailureError)
		}

		timeout := server.callTimeout
		configured := time.Duration(request.Input.Configuration.TimeoutMS) * time.Millisecond
		if configured > 0 && configured < timeout {
			timeout = configured
		}
		callContext, cancel := context.WithTimeout(parent, timeout)
		result, executionErr := server.executor.Execute(callContext, request.Input.modelRequest())
		cause := context.Cause(callContext)
		cancel()
		if executionErr != nil {
			if errors.Is(cause, context.DeadlineExceeded) {
				return server.failureResponse(request, "sandbox_execution_timeout", campaignassuranceworker.ModelFailureRetryable)
			}
			return server.executorFailureResponse(request, executionErr)
		}
		if cause != nil {
			return server.failureResponse(request, "sandbox_execution_timeout", campaignassuranceworker.ModelFailureRetryable)
		}
		if err := validateModelResult(result, *request.Input, server.identity); err != nil {
			return server.failureResponse(request, "sandbox_output_invalid", campaignassuranceworker.ModelFailureError)
		}
		result.RawExtraction = append([]byte(nil), result.RawExtraction...)
		base.Status, base.Result = "complete", &result
		return base
	default:
		return server.failureResponse(request, "sandbox_operation_unsupported", campaignassuranceworker.ModelFailureError)
	}
}

func (server *Server) executorFailureResponse(request wireEnvelope, executionErr error) wireResponse {
	var classified *campaignassuranceworker.ModelExecutionFailure
	if errors.As(executionErr, &classified) && classified != nil {
		failure := wireFailure{Code: classified.Code, Kind: classified.Kind}
		if validFailure(failure) {
			return server.failureResponse(request, failure.Code, failure.Kind)
		}
	}
	return server.failureResponse(request, "sandbox_executor_retryable", campaignassuranceworker.ModelFailureRetryable)
}

func (server *Server) failureResponse(
	request wireEnvelope,
	code string,
	kind campaignassuranceworker.ModelFailureKind,
) wireResponse {
	return wireResponse{
		Protocol: server.protocol, Operation: request.Operation, RequestID: request.RequestID,
		Status: "failed", ServiceID: server.serviceID, ServiceVersion: server.serviceVersion,
		Identity: server.identity, Failure: &wireFailure{Code: code, Kind: kind},
	}
}

func decodeWireEnvelope(body []byte, protocol string) (wireEnvelope, error) {
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return wireEnvelope{}, ErrProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var request wireEnvelope
	if err := decoder.Decode(&request); err != nil || decoder.Decode(new(any)) != io.EOF ||
		request.Protocol != protocol || !requestIDPattern.MatchString(request.RequestID) {
		return wireEnvelope{}, ErrProtocol
	}
	return request, nil
}

func (server *Server) validateSocketParent() error {
	directory := filepath.Dir(server.path)
	information, err := os.Lstat(directory)
	if err != nil || !information.IsDir() || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%w: insecure socket directory", ErrUnsafeSocket)
	}
	owner, known := fileOwnerUID(information)
	if !known || owner != os.Geteuid() {
		return fmt.Errorf("%w: foreign socket directory", ErrUnsafeSocket)
	}
	return nil
}

func (server *Server) validateCreatedSocket() error {
	information, err := os.Lstat(server.path)
	if err != nil || information.Mode()&os.ModeSocket == 0 ||
		information.Mode()&os.ModeSymlink != 0 || information.Mode().Perm() != server.mode {
		return fmt.Errorf("%w: invalid created socket", ErrUnsafeSocket)
	}
	owner, known := fileOwnerUID(information)
	if !known || owner != os.Geteuid() {
		return fmt.Errorf("%w: foreign created socket", ErrUnsafeSocket)
	}
	return nil
}
