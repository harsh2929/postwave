// Package listmonk is the WRITE side of the migration pipeline.
//
// It speaks to a running Listmonk admin HTTP API to materialise canonical
// resources (subscribers, lists, segments-as-SQL templates, archived
// campaigns). Per LICENSE-BOUNDARY.md this package MUST NOT import any
// `github.com/postwave/listmonk/...` or `github.com/knadh/listmonk/...`
// package — only HTTP. A CI grep enforces the rule.
package listmonk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
)

const (
	listmonkErrorResponseMaxBytes int64 = 64 << 10
	listmonkJSONResponseMaxBytes  int64 = 8 << 20
)

// Client is a typed wrapper around Listmonk's admin HTTP API.
type Client struct {
	BaseURL    string
	AdminUser  string
	AdminPass  string
	HTTPClient *http.Client

	// TenantID scopes subscriber ownership when one Listmonk installation is
	// shared by multiple Moosewave tenants. New subscribers are stamped with
	// postwave_tenant_id and conflict updates fail closed unless the existing
	// row carries the same owner. DedicatedTenant permits claiming legacy rows
	// that predate the ownership attribute and must only be enabled when this
	// client points at a tenant-dedicated Listmonk installation.
	TenantID          string
	DedicatedTenant   bool
	DedicatedTenantID string
	DestinationID     string
	EndpointHash      string

	// reconciliationInventory is shared by shallow tenant-bound copies. It
	// snapshots the create-only resource inventories once, so importing N
	// source lists/templates does not scan the entire destination N times.
	// Exact matches are still re-read by ID before ownership is trusted.
	reconciliationInventory *reconciliationInventory
}

func NewClientForDestination(route tenantengine.Route) *Client {
	return &Client{BaseURL: route.BaseURL, AdminUser: route.AdminUser, AdminPass: route.AdminPassword,
		TenantID: route.TenantID, DedicatedTenant: true, DedicatedTenantID: route.TenantID,
		DestinationID: route.DestinationID, EndpointHash: route.EndpointHash(),
		HTTPClient: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// ForTenant returns a shallow client copy bound to one Moosewave tenant. The
// underlying HTTP client and credentials remain shared; ownership checks are
// performed on every subscriber conflict update.
func (c *Client) ForTenant(tenantID string) *Client {
	if c == nil {
		return nil
	}
	// Initialize before the shallow copy so all tenant-bound views share one
	// bounded reconciliation inventory instead of rescanning per resource.
	inventory := c.resourceReconciliationInventory()
	cp := *c
	cp.TenantID = strings.TrimSpace(tenantID)
	cp.reconciliationInventory = inventory
	return &cp
}

// ValidateMigrationIsolation verifies that a migration can represent the same
// email independently for multiple Moosewave tenants. Listmonk enforces global
// email uniqueness per installation, so full-fidelity migration commits
// require an explicitly tenant-dedicated destination.
func (c *Client) ValidateMigrationIsolation(tenantID string) error {
	if c == nil {
		return fmt.Errorf("Listmonk client is not configured")
	}
	if strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("Moosewave tenant id is required for Listmonk writes")
	}
	if !c.DedicatedTenant {
		return fmt.Errorf("Listmonk destination is not tenant-dedicated; configure a per-tenant instance and set LISTMONK_TENANT_MODE=dedicated plus LISTMONK_DEDICATED_TENANT_ID before migration commit (shared Listmonk cannot isolate duplicate emails across tenants)")
	}
	if strings.TrimSpace(c.DedicatedTenantID) == "" {
		return fmt.Errorf("LISTMONK_DEDICATED_TENANT_ID is required to bind the dedicated Listmonk destination to its Moosewave tenant")
	}
	if c.DedicatedTenantID != strings.TrimSpace(tenantID) {
		return fmt.Errorf("dedicated Listmonk destination is bound to tenant %q, not requested tenant %q", c.DedicatedTenantID, tenantID)
	}
	return nil
}

// SecretsResolver is the surface NewClientFromResolver consumes to look
// up Listmonk admin credentials. AWS Secrets Manager + env-fallback
// implementations live in services/migration/main.go; tests can pass a
// trivial in-memory fake.
//
// GetJSON unmarshals the named secret's payload into dst. ErrNotFound
// (matched via errors.Is) signals "fall back to env vars".
type SecretsResolver interface {
	GetJSON(ctx context.Context, name string, dst any) error
}

// ErrSecretNotFound is the canonical "secret missing" sentinel callers
// can return from a SecretsResolver. NewClientFromResolver matches it
// via errors.Is so the env fallback fires for both "no secret" and
// "wrong shape JSON" — keeping dev unbroken when the secret store is
// not configured at all.
var ErrSecretNotFound = errors.New("listmonk: secret not found")

// listmonkCreds is the JSON shape stored in Secrets Manager under
// $POSTWAVE_LISTMONK_SECRET_NAME (default "postwave/listmonk"). All
// three fields are required when the secret exists.
type listmonkCreds struct {
	AdminUser     string `json:"admin_user"`
	AdminPassword string `json:"admin_password"`
	BaseURL       string `json:"base_url"`
}

// NewClientFromEnv reads LISTMONK_URL, LISTMONK_ADMIN_USER, and
// LISTMONK_ADMIN_PASSWORD from the environment. Kept for backward-
// compat with tests that don't want a Resolver.
func NewClientFromEnv() (*Client, error) {
	base := strings.TrimRight(os.Getenv("LISTMONK_URL"), "/")
	if base == "" {
		return nil, fmt.Errorf("listmonk: LISTMONK_URL not set")
	}
	user := os.Getenv("LISTMONK_ADMIN_USER")
	pass := os.Getenv("LISTMONK_ADMIN_PASSWORD")
	if user == "" || pass == "" {
		return nil, fmt.Errorf("listmonk: LISTMONK_ADMIN_USER/PASSWORD not set")
	}
	return &Client{
		BaseURL:           base,
		AdminUser:         user,
		AdminPass:         pass,
		HTTPClient:        &http.Client{Timeout: 60 * time.Second},
		DedicatedTenant:   strings.EqualFold(strings.TrimSpace(os.Getenv("LISTMONK_TENANT_MODE")), "dedicated"),
		DedicatedTenantID: strings.TrimSpace(os.Getenv("LISTMONK_DEDICATED_TENANT_ID")),
	}, nil
}

// NewClientFromResolver pulls Listmonk admin creds from a SecretsResolver
// (AWS Secrets Manager in prod). On ErrSecretNotFound it falls back to
// the env-var path so dev remains unbroken when no secret is wired.
//
// The secret-name override comes from the env (POSTWAVE_LISTMONK_SECRET_NAME),
// not the function args — the resolver is always per-process so the name
// is too. Default is "postwave/listmonk".
func NewClientFromResolver(ctx context.Context, r SecretsResolver) (*Client, error) {
	if r == nil {
		return NewClientFromEnv()
	}
	name := os.Getenv("POSTWAVE_LISTMONK_SECRET_NAME")
	if name == "" {
		name = "postwave/listmonk"
	}
	var creds listmonkCreds
	err := r.GetJSON(ctx, name, &creds)
	if err != nil {
		// Fall back to env on missing secret. Other errors (network,
		// permission denied) propagate so a misconfigured prod env
		// doesn't silently degrade to env-vars.
		if errors.Is(err, ErrSecretNotFound) {
			return NewClientFromEnv()
		}
		return nil, fmt.Errorf("listmonk: resolve creds via secrets: %w", err)
	}
	if creds.AdminUser == "" || creds.AdminPassword == "" {
		return nil, fmt.Errorf("listmonk: secret %q missing admin_user/admin_password", name)
	}
	base := strings.TrimRight(creds.BaseURL, "/")
	if base == "" {
		base = strings.TrimRight(os.Getenv("LISTMONK_URL"), "/")
	}
	if base == "" {
		return nil, fmt.Errorf("listmonk: secret %q has no base_url and LISTMONK_URL unset", name)
	}
	return &Client{
		BaseURL:           base,
		AdminUser:         creds.AdminUser,
		AdminPass:         creds.AdminPassword,
		HTTPClient:        &http.Client{Timeout: 60 * time.Second},
		DedicatedTenant:   strings.EqualFold(strings.TrimSpace(os.Getenv("LISTMONK_TENANT_MODE")), "dedicated"),
		DedicatedTenantID: strings.TrimSpace(os.Getenv("LISTMONK_DEDICATED_TENANT_ID")),
	}, nil
}

// SubscriberPayload mirrors POST /api/subscribers.
type SubscriberPayload struct {
	Email                    string                              `json:"email"`
	Name                     string                              `json:"name"`
	Status                   string                              `json:"status"` // enabled | disabled | blocklisted
	Lists                    []int                               `json:"lists,omitempty"`
	Tags                     []string                            `json:"tags"`
	Attribs                  map[string]interface{}              `json:"attribs,omitempty"`
	PreconfirmSubscription   bool                                `json:"preconfirm_subscriptions"`
	AuthoritativeStatus      bool                                `json:"-"`
	AuthoritativeTags        bool                                `json:"-"`
	AuthoritativeFields      bool                                `json:"-"`
	TransferSourceFrom       string                              `json:"-"`
	ProjectionReconciliation *subscriberProjectionReconciliation `json:"-"`
	PreserveExistingConsent  bool                                `json:"-"`
}

// SubscriberResponse is Listmonk's create-subscriber response shape.
type SubscriberResponse struct {
	ID      int                    `json:"id"`
	UUID    string                 `json:"uuid"`
	Email   string                 `json:"email"`
	Name    string                 `json:"name"`
	Status  string                 `json:"status"`
	Tags    []string               `json:"tags"`
	Lists   SubscriberListIDs      `json:"lists"`
	Attribs map[string]interface{} `json:"attribs"`
}

// SubscriberListIDs is a subscriber's list memberships, as list ids.
//
// Listmonk returns a subscriber's `lists` as list OBJECTS ({"id":3,
// "name":"A","subscription_status":"unconfirmed",...}) in every subscriber
// payload, while requests take bare ids. Decoding the objects into []int
// failed every create, upsert, lookup and rollback read of a subscriber on at
// least one list — after Listmonk had already committed the write. It decodes
// both shapes: the objects Listmonk sends, and the bare ids this package
// writes into migration before-images (subscriberSnapshotMap), which encode
// as ids so stored snapshots stay readable.
type SubscriberListIDs []int

// UnmarshalJSON accepts an array of list objects or of bare ids.
func (ids *SubscriberListIDs) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*ids = nil
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return fmt.Errorf("subscriber lists: %w", err)
	}
	out := make(SubscriberListIDs, 0, len(entries))
	for _, entry := range entries {
		var id int
		if err := json.Unmarshal(entry, &id); err == nil {
			out = append(out, id)
			continue
		}
		var list struct {
			ID *int `json:"id"`
		}
		if err := json.Unmarshal(entry, &list); err != nil || list.ID == nil {
			return fmt.Errorf("subscriber lists: an entry is neither a list id nor a list object")
		}
		out = append(out, *list.ID)
	}
	*ids = out
	return nil
}

// SubscriberUpsertResult includes the destination before-image required to
// reverse an update without deleting a subscriber that existed before the
// migration.
type SubscriberUpsertResult struct {
	Subscriber    *SubscriberResponse
	Outcome       UpsertOutcome
	Before        *SubscriberResponse
	AttemptBefore *SubscriberResponse
}

const (
	migrationOperationAttrib       = "postwave_migration_operation"
	migrationBeforeAttrib          = "postwave_migration_before"
	migrationAfterAttrib           = "postwave_migration_after_fingerprint"
	sourceFieldNameCollisionAttrib = "postwave_source_field_name_collisions"
)

// CreateSubscriber POSTs /api/subscribers.
func (c *Client) CreateSubscriber(ctx context.Context, sub SubscriberPayload) (*SubscriberResponse, error) {
	var out struct {
		Data SubscriberResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/subscribers", sub, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// UpsertOutcome distinguishes a create from an update so callers can
// account for migration stats accurately. Without this, every Upsert
// success was optimistically counted as a create — which overstated
// "new subscribers added" in migration reports for re-run jobs.
type UpsertOutcome string

const (
	UpsertCreated UpsertOutcome = "created"
	UpsertUpdated UpsertOutcome = "updated"
)

// UpsertSubscriber tries CreateSubscriber, and on a conflict (Listmonk returns
// 409 with `email: '...': PII conflict` or similar) fetches the existing
// record by email and PUTs an update at /api/subscribers/{id}.
//
// The returned UpsertOutcome reflects the path actually taken:
// UpsertCreated for successful POST, UpsertUpdated for the conflict→PUT
// fallback.
func (c *Client) UpsertSubscriber(ctx context.Context, sub SubscriberPayload) (*SubscriberResponse, UpsertOutcome, error) {
	result, err := c.UpsertSubscriberWithSnapshot(ctx, sub)
	if err != nil {
		return nil, "", err
	}
	return result.Subscriber, result.Outcome, nil
}

// UpsertSubscriberWithSnapshot behaves like UpsertSubscriber and returns the
// complete existing subscriber on the update path. Callers must durably store
// Before before advertising rollback support.
func (c *Client) UpsertSubscriberWithSnapshot(ctx context.Context, sub SubscriberPayload) (SubscriberUpsertResult, error) {
	if c != nil && c.TenantID != "" {
		if c.DedicatedTenant && c.DedicatedTenantID != c.TenantID {
			return SubscriberUpsertResult{}, fmt.Errorf("dedicated Listmonk destination is not bound to tenant %q", c.TenantID)
		}
		if sub.Attribs == nil {
			sub.Attribs = map[string]interface{}{}
		}
		sub.Attribs["postwave_tenant_id"] = c.TenantID
	}
	if attribString(sub.Attribs, "postwave_migration_job_id") != "" {
		stampSubscriberAfterFingerprint(&sub)
	}
	var existing SubscriberResponse
	if sub.ProjectionReconciliation != nil {
		// A survivor reconciliation is update-only. If the tracked shared row
		// disappeared, creating a replacement before proving its exact identity
		// would leave an unledgered orphan and hide destination drift.
		tracked, fetchErr := c.findSubscriberByEmail(ctx, sub.Email)
		if fetchErr != nil {
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: shared-source reconciliation lookup: %w", fetchErr)
		}
		existing = tracked
		if strconv.Itoa(existing.ID) != strings.TrimSpace(sub.ProjectionReconciliation.Candidate.DestinationID) {
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: shared-source reconciliation resolved destination %d, want exact tracked destination %s", existing.ID, sub.ProjectionReconciliation.Candidate.DestinationID)
		}
	} else {
		resp, err := c.CreateSubscriber(ctx, sub)
		if err == nil {
			return SubscriberUpsertResult{Subscriber: resp, Outcome: UpsertCreated}, nil
		}
		// Check for conflict.
		if !isConflict(err) {
			return SubscriberUpsertResult{}, err
		}
		tracked, fetchErr := c.findSubscriberByEmail(ctx, sub.Email)
		if fetchErr != nil {
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: lookup after conflict: %w", fetchErr)
		}
		existing = tracked
	}
	if err := c.validateSubscriberOwnership(existing); err != nil {
		return SubscriberUpsertResult{}, err
	}
	if sub.ProjectionReconciliation != nil {
		if err := validateSubscriberMigrationAfter(existing); err != nil {
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: shared-source reconciliation destination changed after its recorded migration write: %w", err)
		}
	}
	if strings.TrimSpace(sub.TransferSourceFrom) != "" && !validatedSubscriberSourceIdentityTransfer(existing, sub) {
		return SubscriberUpsertResult{}, fmt.Errorf("upsert: requested source-identity transfer from %q is not proven by the Listmonk before-image; refusing update", sub.TransferSourceFrom)
	}
	outcome := UpsertUpdated
	before := existing
	jobID := attribString(sub.Attribs, "postwave_migration_job_id")
	existingJobID := attribString(existing.Attribs, "postwave_migration_job_id")
	recovered := jobID != "" && jobID == existingJobID
	if recovered {
		if err := validateSubscriberMigrationAfter(existing); err != nil {
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: same-job subscriber changed after the unledgered migration write: %w", err)
		}
		switch attribString(existing.Attribs, migrationOperationAttrib) {
		case string(UpsertCreated):
			outcome = UpsertCreated
		case string(UpsertUpdated):
			original, err := subscriberSnapshotFromAttrib(existing.Attribs[migrationBeforeAttrib])
			if err != nil {
				return SubscriberUpsertResult{}, fmt.Errorf("upsert: crashed-update marker has invalid before-image: %w", err)
			}
			before = original
		default:
			return SubscriberUpsertResult{}, fmt.Errorf("upsert: same-job subscriber %q lacks an unambiguous create/update recovery marker", existing.Email)
		}
	}
	merged := mergeSubscriberPayload(existing, sub)
	if jobID != "" && !recovered {
		merged.Attribs[migrationOperationAttrib] = string(UpsertUpdated)
		merged.Attribs[migrationBeforeAttrib] = subscriberSnapshotMap(existing)
	}
	if jobID != "" {
		// Preserve the recovered operation/original before-image and replace the
		// provisional create fingerprint with this exact merged update state.
		if recovered {
			merged.Attribs[migrationOperationAttrib] = attribString(existing.Attribs, migrationOperationAttrib)
			if beforeImage, ok := existing.Attribs[migrationBeforeAttrib]; ok {
				merged.Attribs[migrationBeforeAttrib] = beforeImage
			}
		}
		stampSubscriberAfterFingerprint(&merged)
	}
	var out struct {
		Data SubscriberResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodPut, fmt.Sprintf("/api/subscribers/%d", existing.ID), merged, &out); err != nil {
		return SubscriberUpsertResult{}, err
	}
	attemptBefore := existing
	result := SubscriberUpsertResult{Subscriber: &out.Data, Outcome: outcome, AttemptBefore: &attemptBefore}
	if outcome == UpsertUpdated {
		result.Before = &before
	}
	return result, nil
}

func attribString(attribs map[string]interface{}, key string) string {
	if attribs == nil {
		return ""
	}
	value, _ := attribs[key].(string)
	return strings.TrimSpace(value)
}

func subscriberSnapshotMap(sub SubscriberResponse) map[string]interface{} {
	raw, _ := json.Marshal(sub)
	out := map[string]interface{}{}
	_ = json.Unmarshal(raw, &out)
	return out
}

func subscriberSnapshotFromAttrib(value interface{}) (SubscriberResponse, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return SubscriberResponse{}, err
	}
	var out SubscriberResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return SubscriberResponse{}, err
	}
	if out.ID <= 0 || strings.TrimSpace(out.Email) == "" {
		return SubscriberResponse{}, fmt.Errorf("subscriber id/email missing")
	}
	return out, nil
}

func stampSubscriberAfterFingerprint(payload *SubscriberPayload) {
	if payload == nil {
		return
	}
	if payload.Attribs == nil {
		payload.Attribs = map[string]interface{}{}
	}
	delete(payload.Attribs, migrationAfterAttrib)
	payload.Attribs[migrationAfterAttrib] = subscriberStateFingerprint(
		payload.Email, payload.Name, payload.Status, payload.Tags, payload.Lists, payload.Attribs,
	)
}

func validateSubscriberMigrationAfter(sub SubscriberResponse) error {
	want := attribString(sub.Attribs, migrationAfterAttrib)
	if want == "" {
		return fmt.Errorf("missing migration after-state fingerprint")
	}
	got := subscriberStateFingerprint(sub.Email, sub.Name, sub.Status, sub.Tags, sub.Lists, sub.Attribs)
	if got != want {
		return fmt.Errorf("destination after-state fingerprint mismatch")
	}
	return nil
}

func subscriberStateFingerprint(email, name, status string, tags []string, lists []int, attribs map[string]interface{}) string {
	tags = append([]string(nil), tags...)
	lists = append([]int(nil), lists...)
	sort.Strings(tags)
	sort.Ints(lists)
	attrs := copyAttribs(attribs)
	delete(attrs, migrationAfterAttrib)
	raw, _ := json.Marshal(struct {
		Email   string                 `json:"email"`
		Name    string                 `json:"name"`
		Status  string                 `json:"status"`
		Tags    []string               `json:"tags"`
		Lists   []int                  `json:"lists"`
		Attribs map[string]interface{} `json:"attribs"`
	}{email, name, status, tags, lists, attrs})
	return migrationOwnershipFingerprint("subscriber-after", string(raw))
}

func (c *Client) validateSubscriberOwnership(existing SubscriberResponse) error {
	if c == nil || c.TenantID == "" {
		return nil
	}
	if c.DedicatedTenant && strings.TrimSpace(c.DedicatedTenantID) != c.TenantID {
		return fmt.Errorf("dedicated Listmonk destination is not bound to tenant %q", c.TenantID)
	}
	owner := ""
	if existing.Attribs != nil {
		owner, _ = existing.Attribs["postwave_tenant_id"].(string)
		owner = strings.TrimSpace(owner)
	}
	if owner == c.TenantID {
		return nil
	}
	if owner == "" && c.DedicatedTenant {
		return nil
	}
	if owner == "" {
		return fmt.Errorf("listmonk subscriber %q has no tenant owner; refusing shared-instance conflict update", existing.Email)
	}
	return fmt.Errorf("listmonk subscriber %q belongs to a different tenant; refusing conflict update", existing.Email)
}

// RestoreSubscriber replaces the fields changed by migration upsert with a
// previously captured destination snapshot.
func (c *Client) RestoreSubscriber(ctx context.Context, before SubscriberResponse) error {
	if before.ID <= 0 {
		return fmt.Errorf("restore subscriber: destination id required")
	}
	if err := c.validateSubscriberOwnership(before); err != nil {
		return err
	}
	payload := SubscriberPayload{
		Email:                  before.Email,
		Name:                   before.Name,
		Status:                 before.Status,
		Lists:                  append([]int(nil), before.Lists...),
		Tags:                   append([]string(nil), before.Tags...),
		Attribs:                copyAttribs(before.Attribs),
		PreconfirmSubscription: true,
	}
	return c.do(ctx, http.MethodPut, fmt.Sprintf("/api/subscribers/%d", before.ID), payload, nil)
}

// GetSubscriber returns the current destination row used by rollback
// conflict detection.
func (c *Client) GetSubscriber(ctx context.Context, id int) (*SubscriberResponse, error) {
	if id <= 0 {
		return nil, fmt.Errorf("get subscriber: destination id required")
	}
	var out struct {
		Data SubscriberResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/subscribers/%d", id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// ValidateSubscriberUnchanged refuses rollback when the subscriber has been
// edited since the migration recorded its after-image.
func (c *Client) ValidateSubscriberUnchanged(ctx context.Context, id int, expected SubscriberResponse) error {
	current, err := c.GetSubscriber(ctx, id)
	if err != nil {
		return fmt.Errorf("%w: Listmonk subscriber %d lookup: %v", ErrRollbackConflict, id, err)
	}
	if err := c.validateSubscriberOwnership(*current); err != nil {
		return err
	}
	want := comparableSubscriber(expected)
	got := comparableSubscriber(*current)
	if !reflect.DeepEqual(want, got) {
		return fmt.Errorf("%w: Listmonk subscriber %d fields, lists, tags, or attributes diverged", ErrRollbackConflict, id)
	}
	return nil
}

// SubscriberRollbackNeedsMutation validates a subscriber against the durable
// rollback ledger and reports whether the Listmonk mutation is still needed.
// The exact intended terminal state is accepted so a retry can finish the
// Postgres half of the rollback after a prior DELETE/PUT succeeded.
func (c *Client) SubscriberRollbackNeedsMutation(ctx context.Context, id int, operation UpsertOutcome, before, after SubscriberResponse) (bool, error) {
	current, err := c.GetSubscriber(ctx, id)
	if err != nil {
		if operation == UpsertCreated && strings.Contains(err.Error(), " status 404:") {
			return false, nil
		}
		return false, fmt.Errorf("%w: Listmonk subscriber %d lookup: %v", ErrRollbackConflict, id, err)
	}
	if err := c.validateSubscriberOwnership(*current); err != nil {
		return false, err
	}
	if reflect.DeepEqual(comparableSubscriber(after), comparableSubscriber(*current)) {
		return true, nil
	}
	if operation == UpsertUpdated && before.ID == id && reflect.DeepEqual(comparableSubscriber(before), comparableSubscriber(*current)) {
		return false, nil
	}
	return false, fmt.Errorf("%w: Listmonk subscriber %d is neither the recorded after-image nor the intended rollback state", ErrRollbackConflict, id)
}

type subscriberComparison struct {
	ID      int
	Email   string
	Name    string
	Status  string
	Tags    []string
	Lists   []int
	Attribs map[string]interface{}
}

func comparableSubscriber(sub SubscriberResponse) subscriberComparison {
	tags := append([]string(nil), sub.Tags...)
	lists := append([]int(nil), sub.Lists...)
	sort.Strings(tags)
	sort.Ints(lists)
	return subscriberComparison{
		ID: sub.ID, Email: sub.Email, Name: sub.Name, Status: sub.Status,
		Tags: tags, Lists: lists, Attribs: copyAttribs(sub.Attribs),
	}
}

// ListPayload mirrors POST /api/lists.
type ListPayload struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`  // public | private
	Optin       string   `json:"optin"` // single | double
	Tags        []string `json:"tags,omitempty"`
	Description string   `json:"description,omitempty"`
}

// ListResponse is Listmonk's create-list response shape.
type ListResponse struct {
	ID          int      `json:"id"`
	UUID        string   `json:"uuid"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Optin       string   `json:"optin"`
	Tags        []string `json:"tags"`
	Description string   `json:"description"`
}

// CreateList POSTs /api/lists.
func (c *Client) CreateList(ctx context.Context, l ListPayload) (*ListResponse, error) {
	var out struct {
		Data ListResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/lists", l, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// (Segment persistence lives in the orchestrator: see
// listmonkx.PersistSegment, which writes to the real `segments` table with
// RLS + records the migration's imported-resource handle for rollback.
// There is no Listmonk-product-side analog because Listmonk implements
// segments as raw SQL in campaign queries — there's nothing to POST.)

// TemplatePayload mirrors POST /api/templates.
type TemplatePayload struct {
	Name string `json:"name"`
	Type string `json:"type"` // campaign | tx
	Body string `json:"body"`
}

// TemplateResponse mirrors Listmonk's create-template response.
type TemplateResponse struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Body string `json:"body"`
}

const (
	reconciliationInventoryPageSize = 100
	reconciliationInventoryMaxRows  = 10_000
)

type reconciliationInventory struct {
	listsMu     sync.Mutex
	listsLoaded bool
	listsByName map[string][]ListResponse

	templatesMu     sync.Mutex
	templatesLoaded bool
	templatesByName map[string][]TemplateResponse
}

var reconciliationInventoryInitMu sync.Mutex

func (c *Client) resourceReconciliationInventory() *reconciliationInventory {
	reconciliationInventoryInitMu.Lock()
	defer reconciliationInventoryInitMu.Unlock()
	if c.reconciliationInventory == nil {
		c.reconciliationInventory = &reconciliationInventory{}
	}
	return c.reconciliationInventory
}

func (c *Client) invalidateListInventory() {
	inv := c.resourceReconciliationInventory()
	inv.listsMu.Lock()
	defer inv.listsMu.Unlock()
	inv.listsLoaded = false
	inv.listsByName = nil
}

func (c *Client) invalidateTemplateInventory() {
	inv := c.resourceReconciliationInventory()
	inv.templatesMu.Lock()
	defer inv.templatesMu.Unlock()
	inv.templatesLoaded = false
	inv.templatesByName = nil
}

// RefreshTemplateReconciliationInventory starts a fresh bounded inventory for
// one template-stage execution. Callers invoke it once before materializing a
// batch; individual templates then share that operation-local snapshot.
func (c *Client) RefreshTemplateReconciliationInventory() {
	if c == nil {
		return
	}
	c.invalidateTemplateInventory()
}

func (c *Client) rememberListForReconciliation(item ListResponse) {
	inv := c.resourceReconciliationInventory()
	inv.listsMu.Lock()
	defer inv.listsMu.Unlock()
	if !inv.listsLoaded {
		return
	}
	for name, items := range inv.listsByName {
		inv.listsByName[name] = removeListInventoryID(items, item.ID)
	}
	inv.listsByName[item.Name] = append(inv.listsByName[item.Name], item)
}

func (c *Client) rememberTemplateForReconciliation(item TemplateResponse) {
	inv := c.resourceReconciliationInventory()
	inv.templatesMu.Lock()
	defer inv.templatesMu.Unlock()
	if !inv.templatesLoaded {
		return
	}
	for name, items := range inv.templatesByName {
		inv.templatesByName[name] = removeTemplateInventoryID(items, item.ID)
	}
	inv.templatesByName[item.Name] = append(inv.templatesByName[item.Name], item)
}

func removeListInventoryID(items []ListResponse, id int) []ListResponse {
	out := items[:0]
	for _, item := range items {
		if item.ID != id {
			out = append(out, item)
		}
	}
	return out
}

func removeTemplateInventoryID(items []TemplateResponse, id int) []TemplateResponse {
	out := items[:0]
	for _, item := range items {
		if item.ID != id {
			out = append(out, item)
		}
	}
	return out
}

func (c *Client) forgetListForReconciliation(id int) {
	inv := c.resourceReconciliationInventory()
	inv.listsMu.Lock()
	defer inv.listsMu.Unlock()
	if !inv.listsLoaded {
		return
	}
	for name, items := range inv.listsByName {
		remaining := removeListInventoryID(items, id)
		if len(remaining) == 0 {
			delete(inv.listsByName, name)
		} else {
			inv.listsByName[name] = remaining
		}
	}
}

func (c *Client) forgetTemplateForReconciliation(id int) {
	inv := c.resourceReconciliationInventory()
	inv.templatesMu.Lock()
	defer inv.templatesMu.Unlock()
	if !inv.templatesLoaded {
		return
	}
	for name, items := range inv.templatesByName {
		remaining := removeTemplateInventoryID(items, id)
		if len(remaining) == 0 {
			delete(inv.templatesByName, name)
		} else {
			inv.templatesByName[name] = remaining
		}
	}
}

// FindListByName reconciles a create-only Listmonk list after the external
// POST succeeded but the worker died before recording the Moosewave ledger.
// The bounded inventory is loaded once per client and exact matches are then
// fetched by ID so ownership checks never rely on a potentially abbreviated
// listing response. Ambiguous exact-name matches fail closed.
func (c *Client) FindListByName(ctx context.Context, name string) (*ListResponse, error) {
	inv := c.resourceReconciliationInventory()
	inv.listsMu.Lock()
	if !inv.listsLoaded {
		items, err := c.loadListReconciliationInventory(ctx)
		if err != nil {
			inv.listsMu.Unlock()
			return nil, err
		}
		inv.listsByName = make(map[string][]ListResponse)
		for _, item := range items {
			inv.listsByName[item.Name] = append(inv.listsByName[item.Name], item)
		}
		inv.listsLoaded = true
	}
	matches := append([]ListResponse(nil), inv.listsByName[name]...)
	inv.listsMu.Unlock()
	if len(matches) > 1 {
		return nil, fmt.Errorf("Listmonk has multiple lists named %q; refusing migration adoption", name)
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return c.GetList(ctx, matches[0].ID)
}

func (c *Client) loadListReconciliationInventory(ctx context.Context) ([]ListResponse, error) {
	items := make([]ListResponse, 0)
	seen := make(map[int]struct{})
	for page := 1; ; page++ {
		var out struct {
			Data struct {
				Results []ListResponse `json:"results"`
				Total   int            `json:"total"`
			} `json:"data"`
		}
		path := fmt.Sprintf("/api/lists?per_page=%d&page=%d", reconciliationInventoryPageSize, page)
		if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
			return nil, err
		}
		if out.Data.Total > reconciliationInventoryMaxRows {
			return nil, fmt.Errorf("Listmonk list reconciliation requires scanning %d rows, exceeding the safe %d-row bound; refusing create", out.Data.Total, reconciliationInventoryMaxRows)
		}
		if len(items)+len(out.Data.Results) > reconciliationInventoryMaxRows {
			return nil, fmt.Errorf("Listmonk list reconciliation exceeds the safe %d-row bound; refusing create", reconciliationInventoryMaxRows)
		}
		for _, item := range out.Data.Results {
			if item.ID <= 0 {
				return nil, fmt.Errorf("Listmonk list reconciliation returned an invalid destination id")
			}
			if _, duplicate := seen[item.ID]; duplicate {
				return nil, fmt.Errorf("Listmonk list reconciliation repeated destination id %d across pages; refusing incomplete inventory", item.ID)
			}
			seen[item.ID] = struct{}{}
			items = append(items, item)
		}
		if out.Data.Total > 0 {
			if len(items) >= out.Data.Total {
				break
			}
			if len(out.Data.Results) < reconciliationInventoryPageSize {
				return nil, fmt.Errorf("Listmonk list reconciliation ended after %d of %d advertised rows; refusing incomplete inventory", len(items), out.Data.Total)
			}
		} else if len(out.Data.Results) < reconciliationInventoryPageSize {
			break
		}
	}
	return items, nil
}

// GetList retrieves the full list record used for exact description/tag
// ownership verification and safe loser cleanup.
func (c *Client) GetList(ctx context.Context, id int) (*ListResponse, error) {
	if id <= 0 {
		return nil, fmt.Errorf("Listmonk list id required")
	}
	var out struct {
		Data ListResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/lists/%d", id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// GetTemplate retrieves the full template, including the body used for
// crash-window ownership verification.
func (c *Client) GetTemplate(ctx context.Context, id int) (*TemplateResponse, error) {
	if id <= 0 {
		return nil, fmt.Errorf("Listmonk template id required")
	}
	var out struct {
		Data TemplateResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/templates/%d", id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// FindTemplateByName is the template counterpart to FindListByName.
func (c *Client) FindTemplateByName(ctx context.Context, name string) (*TemplateResponse, error) {
	inv := c.resourceReconciliationInventory()
	inv.templatesMu.Lock()
	if !inv.templatesLoaded {
		items, err := c.loadTemplateReconciliationInventory(ctx)
		if err != nil {
			inv.templatesMu.Unlock()
			return nil, err
		}
		inv.templatesByName = make(map[string][]TemplateResponse)
		for _, item := range items {
			inv.templatesByName[item.Name] = append(inv.templatesByName[item.Name], item)
		}
		inv.templatesLoaded = true
	}
	matches := append([]TemplateResponse(nil), inv.templatesByName[name]...)
	inv.templatesMu.Unlock()
	if len(matches) > 1 {
		return nil, fmt.Errorf("Listmonk has multiple templates named %q; refusing migration adoption", name)
	}
	if len(matches) == 0 {
		return nil, nil
	}
	// Listing responses are not guaranteed to include the full body. Recovery
	// ownership is carried in an HTML fingerprint marker, so fetch the exact
	// record before allowing a caller to adopt it.
	return c.GetTemplate(ctx, matches[0].ID)
}

func (c *Client) loadTemplateReconciliationInventory(ctx context.Context) ([]TemplateResponse, error) {
	items := make([]TemplateResponse, 0)
	seen := make(map[int]struct{})
	for page := 1; ; page++ {
		var out struct {
			Data struct {
				Results []TemplateResponse `json:"results"`
				Total   int                `json:"total"`
			} `json:"data"`
		}
		path := fmt.Sprintf("/api/templates?per_page=%d&page=%d", reconciliationInventoryPageSize, page)
		if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
			return nil, err
		}
		if out.Data.Total > reconciliationInventoryMaxRows {
			return nil, fmt.Errorf("Listmonk template reconciliation requires scanning %d rows, exceeding the safe %d-row bound; refusing create", out.Data.Total, reconciliationInventoryMaxRows)
		}
		if len(items)+len(out.Data.Results) > reconciliationInventoryMaxRows {
			return nil, fmt.Errorf("Listmonk template reconciliation exceeds the safe %d-row bound; refusing create", reconciliationInventoryMaxRows)
		}
		for _, item := range out.Data.Results {
			if item.ID <= 0 {
				return nil, fmt.Errorf("Listmonk template reconciliation returned an invalid destination id")
			}
			if _, duplicate := seen[item.ID]; duplicate {
				return nil, fmt.Errorf("Listmonk template reconciliation repeated destination id %d across pages; refusing incomplete inventory", item.ID)
			}
			seen[item.ID] = struct{}{}
			items = append(items, item)
		}
		if out.Data.Total > 0 {
			if len(items) >= out.Data.Total {
				break
			}
			if len(out.Data.Results) < reconciliationInventoryPageSize {
				return nil, fmt.Errorf("Listmonk template reconciliation ended after %d of %d advertised rows; refusing incomplete inventory", len(items), out.Data.Total)
			}
		} else if len(out.Data.Results) < reconciliationInventoryPageSize {
			break
		}
	}
	return items, nil
}

// DeleteSubscriber DELETEs /api/subscribers/{id}. Used by the 7-day rollback
// engine to undo an imported migration.
//
// Idempotent: a 404 (the row is already gone) is treated as success so a
// retried rollback doesn't fail mid-way through a partial sweep.
func (c *Client) DeleteSubscriber(ctx context.Context, id int) error {
	return c.deleteIgnoreMissing(ctx, fmt.Sprintf("/api/subscribers/%d", id))
}

// DeleteList DELETEs /api/lists/{id}.
func (c *Client) DeleteList(ctx context.Context, id int) error {
	if err := c.deleteIgnoreMissing(ctx, fmt.Sprintf("/api/lists/%d", id)); err != nil {
		return err
	}
	c.forgetListForReconciliation(id)
	return nil
}

// (Segment rollback lives in orchestrator.RollbackEngine.deleteSegments,
// which calls listmonkx.DeleteTrackedPostgresResources directly against
// the `segments` table. There is no Listmonk-product-side delete; the
// rows live only in Moosewave.)

// DeleteTemplate DELETEs /api/templates/{id}.
func (c *Client) DeleteTemplate(ctx context.Context, id int) error {
	if err := c.deleteIgnoreMissing(ctx, fmt.Sprintf("/api/templates/%d", id)); err != nil {
		return err
	}
	c.forgetTemplateForReconciliation(id)
	return nil
}

func (c *Client) deleteIgnoreMissing(ctx context.Context, path string) error {
	err := c.do(ctx, http.MethodDelete, path, nil, nil)
	if err == nil {
		return nil
	}
	// 404 is fine — the resource is already gone, which is the desired
	// terminal state of the rollback.
	if strings.Contains(err.Error(), "status 404") {
		return nil
	}
	return err
}

// CreateTemplate POSTs /api/templates.
func (c *Client) CreateTemplate(ctx context.Context, name, html string) (*TemplateResponse, error) {
	payload := TemplatePayload{Name: name, Type: "campaign", Body: html}
	var out struct {
		Data TemplateResponse `json:"data"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/templates", payload, &out); err != nil {
		return nil, err
	}
	return &out.Data, nil
}

// --- internals ---

func (c *Client) do(ctx context.Context, method, path string, body, out interface{}) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode: %w", err)
		}
		reader = bytes.NewReader(buf)
	}
	endpoint, err := listmonkURL(c.BaseURL, path)
	if err != nil {
		return fmt.Errorf("build request URL: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.SetBasicAuth(c.AdminUser, c.AdminPass)
	req.Header.Set("Accept", "application/json")
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("listmonk %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusConflict {
		return &conflictError{status: resp.StatusCode}
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, listmonkErrorResponseMaxBytes))
		return fmt.Errorf("listmonk %s %s status %d: %s", method, path, resp.StatusCode, string(b))
	}
	if out == nil {
		return nil
	}
	if resp.ContentLength > listmonkJSONResponseMaxBytes {
		return fmt.Errorf("listmonk response body too large")
	}
	if err := decodeJSONLimited(resp.Body, listmonkJSONResponseMaxBytes, out); err != nil {
		return fmt.Errorf("decode listmonk response: %w", err)
	}
	return nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return fmt.Errorf("response body too large")
	}
	return json.NewDecoder(bytes.NewReader(buf)).Decode(out)
}

func listmonkURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(baseRaw, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid base URL")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported base URL scheme")
	}
	rel := strings.TrimLeft(path, "/")
	pathPart, rawQuery, _ := strings.Cut(rel, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe request path")
		}
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/" + pathPart
	base.RawQuery = rawQuery
	return base.String(), nil
}

// FindSubscribersByAttrib pages through Listmonk's `query` API looking for
// subscribers whose attribs JSONB blob contains the given key=value pair. It
// is the rollback engine's primary lookup tool: every subscriber the
// translator imports gets stamped with `postwave_source_platform`, so we can
// find them again even without keeping a per-job ID list.
//
// Returns up to `limit` subscriber IDs per call. The caller loops until an
// empty result set comes back, deleting between calls so the same row never
// appears twice.
func (c *Client) FindSubscribersByAttrib(ctx context.Context, key, value string, limit int) ([]int, error) {
	if limit <= 0 {
		limit = 100
	}
	q := fmt.Sprintf("/api/subscribers?per_page=%d&query=%s", limit,
		urlEncode(fmt.Sprintf("subscribers.attribs->>'%s' = '%s'", sqlIdent(key), sqlIdent(value))))
	var out struct {
		Data struct {
			Results []SubscriberResponse `json:"results"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, q, nil, &out); err != nil {
		return nil, err
	}
	ids := make([]int, 0, len(out.Data.Results))
	for _, r := range out.Data.Results {
		ids = append(ids, r.ID)
	}
	return ids, nil
}

// sqlIdent escapes a value for safe interpolation inside a single-quoted SQL
// literal in a Listmonk segment query. We can't parameterise here because
// Listmonk's `query` param is pre-formatted SQL, not parameterised.
func sqlIdent(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// findSubscriberByEmail uses Listmonk's `query` parameter on /api/subscribers.
func (c *Client) findSubscriberByEmail(ctx context.Context, email string) (SubscriberResponse, error) {
	q := fmt.Sprintf("/api/subscribers?query=%s", urlEncode("subscribers.email = '"+sqlIdent(email)+"'"))
	var out struct {
		Data struct {
			Results []SubscriberResponse `json:"results"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, q, nil, &out); err != nil {
		return SubscriberResponse{}, err
	}
	if len(out.Data.Results) == 0 {
		return SubscriberResponse{}, fmt.Errorf("listmonk: subscriber %q not found after conflict", email)
	}
	return out.Data.Results[0], nil
}

// FindSubscriberByEmailForReconciliation returns a full subscriber when a
// pending durable intent has an external result. Absence is not an error: it
// means the worker stopped after recording intent but before mutation.
func (c *Client) FindSubscriberByEmailForReconciliation(ctx context.Context, email string) (*SubscriberResponse, error) {
	q := fmt.Sprintf("/api/subscribers?query=%s", urlEncode("subscribers.email = '"+sqlIdent(email)+"'"))
	var out struct {
		Data struct {
			Results []SubscriberResponse `json:"results"`
		} `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, q, nil, &out); err != nil {
		return nil, err
	}
	if len(out.Data.Results) == 0 {
		return nil, nil
	}
	if len(out.Data.Results) > 1 {
		return nil, fmt.Errorf("listmonk: multiple subscribers matched email %q; refusing intent reconciliation", email)
	}
	result := out.Data.Results[0]
	return &result, nil
}

func mergeSubscriberPayload(existing SubscriberResponse, incoming SubscriberPayload) SubscriberPayload {
	merged := incoming
	sameSourceIdentity := sourceIdentityMatches(existing.Attribs, incoming.Attribs)
	transferSourceIdentity := validatedSubscriberSourceIdentityTransfer(existing, incoming)
	snapshotAuthorityBlocked := sourceSnapshotAuthorityBlocked(existing.Attribs, incoming.Attribs)
	statusAuthorityBlocked := sourceStatusAuthorityBlocked(existing.Attribs, incoming.Attribs)
	authoritativeTags := incoming.AuthoritativeTags && ((sameSourceIdentity && !snapshotAuthorityBlocked) || transferSourceIdentity)
	authoritativeFields := incoming.AuthoritativeFields && ((sameSourceIdentity && !snapshotAuthorityBlocked) || transferSourceIdentity)
	preserveExistingConsent := incoming.PreserveExistingConsent || (incoming.AuthoritativeStatus && (!sameSourceIdentity || statusAuthorityBlocked) && !transferSourceIdentity)
	if existing.Name != "" && !sameSourceIdentity && !transferSourceIdentity {
		// A migration source must not replace a locally curated or different-
		// source display name merely because Listmonk deduplicates on email.
		merged.Name = existing.Name
	} else if merged.Name == "" {
		merged.Name = existing.Name
	}
	if transferSourceIdentity || useSourceAuthoritativeStatus(existing, incoming) {
		merged.Status = incoming.Status
	} else {
		merged.Status = mergeSubscriberStatus(existing.Status, incoming.Status)
	}
	if authoritativeTags {
		merged.Tags = replaceSourceOwnedStrings(existing.Tags, stringListFromAttrib(existing.Attribs["postwave_tags"]), incoming.Tags)
	} else {
		merged.Tags = mergeStringUnion(existing.Tags, incoming.Tags)
	}
	if merged.Tags == nil {
		merged.Tags = []string{}
	}
	if incoming.ProjectionReconciliation != nil {
		merged.Lists = replaceSourceOwnedInts(existing.Lists, intListFromAttrib(existing.Attribs["postwave_source_list_ids"]), incoming.Lists)
	} else {
		merged.Lists = mergeIntUnion(existing.Lists, incoming.Lists)
	}
	existingSourceTags := stringListFromAttrib(existing.Attribs["postwave_tags"])
	sourceTags := mergeStringUnion(
		existingSourceTags,
		newlySourceOwnedStrings(existing.Tags, existingSourceTags, incoming.Tags),
	)
	if authoritativeTags {
		sourceTags = newlySourceOwnedStrings(existing.Tags, existingSourceTags, incoming.Tags)
	}
	merged.Attribs = mergeSubscriberAttribs(
		existing.Attribs,
		incoming.Attribs,
		sourceTags,
		authoritativeFields,
		authoritativeTags,
		preserveExistingConsent,
	)
	if incoming.ProjectionReconciliation != nil {
		reconciliation := incoming.ProjectionReconciliation
		merged.Attribs["postwave_source_ids"] = append([]string(nil), reconciliation.ActiveSourceIDs...)
		merged.Attribs["postwave_source_id"] = strings.TrimSpace(reconciliation.PrimaryProjection.Subscriber.SourceID)
		merged.Attribs["postwave_source_platform"] = string(reconciliation.PrimaryProjection.Subscriber.SourcePlatform)
		merged.Attribs["postwave_source_identity_keys"] = append([]string(nil), reconciliation.ActiveIdentityKeys...)
		merged.Attribs["postwave_source_list_ids"] = append([]int(nil), incoming.Lists...)
		filterSubscriberAuthorityProtections(merged.Attribs, reconciliation.ActiveIdentityKeys)
	}
	if transferSourceIdentity {
		incomingSourceID := primarySourceID(incoming.Attribs)
		merged.Attribs["postwave_source_id"] = incomingSourceID
		removeSourceAuthorityProtection(merged.Attribs, "postwave_status_protected_source_ids", sourceStatusAuthorityKey(incoming.Attribs))
		removeSourceAuthorityProtection(merged.Attribs, "postwave_snapshot_protected_source_ids", sourceStatusAuthorityKey(incoming.Attribs))
	}
	if shouldProtectExistingSubscriberStatus(existing, incoming) && !transferSourceIdentity {
		protectSubscriberStatusSource(merged.Attribs, incoming.Attribs)
	}
	if (incoming.AuthoritativeTags || incoming.AuthoritativeFields) &&
		!sameSourceIdentity && !transferSourceIdentity && sourceIdentityKnown(existing.Attribs) {
		protectSourceSnapshotAuthority(merged.Attribs, incoming.Attribs)
	}
	return merged
}

func validatedSubscriberSourceIdentityTransfer(existing SubscriberResponse, incoming SubscriberPayload) bool {
	from := strings.TrimSpace(incoming.TransferSourceFrom)
	if from == "" || !incoming.AuthoritativeStatus || !incoming.AuthoritativeTags || !incoming.AuthoritativeFields {
		return false
	}
	if primarySourceID(existing.Attribs) != from {
		return false
	}
	to := primarySourceID(incoming.Attribs)
	if to == "" || to == from {
		return false
	}
	if incoming.ProjectionReconciliation != nil {
		retiringKey := subscriberSourceIdentityKey(canonical.SourcePlatform(sourcePlatformAttrib(existing.Attribs)), from)
		toKey := subscriberSourceIdentityKey(canonical.SourcePlatform(sourcePlatformAttrib(incoming.Attribs)), to)
		trackedKeys := stringListFromAttrib(existing.Attribs["postwave_source_identity_keys"])
		if retiringKey == "" || toKey == "" || !containsMetadataString(trackedKeys, retiringKey) || !containsMetadataString(trackedKeys, toKey) {
			return false
		}
		return containsMetadataString(incoming.ProjectionReconciliation.ActiveIdentityKeys, toKey)
	}
	if !strings.EqualFold(sourcePlatformAttrib(existing.Attribs), sourcePlatformAttrib(incoming.Attribs)) {
		return false
	}
	for _, tracked := range sourceIDsFromAttribs(existing.Attribs) {
		if tracked == to {
			return true
		}
	}
	return false
}

func filterSubscriberAuthorityProtections(attribs map[string]interface{}, activeIdentityKeys []string) {
	active := map[string]struct{}{}
	for _, key := range activeIdentityKeys {
		active[key] = struct{}{}
	}
	for _, name := range []string{"postwave_status_protected_source_ids", "postwave_snapshot_protected_source_ids"} {
		remaining := []string{}
		for _, key := range stringListFromAttrib(attribs[name]) {
			if _, retained := active[key]; retained {
				remaining = append(remaining, key)
			}
		}
		if len(remaining) == 0 {
			delete(attribs, name)
		} else {
			attribs[name] = remaining
		}
	}
}

func primarySourceID(attribs map[string]interface{}) string {
	values := stringListFromAttrib(attribs["postwave_source_id"])
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func removeSourceAuthorityProtection(attribs map[string]interface{}, key, blockedKey string) {
	blockedKey = strings.TrimSpace(blockedKey)
	if blockedKey == "" {
		return
	}
	remaining := make([]string, 0)
	for _, value := range stringListFromAttrib(attribs[key]) {
		if value != blockedKey {
			remaining = append(remaining, value)
		}
	}
	if len(remaining) == 0 {
		delete(attribs, key)
		return
	}
	attribs[key] = remaining
}

func replaceSourceOwnedStrings(existing, previouslyOwned, incoming []string) []string {
	owned := map[string]struct{}{}
	for _, value := range previouslyOwned {
		if key := strings.ToLower(strings.TrimSpace(value)); key != "" {
			owned[key] = struct{}{}
		}
	}
	kept := make([]string, 0, len(existing)+len(incoming))
	for _, value := range existing {
		if _, replace := owned[strings.ToLower(strings.TrimSpace(value))]; replace {
			continue
		}
		kept = append(kept, value)
	}
	return mergeStringUnion(kept, incoming)
}

func replaceSourceOwnedInts(existing, previouslyOwned, incoming []int) []int {
	owned := map[int]struct{}{}
	for _, value := range previouslyOwned {
		if value > 0 {
			owned[value] = struct{}{}
		}
	}
	kept := make([]int, 0, len(existing)+len(incoming))
	for _, value := range existing {
		if _, replace := owned[value]; replace {
			continue
		}
		kept = append(kept, value)
	}
	return mergeIntUnion(kept, incoming)
}

func newlySourceOwnedStrings(existing, previouslyOwned, incoming []string) []string {
	existingSet := map[string]struct{}{}
	for _, value := range existing {
		if key := strings.ToLower(strings.TrimSpace(value)); key != "" {
			existingSet[key] = struct{}{}
		}
	}
	ownedSet := map[string]struct{}{}
	for _, value := range previouslyOwned {
		if key := strings.ToLower(strings.TrimSpace(value)); key != "" {
			ownedSet[key] = struct{}{}
		}
	}
	out := make([]string, 0, len(incoming))
	for _, value := range incoming {
		key := strings.ToLower(strings.TrimSpace(value))
		if key == "" {
			continue
		}
		_, existed := existingSet[key]
		_, alreadyOwned := ownedSet[key]
		if !existed || alreadyOwned {
			out = append(out, value)
		}
	}
	return mergeStringUnion(out)
}

func mergeIntUnion(left, right []int) []int {
	if len(left) == 0 && len(right) == 0 {
		return nil
	}
	out := make([]int, 0, len(left)+len(right))
	seen := map[int]struct{}{}
	for _, values := range [][]int{left, right} {
		for _, value := range values {
			if value <= 0 {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			out = append(out, value)
		}
	}
	return out
}

func useSourceAuthoritativeStatus(existing SubscriberResponse, incoming SubscriberPayload) bool {
	if !incoming.AuthoritativeStatus {
		return false
	}
	if sourceStatusAuthorityBlocked(existing.Attribs, incoming.Attribs) {
		return false
	}
	return sourceIdentityMatches(existing.Attribs, incoming.Attribs)
}

func shouldProtectExistingSubscriberStatus(existing SubscriberResponse, incoming SubscriberPayload) bool {
	return incoming.AuthoritativeStatus && !sourceIdentityMatches(existing.Attribs, incoming.Attribs)
}

func sourceIdentityMatches(existing, incoming map[string]interface{}) bool {
	existingKeys := stringListFromAttrib(existing["postwave_source_identity_keys"])
	incomingKeys := stringListFromAttrib(incoming["postwave_source_identity_keys"])
	if len(existingKeys) > 0 && len(incomingKeys) > 0 {
		seen := map[string]struct{}{}
		for _, key := range existingKeys {
			seen[key] = struct{}{}
		}
		for _, key := range incomingKeys {
			if _, ok := seen[key]; ok {
				return true
			}
		}
		return false
	}
	existingPlatform := sourcePlatformAttrib(existing)
	incomingPlatform := sourcePlatformAttrib(incoming)
	if existingPlatform == "" || incomingPlatform == "" || !strings.EqualFold(existingPlatform, incomingPlatform) {
		return false
	}
	existingIDs := sourceIDsFromAttribs(existing)
	incomingIDs := sourceIDsFromAttribs(incoming)
	if len(existingIDs) == 0 || len(incomingIDs) == 0 {
		return false
	}
	seen := map[string]struct{}{}
	for _, id := range existingIDs {
		if strings.TrimSpace(id) != "" {
			seen[id] = struct{}{}
		}
	}
	for _, id := range incomingIDs {
		if _, ok := seen[id]; ok {
			return true
		}
	}
	return false
}

func sourceStatusAuthorityBlocked(existing, incoming map[string]interface{}) bool {
	key := sourceStatusAuthorityKey(incoming)
	if key == "" {
		return false
	}
	for _, blocked := range stringListFromAttrib(existing["postwave_status_protected_source_ids"]) {
		if blocked == key {
			return true
		}
	}
	for _, blocked := range stringListFromAttrib(existing["postwave_snapshot_protected_source_ids"]) {
		if blocked == key {
			return true
		}
	}
	return false
}

func sourceIdentityKnown(attribs map[string]interface{}) bool {
	return sourcePlatformAttrib(attribs) != "" && len(sourceIDsFromAttribs(attribs)) > 0
}

func sourceSnapshotAuthorityBlocked(existing, incoming map[string]interface{}) bool {
	key := sourceStatusAuthorityKey(incoming)
	if key == "" {
		return false
	}
	for _, blocked := range stringListFromAttrib(existing["postwave_snapshot_protected_source_ids"]) {
		if blocked == key {
			return true
		}
	}
	return false
}

func protectSourceSnapshotAuthority(merged, incoming map[string]interface{}) {
	key := sourceStatusAuthorityKey(incoming)
	if key == "" {
		return
	}
	merged["postwave_snapshot_protected_source_ids"] = mergeStringUnion(
		stringListFromAttrib(merged["postwave_snapshot_protected_source_ids"]),
		[]string{key},
	)
}

func protectSubscriberStatusSource(merged, incoming map[string]interface{}) {
	key := sourceStatusAuthorityKey(incoming)
	if key == "" {
		return
	}
	merged["postwave_status_protected_source_ids"] = mergeStringUnion(
		stringListFromAttrib(merged["postwave_status_protected_source_ids"]),
		[]string{key},
	)
}

func sourceStatusAuthorityKey(attribs map[string]interface{}) string {
	if keys := stringListFromAttrib(attribs["postwave_source_identity_keys"]); len(keys) > 0 {
		return keys[0]
	}
	platform := sourcePlatformAttrib(attribs)
	ids := sourceIDsFromAttribs(attribs)
	if platform == "" || len(ids) == 0 {
		return ""
	}
	return strings.ToLower(platform) + ":" + ids[0]
}

func sourcePlatformAttrib(attribs map[string]interface{}) string {
	values := stringListFromAttrib(attribs["postwave_source_platform"])
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func sourceIDsFromAttribs(attribs map[string]interface{}) []string {
	return mergeStringUnion(
		stringListFromAttrib(attribs["postwave_source_ids"]),
		stringListFromAttrib(attribs["postwave_source_id"]),
	)
}

func mergeSubscriberStatus(existing, incoming string) string {
	if statusRank(incoming) >= statusRank(existing) {
		return incoming
	}
	return existing
}

func statusRank(status string) int {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "blocklisted":
		return 3
	case "disabled", "unsubscribed", "unconfirmed":
		return 2
	case "enabled", "subscribed":
		return 1
	default:
		return 0
	}
}

func mergeStringUnion(groups ...[]string) []string {
	var out []string
	seen := map[string]struct{}{}
	for _, group := range groups {
		for _, value := range group {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			key := strings.ToLower(value)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, value)
		}
	}
	return out
}

func mergeSubscriberAttribs(existing, incoming map[string]interface{}, tags []string, authoritative ...bool) map[string]interface{} {
	merged := copyAttribs(existing)
	conflicts := normalizeFieldConflicts(merged["postwave_field_conflicts"])
	replaceSourceFields := len(authoritative) > 0 && authoritative[0]
	replaceSourceTags := len(authoritative) > 1 && authoritative[1]
	preserveExistingConsent := len(authoritative) > 2 && authoritative[2]
	previousSourceFields := stringListFromAttrib(existing["postwave_source_field_keys"])
	previousSourceFieldSet := make(map[string]struct{}, len(previousSourceFields))
	for _, key := range previousSourceFields {
		previousSourceFieldSet[key] = struct{}{}
	}
	incomingSourceFields := stringListFromAttrib(incoming["postwave_source_field_keys"])
	currentSourceFields := make([]string, 0, len(incomingSourceFields))
	for _, key := range incomingSourceFields {
		existingValue, existed := existing[key]
		_, previouslyOwned := previousSourceFieldSet[key]
		if !existed || existingValue == nil || fmt.Sprint(existingValue) == "" || previouslyOwned {
			currentSourceFields = append(currentSourceFields, key)
		}
	}
	trackedSourceFields := mergeStringUnion(previousSourceFields, currentSourceFields)
	if replaceSourceFields {
		trackedSourceFields = currentSourceFields
	}
	trackedSourceFieldSet := make(map[string]struct{}, len(trackedSourceFields))
	for _, key := range trackedSourceFields {
		trackedSourceFieldSet[key] = struct{}{}
	}
	if replaceSourceFields {
		for _, key := range previousSourceFields {
			if _, retained := trackedSourceFieldSet[key]; !retained {
				delete(merged, key)
				delete(conflicts, key)
			}
		}
	}
	sourceIDs := mergeStringUnion(
		stringListFromAttrib(merged["postwave_source_ids"]),
		stringListFromAttrib(merged["postwave_source_id"]),
		stringListFromAttrib(incoming["postwave_source_ids"]),
		stringListFromAttrib(incoming["postwave_source_id"]),
	)
	sourceIdentityKeys := mergeStringUnion(
		stringListFromAttrib(merged["postwave_source_identity_keys"]),
		stringListFromAttrib(incoming["postwave_source_identity_keys"]),
	)
	sourceListIDs := mergeIntUnion(
		intListFromAttrib(merged["postwave_source_list_ids"]),
		intListFromAttrib(incoming["postwave_source_list_ids"]),
	)

	for key, value := range incoming {
		switch key {
		case "postwave_tags", "postwave_source_id", "postwave_source_ids", "postwave_source_identity_keys", "postwave_source_list_ids", "postwave_source_field_keys", "postwave_field_conflicts", sourceFieldNameCollisionAttrib:
			continue
		case migrationOperationAttrib, migrationBeforeAttrib, migrationAfterAttrib:
			// Crash-recovery markers are rebuilt explicitly after the business
			// fields merge; they are not user custom-field conflicts.
			continue
		case "postwave_consent_at", "postwave_consent_source":
			if preserveExistingConsent {
				if existingValue, ok := merged[key]; ok && existingValue != nil && strings.TrimSpace(fmt.Sprint(existingValue)) != "" {
					continue
				}
			}
			mergeConsentAttrib(merged, incoming, key)
			continue
		case "postwave_migration_job_id", "postwave_source_platform", "postwave_status_raw":
			if value != nil && fmt.Sprint(value) != "" {
				merged[key] = value
			}
			continue
		}
		if replaceSourceFields {
			if _, sourceOwned := trackedSourceFieldSet[key]; sourceOwned {
				merged[key] = value
				delete(conflicts, key)
				continue
			}
		}

		if existingValue, ok := merged[key]; !ok || existingValue == nil || fmt.Sprint(existingValue) == "" {
			merged[key] = value
		} else if !reflect.DeepEqual(existingValue, value) {
			addFieldConflict(conflicts, key, existingValue)
			addFieldConflict(conflicts, key, value)
		}
	}
	if collisions, exists := incoming[sourceFieldNameCollisionAttrib]; exists {
		if replaceSourceFields {
			merged[sourceFieldNameCollisionAttrib] = cloneSourceFieldNameCollisions(collisions)
		} else {
			merged[sourceFieldNameCollisionAttrib] = mergeSourceFieldNameCollisions(existing[sourceFieldNameCollisionAttrib], collisions)
		}
	} else if replaceSourceFields {
		delete(merged, sourceFieldNameCollisionAttrib)
	}

	if len(sourceIDs) > 0 {
		merged["postwave_source_ids"] = sourceIDs
		merged["postwave_source_id"] = sourceIDs[0]
	}
	if len(sourceIdentityKeys) > 0 {
		merged["postwave_source_identity_keys"] = sourceIdentityKeys
	}
	if len(sourceListIDs) > 0 {
		merged["postwave_source_list_ids"] = sourceListIDs
	} else if replaceSourceTags {
		delete(merged, "postwave_source_list_ids")
	}
	if len(tags) > 0 {
		merged["postwave_tags"] = tags
	} else if replaceSourceTags {
		delete(merged, "postwave_tags")
	}
	if _, tracksSourceFields := incoming["postwave_source_field_keys"]; tracksSourceFields || replaceSourceFields {
		merged["postwave_source_field_keys"] = trackedSourceFields
	}
	if len(conflicts) > 0 {
		merged["postwave_field_conflicts"] = conflicts
	} else {
		delete(merged, "postwave_field_conflicts")
	}
	return merged
}

func mergeSourceFieldNameCollisions(existing, incoming interface{}) map[string]interface{} {
	out := cloneSourceFieldNameCollisions(existing)
	for key, values := range cloneSourceFieldNameCollisions(incoming) {
		current := interfaceSlice(out[key])
		for _, value := range interfaceSlice(values) {
			duplicate := false
			for _, prior := range current {
				if reflect.DeepEqual(prior, value) {
					duplicate = true
					break
				}
			}
			if !duplicate {
				current = append(current, value)
			}
		}
		out[key] = current
	}
	return out
}

func cloneSourceFieldNameCollisions(raw interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	switch values := raw.(type) {
	case map[string]interface{}:
		for key, value := range values {
			out[key] = append([]interface{}(nil), interfaceSlice(value)...)
		}
	case map[string][]interface{}:
		for key, value := range values {
			out[key] = append([]interface{}(nil), value...)
		}
	}
	return out
}

func interfaceSlice(value interface{}) []interface{} {
	switch typed := value.(type) {
	case []interface{}:
		return typed
	case nil:
		return nil
	default:
		return []interface{}{typed}
	}
}

func copyAttribs(in map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for key, value := range in {
		out[key] = value
	}
	return out
}

func mergeConsentAttrib(merged, incoming map[string]interface{}, key string) {
	incomingValue, ok := incoming[key]
	if !ok || incomingValue == nil || fmt.Sprint(incomingValue) == "" {
		return
	}
	if key == "postwave_consent_at" {
		existingValue := fmt.Sprint(merged[key])
		incomingTime, incomingErr := time.Parse(time.RFC3339, fmt.Sprint(incomingValue))
		existingTime, existingErr := time.Parse(time.RFC3339, existingValue)
		if existingErr == nil && incomingErr == nil && existingTime.After(incomingTime) {
			return
		}
	}
	merged[key] = incomingValue
}

func stringListFromAttrib(value interface{}) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return []string{v}
	case []string:
		return v
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item == nil {
				continue
			}
			s := strings.TrimSpace(fmt.Sprint(item))
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		s := strings.TrimSpace(fmt.Sprint(v))
		if s == "" {
			return nil
		}
		return []string{s}
	}
}

func intListFromAttrib(value interface{}) []int {
	out := []int{}
	appendValue := func(item interface{}) {
		var parsed int64
		var err error
		switch typed := item.(type) {
		case int:
			parsed = int64(typed)
		case int64:
			parsed = typed
		case float64:
			if typed != float64(int64(typed)) {
				return
			}
			parsed = int64(typed)
		case json.Number:
			parsed, err = typed.Int64()
		default:
			parsed, err = strconv.ParseInt(strings.TrimSpace(fmt.Sprint(item)), 10, 64)
		}
		if err == nil && parsed > 0 && int64(int(parsed)) == parsed {
			out = append(out, int(parsed))
		}
	}
	switch typed := value.(type) {
	case []int:
		for _, item := range typed {
			appendValue(item)
		}
	case []interface{}:
		for _, item := range typed {
			appendValue(item)
		}
	case nil:
	default:
		appendValue(typed)
	}
	return mergeIntUnion(nil, out)
}

func normalizeFieldConflicts(value interface{}) map[string][]interface{} {
	out := map[string][]interface{}{}
	raw, ok := value.(map[string]interface{})
	if !ok {
		if typed, ok := value.(map[string][]interface{}); ok {
			for key, values := range typed {
				for _, item := range values {
					addFieldConflict(out, key, item)
				}
			}
		}
		return out
	}
	for key, values := range raw {
		switch list := values.(type) {
		case []interface{}:
			for _, item := range list {
				addFieldConflict(out, key, item)
			}
		default:
			addFieldConflict(out, key, list)
		}
	}
	return out
}

func addFieldConflict(conflicts map[string][]interface{}, key string, value interface{}) {
	if key == "" || value == nil {
		return
	}
	for _, existing := range conflicts[key] {
		if reflect.DeepEqual(existing, value) {
			return
		}
	}
	conflicts[key] = append(conflicts[key], value)
}

func urlEncode(s string) string {
	r := strings.NewReplacer(" ", "%20", "'", "%27", "=", "%3D")
	return r.Replace(s)
}

type conflictError struct{ status int }

func (e *conflictError) Error() string { return fmt.Sprintf("listmonk conflict: %d", e.status) }

func isConflict(err error) bool {
	if err == nil {
		return false
	}
	var ce *conflictError
	if asConflict(err, &ce) {
		return true
	}
	// Fallback: some Listmonk versions return 400 with a "duplicate" message.
	return strings.Contains(strings.ToLower(err.Error()), "duplicate") ||
		strings.Contains(strings.ToLower(err.Error()), "already exists")
}

func asConflict(err error, target **conflictError) bool {
	for err != nil {
		if v, ok := err.(*conflictError); ok {
			*target = v
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
