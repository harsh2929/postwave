// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
)

// The in-app agent must disclose that it is an AI.
//
// `internal/aidisclosure`'s package doc names this surface explicitly: Article
// 50(1) of the EU AI Act — in force 2 August 2026 — requires a system that
// interacts with a natural person to disclose that fact, and the doc points at
// "the in-app agent" as the case. `DisclosureText` was written for it.
//
// `internal/aicompose` marks its generated bodies (`MarkHTML` at handlers.go:103)
// and sets the delivery header. The agent, which is the surface the regulation
// names most directly, referenced the package nowhere at all. One product, one
// obligation, two answers.
//
// Asserted structurally rather than by driving a stream: the property is that
// the disclosure is EMITTED on the conversational surface, and a source-level
// check states that without needing a model, a session and a live SSE client.

func agentSource(t *testing.T) string {
	t.Helper()
	var b strings.Builder
	for _, f := range []string{"handler.go", "agentloop.go"} {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		b.Write(raw)
	}
	return b.String()
}

func TestTheAgentDisclosesThatItIsAnAI(t *testing.T) {
	src := agentSource(t)
	if !strings.Contains(src, "aidisclosure.") {
		t.Fatal("the agent never references internal/aidisclosure. Article 50(1) " +
			"requires a system that interacts with a person to disclose that it is " +
			"AI, the package's own doc names the in-app agent as that case, and " +
			"DisclosureText was written for it and used nowhere.")
	}
	if !strings.Contains(src, "aidisclosure.DisclosureText") {
		t.Error("the agent references the package but not DisclosureText. A " +
			"hand-written notice is a second copy of a legal string that exists " +
			"so counsel can change it in one place.")
	}
}

func TestTheDisclosureIsSentBeforeAnyModelOutput(t *testing.T) {
	// Order is the whole point: a notice that arrives after the answer has not
	// disclosed anything. Asserted on source position so the property survives
	// a refactor of the stream body.
	src := agentSource(t)
	disclosure := strings.Index(src, "aidisclosure.DisclosureText")
	if disclosure < 0 {
		t.Fatal("cannot prove disclosure ordering because the agent does not emit aidisclosure.DisclosureText")
	}
	// The first frame written after the SSE headers.
	headers := strings.Index(src, `"text/event-stream"`)
	if headers < 0 {
		t.Fatal("could not locate the SSE handler")
	}
	loop := regexp.MustCompile(`for\s+\w*\s*:?=?\s*range|agentLoop|RunTurn`).FindStringIndex(src[headers:])
	if loop == nil {
		return // no identifiable turn loop; the presence check above still holds
	}
	if disclosure > headers+loop[0] {
		t.Error("the disclosure is emitted after the turn loop begins; it must " +
			"precede any model output, or it has not disclosed anything")
	}
}

func TestTheDisclosureTextIsNotDuplicated(t *testing.T) {
	// The constant exists so a legal decision changes one string. A copy of the
	// wording inside the agent would drift the moment counsel revises it.
	src := agentSource(t)
	if strings.Contains(src, "You are chatting with an AI assistant") &&
		!strings.Contains(src, "aidisclosure.DisclosureText") {
		t.Error("the agent hard-codes the disclosure wording instead of using " +
			"aidisclosure.DisclosureText")
	}
	_ = aidisclosure.DisclosureText
}
