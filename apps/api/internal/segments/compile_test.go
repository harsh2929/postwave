package segments

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileASTNullComparators(t *testing.T) {
	cases := []struct {
		name       string
		raw        json.RawMessage
		wantSuffix string
	}{
		{
			name:       "deterministic never-opened predicate",
			raw:        json.RawMessage(`{"op":"condition","field":"last_opened_at","comparator":"is_null"}`),
			wantSuffix: " IS NULL",
		},
		{
			name:       "non-null engagement predicate",
			raw:        json.RawMessage(`{"op":"condition","field":"last_opened_at","comparator":"is_not_null"}`),
			wantSuffix: " IS NOT NULL",
		},
		{
			name:       "consent timestamp scalar path",
			raw:        json.RawMessage(`{"op":"condition","field":"consent.ai_processing_at","comparator":"is_null"}`),
			wantSuffix: " IS NULL",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fragment, args, err := CompileAST(tc.raw)
			if err != nil {
				t.Fatalf("CompileAST: %v", err)
			}
			if !strings.HasSuffix(fragment, tc.wantSuffix) {
				t.Fatalf("fragment = %q, want suffix %q", fragment, tc.wantSuffix)
			}
			if len(args) != 0 {
				t.Fatalf("null comparator emitted args: %#v", args)
			}
		})
	}
}

func TestCompileASTRollingWindowsUseParameterizedIntervals(t *testing.T) {
	cases := []struct {
		name    string
		raw     json.RawMessage
		wantSQL []string
		wantArg any
	}{
		{
			name:    "recent open",
			raw:     json.RawMessage(`{"op":"condition","field":"last_opened_at","comparator":"in_last_days","value":7}`),
			wantSQL: []string{"make_interval", "days => $1::int", ">= now() -"},
			wantArg: 7,
		},
		{
			name:    "no recent click includes never clicked",
			raw:     json.RawMessage(`{"op":"condition","field":"last_clicked_at","comparator":"more_than_days_ago","value":30}`),
			wantSQL: []string{"IS NULL OR", "make_interval", "days => $1::int"},
			wantArg: 30,
		},
		{
			name:    "subscriber created recently",
			raw:     json.RawMessage(`{"op":"condition","field":"created_at","comparator":"gte","value":"now-7d"}`),
			wantSQL: []string{"subscribers.created_at", "make_interval", "days => $1::int"},
			wantArg: 7,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fragment, args, err := CompileAST(tc.raw)
			if err != nil {
				t.Fatalf("CompileAST: %v", err)
			}
			for _, want := range tc.wantSQL {
				if !strings.Contains(fragment, want) {
					t.Fatalf("fragment %q missing %q", fragment, want)
				}
			}
			if len(args) != 1 || args[0] != tc.wantArg {
				t.Fatalf("args = %#v, want [%v]", args, tc.wantArg)
			}
		})
	}
}

func TestCompileASTTagAddedInLastDays(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"tags","comparator":"added_in_last_days","value":{"tag":"vip","days":30}}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "FROM tag_history h") {
		t.Fatalf("fragment did not reference tag_history: %s", frag)
	}
	if !strings.Contains(frag, "h.action = $") {
		t.Fatalf("fragment did not parameterise action: %s", frag)
	}
	if !strings.Contains(frag, "h.occurred_at > now() - ") {
		t.Fatalf("fragment did not use a relative interval: %s", frag)
	}
	if len(args) != 3 {
		t.Fatalf("expected 3 args (tag, action, interval), got %d: %#v", len(args), args)
	}
	if args[0] != "vip" {
		t.Fatalf("expected first arg to be tag name 'vip', got %#v", args[0])
	}
	if args[1] != "tag_added" {
		t.Fatalf("expected second arg to be 'tag_added', got %#v", args[1])
	}
	if args[2] != "30 days" {
		t.Fatalf("expected third arg to be '30 days', got %#v", args[2])
	}
}

func TestCompileASTTagRemovedInLastDays(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"tags","comparator":"removed_in_last_days","value":{"tag":"newsletter","days":7}}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "FROM tag_history h") {
		t.Fatalf("fragment did not reference tag_history: %s", frag)
	}
	if len(args) != 3 || args[1] != "tag_removed" {
		t.Fatalf("expected action='tag_removed' in args, got %#v", args)
	}
	if args[0] != "newsletter" || args[2] != "7 days" {
		t.Fatalf("unexpected args: %#v", args)
	}
}

func TestCompileASTTagAddedInLastDaysZeroEdge(t *testing.T) {
	// N=0 should compile to a no-rows guard so the editor's transient
	// zero state doesn't accidentally match every subscriber.
	raw := json.RawMessage(`{"op":"condition","field":"tags","comparator":"added_in_last_days","value":{"tag":"vip","days":0}}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(frag) != "FALSE" {
		t.Fatalf("expected FALSE for zero-day window, got %q", frag)
	}
	if len(args) != 0 {
		t.Fatalf("expected no placeholders for FALSE fragment, got %#v", args)
	}
}

func TestCompileASTTagLifecycleStringShorthand(t *testing.T) {
	// "<tag>:<days>" shorthand for CLI/tests.
	raw := json.RawMessage(`{"op":"condition","field":"tags","comparator":"added_in_last_days","value":"vip:14"}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "tag_history") {
		t.Fatalf("shorthand did not compile to tag_history EXISTS: %s", frag)
	}
	if len(args) != 3 || args[0] != "vip" || args[2] != "14 days" {
		t.Fatalf("shorthand args mismatch: %#v", args)
	}
}

func TestCompileASTTagUnknownComparator(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"tags","comparator":"never_added","value":"vip"}`)
	_, _, err := CompileAST(raw)
	if err == nil {
		t.Fatal("expected error for unknown tag comparator")
	}
	if !strings.Contains(err.Error(), "unsupported comparator") {
		t.Fatalf("expected unsupported-comparator error, got %v", err)
	}
}

func TestSchemaIncludesTagLifecycleComparators(t *testing.T) {
	fields := BaseFieldSchemas()
	var tagField *FieldSchema
	for i := range fields {
		if fields[i].Key == "tags" {
			tagField = &fields[i]
			break
		}
	}
	if tagField == nil {
		t.Fatal("schema is missing the 'tags' field entry")
	}
	want := map[string]bool{
		"added_in_last_days":   false,
		"removed_in_last_days": false,
	}
	for _, c := range tagField.Comparators {
		if _, ok := want[c]; ok {
			want[c] = true
		}
	}
	for k, ok := range want {
		if !ok {
			t.Errorf("tag schema missing comparator %q", k)
		}
	}
}

// SUB-011: a custom_object predicate must compile to a profile-link-scoped
// EXISTS subquery so the segment resolves against the subscriber's linked
// records (profile_object_links), not every record in the tenant.
func TestCompileAST_CustomObjectLinkedToProfile(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"custom_object.order.total","comparator":"gte","value":100}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(frag, "FROM profile_object_links pol") {
		t.Fatalf("fragment must scope through profile_object_links: %s", frag)
	}
	if !strings.Contains(frag, "pol.subscriber_id = subscribers.id") {
		t.Fatalf("fragment must scope to the subscriber's own links: %s", frag)
	}
	if !strings.Contains(frag, "EXISTS") || !strings.Contains(frag, "::numeric") {
		t.Fatalf("fragment must be a numeric EXISTS test: %s", frag)
	}
	// Args: object type key "order", property "total", value "100".
	if len(args) != 3 {
		t.Fatalf("expected 3 args (key, property, value), got %d: %#v", len(args), args)
	}
	if args[0] != "order" || args[1] != "total" {
		t.Fatalf("args[0]/args[1] = %v/%v, want order/total", args[0], args[1])
	}
	// Placeholders must be renumbered to the outer compiler's running index
	// ($1..$3), not the plug-in's relative $1..$N — assert no stale $1 ref
	// duplicate by checking the highest placeholder is $3.
	if !strings.Contains(frag, "$3") {
		t.Fatalf("expected renumbered $3 placeholder in fragment: %s", frag)
	}
}

// A bare custom_object.<type> existence predicate compiles too, scoped to
// the subscriber's links.
func TestCompileAST_CustomObjectExists(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"custom_object.wishlist","comparator":"exists"}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(frag), "EXISTS") {
		t.Fatalf("exists must compile to EXISTS: %s", frag)
	}
	if !strings.Contains(frag, "pol.subscriber_id = subscribers.id") {
		t.Fatalf("exists must scope to profile links: %s", frag)
	}
	if len(args) != 1 || args[0] != "wishlist" {
		t.Fatalf("exists args = %#v, want [wishlist]", args)
	}
}

// not_exists must invert to NOT EXISTS, still scoped to profile links.
func TestCompileAST_CustomObjectNotExists(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"custom_object.order","comparator":"not_exists"}`)
	frag, _, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(frag, "NOT EXISTS") {
		t.Fatalf("not_exists must compile to NOT EXISTS: %s", frag)
	}
	if !strings.Contains(frag, "pol.subscriber_id = subscribers.id") {
		t.Fatalf("not_exists must scope to profile links: %s", frag)
	}
}

// Security pin: a malicious custom_object value must never be inlined into
// the compiled SQL — it must flow through a placeholder.
func TestCompileAST_CustomObjectValueParameterised(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"custom_object.order.status","comparator":"equals","value":"'; DROP TABLE subscribers; --"}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(frag, "DROP TABLE") {
		t.Fatalf("customer value leaked into SQL: %s", frag)
	}
	found := false
	for _, a := range args {
		if a == "'; DROP TABLE subscribers; --" {
			found = true
		}
	}
	if !found {
		t.Fatalf("value must be carried as a bound arg, got %#v", args)
	}
}

// --- SUB-051: channel-consent-aware segment evaluation ---------------

// TestCompileChannelConsentEmail: channel_consent.email equals true →
// the email consent-vector column IS NOT NULL, arg-free (the predicate
// is a static column test, not a bound value).
func TestCompileChannelConsentEmail(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"channel_consent.email","comparator":"equals","value":true}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_email_marketing_at IS NOT NULL") {
		t.Fatalf("fragment did not gate on email consent: %s", frag)
	}
	if len(args) != 0 {
		t.Fatalf("channel_consent predicate must be arg-free, got %#v", args)
	}
}

// TestCompileChannelConsentEmailNotEquals: not_equals true negates the whole
// canonical-address eligibility invariant (the "cannot receive" branch).
func TestCompileChannelConsentEmailNotEquals(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"channel_consent.email","comparator":"not_equals","value":true}`)
	frag, _, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "NOT (subscribers.consent_email_marketing_at IS NOT NULL AND EXISTS") ||
		!strings.Contains(frag, "FROM subscriber_emails AS channel_email") {
		t.Fatalf("not_equals did not negate the combined eligibility invariant: %s", frag)
	}
}

// TestCompileChannelConsentSMS: channel_consent.sms equals true → the SMS
// consent-vector column IS NOT NULL.
func TestCompileChannelConsentSMS(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"channel_consent.sms","comparator":"equals","value":true}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "consent_sms_marketing_at IS NOT NULL") {
		t.Fatalf("fragment did not gate on sms consent: %s", frag)
	}
	if len(args) != 0 {
		t.Fatalf("channel_consent predicate must be arg-free, got %#v", args)
	}
}

// TestCompileChannelConsentPush: push has no consent-vector column yet, so
// "can receive" (equals true) compiles to a deterministic FALSE rather
// than silently matching the whole base; not_equals true → TRUE.
func TestCompileChannelConsentPush(t *testing.T) {
	rawTrue := json.RawMessage(`{"op":"condition","field":"channel_consent.push","comparator":"equals","value":true}`)
	frag, _, err := CompileAST(rawTrue)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(frag) != "FALSE" {
		t.Fatalf("push can-receive must compile to FALSE, got: %s", frag)
	}
	rawFalse := json.RawMessage(`{"op":"condition","field":"channel_consent.push","comparator":"not_equals","value":true}`)
	frag2, _, err := CompileAST(rawFalse)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(frag2) != "TRUE" {
		t.Fatalf("push cannot-receive must compile to TRUE, got: %s", frag2)
	}
}

// TestCompileChannelConsentUnknownChannelErrors: an unsupported channel
// surfaces as a compile error rather than a silent pass-through.
func TestCompileChannelConsentUnknownChannelErrors(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"channel_consent.carrier_pigeon","comparator":"equals","value":true}`)
	if _, _, err := CompileAST(raw); err == nil {
		t.Fatalf("expected error for unsupported channel")
	}
}

// TestSchemaIncludesChannelConsentFields pins the schema_handler additions
// so the builder can render the new gates.
func TestSchemaIncludesChannelConsentFields(t *testing.T) {
	fields := BaseFieldSchemas()
	want := map[string]bool{
		"channel_consent.email": false,
		"channel_consent.sms":   false,
		"channel_consent.push":  false,
	}
	for _, f := range fields {
		if _, ok := want[f.Key]; ok {
			if f.Type != "boolean" {
				t.Errorf("%s: want type=boolean, got %q", f.Key, f.Type)
			}
			want[f.Key] = true
		}
	}
	for k, ok := range want {
		if !ok {
			t.Errorf("schema missing %s", k)
		}
	}
}

/* ------- SUB-032: composable segment-of-segments ------------------ */

// fakeSegmentResolver is an in-memory SegmentResolver for the composable
// predicate tests. asts maps segment id → stored query_ast JSON; a
// missing id yields ErrNotFound (mirroring Repo.Get).
type fakeSegmentResolver struct {
	asts map[string]string
}

func (f *fakeSegmentResolver) ASTForSegment(_ context.Context, _ string, segmentID string) (json.RawMessage, error) {
	raw, ok := f.asts[segmentID]
	if !ok {
		return nil, ErrNotFound
	}
	return json.RawMessage(raw), nil
}

func TestCompileComposableInSegmentResolves(t *testing.T) {
	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-a": `{"op":"condition","field":"status","comparator":"equals","value":"subscribed"}`,
	}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`)
	frag, args, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag, "EXISTS") {
		t.Fatalf("expected EXISTS correlated subquery, got: %s", frag)
	}
	if !strings.Contains(frag, "subscribers.status = $1") {
		t.Fatalf("expected inner placeholder to start at $1: %s", frag)
	}
	if len(args) != 1 || args[0] != "subscribed" {
		t.Fatalf("args = %#v", args)
	}
}

func TestCompileComposableNotInSegmentResolves(t *testing.T) {
	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-a": `{"op":"condition","field":"status","comparator":"equals","value":"bounced"}`,
	}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"not_in_segment","value":{"segment_id":"seg-a"}}`)
	frag, _, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(frag, "NOT EXISTS") {
		t.Fatalf("expected NOT EXISTS, got: %s", frag)
	}
}

func TestCompileComposableNestedWithinDepthLimit(t *testing.T) {
	// seg-a references seg-b (depth 2 total) — allowed at MaxComposableDepth=2.
	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-a": `{"op":"and","children":[{"op":"condition","field":"status","comparator":"equals","value":"subscribed"},{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-b"}]}`,
		"seg-b": `{"op":"condition","field":"email","comparator":"contains","value":"acme"}`,
	}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`)
	frag, args, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver)
	if err != nil {
		t.Fatalf("nested-within-limit should compile: %v (frag=%s)", err, frag)
	}
	// Two EXISTS clauses: the outer seg-a and the nested seg-b.
	if strings.Count(frag, "EXISTS") < 2 {
		t.Fatalf("expected nested EXISTS, got: %s", frag)
	}
	// Referenced ids are resolver inputs, not unused SQL bind parameters.
	if len(args) != 2 || args[0] != "subscribed" || args[1] != "%acme%" {
		t.Fatalf("expected only executable predicate args, got %#v", args)
	}
}

func TestCompileComposableRejectsReferenceCycle(t *testing.T) {
	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-a": `{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-b"}`,
		"seg-b": `{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`,
	}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`)
	_, _, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver)
	if err == nil || !strings.Contains(err.Error(), "reference cycle") {
		t.Fatalf("expected explicit cycle error, got %v", err)
	}
}

func TestCompileComposableExceedsDepthLimit(t *testing.T) {
	// seg-a → seg-b → seg-c is 3 hops; MaxComposableDepth=2 must reject.
	resolver := &fakeSegmentResolver{asts: map[string]string{
		"seg-a": `{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-b"}`,
		"seg-b": `{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-c"}`,
		"seg-c": `{"op":"condition","field":"status","comparator":"equals","value":"subscribed"}`,
	}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`)
	if _, _, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver); err == nil {
		t.Fatal("expected depth-limit error for 3-hop nesting")
	}
}

func TestCompileComposableUnknownSegment(t *testing.T) {
	resolver := &fakeSegmentResolver{asts: map[string]string{}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"missing"}`)
	_, _, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver)
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected not-found error, got: %v", err)
	}
}

func TestCompileComposableWithoutResolverErrors(t *testing.T) {
	// The plain CompileAST path has no resolver; a segment_id predicate
	// must surface ErrComposableUnsupported rather than nil-deref.
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"seg-a"}`)
	_, _, err := CompileAST(raw)
	if err == nil {
		t.Fatal("expected error compiling segment_id without resolver")
	}
}

func TestCompileComposableRejectsBadComparator(t *testing.T) {
	resolver := &fakeSegmentResolver{asts: map[string]string{"seg-a": "{}"}}
	raw := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"equals","value":"seg-a"}`)
	if _, _, err := CompileASTWithResolver(context.Background(), raw, "tenant-1", resolver); err == nil {
		t.Fatal("expected error for unsupported comparator on segment_id")
	}
}
