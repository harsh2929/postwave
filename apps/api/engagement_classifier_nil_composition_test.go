package main

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

// A disabled classifier must not reach the ingest handler as a non-nil interface.
//
// The bug this pins: initializeEngagementClassificationRuntime returns a nil
// *Runtime when POSTWAVE_ENABLE_ENGAGEMENT_CLASSIFIER_V2 is unset (the default),
// and a nil POINTER in an INTERFACE field is not a nil interface. The handler's
// nil guard passed, RecordProviderEvent returned ErrRuntimeDisabled, and that
// error was wrapped as a fatal persist failure — so with the feature OFF, every
// engagement event on the Listmonk path failed to persist and the provider
// retried the batch forever.
//
// It was invisible because engagement_classification_composition_test.go sets
// the flag to "true": the only path under test was the working one.
func TestDisabledClassifierIsANilInterfaceNotATypedNil(t *testing.T) {
	var disabled *engagementclassification.Runtime // exactly what the initializer returns when off

	got := engagementClassifierForDeps(disabled)

	if got != nil {
		t.Fatal("a disabled classifier reached the handler as a NON-nil interface " +
			"holding a nil *Runtime. The handler's `!= nil` guard will pass, " +
			"RecordProviderEvent will return ErrRuntimeDisabled, and every " +
			"engagement event on this path will fail to persist.")
	}
	if replyEngagementClassifierForDeps(disabled) != nil {
		t.Fatal("a disabled classifier reached the reply Store as a typed non-nil; " +
			"human replies would fail persistence instead of remaining honestly unprojected")
	}
}

// And an enabled one must still be passed through.
func TestAnEnabledClassifierIsPassedThrough(t *testing.T) {
	enabled := &engagementclassification.Runtime{}
	if engagementClassifierForDeps(enabled) == nil {
		t.Fatal("an enabled classifier was dropped; no event would ever be classified")
	}
	if replyEngagementClassifierForDeps(enabled) == nil {
		t.Fatal("an enabled classifier was dropped from the reply writer")
	}
}
