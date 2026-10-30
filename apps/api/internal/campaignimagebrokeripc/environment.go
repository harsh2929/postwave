// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokeripc

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	SocketEnvironmentKey             = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_UNIX_SOCKET"
	DeploymentIdentityEnvironmentKey = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_DEPLOYMENT_IDENTITY"
	ServerUIDEnvironmentKey          = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_SERVER_UID"
	ServerGIDEnvironmentKey          = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_SERVER_GID"
	SocketUIDEnvironmentKey          = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_SOCKET_UID"
	SocketGIDEnvironmentKey          = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_SOCKET_GID"
	SocketModeEnvironmentKey         = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_SOCKET_MODE"
	AllowedClientsEnvironmentKey     = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_ALLOWED_CLIENT_PEERS"
	MaxHTMLBytesEnvironmentKey       = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_HTML_BYTES"
	MaxSourcesEnvironmentKey         = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_REVIEWED_SOURCES"
	MaxRequestHeaderEnvironmentKey   = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_REQUEST_HEADER_BYTES"
	MaxResponseEnvironmentKey        = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_RESPONSE_BYTES"
	MaxReceiptsEnvironmentKey        = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_RECEIPTS"
	MaxConcurrencyEnvironmentKey     = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_MAX_CONCURRENCY"
	RequestTimeoutEnvironmentKey     = "POSTWAVE_CAMPAIGN_IMAGE_BROKER_IPC_REQUEST_TIMEOUT"
)

// ServerConfigFromEnvironment parses the broker-process half of the boundary.
// Identity and permission values are mandatory and exact; limits are optional
// and use reviewed defaults only when absent.
func ServerConfigFromEnvironment(getenv func(string) string) (ServerConfig, error) {
	if getenv == nil {
		return ServerConfig{}, fmt.Errorf("%w: environment reader is required", ErrInvalidConfiguration)
	}
	serverIdentity, err := parseEnvironmentPeer(getenv, ServerUIDEnvironmentKey, ServerGIDEnvironmentKey)
	if err != nil {
		return ServerConfig{}, err
	}
	socketOwner, err := parseEnvironmentPeer(getenv, SocketUIDEnvironmentKey, SocketGIDEnvironmentKey)
	if err != nil {
		return ServerConfig{}, err
	}
	mode, err := parseSocketMode(getenv(SocketModeEnvironmentKey))
	if err != nil {
		return ServerConfig{}, err
	}
	allowed, err := parseAllowedPeers(getenv(AllowedClientsEnvironmentKey))
	if err != nil {
		return ServerConfig{}, err
	}
	limits, err := limitsFromEnvironment(getenv)
	if err != nil {
		return ServerConfig{}, err
	}
	return normalizeServerConfig(ServerConfig{
		SocketPath: getenv(SocketEnvironmentKey), DeploymentIdentity: getenv(DeploymentIdentityEnvironmentKey),
		ServerIdentity: serverIdentity, SocketOwner: socketOwner, SocketMode: mode,
		AllowedClients: allowed, Limits: limits,
	})
}

// ClientConfigFromEnvironment parses the socket-only caller half. It uses the
// same exact server and socket identities as the broker process configuration;
// it does not expose or accept any in-process Inspector fallback.
func ClientConfigFromEnvironment(getenv func(string) string) (ClientConfig, error) {
	if getenv == nil {
		return ClientConfig{}, fmt.Errorf("%w: environment reader is required", ErrInvalidConfiguration)
	}
	serverIdentity, err := parseEnvironmentPeer(getenv, ServerUIDEnvironmentKey, ServerGIDEnvironmentKey)
	if err != nil {
		return ClientConfig{}, err
	}
	socketOwner, err := parseEnvironmentPeer(getenv, SocketUIDEnvironmentKey, SocketGIDEnvironmentKey)
	if err != nil {
		return ClientConfig{}, err
	}
	limits, err := limitsFromEnvironment(getenv)
	if err != nil {
		return ClientConfig{}, err
	}
	return normalizeClientConfig(ClientConfig{
		SocketPath: getenv(SocketEnvironmentKey), DeploymentIdentity: getenv(DeploymentIdentityEnvironmentKey),
		ExpectedServer: serverIdentity, ExpectedSocketOwner: socketOwner, Limits: limits,
	})
}

func NewClientFromEnvironment(getenv func(string) string) (*Client, error) {
	configuration, err := ClientConfigFromEnvironment(getenv)
	if err != nil {
		return nil, err
	}
	return NewClient(configuration)
}

func limitsFromEnvironment(getenv func(string) string) (Limits, error) {
	keys := []string{
		MaxHTMLBytesEnvironmentKey, MaxSourcesEnvironmentKey, MaxRequestHeaderEnvironmentKey,
		MaxResponseEnvironmentKey, MaxReceiptsEnvironmentKey, MaxConcurrencyEnvironmentKey,
	}
	values := make([]int, len(keys))
	for index, key := range keys {
		value, err := parseOptionalInt(getenv(key), key)
		if err != nil {
			return Limits{}, err
		}
		values[index] = value
	}
	var timeout time.Duration
	if raw := getenv(RequestTimeoutEnvironmentKey); raw != "" {
		if strings.TrimSpace(raw) != raw {
			return Limits{}, fmt.Errorf("%w: %s must not contain whitespace", ErrInvalidConfiguration, RequestTimeoutEnvironmentKey)
		}
		parsed, err := time.ParseDuration(raw)
		if err != nil {
			return Limits{}, fmt.Errorf("%w: invalid %s", ErrInvalidConfiguration, RequestTimeoutEnvironmentKey)
		}
		timeout = parsed
	}
	return normalizeLimits(Limits{
		MaxHTMLBytes: values[0], MaxReviewedSources: values[1], MaxRequestHeader: values[2],
		MaxResponseBytes: values[3], MaxReceipts: values[4], MaxConcurrency: values[5],
		RequestTimeout: timeout,
	})
}

func parseEnvironmentPeer(getenv func(string) string, uidKey, gidKey string) (PeerIdentity, error) {
	uid, err := parseRequiredUint32(getenv(uidKey), uidKey)
	if err != nil {
		return PeerIdentity{}, err
	}
	gid, err := parseRequiredUint32(getenv(gidKey), gidKey)
	if err != nil {
		return PeerIdentity{}, err
	}
	return PeerIdentity{UID: uid, GID: gid}, nil
}

func parseAllowedPeers(raw string) ([]PeerIdentity, error) {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return nil, fmt.Errorf("%w: %s is required without whitespace", ErrInvalidConfiguration, AllowedClientsEnvironmentKey)
	}
	parts := strings.Split(raw, ",")
	peers := make([]PeerIdentity, 0, len(parts))
	for _, part := range parts {
		identityParts := strings.Split(part, ":")
		if len(identityParts) != 2 {
			return nil, fmt.Errorf("%w: invalid client peer identity", ErrInvalidConfiguration)
		}
		uid, err := parseRequiredUint32(identityParts[0], AllowedClientsEnvironmentKey)
		if err != nil {
			return nil, err
		}
		gid, err := parseRequiredUint32(identityParts[1], AllowedClientsEnvironmentKey)
		if err != nil {
			return nil, err
		}
		peers = append(peers, PeerIdentity{UID: uid, GID: gid})
	}
	return peers, nil
}

func parseRequiredUint32(raw, key string) (uint32, error) {
	parsed, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || strconv.FormatUint(parsed, 10) != raw {
		return 0, fmt.Errorf("%w: %s must be a canonical uint32", ErrInvalidConfiguration, key)
	}
	return uint32(parsed), nil
}

func parseOptionalInt(raw, key string) (int, error) {
	if raw == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseUint(raw, 10, 31)
	if err != nil || parsed == 0 || strconv.FormatUint(parsed, 10) != raw {
		return 0, fmt.Errorf("%w: %s must be a canonical positive integer", ErrInvalidConfiguration, key)
	}
	return int(parsed), nil
}

func parseSocketMode(raw string) (os.FileMode, error) {
	switch raw {
	case "0600":
		return 0o600, nil
	case "0660":
		return 0o660, nil
	default:
		return 0, fmt.Errorf("%w: %s must be exactly 0600 or 0660", ErrInvalidConfiguration, SocketModeEnvironmentKey)
	}
}
