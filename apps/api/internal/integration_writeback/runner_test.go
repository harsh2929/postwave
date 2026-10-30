// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeStore struct {
	target   Target
	members  []AudienceMember
	recorded RunSummary
	statusTo string
}

func (f *fakeStore) ListTargets(context.Context, string) ([]Target, error) {
	return []Target{f.target}, nil
}
func (f *fakeStore) GetTarget(context.Context, string, string) (*Target, error) {
	t := f.target
	return &t, nil
}
func (f *fakeStore) UpsertTarget(_ context.Context, _ string, in TargetInput) (*Target, error) {
	f.target.Provider = in.Provider
	f.target.Name = in.Name
	f.target.Settings = in.Settings
	return &f.target, nil
}
func (f *fakeStore) SetTargetStatus(_ context.Context, _, _, status string) (*Target, error) {
	f.statusTo = status
	f.target.Status = status
	return &f.target, nil
}
func (f *fakeStore) RecordRun(_ context.Context, _, targetID, _ string, s RunSummary, started, completed time.Time) (*Run, error) {
	f.recorded = s
	return &Run{ID: "run_1", TargetID: targetID, Status: s.Status, MembersSeen: s.MembersSeen,
		Matched: s.Matched, TagsWritten: s.TagsWritten, FieldsWritten: s.FieldsWritten,
		RowsFailed: s.RowsFailed, ErrorMessage: s.ErrorMessage, StartedAt: started, CompletedAt: &completed}, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]Run, error) { return nil, nil }
func (f *fakeStore) ResolveAudience(context.Context, string, *Target) ([]AudienceMember, error) {
	return f.members, nil
}

type fakeAdapter struct {
	provider string
	calls    []ProfileWrite
	matchAll bool
	err      error
}

func (a *fakeAdapter) Provider() string { return a.provider }
func (a *fakeAdapter) WriteProfile(_ context.Context, _ map[string]string, _ map[string]any, p ProfileWrite) (WriteResult, error) {
	a.calls = append(a.calls, p)
	if a.err != nil {
		return WriteResult{}, a.err
	}
	if !a.matchAll {
		return WriteResult{Matched: false}, nil
	}
	return WriteResult{Matched: true, TagsWritten: len(p.Tags), FieldsWritten: len(p.Fields)}, nil
}

type stubCreds struct{}

func (stubCreds) Resolve(context.Context, string) (map[string]string, error) {
	return map[string]string{"token": "t"}, nil
}

func fixedNow() time.Time { return time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC) }

func newDeps(store *fakeStore, adapter *fakeAdapter) *Deps {
	return &Deps{
		Repo:        store,
		Credentials: stubCreds{},
		Adapters:    map[string]Adapter{adapter.provider: adapter},
		Now:         fixedNow,
	}
}

func TestRunWritebackAppliesTagsToAudience(t *testing.T) {
	store := &fakeStore{
		target: Target{ID: "t1", TenantID: "tenant-1", Provider: ProviderShopify, Status: "active", CredentialsRef: "vault://x",
			Settings: map[string]any{"source_segment_id": "seg1", "shop_domain": "acme", "tags": []any{"Moosewave-VIP"}, "field_map": map[string]any{"clv_tier": "gold"}}},
		members: []AudienceMember{{Email: "a@x.com"}, {Email: "b@x.com"}},
	}
	adapter := &fakeAdapter{provider: ProviderShopify, matchAll: true}
	summary, run, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if summary.MembersSeen != 2 || summary.Matched != 2 || summary.TagsWritten != 2 || summary.FieldsWritten != 2 || summary.Status != "completed" {
		t.Fatalf("summary=%+v", summary)
	}
	if len(adapter.calls) != 2 || len(adapter.calls[0].Tags) != 1 || adapter.calls[0].Tags[0] != "Moosewave-VIP" {
		t.Fatalf("adapter calls=%+v", adapter.calls)
	}
	if adapter.calls[0].Fields["clv_tier"] != "gold" {
		t.Fatalf("field_map not applied: %+v", adapter.calls[0].Fields)
	}
	if run == nil || run.ID != "run_1" || store.recorded.Matched != 2 {
		t.Fatalf("run not recorded: %+v / %+v", run, store.recorded)
	}
}

func TestRunWritebackUnmatchedMembersAreNotFailures(t *testing.T) {
	store := &fakeStore{
		target:  Target{ID: "t1", Provider: ProviderHubSpot, Status: "active", CredentialsRef: "v", Settings: map[string]any{"source_list_id": "l1"}},
		members: []AudienceMember{{Email: "ghost@x.com"}},
	}
	adapter := &fakeAdapter{provider: ProviderHubSpot, matchAll: false}
	summary, _, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Matched != 0 || summary.RowsFailed != 0 || summary.Status != "completed" {
		t.Fatalf("an unmatched member must not be a failure: %+v", summary)
	}
}

func TestRunWritebackRefusesPausedTarget(t *testing.T) {
	store := &fakeStore{target: Target{ID: "t1", Provider: ProviderShopify, Status: "paused", CredentialsRef: "v"}}
	adapter := &fakeAdapter{provider: ProviderShopify}
	if _, _, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual"); err == nil {
		t.Fatal("expected an error running a paused target")
	}
}

func TestRunWritebackNoAdapter(t *testing.T) {
	store := &fakeStore{target: Target{ID: "t1", Provider: ProviderSalesforce, Status: "active", CredentialsRef: "v"}}
	adapter := &fakeAdapter{provider: ProviderShopify} // wrong provider registered
	if _, _, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual"); err == nil {
		t.Fatal("expected an error when no adapter is wired for the provider")
	}
}

// fakeBatchAdapter implements both Adapter and Batcher so we can assert the
// runner prefers the bulk path.
type fakeBatchAdapter struct {
	provider    string
	writeCalls  int
	batchCalls  int
	batchSize   int
	gotProfiles []ProfileWrite
	result      BatchResult
}

func (a *fakeBatchAdapter) Provider() string { return a.provider }
func (a *fakeBatchAdapter) WriteProfile(_ context.Context, _ map[string]string, _ map[string]any, _ ProfileWrite) (WriteResult, error) {
	a.writeCalls++
	return WriteResult{Matched: true}, nil
}
func (a *fakeBatchAdapter) BatchWrite(_ context.Context, _ map[string]string, _ map[string]any, profiles []ProfileWrite) (BatchResult, error) {
	a.batchCalls++
	a.batchSize = len(profiles)
	a.gotProfiles = profiles
	return a.result, nil
}

func batchDeps(store *fakeStore, adapter *fakeBatchAdapter) *Deps {
	return &Deps{
		Repo:        store,
		Credentials: stubCreds{},
		Adapters:    map[string]Adapter{adapter.provider: adapter},
		Now:         fixedNow,
	}
}

func TestRunWritebackUsesBatcherForMultiMember(t *testing.T) {
	store := &fakeStore{
		target:  Target{ID: "t1", Provider: ProviderHubSpot, Status: "active", CredentialsRef: "v", Settings: map[string]any{"source_segment_id": "seg1"}},
		members: []AudienceMember{{Email: "a@x.com"}, {Email: "b@x.com"}, {Email: "c@x.com"}},
	}
	adapter := &fakeBatchAdapter{provider: ProviderHubSpot, result: BatchResult{Matched: 3, TagsWritten: 3, FieldsWritten: 6}}
	summary, _, err := batchDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if adapter.batchCalls != 1 || adapter.writeCalls != 0 {
		t.Fatalf("expected the batch path (batch=1 write=0), got batch=%d write=%d", adapter.batchCalls, adapter.writeCalls)
	}
	if adapter.batchSize != 3 {
		t.Fatalf("batch must receive all 3 members at once, got %d", adapter.batchSize)
	}
	if summary.Matched != 3 || summary.TagsWritten != 3 || summary.FieldsWritten != 6 {
		t.Fatalf("batch result not folded into summary: %+v", summary)
	}
}

func TestRunWritebackBatchPartialFailure(t *testing.T) {
	store := &fakeStore{
		target:  Target{ID: "t1", Provider: ProviderHubSpot, Status: "active", CredentialsRef: "v", Settings: map[string]any{"source_segment_id": "seg1"}},
		members: []AudienceMember{{Email: "a@x.com"}, {Email: "b@x.com"}, {Email: "c@x.com"}},
	}
	adapter := &fakeBatchAdapter{provider: ProviderHubSpot, result: BatchResult{Matched: 2, TagsWritten: 2, FieldsWritten: 4, RowsFailed: 1}}
	summary, _, err := batchDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual")
	if err != nil {
		t.Fatal(err)
	}
	// A batch with failures marks the run partial (mirrors the sequential path) and
	// still accrues the matched/written counts.
	if summary.Status != "partial" || summary.RowsFailed != 1 || summary.Matched != 2 || summary.FieldsWritten != 4 {
		t.Fatalf("batch partial not folded correctly: %+v", summary)
	}
}

func TestRunWritebackBatchMapsPerMemberTraits(t *testing.T) {
	store := &fakeStore{
		target: Target{ID: "t1", Provider: ProviderHubSpot, Status: "active", CredentialsRef: "v",
			Settings: map[string]any{
				"source_segment_id": "seg1",
				"field_map":         map[string]any{"source": "postwave"},
				"trait_field_map":   map[string]any{"clv": "lifetime_value"},
			}},
		members: []AudienceMember{
			{Email: "vip@x.com", Traits: map[string]any{"lifetime_value": 1240.0}},
			{Email: "new@x.com", Traits: map[string]any{"lifetime_value": 12.5}},
		},
	}
	adapter := &fakeBatchAdapter{provider: ProviderHubSpot, result: BatchResult{Matched: 2}}
	if _, _, err := batchDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual"); err != nil {
		t.Fatal(err)
	}
	if len(adapter.gotProfiles) != 2 {
		t.Fatalf("batch should receive 2 resolved profiles, got %d", len(adapter.gotProfiles))
	}
	byEmail := map[string]ProfileWrite{}
	for _, p := range adapter.gotProfiles {
		byEmail[p.Email] = p
	}
	// The same per-member trait resolution the sequential path uses must apply to
	// the batch path too — each member carries its OWN computed trait value.
	if byEmail["vip@x.com"].Fields["clv"] != "1240" || byEmail["vip@x.com"].Fields["source"] != "postwave" {
		t.Fatalf("vip batch profile fields wrong: %+v", byEmail["vip@x.com"].Fields)
	}
	if byEmail["new@x.com"].Fields["clv"] != "12.5" {
		t.Fatalf("new batch profile fields wrong: %+v", byEmail["new@x.com"].Fields)
	}
}

func TestRunWritebackSingleMemberStaysSequential(t *testing.T) {
	store := &fakeStore{
		target:  Target{ID: "t1", Provider: ProviderHubSpot, Status: "active", CredentialsRef: "v", Settings: map[string]any{"source_segment_id": "seg1"}},
		members: []AudienceMember{{Email: "solo@x.com"}},
	}
	adapter := &fakeBatchAdapter{provider: ProviderHubSpot}
	if _, _, err := batchDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual"); err != nil {
		t.Fatal(err)
	}
	// One member isn't worth a bulk round-trip — the sequential path runs.
	if adapter.writeCalls != 1 || adapter.batchCalls != 0 {
		t.Fatalf("single member should use WriteProfile (write=1 batch=0), got write=%d batch=%d", adapter.writeCalls, adapter.batchCalls)
	}
}

func TestRunWritebackMapsPerMemberTraits(t *testing.T) {
	// trait_field_map resolves THIS member's own traits into platform fields,
	// overlaid on a static field_map default — the Klaviyo-class behaviour. Two
	// members with different traits must produce different field payloads.
	store := &fakeStore{
		target: Target{ID: "t1", Provider: ProviderShopify, Status: "active", CredentialsRef: "v",
			Settings: map[string]any{
				"source_segment_id": "seg1",
				"field_map":         map[string]any{"source": "postwave"},
				"trait_field_map":   map[string]any{"clv": "lifetime_value", "tier": "loyalty_tier"},
			}},
		members: []AudienceMember{
			{Email: "vip@x.com", Traits: map[string]any{"lifetime_value": 1240.0, "loyalty_tier": "gold"}},
			{Email: "new@x.com", Traits: map[string]any{"lifetime_value": 12.5}}, // no loyalty_tier
		},
	}
	adapter := &fakeAdapter{provider: ProviderShopify, matchAll: true}
	if _, _, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual"); err != nil {
		t.Fatal(err)
	}
	if len(adapter.calls) != 2 {
		t.Fatalf("want 2 adapter calls, got %d", len(adapter.calls))
	}
	vip := adapter.calls[0].Fields
	if vip["source"] != "postwave" || vip["clv"] != "1240" || vip["tier"] != "gold" {
		t.Fatalf("vip fields wrong (whole-number float must render 1240, not 1240.0): %+v", vip)
	}
	newby := adapter.calls[1].Fields
	if newby["clv"] != "12.5" {
		t.Fatalf("fractional clv should render 12.5: %+v", newby)
	}
	if _, present := newby["tier"]; present {
		t.Fatalf("a missing trait must not write the field at all: %+v", newby)
	}
	if newby["source"] != "postwave" {
		t.Fatalf("static field_map default must survive for every member: %+v", newby)
	}
}

func TestResolveMemberFieldsAndStringify(t *testing.T) {
	traits := map[string]any{"n": 7.0, "f": 3.14, "b": true, "s": " hi ", "z": float64(0)}
	got := resolveMemberFields(
		map[string]string{"const": "k"},
		map[string]string{"N": "n", "F": "f", "B": "b", "S": "s", "Z": "z", "Missing": "nope"},
		traits,
	)
	want := map[string]string{"const": "k", "N": "7", "F": "3.14", "B": "true", "S": "hi", "Z": "0"}
	if len(got) != len(want) {
		t.Fatalf("got %+v want %+v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("field %q = %q, want %q", k, got[k], v)
		}
	}
	if _, ok := got["Missing"]; ok {
		t.Errorf("absent trait must not produce a field: %+v", got)
	}
}

func TestBuildTraitsReservedKeys(t *testing.T) {
	ts := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	tr := buildTraits([]byte(`{"plan":"pro"}`), []string{"a", "b"}, "enabled", &ts)
	if tr["plan"] != "pro" {
		t.Errorf("custom field lost: %+v", tr)
	}
	if tr["_tags"] != "a,b" || tr["tags"] != "a,b" {
		t.Errorf("tags reserved key wrong: %+v", tr)
	}
	if tr["_status"] != "enabled" || tr["status"] != "enabled" {
		t.Errorf("status reserved key wrong: %+v", tr)
	}
	if tr["_consent_timestamp"] != "2026-06-01T09:00:00Z" {
		t.Errorf("consent ts wrong: %+v", tr)
	}
	// A tenant's own custom field must win over the bare alias.
	tr2 := buildTraits([]byte(`{"status":"custom-val"}`), nil, "enabled", nil)
	if tr2["status"] != "custom-val" {
		t.Errorf("custom field should win over bare alias: %+v", tr2)
	}
	if tr2["_status"] != "enabled" {
		t.Errorf("reserved _status should still reflect the column: %+v", tr2)
	}
}

func TestRunWritebackPartialOnAdapterError(t *testing.T) {
	store := &fakeStore{
		target:  Target{ID: "t1", Provider: ProviderShopify, Status: "active", CredentialsRef: "v", Settings: map[string]any{"source_list_id": "l1", "tags": []any{"X"}}},
		members: []AudienceMember{{Email: "a@x.com"}},
	}
	adapter := &fakeAdapter{provider: ProviderShopify, err: errors.New("429 throttled")}
	summary, _, err := newDeps(store, adapter).RunWriteback(context.Background(), "tenant-1", "t1", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if summary.RowsFailed != 1 || summary.Status != "failed" {
		t.Fatalf("expected failed status when the only member errors: %+v", summary)
	}
}
