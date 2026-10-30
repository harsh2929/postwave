// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type populationResolver struct {
	tenant string
	asts   map[string]json.RawMessage
}

func (r populationResolver) ASTForSegment(_ context.Context, tenantID, segmentID string) (json.RawMessage, error) {
	if tenantID != r.tenant {
		return nil, ErrNotFound
	}
	ast, ok := r.asts[segmentID]
	if !ok {
		return nil, ErrNotFound
	}
	return ast, nil
}

func TestCompilePopulationDefinitionScopes(t *testing.T) {
	resolver := populationResolver{tenant: "tenant-1", asts: map[string]json.RawMessage{}}
	ast := json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"example"}`)

	active, err := CompilePopulation(context.Background(), ast, "tenant-1", resolver, DefinitionPopulation(false))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(active.SQL, "subscribers.archived_at IS NULL") {
		t.Fatalf("active definition missing archive gate: %s", active.SQL)
	}
	if strings.Contains(active.SQL, "status = 'enabled'") || strings.Contains(active.SQL, "consent_email_marketing_at") {
		t.Fatalf("definition population unexpectedly contains activation gates: %s", active.SQL)
	}

	historical, err := CompilePopulation(context.Background(), ast, "tenant-1", resolver, DefinitionPopulation(true))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(historical.SQL, "archived_at") {
		t.Fatalf("explicit include-archived definition was narrowed: %s", historical.SQL)
	}
}

func TestCompilePopulationActivationScope(t *testing.T) {
	resolver := populationResolver{tenant: "tenant-1", asts: map[string]json.RawMessage{}}
	predicate, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver, ActivationPopulation(ActivationChannelEmail))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"subscribers.archived_at IS NULL",
		"subscribers.status = 'enabled'",
		"subscribers.consent_email_marketing_at IS NOT NULL",
		"FROM subscriber_emails AS channel_email",
		"channel_email.consent_status = 'subscribed'",
		"channel_email.suppressed = false",
	} {
		if !strings.Contains(predicate.SQL, want) {
			t.Fatalf("activation predicate missing %q: %s", want, predicate.SQL)
		}
	}
	if len(predicate.Args) != 0 {
		t.Fatalf("activation-only args = %#v, want none", predicate.Args)
	}

	sms, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver, ActivationPopulation(ActivationChannelSMS))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sms.SQL, "subscribers.consent_sms_marketing_at IS NOT NULL") {
		t.Fatalf("sms activation missing consent gate: %s", sms.SQL)
	}
	push, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver, ActivationPopulation(ActivationChannelPush))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(push.SQL, "(FALSE)") {
		t.Fatalf("push without a canonical vector must fail closed: %s", push.SQL)
	}
}

func TestCompilePopulationComposedUsesOnlyExecutableArgs(t *testing.T) {
	resolver := populationResolver{
		tenant: "tenant-1",
		asts: map[string]json.RawMessage{
			"base": json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"vip"}`),
		},
	}
	ast := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"base"}`)
	predicate, err := CompilePopulation(context.Background(), ast, "tenant-1", resolver, DefinitionPopulation(false))
	if err != nil {
		t.Fatal(err)
	}
	if len(predicate.Args) != 1 || predicate.Args[0] != "%vip%" {
		t.Fatalf("args = %#v; referenced id must not become an unused bind", predicate.Args)
	}
	if !strings.Contains(predicate.SQL, "$1") || strings.Contains(predicate.SQL, "$2") {
		t.Fatalf("unexpected placeholders: %s", predicate.SQL)
	}
}

func TestCompilePopulationRejectsInvalidOrCrossTenantScope(t *testing.T) {
	resolver := populationResolver{tenant: "tenant-1", asts: map[string]json.RawMessage{}}
	if _, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver,
		PopulationScope{Purpose: PopulationPurposeActivation, IncludeArchived: true, Channel: ActivationChannelEmail}); err == nil {
		t.Fatal("expected activation include-archived rejection")
	}
	if _, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver,
		ActivationPopulation(ActivationChannel("fax"))); err == nil {
		t.Fatal("expected unsupported channel rejection")
	}
	if _, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver,
		PopulationScope{Purpose: PopulationPurposeDefinition, Channel: ActivationChannelEmail}); err == nil {
		t.Fatal("expected definition channel rejection")
	}
	if _, err := CompilePopulation(context.Background(), nil, "tenant-1", resolver, PopulationScope{}); err == nil {
		t.Fatal("expected unknown purpose rejection")
	}
	if _, err := CompilePopulation(context.Background(), nil, "", resolver, DefinitionPopulation(false)); err == nil {
		t.Fatal("expected empty tenant rejection")
	}
	if _, err := CompilePopulation(context.Background(), nil, "tenant-1", nil, DefinitionPopulation(false)); err == nil {
		t.Fatal("expected missing resolver rejection")
	}
	var nilResolver SegmentResolverFunc
	composed := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"missing"}`)
	if _, err := CompilePopulation(context.Background(), composed, "tenant-1", nilResolver, DefinitionPopulation(false)); err == nil || !strings.Contains(err.Error(), "nil resolver function") {
		t.Fatalf("typed nil resolver must fail without panicking, got %v", err)
	}

	crossTenant := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"foreign"}`)
	_, err := CompilePopulation(context.Background(), crossTenant, "tenant-2", resolver, DefinitionPopulation(false))
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected fail-closed cross-tenant not-found, got %v", err)
	}
}
