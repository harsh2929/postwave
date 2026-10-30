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
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
)

type readinessChecker interface {
	Ready(context.Context) error
}

// Server owns the network-capable broker. It is deployable as a separate
// process role; this type intentionally accepts an already-composed Inspector
// so none of its resolver, HTTP, scanner, OCR, object-store, or credential
// dependencies can cross into Client.
type Server struct {
	configuration ServerConfig
	inspector     campaignimagebroker.Inspector
	allowed       map[PeerIdentity]struct{}
	slots         chan struct{}
}

func NewServer(input ServerConfig, inspector campaignimagebroker.Inspector) (*Server, error) {
	configuration, err := normalizeServerConfig(input)
	if err != nil {
		return nil, err
	}
	if inspector == nil {
		return nil, fmt.Errorf("%w: inspector is required", ErrInvalidConfiguration)
	}
	allowed := make(map[PeerIdentity]struct{}, len(configuration.AllowedClients))
	for _, identity := range configuration.AllowedClients {
		allowed[identity] = struct{}{}
	}
	return &Server{
		configuration: configuration, inspector: inspector, allowed: allowed,
		slots: make(chan struct{}, configuration.Limits.MaxConcurrency),
	}, nil
}

// Listen creates a new socket only when its parent and resulting socket have
// exact configured ownership and non-public permissions. A pre-existing path,
// including a symlink or stale socket, fails closed and is never removed here.
func (s *Server) Listen() (*net.UnixListener, error) {
	if s == nil || s.inspector == nil || CurrentProcessIdentity() != s.configuration.ServerIdentity {
		return nil, ErrInvalidConfiguration
	}
	if err := validateSocketParent(s.configuration.SocketPath, s.configuration.SocketOwner); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(s.configuration.SocketPath); err == nil || !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: socket path already exists or cannot be inspected", ErrUnsafeSocket)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: s.configuration.SocketPath, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("%w: create listener", ErrUnavailable)
	}
	listener.SetUnlinkOnClose(true)
	if err := os.Chown(s.configuration.SocketPath, int(s.configuration.SocketOwner.UID), int(s.configuration.SocketOwner.GID)); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("%w: set socket owner", ErrUnsafeSocket)
	}
	if err := os.Chmod(s.configuration.SocketPath, s.configuration.SocketMode.Perm()); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("%w: set socket permissions", ErrUnsafeSocket)
	}
	if _, err := validateSocket(s.configuration.SocketPath, s.configuration.SocketOwner); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	listener, err := s.Listen()
	if err != nil {
		return err
	}
	return s.Serve(ctx, listener)
}

// RunServer is the process-role entry point: it constructs the authenticated
// server and blocks until ctx is cancelled. Deployment remains responsible for
// placing this call in a distinct, restricted-egress workload.
func RunServer(ctx context.Context, configuration ServerConfig, inspector campaignimagebroker.Inspector) error {
	server, err := NewServer(configuration, inspector)
	if err != nil {
		return err
	}
	return server.ListenAndServe(ctx)
}

// Serve blocks until ctx is cancelled or the listener fails. The listener must
// be the exact configured Unix socket and is closed on return.
func (s *Server) Serve(ctx context.Context, listener *net.UnixListener) error {
	if s == nil || s.inspector == nil || listener == nil || ctx == nil {
		return ErrInvalidConfiguration
	}
	address, ok := listener.Addr().(*net.UnixAddr)
	if !ok || address.Net != "unix" || address.Name != s.configuration.SocketPath {
		return fmt.Errorf("%w: listener identity", ErrUnsafeSocket)
	}
	if _, err := validateSocket(s.configuration.SocketPath, s.configuration.SocketOwner); err != nil {
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
	defer func() { _ = listener.Close() }()
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			if context.Cause(ctx) != nil {
				return nil
			}
			return fmt.Errorf("%w: accept connection", ErrUnavailable)
		}
		select {
		case s.slots <- struct{}{}:
			go func() {
				defer func() { <-s.slots }()
				s.handleConnection(ctx, connection)
			}()
		default:
			_ = connection.Close()
		}
	}
}

func (s *Server) handleConnection(parent context.Context, connection *net.UnixConn) {
	defer func() { _ = connection.Close() }()
	identity, err := connectedPeer(connection)
	if err != nil {
		return
	}
	if _, authorized := s.allowed[identity]; !authorized {
		return
	}
	requestContext, cancel := context.WithTimeout(parent, s.configuration.Limits.RequestTimeout)
	defer cancel()
	deadline := time.Now().Add(s.configuration.Limits.RequestTimeout)
	if contextDeadline, ok := requestContext.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := connection.SetDeadline(deadline); err != nil {
		return
	}
	header, err := readFrame(connection, s.configuration.Limits.MaxRequestHeader)
	if err != nil {
		return
	}
	var request wireRequest
	if err := decodeStrict(header, &request); err != nil ||
		validateWireRequest(request, s.configuration.Limits, s.configuration.DeploymentIdentity) != nil {
		return
	}
	payload := make([]byte, request.HTMLBytes)
	if request.HTMLBytes != 0 {
		if _, err := io.ReadFull(connection, payload); err != nil {
			return
		}
		if sha256Hex(payload) != request.HTMLHash {
			s.writeError(connection, request, "invalid_request")
			return
		}
	}
	if request.Operation == "ready" {
		if checker, ok := s.inspector.(readinessChecker); ok {
			if err := checker.Ready(requestContext); err != nil {
				s.writeError(connection, request, classifyRemoteError(err))
				return
			}
		}
		s.writeResponse(connection, request, wireResponse{
			Status: "ready",
		})
		return
	}
	report, err := s.inspector.Inspect(requestContext, campaignimagebroker.Request{
		TenantID: request.TenantID, FrozenSourceHash: request.FrozenSourceHash,
		ArtifactHash: request.ArtifactHash, HTMLHash: request.HTMLHash, Locale: request.Locale,
		HTML: payload, ReviewedSources: append([]campaignimagebroker.SourceReview(nil), request.ReviewedSources...),
	})
	if err != nil {
		s.writeError(connection, request, classifyRemoteError(err))
		return
	}
	if len(report.Receipts) > s.configuration.Limits.MaxReceipts {
		s.writeError(connection, request, "resource_limit")
		return
	}
	if err := validateReport(report, request, s.configuration.Limits); err != nil {
		s.writeError(connection, request, "internal")
		return
	}
	s.writeResponse(connection, request, wireResponse{Status: "ok", Report: &report})
}

func (s *Server) writeError(connection *net.UnixConn, request wireRequest, code string) {
	if !validRemoteErrorCode(code) {
		code = "internal"
	}
	s.writeResponse(connection, request, wireResponse{Status: "error", ErrorCode: code})
}

func (s *Server) writeResponse(connection *net.UnixConn, request wireRequest, response wireResponse) {
	// The inspector deadline may be the event being reported. Give only the
	// bounded response frame a fresh, short write deadline so a timeout verdict
	// is observable without allowing a slow peer to retain the connection.
	_ = connection.SetWriteDeadline(time.Now().Add(250 * time.Millisecond))
	response.Protocol = ProtocolVersion
	response.Operation = request.Operation
	response.RequestID = request.RequestID
	response.DeploymentIdentity = s.configuration.DeploymentIdentity
	response.BoundaryProfile = BoundaryProfile
	response.BrokerVersion = campaignimagebroker.BrokerVersion
	body, err := json.Marshal(response)
	if err != nil || len(body) > s.configuration.Limits.MaxResponseBytes {
		response.Status, response.ErrorCode, response.Report = "error", "resource_limit", nil
		body, err = json.Marshal(response)
	}
	if err != nil || len(body) > s.configuration.Limits.MaxResponseBytes {
		return
	}
	_ = writeFrame(connection, body)
}

func classifyRemoteError(err error) string {
	switch {
	case errors.Is(err, campaignimagebroker.ErrInvalidRequest):
		return "invalid_request"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, campaignimagebroker.ErrResourceLimit):
		return "resource_limit"
	case errors.Is(err, campaignimagebroker.ErrInvalidConfiguration), errors.Is(err, ErrNotReady), errors.Is(err, ErrUnavailable):
		return "unavailable"
	default:
		return "internal"
	}
}
