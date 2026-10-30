// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	ProtocolVersion = "postwave.campaign-image-broker-ipc.v1"
	BoundaryProfile = "postwave.image-fetch-broker.separate-process.v1"

	defaultMaxHTMLBytes       = 8 << 20
	defaultMaxReviewedSources = 64
	defaultMaxRequestHeader   = 512 << 10
	defaultMaxResponseBytes   = 4 << 20
	defaultMaxReceipts        = 2048
	defaultMaxConcurrency     = 4
	defaultRequestTimeout     = 60 * time.Second
)

var (
	ErrInvalidConfiguration = errors.New("campaign image broker IPC: invalid configuration")
	ErrNotReady             = errors.New("campaign image broker IPC: not ready")
	ErrUnavailable          = errors.New("campaign image broker IPC: unavailable")
	ErrProtocol             = errors.New("campaign image broker IPC: invalid protocol")
	ErrUnsafeSocket         = errors.New("campaign image broker IPC: unsafe socket")
	ErrUnauthorizedPeer     = errors.New("campaign image broker IPC: unauthorized peer")
	ErrRemoteFailure        = errors.New("campaign image broker IPC: remote broker failure")

	deploymentIdentityPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,159}$`)
)

// PeerIdentity is the effective Unix uid/gid pair authenticated on a connected
// socket. Both values are explicit because zero is a valid root identity.
type PeerIdentity struct {
	UID uint32
	GID uint32
}

// CurrentProcessIdentity returns the effective identity used by Unix peer
// credential checks and by newly created socket files.
func CurrentProcessIdentity() PeerIdentity {
	return PeerIdentity{UID: uint32(os.Geteuid()), GID: uint32(os.Getegid())}
}

// Limits bounds every allocation and unit of work performed by the IPC layer.
// The underlying broker retains its own stricter acquisition, decode, scan,
// pixel, OCR, and campaign bounds.
type Limits struct {
	MaxHTMLBytes       int
	MaxReviewedSources int
	MaxRequestHeader   int
	MaxResponseBytes   int
	MaxReceipts        int
	MaxConcurrency     int
	RequestTimeout     time.Duration
}

type ClientConfig struct {
	SocketPath          string
	DeploymentIdentity  string
	ExpectedServer      PeerIdentity
	ExpectedSocketOwner PeerIdentity
	Limits              Limits
}

type ServerConfig struct {
	SocketPath         string
	DeploymentIdentity string
	ServerIdentity     PeerIdentity
	SocketOwner        PeerIdentity
	SocketMode         os.FileMode
	AllowedClients     []PeerIdentity
	Limits             Limits
}

func normalizeClientConfig(input ClientConfig) (ClientConfig, error) {
	configuration := input
	if err := validateSocketPath(configuration.SocketPath); err != nil {
		return ClientConfig{}, err
	}
	if !deploymentIdentityPattern.MatchString(configuration.DeploymentIdentity) {
		return ClientConfig{}, fmt.Errorf("%w: exact deployment identity is required", ErrInvalidConfiguration)
	}
	limits, err := normalizeLimits(configuration.Limits)
	if err != nil {
		return ClientConfig{}, err
	}
	configuration.Limits = limits
	return configuration, nil
}

func normalizeServerConfig(input ServerConfig) (ServerConfig, error) {
	configuration := input
	if err := validateSocketPath(configuration.SocketPath); err != nil {
		return ServerConfig{}, err
	}
	if !deploymentIdentityPattern.MatchString(configuration.DeploymentIdentity) {
		return ServerConfig{}, fmt.Errorf("%w: exact deployment identity is required", ErrInvalidConfiguration)
	}
	if configuration.ServerIdentity.UID != configuration.SocketOwner.UID {
		return ServerConfig{}, fmt.Errorf("%w: server and socket owner uid must match", ErrInvalidConfiguration)
	}
	mode := configuration.SocketMode.Perm()
	if configuration.SocketMode != mode || mode != 0o600 && mode != 0o660 {
		return ServerConfig{}, fmt.Errorf("%w: socket mode must be exactly 0600 or 0660", ErrInvalidConfiguration)
	}
	if len(configuration.AllowedClients) < 1 || len(configuration.AllowedClients) > 32 {
		return ServerConfig{}, fmt.Errorf("%w: one to 32 exact client identities are required", ErrInvalidConfiguration)
	}
	seen := make(map[PeerIdentity]struct{}, len(configuration.AllowedClients))
	for _, identity := range configuration.AllowedClients {
		if _, duplicate := seen[identity]; duplicate {
			return ServerConfig{}, fmt.Errorf("%w: duplicate client identity", ErrInvalidConfiguration)
		}
		seen[identity] = struct{}{}
	}
	limits, err := normalizeLimits(configuration.Limits)
	if err != nil {
		return ServerConfig{}, err
	}
	configuration.Limits = limits
	configuration.AllowedClients = append([]PeerIdentity(nil), configuration.AllowedClients...)
	return configuration, nil
}

func normalizeLimits(input Limits) (Limits, error) {
	limits := input
	if limits.MaxHTMLBytes == 0 {
		limits.MaxHTMLBytes = defaultMaxHTMLBytes
	}
	if limits.MaxReviewedSources == 0 {
		limits.MaxReviewedSources = defaultMaxReviewedSources
	}
	if limits.MaxRequestHeader == 0 {
		limits.MaxRequestHeader = defaultMaxRequestHeader
	}
	if limits.MaxResponseBytes == 0 {
		limits.MaxResponseBytes = defaultMaxResponseBytes
	}
	if limits.MaxReceipts == 0 {
		limits.MaxReceipts = defaultMaxReceipts
	}
	if limits.MaxConcurrency == 0 {
		limits.MaxConcurrency = defaultMaxConcurrency
	}
	if limits.RequestTimeout == 0 {
		limits.RequestTimeout = defaultRequestTimeout
	}
	if limits.MaxHTMLBytes < 1 || limits.MaxHTMLBytes > 8<<20 ||
		limits.MaxReviewedSources < 1 || limits.MaxReviewedSources > 512 ||
		limits.MaxRequestHeader < 4<<10 || limits.MaxRequestHeader > 4<<20 ||
		limits.MaxResponseBytes < 4<<10 || limits.MaxResponseBytes > 16<<20 ||
		limits.MaxReceipts < limits.MaxReviewedSources || limits.MaxReceipts > 100_000 ||
		limits.MaxConcurrency < 1 || limits.MaxConcurrency > 64 ||
		limits.RequestTimeout < 100*time.Millisecond || limits.RequestTimeout > 5*time.Minute {
		return Limits{}, fmt.Errorf("%w: IPC limit is outside the reviewed range", ErrInvalidConfiguration)
	}
	return limits, nil
}

func validateSocketPath(value string) error {
	if value == "" || strings.TrimSpace(value) != value || !filepath.IsAbs(value) ||
		filepath.Clean(value) != value || len(value) > 100 || strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("%w: exact absolute Unix socket path is required", ErrInvalidConfiguration)
	}
	return nil
}

func validateSocketParent(path string, owner PeerIdentity) error {
	information, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("%w: socket directory unavailable", ErrUnsafeSocket)
	}
	actualOwner, err := fileIdentity(information)
	if err != nil || !information.IsDir() || information.Mode()&os.ModeSymlink != 0 ||
		information.Mode().Perm()&0o022 != 0 || actualOwner.UID != owner.UID {
		return fmt.Errorf("%w: socket directory owner or permissions", ErrUnsafeSocket)
	}
	return nil
}
