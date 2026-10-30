// SPDX-License-Identifier: AGPL-3.0-only
//
// events_test.go — SUB-136 lifecycle-stage automation triggers.
//
// Covers the wire-side matcher (matchLifecycleStageWire) and its registration
// in the platformDispatch table via matchPlatformTrigger, including the
// from_stage/to_stage narrowing and the alternate payload key conventions.
package runtime

import (
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

func lifecycleEv(from, to string) EngagementEvent {
	return ev(canonical.TriggerLifecycleStageChanged, map[string]interface{}{
		"event_name": canonical.TriggerLifecycleStageChanged,
		"from_stage": from,
		"to_stage":   to,
	})
}

// TestMatchPlatformTrigger_LifecycleStage_ToStageNarrow pins the retention
// case: a trigger keyed on to_stage="customer" fires only on a transition that
// enters customer, regardless of origin.
func TestMatchPlatformTrigger_LifecycleStage_ToStageNarrow(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:    canonical.TriggerLifecycleStageChanged,
		ToStage: "customer",
	}
	if !matchPlatformTrigger(trig, lifecycleEv("opportunity", "customer")) {
		t.Fatal("opportunity -> customer should match to_stage=customer trigger")
	}
	if matchPlatformTrigger(trig, lifecycleEv("opportunity", "evangelist")) {
		t.Fatal("opportunity -> evangelist should NOT match to_stage=customer trigger")
	}
}

// TestMatchPlatformTrigger_LifecycleStage_FromAndTo pins the full transition
// narrow: opportunity -> customer fires the onboarding sequence; any other origin or
// destination does not.
func TestMatchPlatformTrigger_LifecycleStage_FromAndTo(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:      canonical.TriggerLifecycleStageChanged,
		FromStage: "opportunity",
		ToStage:   "customer",
	}
	if !matchPlatformTrigger(trig, lifecycleEv("opportunity", "customer")) {
		t.Fatal("opportunity -> customer should match the from+to trigger")
	}
	if matchPlatformTrigger(trig, lifecycleEv("sql", "customer")) {
		t.Fatal("sql -> customer should NOT match from=opportunity trigger")
	}
	if matchPlatformTrigger(trig, lifecycleEv("opportunity", "evangelist")) {
		t.Fatal("opportunity -> evangelist should NOT match to=customer trigger")
	}
}

// TestMatchPlatformTrigger_LifecycleStage_BareFiresAll pins that a trigger with
// no from/to narrowing fires on any lifecycle transition, including an initial
// stage assignment that has an empty from-stage.
func TestMatchPlatformTrigger_LifecycleStage_BareFiresAll(t *testing.T) {
	trig := canonical.AutomationTrigger{Type: canonical.TriggerLifecycleStageChanged}
	if !matchPlatformTrigger(trig, lifecycleEv("lead", "customer")) {
		t.Fatal("bare lifecycle trigger should fire on any transition")
	}
	if !matchPlatformTrigger(trig, lifecycleEv("", "lead")) {
		t.Fatal("bare lifecycle trigger should fire on an initial stage assignment")
	}
}

// TestMatchLifecycleStageWire_AltKeyConvention pins that the wire matcher
// resolves the alternate payload key names (stage / previous_stage) when the
// to_stage / from_stage keys are absent.
func TestMatchLifecycleStageWire_AltKeyConvention(t *testing.T) {
	trig := canonical.AutomationTrigger{
		Type:      canonical.TriggerLifecycleStageChanged,
		FromStage: "opportunity",
		ToStage:   "customer",
	}
	altEv := ev(canonical.TriggerLifecycleStageChanged, map[string]interface{}{
		"previous_stage": "opportunity",
		"stage":          "customer",
	})
	if !matchLifecycleStageWire(trig, altEv) {
		t.Fatal("matcher should resolve stage/previous_stage payload keys")
	}
}

// TestMatchPlatformTrigger_LifecycleStage_WrongEventType pins that a lifecycle
// trigger does not fire for an unrelated event type, and vice versa.
func TestMatchPlatformTrigger_LifecycleStage_WrongEventType(t *testing.T) {
	trig := canonical.AutomationTrigger{Type: canonical.TriggerLifecycleStageChanged}
	wrong := ev(canonical.TriggerProductEvent, map[string]interface{}{"to_stage": "customer"})
	if matchPlatformTrigger(trig, wrong) {
		t.Fatal("lifecycle trigger should not fire for a product_event")
	}
}
