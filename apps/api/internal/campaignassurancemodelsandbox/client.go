// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancemodelsandbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

var _ campaignassuranceworker.ModelExecutor = (*Client)(nil)

// Client is a credential-free ModelExecutor backed by a local Unix socket.
// Execute is fail-closed until Ready has authenticated the socket peer and the
// exact remote executor identity/capability profile.
type Client struct {
	path              string
	expectedServerUID int
	identity          campaignassuranceworker.ModelExecutorIdentity
	timeout           time.Duration
	dialAttempts      int
	maxRequestBytes   int
	maxResponseBytes  int
	dial              func(context.Context, string, string) (net.Conn, error)
	lstat             func(string) (os.FileInfo, error)
	ready             atomic.Bool
}

func NewClient(configuration ClientConfig) (*Client, error) {
	if configuration.Timeout == 0 {
		configuration.Timeout = defaultTimeout
	}
	if configuration.DialAttempts == 0 {
		configuration.DialAttempts = defaultDialAttempts
	}
	if configuration.MaxRequestBytes == 0 {
		configuration.MaxRequestBytes = defaultRequestBytes
	}
	if configuration.MaxResponseBytes == 0 {
		configuration.MaxResponseBytes = defaultResponseBytes
	}
	if configuration.ExpectedServerUID == 0 && os.Geteuid() != 0 {
		configuration.ExpectedServerUID = os.Geteuid()
	}
	if err := validateTransportConfiguration(
		configuration.SocketPath, configuration.Timeout,
		configuration.MaxRequestBytes, configuration.MaxResponseBytes,
	); err != nil || !validExecutorIdentity(configuration.ExpectedIdentity) ||
		configuration.ExpectedServerUID < 0 || configuration.DialAttempts < 1 ||
		configuration.DialAttempts > maximumDialAttempts {
		return nil, ErrInvalidConfiguration
	}
	dialer := &net.Dialer{Timeout: configuration.Timeout}
	return &Client{
		path: configuration.SocketPath, expectedServerUID: configuration.ExpectedServerUID,
		identity: configuration.ExpectedIdentity, timeout: configuration.Timeout,
		dialAttempts:     configuration.DialAttempts,
		maxRequestBytes:  configuration.MaxRequestBytes,
		maxResponseBytes: configuration.MaxResponseBytes,
		dial:             dialer.DialContext, lstat: os.Lstat,
	}, nil
}

func (client *Client) Identity() campaignassuranceworker.ModelExecutorIdentity {
	if client == nil {
		return campaignassuranceworker.ModelExecutorIdentity{}
	}
	return client.identity
}

func (client *Client) IsReady() bool { return client != nil && client.ready.Load() }

func (client *Client) Ready(ctx context.Context) error {
	if client == nil {
		return ErrInvalidConfiguration
	}
	client.ready.Store(false)
	requestID, err := newRequestID()
	if err != nil {
		return fmt.Errorf("%w: readiness identity", ErrNotReady)
	}
	response, err := client.callFor(ctx, wireEnvelope{
		Protocol: ProtocolVersion, Operation: "ready", RequestID: requestID,
	}, ProtocolVersion, ServiceID, ServiceVersion)
	if err != nil {
		return err
	}
	expected := fixedCapabilities()
	if response.Status != "ready" || response.Result != nil || response.Failure != nil ||
		response.Capabilities == nil || *response.Capabilities != expected {
		return fmt.Errorf("%w: invalid readiness profile", ErrProtocol)
	}
	client.ready.Store(true)
	return nil
}

func (client *Client) Execute(
	ctx context.Context,
	request campaignassuranceworker.ModelRequest,
) (campaignassuranceworker.ModelResult, error) {
	if client == nil {
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "sandbox_not_ready", Kind: campaignassuranceworker.ModelFailureUnavailable,
		}
	}
	return client.executeFor(ctx, request, &client.ready, ProtocolVersion, ServiceID, ServiceVersion)
}

func (client *Client) executeFor(
	ctx context.Context,
	request campaignassuranceworker.ModelRequest,
	ready *atomic.Bool,
	protocol, serviceID, serviceVersion string,
) (campaignassuranceworker.ModelResult, error) {
	if client == nil || ready == nil || !ready.Load() {
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "sandbox_not_ready", Kind: campaignassuranceworker.ModelFailureUnavailable,
		}
	}
	input := modelInputFromRequest(request)
	if err := validateModelInput(input, client.identity); err != nil {
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "sandbox_request_invalid", Kind: campaignassuranceworker.ModelFailureError,
		}
	}
	inputBody, err := json.Marshal(input)
	if err != nil || len(inputBody) > client.maxRequestBytes {
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "sandbox_request_too_large", Kind: campaignassuranceworker.ModelFailureError,
		}
	}
	response, err := client.callFor(ctx, wireEnvelope{
		Protocol: protocol, Operation: "execute", RequestID: request.InvocationID,
		Input: &input, InputHash: sha256Hex(inputBody),
	}, protocol, serviceID, serviceVersion)
	if err != nil {
		ready.Store(false)
		return campaignassuranceworker.ModelResult{}, err
	}
	if response.Failure != nil {
		if response.Status != "failed" || response.Result != nil || response.Capabilities != nil ||
			!validFailure(*response.Failure) {
			ready.Store(false)
			return campaignassuranceworker.ModelResult{}, ErrProtocol
		}
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: response.Failure.Code, Kind: response.Failure.Kind,
		}
	}
	if response.Status != "complete" || response.Result == nil || response.Capabilities != nil {
		ready.Store(false)
		return campaignassuranceworker.ModelResult{}, ErrProtocol
	}
	result := *response.Result
	result.RawExtraction = append([]byte(nil), result.RawExtraction...)
	if err := validateModelResult(result, input, client.identity); err != nil {
		ready.Store(false)
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "sandbox_output_invalid", Kind: campaignassuranceworker.ModelFailureError,
		}
	}
	return result, nil
}

func (client *Client) callFor(
	ctx context.Context,
	request wireEnvelope,
	protocol, serviceID, serviceVersion string,
) (wireResponse, error) {
	if client == nil || client.dial == nil || client.lstat == nil {
		return wireResponse{}, ErrInvalidConfiguration
	}
	if err := client.validateSocket(); err != nil {
		return wireResponse{}, err
	}
	body, err := json.Marshal(request)
	if err != nil || len(body) < 2 || len(body) > client.maxRequestBytes {
		return wireResponse{}, fmt.Errorf("%w: request frame bound", ErrProtocol)
	}
	callContext, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	connection, err := client.dialAuthorized(callContext)
	if err != nil {
		if cause := context.Cause(callContext); cause != nil {
			return wireResponse{}, cause
		}
		return wireResponse{}, fmt.Errorf("%w: connect", ErrNotReady)
	}
	defer func() { _ = connection.Close() }()
	deadline := time.Now().Add(client.timeout)
	if contextDeadline, ok := callContext.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return wireResponse{}, fmt.Errorf("%w: set deadline", ErrNotReady)
	}
	if err := writeFrame(connection, body, client.maxRequestBytes); err != nil {
		return wireResponse{}, fmt.Errorf("%w: write request", ErrNotReady)
	}
	if err := connection.CloseWrite(); err != nil {
		return wireResponse{}, fmt.Errorf("%w: close request", ErrNotReady)
	}
	responseBody, err := readFrame(connection, client.maxResponseBytes)
	if err != nil {
		if cause := context.Cause(callContext); cause != nil {
			return wireResponse{}, cause
		}
		return wireResponse{}, fmt.Errorf("%w: read response", ErrNotReady)
	}
	response, err := decodeWireResponse(responseBody)
	if err != nil {
		return wireResponse{}, err
	}
	if response.Protocol != protocol || response.Operation != request.Operation ||
		response.RequestID != request.RequestID || response.ServiceID != serviceID ||
		response.ServiceVersion != serviceVersion || response.Identity != client.identity {
		return wireResponse{}, fmt.Errorf("%w: response identity mismatch", ErrProtocol)
	}
	return response, nil
}

// ProviderGatewayClient is the only ModelExecutor intended for injection into
// the no-network Server. It can communicate solely over a pinned Unix socket;
// it contains no provider credential or HTTP client.
type ProviderGatewayClient struct {
	transport *Client
	ready     atomic.Bool
}

var _ campaignassuranceworker.ModelExecutor = (*ProviderGatewayClient)(nil)

func NewProviderGatewayClient(configuration ProviderGatewayClientConfig) (*ProviderGatewayClient, error) {
	transport, err := NewClient(ClientConfig(configuration))
	if err != nil {
		return nil, err
	}
	return &ProviderGatewayClient{transport: transport}, nil
}

func (client *ProviderGatewayClient) Identity() campaignassuranceworker.ModelExecutorIdentity {
	if client == nil || client.transport == nil {
		return campaignassuranceworker.ModelExecutorIdentity{}
	}
	return client.transport.Identity()
}

func (client *ProviderGatewayClient) IsReady() bool {
	return client != nil && client.transport != nil && client.ready.Load()
}

func (client *ProviderGatewayClient) Ready(ctx context.Context) error {
	if client == nil || client.transport == nil {
		return ErrInvalidConfiguration
	}
	client.ready.Store(false)
	requestID, err := newRequestID()
	if err != nil {
		return fmt.Errorf("%w: gateway readiness identity", ErrNotReady)
	}
	response, err := client.transport.callFor(ctx, wireEnvelope{
		Protocol: GatewayProtocolVersion, Operation: "ready", RequestID: requestID,
	}, GatewayProtocolVersion, GatewayServiceID, GatewayServiceVersion)
	if err != nil {
		return err
	}
	expected := gatewayCapabilities()
	if response.Status != "ready" || response.Result != nil || response.Failure != nil ||
		response.Capabilities == nil || *response.Capabilities != expected {
		return fmt.Errorf("%w: invalid provider gateway readiness profile", ErrProtocol)
	}
	client.ready.Store(true)
	return nil
}

func (client *ProviderGatewayClient) Execute(
	ctx context.Context,
	request campaignassuranceworker.ModelRequest,
) (campaignassuranceworker.ModelResult, error) {
	if client == nil || client.transport == nil {
		return campaignassuranceworker.ModelResult{}, &campaignassuranceworker.ModelExecutionFailure{
			Code: "provider_gateway_not_ready", Kind: campaignassuranceworker.ModelFailureUnavailable,
		}
	}
	return client.transport.executeFor(
		ctx, request, &client.ready,
		GatewayProtocolVersion, GatewayServiceID, GatewayServiceVersion,
	)
}

func (client *Client) dialAuthorized(ctx context.Context) (*net.UnixConn, error) {
	var last error
	for attempt := 0; attempt < client.dialAttempts; attempt++ {
		connection, err := client.dial(ctx, "unix", client.path)
		if err == nil {
			unixConnection, ok := connection.(*net.UnixConn)
			if !ok {
				_ = connection.Close()
				return nil, ErrUnsafeSocket
			}
			uid, peerErr := unixPeerUID(unixConnection)
			if peerErr != nil || uid != client.expectedServerUID {
				_ = unixConnection.Close()
				return nil, ErrPeerUnauthorized
			}
			return unixConnection, nil
		}
		last = err
		if attempt+1 == client.dialAttempts {
			break
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, context.Cause(ctx)
		case <-timer.C:
		}
	}
	return nil, last
}

func (client *Client) validateSocket() error {
	information, err := client.lstat(client.path)
	if err != nil {
		return fmt.Errorf("%w: socket unavailable", ErrNotReady)
	}
	owner, ownerKnown := fileOwnerUID(information)
	if information.Mode()&os.ModeSocket == 0 || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm() != 0o600 || !ownerKnown || owner != client.expectedServerUID {
		return ErrUnsafeSocket
	}
	return nil
}

func validateTransportConfiguration(path string, timeout time.Duration, requestBytes, responseBytes int) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 100 ||
		timeout < 100*time.Millisecond || timeout > maximumTimeout || requestBytes < 1024 ||
		requestBytes > maximumRequestBytes || responseBytes < 1024 || responseBytes > maximumResponseBytes {
		return ErrInvalidConfiguration
	}
	return nil
}

func decodeWireResponse(body []byte) (wireResponse, error) {
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return wireResponse{}, fmt.Errorf("%w: duplicate or malformed response", ErrProtocol)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var response wireResponse
	if err := decoder.Decode(&response); err != nil {
		return wireResponse{}, fmt.Errorf("%w: response schema", ErrProtocol)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return wireResponse{}, fmt.Errorf("%w: trailing response", ErrProtocol)
	}
	return response, nil
}

func writeFrame(writer io.Writer, body []byte, maximum int) error {
	if len(body) < 2 || len(body) > maximum || uint64(len(body)) > uint64(^uint32(0)) {
		return ErrProtocol
	}
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(body)))
	if err := writeFull(writer, length[:]); err != nil {
		return err
	}
	return writeFull(writer, body)
}

func readFrame(reader io.Reader, maximum int) ([]byte, error) {
	var length [4]byte
	if _, err := io.ReadFull(reader, length[:]); err != nil {
		return nil, err
	}
	size := int(binary.BigEndian.Uint32(length[:]))
	if size < 2 || size > maximum {
		return nil, ErrProtocol
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, err
	}
	return body, nil
}

func writeFull(writer io.Writer, body []byte) error {
	for len(body) != 0 {
		written, err := writer.Write(body)
		if err != nil {
			return err
		}
		if written < 1 || written > len(body) {
			return io.ErrShortWrite
		}
		body = body[written:]
	}
	return nil
}

func newRequestID() (string, error) {
	var body [32]byte
	if _, err := rand.Read(body[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(body[:]), nil
}

func validFailure(failure wireFailure) bool {
	if !failureCodePattern.MatchString(failure.Code) {
		return false
	}
	switch failure.Kind {
	case campaignassuranceworker.ModelFailureRetryable,
		campaignassuranceworker.ModelFailureError,
		campaignassuranceworker.ModelFailureUnavailable:
		return true
	default:
		return false
	}
}
