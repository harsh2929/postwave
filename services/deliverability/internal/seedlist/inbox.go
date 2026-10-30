// Package seedlist owns the controlled-mailbox registry and the IMAP poller
// that classifies inbound test emails into Primary/Promotions/Spam buckets.
//
// Layer 1 of the five-layer deliverability stack.
package seedlist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Status reflects the operational health of a seedlist inbox.
type Status string

const (
	StatusActive  Status = "active"
	StatusFlagged Status = "flagged"
	StatusBanned  Status = "banned"

	maxSeedlistConfigBytes int64 = 1 << 20
)

// Inbox is one mailbox in the seedlist. The IMAP password is *never* stored
// in this struct — only the name of the env var that holds it. Resolution
// happens at IMAP-connect time via Password().
type Inbox struct {
	ID       string          `json:"id" yaml:"id"`
	Provider domain.Provider `json:"provider" yaml:"provider"`
	// Address and IMAPUser remain runtime fields for compatibility with the
	// existing connector. Durable registry publication requires their secret
	// references and never persists these resolved values.
	Address               string `json:"address,omitempty" yaml:"address,omitempty"`
	AddressSecretRef      string `json:"address_secret_ref,omitempty" yaml:"address_secret_ref,omitempty"`
	IMAPHost              string `json:"imap_host" yaml:"imap_host"`
	IMAPPort              int    `json:"imap_port" yaml:"imap_port"`
	IMAPUser              string `json:"imap_user,omitempty" yaml:"imap_user,omitempty"`
	IMAPUserSecretRef     string `json:"imap_user_secret_ref,omitempty" yaml:"imap_user_secret_ref,omitempty"`
	IMAPPasswordEnv       string `json:"imap_password_env,omitempty" yaml:"imap_password_env,omitempty"`
	IMAPPasswordSecretRef string `json:"imap_password_secret_ref,omitempty" yaml:"imap_password_secret_ref,omitempty"`

	Client        string         `json:"client,omitempty" yaml:"client,omitempty"`
	Device        string         `json:"device,omitempty" yaml:"device,omitempty"`
	AccountTier   string         `json:"account_tier,omitempty" yaml:"account_tier,omitempty"`
	Region        string         `json:"region,omitempty" yaml:"region,omitempty"`
	Locale        string         `json:"locale,omitempty" yaml:"locale,omitempty"`
	Timezone      string         `json:"timezone,omitempty" yaml:"timezone,omitempty"`
	Language      string         `json:"language,omitempty" yaml:"language,omitempty"`
	MPPEnabled    *bool          `json:"mpp_enabled,omitempty" yaml:"mpp_enabled,omitempty"`
	SmartFeatures map[string]any `json:"smart_features,omitempty" yaml:"smart_features,omitempty"`
	WarmupState   string         `json:"warmup_state,omitempty" yaml:"warmup_state,omitempty"`
	HealthState   string         `json:"health_state,omitempty" yaml:"health_state,omitempty"`

	Status            Status    `json:"status" yaml:"status"`
	LastCheckedAt     time.Time `json:"-" yaml:"-"`
	LastHealthAt      time.Time `json:"-" yaml:"-"`
	RegistryVersionID string    `json:"-" yaml:"-"`

	resolvedIMAPPassword string
}

// Password resolves the IMAP password from the env var named in the YAML.
// It is intentionally a method (not a field) so the secret is never logged
// alongside the inbox struct.
func (i Inbox) Password() string {
	if i.resolvedIMAPPassword != "" {
		return i.resolvedIMAPPassword
	}
	if i.IMAPPasswordEnv == "" {
		return ""
	}
	return os.Getenv(i.IMAPPasswordEnv)
}

// Registry is an in-memory store of seedlist inboxes.
type Registry struct {
	mu       sync.RWMutex
	inboxes  map[string]*Inbox
	resolver SecretResolver
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return NewRegistryWithSecretResolver(EnvironmentSecretResolver{})
}

// NewRegistryWithSecretResolver keeps secret resolution at the registry
// boundary. The default resolver supports env: and env:// references; other
// secret managers can be injected without changing the connector contract.
func NewRegistryWithSecretResolver(resolver SecretResolver) *Registry {
	if resolver == nil {
		resolver = EnvironmentSecretResolver{}
	}
	return &Registry{inboxes: make(map[string]*Inbox), resolver: resolver}
}

// Load parses a YAML config file and loads its inboxes into the registry.
func (r *Registry) Load(path string) error {
	b, err := readFileLimited(path, maxSeedlistConfigBytes)
	if err != nil {
		return fmt.Errorf("seedlist: read %s: %w", path, err)
	}
	if strings.EqualFold(filepath.Ext(path), ".json") {
		if err := r.LoadJSONBytes(b); err != nil {
			return fmt.Errorf("seedlist: parse %s: %w", path, err)
		}
		return nil
	}
	var doc struct {
		Inboxes []Inbox `yaml:"inboxes"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		return fmt.Errorf("seedlist: parse %s: %w", path, err)
	}
	return r.replace(doc.Inboxes)
}

func readFileLimited(path string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxBytes)
	}
	return b, nil
}

// LoadJSON parses an inline JSON seedlist document, usually from
// POSTWAVE_SEEDLIST_IMAP_JSON. Shape:
//
//	{"inboxes":[{"id":"gmail-001","provider":"gmail",...}]}
func (r *Registry) LoadJSON(raw string) error {
	return r.LoadJSONBytes([]byte(raw))
}

// LoadJSONBytes parses a JSON seedlist document.
func (r *Registry) LoadJSONBytes(b []byte) error {
	var doc struct {
		Inboxes []Inbox `json:"inboxes"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return err
	}
	return r.replace(doc.Inboxes)
}

func (r *Registry) replace(inboxes []Inbox) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make(map[string]*Inbox, len(inboxes))
	for _, in := range inboxes {
		i := in
		if err := r.resolveRuntimeSecrets(context.Background(), &i); err != nil {
			return err
		}
		if i.Status == "" {
			i.Status = StatusActive
		}
		applyMetadataDefaults(&i)
		if strings.TrimSpace(i.ID) == "" {
			return errors.New("seedlist: inbox id is required")
		}
		if strings.TrimSpace(i.Address) == "" {
			return fmt.Errorf("seedlist: inbox %s address is required", i.ID)
		}
		if strings.TrimSpace(string(i.Provider)) == "" {
			return fmt.Errorf("seedlist: inbox %s provider is required", i.ID)
		}
		if err := validateMetadata(i); err != nil {
			return fmt.Errorf("seedlist: inbox %s: %w", i.ID, err)
		}
		if _, exists := next[i.ID]; exists {
			return fmt.Errorf("seedlist: duplicate inbox id %s", i.ID)
		}
		next[i.ID] = &i
	}
	r.inboxes = next
	return nil
}

// All returns a snapshot of all inboxes.
func (r *Registry) All() []*Inbox {
	return r.Snapshot()
}

// Snapshot returns deep copies so callers cannot mix a registry publication
// with concurrent in-place status changes.
func (r *Registry) Snapshot() []*Inbox {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Inbox, 0, len(r.inboxes))
	for _, i := range r.inboxes {
		copy := cloneInbox(i)
		out = append(out, &copy)
	}
	return out
}

// Get returns a single inbox by ID.
func (r *Registry) Get(id string) (*Inbox, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	i, ok := r.inboxes[id]
	if !ok {
		return nil, false
	}
	copy := cloneInbox(i)
	return &copy, true
}

// SetStatus updates an inbox's operational status (e.g. flagged, banned).
func (r *Registry) SetStatus(id string, s Status) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	i, ok := r.inboxes[id]
	if !ok {
		return errors.New("seedlist: unknown inbox id")
	}
	i.Status = s
	return nil
}

// BindPublishedVersions attaches immutable database revision identities to the
// current in-memory entries without changing their configuration authority.
func (r *Registry) BindPublishedVersions(versionIDs map[string]string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, versionID := range versionIDs {
		inbox, ok := r.inboxes[id]
		if !ok {
			return fmt.Errorf("seedlist: cannot bind version for unknown inbox %s", id)
		}
		inbox.RegistryVersionID = strings.TrimSpace(versionID)
	}
	return nil
}

func (r *Registry) resolveRuntimeSecrets(ctx context.Context, inbox *Inbox) error {
	if inbox == nil {
		return errors.New("seedlist: inbox is nil")
	}
	if strings.TrimSpace(inbox.AddressSecretRef) != "" {
		if strings.TrimSpace(inbox.Address) != "" {
			return fmt.Errorf("seedlist: inbox %s declares both address and address_secret_ref", inbox.ID)
		}
		value, err := r.resolver.Resolve(ctx, inbox.AddressSecretRef)
		if err != nil {
			return fmt.Errorf("seedlist: inbox %s resolve address secret: %w", inbox.ID, err)
		}
		inbox.Address = strings.TrimSpace(value)
	}
	if strings.TrimSpace(inbox.IMAPUserSecretRef) != "" {
		if strings.TrimSpace(inbox.IMAPUser) != "" {
			return fmt.Errorf("seedlist: inbox %s declares both imap_user and imap_user_secret_ref", inbox.ID)
		}
		value, err := r.resolver.Resolve(ctx, inbox.IMAPUserSecretRef)
		if err != nil {
			return fmt.Errorf("seedlist: inbox %s resolve IMAP username secret: %w", inbox.ID, err)
		}
		inbox.IMAPUser = strings.TrimSpace(value)
	}
	if strings.TrimSpace(inbox.IMAPPasswordSecretRef) != "" {
		if strings.TrimSpace(inbox.IMAPPasswordEnv) != "" {
			return fmt.Errorf("seedlist: inbox %s declares both imap_password_env and imap_password_secret_ref", inbox.ID)
		}
		value, err := r.resolver.Resolve(ctx, inbox.IMAPPasswordSecretRef)
		if err != nil {
			return fmt.Errorf("seedlist: inbox %s resolve IMAP password secret: %w", inbox.ID, err)
		}
		inbox.resolvedIMAPPassword = value
	} else if strings.TrimSpace(inbox.IMAPPasswordEnv) != "" {
		// Preserve the legacy environment indirection as an explicit reference
		// when the rest of the document is upgraded for durable publication.
		inbox.IMAPPasswordSecretRef = "env:" + strings.TrimSpace(inbox.IMAPPasswordEnv)
	}
	return nil
}

func applyMetadataDefaults(inbox *Inbox) {
	defaults := []*string{&inbox.Client, &inbox.Device, &inbox.AccountTier, &inbox.Region}
	for _, field := range defaults {
		if strings.TrimSpace(*field) == "" {
			*field = "unknown"
		}
	}
	if strings.TrimSpace(inbox.Locale) == "" {
		inbox.Locale = "und"
	}
	if strings.TrimSpace(inbox.Timezone) == "" {
		inbox.Timezone = "UTC"
	}
	if strings.TrimSpace(inbox.Language) == "" {
		inbox.Language = "und"
	}
	if strings.TrimSpace(inbox.WarmupState) == "" {
		inbox.WarmupState = "unknown"
	}
	if strings.TrimSpace(inbox.HealthState) == "" {
		inbox.HealthState = "unknown"
	}
	if inbox.SmartFeatures == nil {
		inbox.SmartFeatures = map[string]any{}
	}
}

func validateMetadata(inbox Inbox) error {
	for label, value := range map[string]string{
		"client": inbox.Client, "device": inbox.Device, "account_tier": inbox.AccountTier,
		"region": inbox.Region, "locale": inbox.Locale, "timezone": inbox.Timezone,
		"language": inbox.Language,
	} {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 120 || strings.ContainsAny(value, "\x00\r\n") {
			return fmt.Errorf("invalid %s", label)
		}
	}
	if _, err := time.LoadLocation(inbox.Timezone); err != nil {
		return errors.New("invalid timezone")
	}
	if inbox.WarmupState != "unknown" && inbox.WarmupState != "cold" &&
		inbox.WarmupState != "warming" && inbox.WarmupState != "ready" && inbox.WarmupState != "paused" {
		return errors.New("invalid warmup_state")
	}
	if inbox.HealthState != "unknown" && inbox.HealthState != "healthy" &&
		inbox.HealthState != "degraded" && inbox.HealthState != "unhealthy" {
		return errors.New("invalid health_state")
	}
	return nil
}

func cloneInbox(inbox *Inbox) Inbox {
	if inbox == nil {
		return Inbox{}
	}
	copy := *inbox
	if inbox.MPPEnabled != nil {
		value := *inbox.MPPEnabled
		copy.MPPEnabled = &value
	}
	if inbox.SmartFeatures != nil {
		copy.SmartFeatures = make(map[string]any, len(inbox.SmartFeatures))
		for key, value := range inbox.SmartFeatures {
			copy.SmartFeatures[key] = value
		}
	}
	return copy
}
