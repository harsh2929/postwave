// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignassurancemodelsandbox is the data-only process boundary
// between the Campaign Assurance orchestrator and a modeled-comprehension
// process. That no-network process relays through a second Unix-only boundary
// to a credentialed provider-egress gateway.
//
// The client deliberately has no credential, HTTP, repository, object-store,
// browser, tool, or action field. The model sandbox has a fail-closed network
// isolation contract; its production Linux enforcer applies a process-wide
// seccomp/no-new-privileges filter that denies AF_INET and AF_INET6 while
// retaining AF_UNIX. Provider credentials and HTTP exist only in the separate
// provider-gateway command, never in the API or no-network sandbox command.
package campaignassurancemodelsandbox

import (
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

const (
	ProtocolVersion        = "postwave.campaign-assurance-model-sandbox-ipc.v1"
	ServiceID              = "postwave.campaign-assurance-model-sandbox"
	ServiceVersion         = "v1"
	GatewayProtocolVersion = "postwave.campaign-assurance-provider-gateway-ipc.v1"
	GatewayServiceID       = "postwave.campaign-assurance-provider-gateway"
	GatewayServiceVersion  = "v1"

	InputDispositionQuotedUntrusted = "quoted_untrusted_email_data"
	CapabilityProfileDataOnly       = "postwave.modeled-comprehension.data-only.v1"
	NetworkIsolationAFDenied        = "linux_seccomp_af_inet_af_inet6_denied"
	GatewayProviderEgress           = "fixed_reviewed_provider_adapter"

	defaultTimeout       = 65 * time.Second
	maximumTimeout       = 5 * time.Minute
	defaultDialAttempts  = 2
	maximumDialAttempts  = 3
	defaultRequestBytes  = 8 << 20
	maximumRequestBytes  = 12 << 20
	defaultResponseBytes = 256 << 10
	maximumResponseBytes = 512 << 10
	defaultConcurrency   = 4
	maximumConcurrency   = 32

	maximumProtocolTextBytes = 256
	maximumEvidenceItems     = 4096
	maximumFactSlots         = 1024
)

var (
	ErrInvalidConfiguration  = errors.New("campaign assurance model sandbox: invalid configuration")
	ErrNotReady              = errors.New("campaign assurance model sandbox: not ready")
	ErrUnsafeSocket          = errors.New("campaign assurance model sandbox: unsafe Unix-domain socket")
	ErrPeerUnauthorized      = errors.New("campaign assurance model sandbox: Unix peer is not authorized")
	ErrProtocol              = errors.New("campaign assurance model sandbox: invalid IPC protocol")
	ErrRequestRejected       = errors.New("campaign assurance model sandbox: request rejected")
	ErrOutputRejected        = errors.New("campaign assurance model sandbox: output rejected")
	ErrApplicationCredential = errors.New(
		"campaign assurance model sandbox: application credential environment is forbidden",
	)
)

// ClientConfig contains only transport policy and the public executor
// identity. There is intentionally nowhere to put a provider credential or an
// HTTP client. ExpectedServerUID defaults to the caller's effective UID.
type ClientConfig struct {
	SocketPath        string
	ExpectedServerUID int
	ExpectedIdentity  campaignassuranceworker.ModelExecutorIdentity
	Timeout           time.Duration
	DialAttempts      int
	MaxRequestBytes   int
	MaxResponseBytes  int
}

// ProviderGatewayClientConfig configures the Unix-only hop from the
// no-network sandbox to the credentialed provider gateway.
type ProviderGatewayClientConfig = ClientConfig

// ServerConfig is process-local policy. Executor is injected by the dedicated
// sandbox command; the protocol never accepts a provider endpoint, credential,
// tool declaration, callback, or executable action from a caller.
type ServerConfig struct {
	SocketPath       string
	SocketMode       os.FileMode
	AllowedClientUID int
	Executor         campaignassuranceworker.ModelExecutor
	NetworkIsolation NetworkIsolationEnforcer
	CallTimeout      time.Duration
	MaxRequestBytes  int
	MaxResponseBytes int
	MaxConcurrent    int
}

// ProviderGatewayServerConfig is intentionally separate from ServerConfig:
// the provider gateway needs reviewed provider egress and therefore cannot
// accept or advertise the model sandbox's no-network attestation.
type ProviderGatewayServerConfig struct {
	SocketPath       string
	SocketMode       os.FileMode
	AllowedClientUID int
	Executor         campaignassuranceworker.ModelExecutor
	CallTimeout      time.Duration
	MaxRequestBytes  int
	MaxResponseBytes int
	MaxConcurrent    int
}

type wireEnvelope struct {
	Protocol  string          `json:"protocol"`
	Operation string          `json:"operation"`
	RequestID string          `json:"request_id"`
	Input     *wireModelInput `json:"input,omitempty"`
	InputHash string          `json:"input_sha256,omitempty"`
}

// wireModelInput is intentionally smaller than ModelRequest. Tenant, run,
// campaign, storage, and other application identities never cross the model
// process boundary because the reviewed provider adapter does not need them.
// The fields below are inert quoted data and frozen analysis metadata only.
type wireModelInput struct {
	Disposition        string                                         `json:"input_disposition"`
	InvocationID       string                                         `json:"invocation_id"`
	InputManifestHash  string                                         `json:"input_manifest_hash"`
	OutboundMIMEHash   string                                         `json:"outbound_mime_hash"`
	Configuration      campaignassuranceworker.ModeledConfigurationV1 `json:"configuration"`
	Vocabulary         campaignassuranceworker.RecoveryVocabularyV1   `json:"recovery_vocabulary"`
	Evidence           []campaignassuranceworker.ModelEvidence        `json:"evidence"`
	AllowedEvidenceIDs []string                                       `json:"allowed_evidence_ids"`
	ExtractionSchema   json.RawMessage                                `json:"extraction_schema"`
	MaxOutputBytes     int                                            `json:"max_output_bytes"`
	SummaryRun         int                                            `json:"summary_run,omitempty"`
	QuotedArtifact     wireQuotedArtifact                             `json:"quoted_untrusted_artifact"`
}

// wireQuotedArtifact has no URL-to-fetch or callback field. URLs that happen
// to appear inside email text/HTML/MIME remain inert untrusted content.
type wireQuotedArtifact struct {
	Subject        string          `json:"subject"`
	HTML           string          `json:"html"`
	PlainText      string          `json:"plain_text"`
	StructuredData json.RawMessage `json:"structured_data,omitempty"`
	RFC822         []byte          `json:"rfc822"`
}

type wireCapabilities struct {
	Profile                string `json:"profile"`
	Database               bool   `json:"database"`
	ObjectStorage          bool   `json:"object_storage"`
	Mailbox                bool   `json:"mailbox"`
	OutboundDelivery       bool   `json:"outbound_delivery"`
	Actions                bool   `json:"actions"`
	Browser                bool   `json:"browser"`
	Tools                  bool   `json:"tools"`
	Shell                  bool   `json:"shell"`
	URLFetch               bool   `json:"url_fetch"`
	ApplicationCredentials bool   `json:"application_credentials"`
	ProviderCredential     string `json:"provider_credential_scope"`
	NetworkIsolation       string `json:"os_network_isolation"`
	ProviderEgress         string `json:"provider_egress"`
}

type wireFailure struct {
	Code string                                   `json:"code"`
	Kind campaignassuranceworker.ModelFailureKind `json:"kind"`
}

type wireResponse struct {
	Protocol       string                                        `json:"protocol"`
	Operation      string                                        `json:"operation"`
	RequestID      string                                        `json:"request_id"`
	Status         string                                        `json:"status"`
	ServiceID      string                                        `json:"service_id"`
	ServiceVersion string                                        `json:"service_version"`
	Identity       campaignassuranceworker.ModelExecutorIdentity `json:"executor_identity"`
	Capabilities   *wireCapabilities                             `json:"capabilities,omitempty"`
	Result         *campaignassuranceworker.ModelResult          `json:"result,omitempty"`
	Failure        *wireFailure                                  `json:"failure,omitempty"`
}

func fixedCapabilities() wireCapabilities {
	return wireCapabilities{
		Profile: CapabilityProfileDataOnly,
		// These are protocol/application-capability assertions, enforced by
		// the absence of such interfaces from ServerConfig and wireModelInput.
		Database: false, ObjectStorage: false, Mailbox: false,
		OutboundDelivery: false, Actions: false, Browser: false,
		Tools: false, Shell: false, URLFetch: false,
		ApplicationCredentials: false,
		ProviderCredential:     "none",
		NetworkIsolation:       NetworkIsolationAFDenied,
		ProviderEgress:         "none",
	}
}

func gatewayCapabilities() wireCapabilities {
	return wireCapabilities{
		Profile:  "postwave.modeled-comprehension.provider-gateway.v1",
		Database: false, ObjectStorage: false, Mailbox: false,
		OutboundDelivery: false, Actions: false, Browser: false,
		Tools: false, Shell: false, URLFetch: false,
		ApplicationCredentials: false,
		ProviderCredential:     "gateway_process_only",
		// The gateway intentionally has reviewed provider egress. It makes no
		// false no-network assertion; the no-network claim belongs only to the
		// upstream model sandbox.
		NetworkIsolation: "not_applicable_provider_gateway",
		ProviderEgress:   GatewayProviderEgress,
	}
}
