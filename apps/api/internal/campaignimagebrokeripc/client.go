// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync/atomic"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

// Client is a fail-closed campaignimagebroker.Inspector. It owns only a Unix
// socket endpoint and never receives a resolver, HTTP transport, credential,
// remote image body, browser, tool, shell, or arbitrary file-read capability.
type Client struct {
	configuration ClientConfig
	ready         atomic.Bool
	dial          func(context.Context) (net.Conn, error)
}

var _ campaignimagebroker.Inspector = (*Client)(nil)

func NewClient(input ClientConfig) (*Client, error) {
	configuration, err := normalizeClientConfig(input)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: configuration.Limits.RequestTimeout}
	return &Client{
		configuration: configuration,
		dial: func(ctx context.Context) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", configuration.SocketPath)
		},
	}, nil
}

// Ready authenticates the socket file and connected server peer, then requires
// the exact deployment identity, protocol, broker version, and boundary profile.
func (c *Client) Ready(ctx context.Context) error {
	if c == nil || c.dial == nil {
		return ErrInvalidConfiguration
	}
	requestID, err := newRequestID()
	if err != nil {
		c.ready.Store(false)
		return fmt.Errorf("%w: create readiness request identity", ErrUnavailable)
	}
	request := wireRequest{
		Protocol: ProtocolVersion, Operation: "ready", RequestID: requestID,
		DeploymentIdentity: c.configuration.DeploymentIdentity,
	}
	response, err := c.call(ctx, request, nil)
	if err == nil && response.Status == "error" {
		err = mapRemoteError(response.ErrorCode)
	}
	if err != nil {
		c.ready.Store(false)
		return err
	}
	c.ready.Store(true)
	return nil
}

func (c *Client) IsReady() bool { return c != nil && c.ready.Load() }

func (c *Client) Inspect(ctx context.Context, input campaignimagebroker.Request) (campaignimagebroker.Report, error) {
	if c == nil || c.dial == nil || !c.ready.Load() {
		return campaignimagebroker.Report{}, ErrNotReady
	}
	requestID, err := newRequestID()
	if err != nil {
		return campaignimagebroker.Report{}, fmt.Errorf("%w: create request identity", ErrUnavailable)
	}
	request := wireRequest{
		Protocol: ProtocolVersion, Operation: "inspect", RequestID: requestID,
		DeploymentIdentity: c.configuration.DeploymentIdentity,
		TenantID:           input.TenantID, FrozenSourceHash: input.FrozenSourceHash,
		ArtifactHash: input.ArtifactHash, HTMLHash: input.HTMLHash, Locale: input.Locale,
		HTMLBytes: len(input.HTML), ReviewedSources: append([]campaignimagebroker.SourceReview(nil), input.ReviewedSources...),
	}
	if err := validateWireRequest(request, c.configuration.Limits, c.configuration.DeploymentIdentity); err != nil ||
		sha256Hex(input.HTML) != input.HTMLHash {
		return campaignimagebroker.Report{}, fmt.Errorf("%w: request does not satisfy IPC contract", campaignimagebroker.ErrInvalidRequest)
	}
	response, err := c.call(ctx, request, input.HTML)
	if err != nil {
		c.ready.Store(false)
		return campaignimagebroker.Report{}, err
	}
	if response.Status == "error" {
		return campaignimagebroker.Report{}, mapRemoteError(response.ErrorCode)
	}
	if response.Report == nil {
		return campaignimagebroker.Report{}, fmt.Errorf("%w: absent report", ErrProtocol)
	}
	return *response.Report, nil
}

func (c *Client) call(ctx context.Context, request wireRequest, payload []byte) (wireResponse, error) {
	if err := validateWireRequest(request, c.configuration.Limits, c.configuration.DeploymentIdentity); err != nil ||
		request.HTMLBytes != len(payload) {
		return wireResponse{}, fmt.Errorf("%w: invalid client request", ErrProtocol)
	}
	if err := validateSocketParent(c.configuration.SocketPath, c.configuration.ExpectedSocketOwner); err != nil {
		return wireResponse{}, err
	}
	before, err := validateSocket(c.configuration.SocketPath, c.configuration.ExpectedSocketOwner)
	if err != nil {
		return wireResponse{}, err
	}
	callContext, cancel := context.WithTimeout(ctx, c.configuration.Limits.RequestTimeout)
	defer cancel()
	connection, err := c.dial(callContext)
	if err != nil {
		if cause := context.Cause(callContext); cause != nil {
			return wireResponse{}, cause
		}
		return wireResponse{}, fmt.Errorf("%w: connect broker", ErrUnavailable)
	}
	defer func() { _ = connection.Close() }()
	peer, err := connectedPeer(connection)
	if err != nil {
		return wireResponse{}, err
	}
	if peer != c.configuration.ExpectedServer {
		return wireResponse{}, ErrUnauthorizedPeer
	}
	after, err := validateSocket(c.configuration.SocketPath, c.configuration.ExpectedSocketOwner)
	if err != nil {
		return wireResponse{}, err
	}
	if !os.SameFile(before, after) {
		return wireResponse{}, fmt.Errorf("%w: socket replaced during connection", ErrUnsafeSocket)
	}
	deadline := time.Now().Add(c.configuration.Limits.RequestTimeout)
	if contextDeadline, ok := callContext.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return wireResponse{}, fmt.Errorf("%w: set connection deadline", ErrUnavailable)
	}
	header, err := json.Marshal(request)
	if err != nil || len(header) > c.configuration.Limits.MaxRequestHeader {
		return wireResponse{}, fmt.Errorf("%w: request header bound", ErrProtocol)
	}
	if err := writeFrame(connection, header); err != nil {
		return wireResponse{}, c.ioError(callContext, "write request header", err)
	}
	if len(payload) != 0 {
		if err := writeFull(connection, payload); err != nil {
			return wireResponse{}, c.ioError(callContext, "write request payload", err)
		}
	}
	body, err := readFrame(connection, c.configuration.Limits.MaxResponseBytes)
	if err != nil {
		return wireResponse{}, c.ioError(callContext, "read response", err)
	}
	var response wireResponse
	if err := decodeStrict(body, &response); err != nil {
		return wireResponse{}, err
	}
	if err := validateWireResponse(response, request, c.configuration.Limits); err != nil {
		return wireResponse{}, err
	}
	return response, nil
}

func (c *Client) ioError(ctx context.Context, operation string, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return context.DeadlineExceeded
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%w: %s", ErrUnavailable, operation)
	}
	return fmt.Errorf("%w: %s", ErrUnavailable, operation)
}

func mapRemoteError(code string) error {
	switch code {
	case "invalid_request":
		return fmt.Errorf("%w: remote broker rejected request", campaignimagebroker.ErrInvalidRequest)
	case "deadline_exceeded":
		return context.DeadlineExceeded
	case "canceled":
		return context.Canceled
	case "resource_limit":
		return campaignimagebroker.ErrResourceLimit
	case "unavailable":
		return ErrUnavailable
	case "internal":
		return ErrRemoteFailure
	default:
		return ErrProtocol
	}
}
