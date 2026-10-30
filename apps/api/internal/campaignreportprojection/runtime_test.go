// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRuntimeConfigurationIsExplicitAndDefaultClosed(t *testing.T) {
	for _, value := range []string{"", "0", "false", "off", "no"} {
		configuration, err := RuntimeConfigurationFromEnvironment(func(string) string { return value })
		if err != nil || configuration.Enabled {
			t.Fatalf("value=%q configuration=%+v err=%v", value, configuration, err)
		}
	}
	for _, value := range []string{"1", "true", "on", "yes"} {
		configuration, err := RuntimeConfigurationFromEnvironment(func(string) string { return value })
		if err != nil || !configuration.Enabled {
			t.Fatalf("value=%q configuration=%+v err=%v", value, configuration, err)
		}
	}
	if _, err := RuntimeConfigurationFromEnvironment(func(string) string { return "sometimes" }); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid flag error=%v", err)
	}
	if _, err := RuntimeConfigurationFromEnvironment(nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("nil environment reader error=%v", err)
	}
}

func TestRuntimeDisabledAndEligibilityBoundaries(t *testing.T) {
	disabled, err := BuildRuntime(context.Background(), RuntimeConfiguration{}, nil)
	if err != nil || disabled.Enabled() {
		t.Fatalf("disabled runtime=%+v err=%v", disabled, err)
	}
	if err := disabled.ProjectCanonicalEvent(context.Background(), nil, uuid.NewString(), CanonicalEvent{}); !errors.Is(err, ErrRuntimeDisabled) {
		t.Fatalf("disabled projection error=%v", err)
	}

	for _, eventType := range []string{
		"delivered", "opened", "clicked", "bounced", "complained",
		"unsubscribed", "replied", " OPENED ",
	} {
		if !EligibleCanonicalEventType(eventType) {
			t.Errorf("eligible event type %q rejected", eventType)
		}
	}
	for _, eventType := range []string{
		"", "sent", "conversion", "custom", "identified",
		"lifecycle_stage_changed", "sandbox_opened",
	} {
		if EligibleCanonicalEventType(eventType) {
			t.Errorf("ineligible event type %q accepted", eventType)
		}
	}

	// Routing exclusions are no-ops even though no transaction is supplied;
	// an eligible row must validate its complete identity and transaction.
	runtime := &Runtime{enabled: true, repo: &Repo{}}
	if err := runtime.ProjectCanonicalEvent(context.Background(), nil, uuid.NewString(), CanonicalEvent{
		EventRef: EventRef{ID: 1, At: time.Now()}, EventType: "custom", CampaignID: uuid.NewString(),
	}); err != nil {
		t.Fatalf("custom event was not an explicit no-op: %v", err)
	}
	if err := runtime.ProjectCanonicalEvent(context.Background(), nil, uuid.NewString(), CanonicalEvent{
		EventRef: EventRef{ID: 1, At: time.Now()}, EventType: "clicked",
	}); err != nil {
		t.Fatalf("campaign-less event was not an explicit no-op: %v", err)
	}
	if err := runtime.ProjectCanonicalEvent(context.Background(), nil, uuid.NewString(), CanonicalEvent{
		EventRef: EventRef{ID: 1, At: time.Now()}, EventType: "clicked", CampaignID: "bad",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid campaign error=%v", err)
	}
}
