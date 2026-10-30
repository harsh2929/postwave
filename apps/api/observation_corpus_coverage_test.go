package main

import (
	"os"
	"strings"
	"testing"
)

// These are the production adapters that intentionally feed F01's
// reclassification corpus. The exhaustive direct-INSERT inventory and the
// reviewed non-engagement/synthetic policies live in
// engagementclassification/writer_coverage_test.go.
//
// The PRD's §19 guarantee is that "any derived layer can be rebuilt from
// raw_event". That is a property of the CORPUS, not of the rebuild code: the
// reclassification worker was correct and complete, and it read from a corpus
// only one of several writers contributed to. A monthly rebuild would have
// produced lower numbers than the live pipeline with nothing to say why —
// the worst shape of wrong, because it looks like a finding.
//
// A source-level composition check complements the package-level exhaustive
// inventory. It does not claim that MCP or lifecycle delegate here: they have
// independent direct writers with fixed non-engagement event types.
func TestComposedEngagementWritersRecordAnObservation(t *testing.T) {
	for _, tc := range []struct{ path, why string }{
		{
			path: "internal/listmonk_events/handler.go",
			why:  "the primary open/click ingest path",
		},
		{
			path: "internal/webhooks/deliverability.go",
			why: "the seven ESP webhooks — bounces, complaints, opens and clicks " +
				"that never touch the Listmonk path",
		},
		{
			path: "internal/subscribers/event_ingest.go",
			why: "RecordSubscriberEvent, including identified first-party " +
				"publictrack events",
		},
		{
			path: "internal/replies/store.go",
			why: "strongly correlated header-classified human replies, which emit " +
				"canonical replied events only with an atomic F01 receipt",
		},
		{
			path: "internal/subscribers/anonymous_events_attribute.go",
			why:  "post-identification attribution of anonymous first-party events",
		},
	} {
		source, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		// Guard the guard: a truncated read would satisfy the check below.
		if len(source) < 2000 {
			t.Fatalf("%s is %d bytes; this assertion would be vacuous", tc.path, len(source))
		}
		if !strings.Contains(string(source), "RecordProviderEvent(") {
			t.Errorf("%s (%s) never calls RecordProviderEvent — events arriving here "+
				"are invisible to reclassification, and a rebuild would silently "+
				"produce a partial corpus", tc.path, tc.why)
		}
	}
}

// All four wirings must guard against the typed nil.
//
// The composition bug was found once and immediately recurred in shape when a
// second path was wired: a nil *Runtime in an interface field is not nil, the
// handler's guard passes, and the insert fails. Every call site goes through a
// converter, and this asserts none revert to a bare assignment.
func TestClassifierWiringsGuardTheTypedNil(t *testing.T) {
	root := readAPICompositionRoot(t)
	body := root.main
	if len(body) < 10000 {
		t.Fatalf("main.go is %d bytes; assertion would be vacuous", len(body))
	}

	for _, wiring := range []string{
		"engagementClassifierForDeps(engagementClassifierRuntime)",
		"espEngagementClassifierForDeps(engagementClassifierRuntime)",
		"subscriberEngagementClassifierForDeps(engagementClassifierRuntime)",
		"replyEngagementClassifierForDeps(",
	} {
		if !strings.Contains(body, wiring) {
			t.Errorf("main.go does not use %s — a bare assignment puts a nil "+
				"*Runtime into a non-nil interface and every event on that path "+
				"fails to persist while the feature is DISABLED", wiring)
		}
	}
	// And no bare assignment survives.
	if strings.Contains(root.all, "EngagementClassifier: engagementClassifierRuntime,") {
		t.Error("a bare EngagementClassifier assignment is back; this is the exact " +
			"typed-nil composition that broke every engagement event with the " +
			"feature turned off")
	}
}
