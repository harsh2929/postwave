// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// This is the fail-closed ownership ledger for production writes to the
// canonical subscriber_events table. It intentionally lives beside F01 rather
// than in any one producer package: a producer cannot quietly add a peer write
// path and then declare itself covered.
//
// The scanner walks every non-test Go source file under apps/api and services.
// A new SQL literal, an extra branch in a registered file, or a material change
// to an existing statement has a new fingerprint and fails until its ownership
// and policy are reviewed here. Fingerprinting the normalized statement rather
// than a line number keeps harmless source movement stable while forcing review
// when the write shape changes.

type writerDisposition string

const (
	dispositionComposed             writerDisposition = "composed_transactional_classifier"
	dispositionDelegated            writerDisposition = "delegated_to_named_composed_writer"
	dispositionExplicitPolicy       writerDisposition = "intentional_synthetic_import_or_raw_policy"
	dispositionForbidden            writerDisposition = "forbidden"
	dispositionOpenNoncompliant     writerDisposition = "open_noncompliant"
	subscriberEventsFingerprintSalt                   = "postwave.f01.subscriber-events-writer.v1"
)

type sourceMarker struct {
	path     string
	fragment string
}

type writerRegistration struct {
	name        string
	path        string
	fingerprint string
	disposition writerDisposition

	// hook names the narrow transactional boundary for composed writers.
	hook string
	// delegate names another registration with a composed disposition. Direct
	// SQL statements should almost never use this; it exists for completeness
	// so delegated entry points cannot be described as if they owned the write.
	delegate string

	// policyID and policy are mandatory for intentional non-F01 writes. The
	// SQL/source markers below make the policy mechanically checkable rather
	// than relying on prose alone.
	policyID string
	policy   string

	requiredSQLMarkers     []string
	requiredSourceMarkers  []sourceMarker
	forbiddenSourceMarkers []sourceMarker
}

type discoveredSubscriberEventWriter struct {
	path        string
	line        int
	fingerprint string
	normalized  string
}

// subscriberEventWriterRegistrations is deliberately a literal inventory.
// Do not generate it from the tree: the review decision is the valuable part.
//
// Fingerprints are populated after the scanner reports the current inventory.
// Empty placeholders fail closed and are never accepted by validation.
var subscriberEventWriterRegistrations = []writerRegistration{
	{
		name:        "listmonk canonical provider event",
		path:        "apps/api/internal/listmonk_events/handler.go",
		fingerprint: "8cc9865edf3b46134b21b6abab79599381ef125a2e4621b338f0e958bd4cf64e",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"returning id, at, event_origin",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/listmonk_events/handler.go", fragment: "d.EngagementClassifier.RecordProviderEvent("},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: engagementClassifierForDeps(engagementClassifierRuntime)"},
		},
	},
	{
		name:        "ESP deliverability provider event",
		path:        "apps/api/internal/webhooks/deliverability.go",
		fingerprint: "21e2a086e53522b14db494eeca26025fb01c2a6f1830f8dc43f203a9314a7052",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"returning id, at",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/webhooks/deliverability.go", fragment: "d.recordEngagementObservation(ctx, tx"},
			{path: "apps/api/internal/webhooks/deliverability.go", fragment: "d.EngagementClassifier.RecordProviderEvent(ctx, tx"},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: espEngagementClassifierForDeps(engagementClassifierRuntime)"},
		},
	},
	{
		name:        "subscriber event with source id",
		path:        "apps/api/internal/subscribers/event_ingest.go",
		fingerprint: "1bfa7b1186ccef1668b3e5147ee03c186a9da02dce977ea8e032241292d30077",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"source_event_id", "returning id, at",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/subscribers/event_ingest.go", fragment: "r.EngagementClassifier.RecordProviderEvent(ctx, tx"},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: subscriberEngagementClassifierForDeps(engagementClassifierRuntime)"},
		},
	},
	{
		name:        "subscriber event without source id",
		path:        "apps/api/internal/subscribers/event_ingest.go",
		fingerprint: "344aec01706c808b69ee25e1e819e18505238a08179e419a9442e126d5cb980f",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"returning id, at, false",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/subscribers/event_ingest.go", fragment: "r.EngagementClassifier.RecordProviderEvent(ctx, tx"},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: subscriberEngagementClassifierForDeps(engagementClassifierRuntime)"},
		},
	},
	{
		name:        "anonymous event attribution",
		path:        "apps/api/internal/subscribers/anonymous_events_attribute.go",
		fingerprint: "0704fa15dca915f31746b1f447dd35ee3f6d13d9359653cf842f092e347f174c",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"source_event_id", "returning id, at",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/subscribers/anonymous_events_attribute.go", fragment: "r.EngagementClassifier.RecordProviderEvent("},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: subscriberEngagementClassifierForDeps(engagementClassifierRuntime)"},
		},
	},
	{
		name:        "trigger replay identified marker",
		path:        "apps/api/internal/trigger_replayer/trigger_replayer.go",
		fingerprint: "9cfb30b8b08923c6220e9f698c4facfdc5983c984eb3a5c215dcfbef143fb79e",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.synthetic-trigger-replay.v1",
		policy: "The replay marker is a synthetic identified domain event, not an " +
			"open, click, or reply; F01 must never infer human engagement from it.",
		requiredSQLMarkers: []string{"'identified'"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/trigger_replayer/trigger_replayer.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "lifecycle stage transition",
		path:        "apps/api/internal/lifecycle/lifecycle.go",
		fingerprint: "150f81c52658a58a2a296158024a83b314e8924c20a432f20d57e507dea88df2",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.lifecycle-domain-event.v1",
		policy: "Lifecycle stage changes are canonical domain/timeline facts but " +
			"not recipient engagement evidence; this writer does not delegate to the subscriber repo.",
		requiredSQLMarkers: []string{"'lifecycle_stage_changed'"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/lifecycle/lifecycle.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "MCP custom event with source id",
		path:        "apps/api/internal/mcp/handlers_tools.go",
		fingerprint: "badeee36533474b5d33bacad8617c7ed9e5061632004eb967bd267f9c89f447b",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.mcp-custom-domain-event.v1",
		policy: "MCP records caller-authored event_name only as metadata while the " +
			"canonical event_type is fixed to custom; it is not an open, click, or reply and does not delegate.",
		requiredSQLMarkers: []string{"'custom'", "source_event_id", "returning id, at"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/mcp/handlers_tools.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "MCP custom event without source id",
		path:        "apps/api/internal/mcp/handlers_tools.go",
		fingerprint: "c3928a40955f9337ec6a4da60b3cfb519bcd4dc20350252439305c71b0b2be9a",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.mcp-custom-domain-event.v1",
		policy: "MCP records caller-authored event_name only as metadata while the " +
			"canonical event_type is fixed to custom; it is not an open, click, or reply and does not delegate.",
		requiredSQLMarkers: []string{"'custom'", "returning id, at, false"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/mcp/handlers_tools.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "MCP batch custom event with source id",
		path:        "apps/api/internal/mcp/batch_tools.go",
		fingerprint: "badeee36533474b5d33bacad8617c7ed9e5061632004eb967bd267f9c89f447b",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.mcp-custom-domain-event.v1",
		policy: "The batch MCP path independently writes fixed custom domain events; " +
			"it does not delegate to subscribers.RecordSubscriberEvent.",
		requiredSQLMarkers: []string{"'custom'", "source_event_id", "returning id, at"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/mcp/batch_tools.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "MCP batch custom event without source id",
		path:        "apps/api/internal/mcp/batch_tools.go",
		fingerprint: "c3928a40955f9337ec6a4da60b3cfb519bcd4dc20350252439305c71b0b2be9a",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.mcp-custom-domain-event.v1",
		policy: "The batch MCP path independently writes fixed custom domain events; " +
			"it does not delegate to subscribers.RecordSubscriberEvent.",
		requiredSQLMarkers: []string{"'custom'", "returning id, at, false"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/mcp/batch_tools.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "sandbox synthetic event promotion",
		path:        "apps/api/internal/sandbox/events.go",
		fingerprint: "120fdc7c93eb19ef0825279435d50a01252572e15ba01d2e1e23a045aca66032",
		disposition: dispositionExplicitPolicy,
		policyID:    "f01.policy.sandbox-synthetic-events.v1",
		policy: "Sandbox lifecycle rows are deterministic synthetic simulation data. " +
			"They deliberately receive no F01 observation/classification, so synthetic opens and clicks cannot enter F01 human reach.",
		requiredSQLMarkers: []string{"from sandbox_events", "returning 1"},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/sandbox/events.go", fragment: "@" + "%s.sandbox.postwave.invalid"},
			{path: "apps/api/internal/engagementclassification/reach.go", fragment: "event_type IN ('opened', 'clicked', 'replied')"},
		},
		forbiddenSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/sandbox/events.go", fragment: ".RecordProviderEvent("},
		},
	},
	{
		name:        "human reply projection",
		path:        "apps/api/internal/replies/store.go",
		fingerprint: "b31bd93d2a3893cc7e6e997c1cc8c5e5666d7de86e59ec1c16768b52e774160d",
		disposition: dispositionComposed,
		hook:        "engagementclassification.Runtime.RecordProviderEvent",
		requiredSQLMarkers: []string{
			"'replied'", "returning id, at",
		},
		requiredSourceMarkers: []sourceMarker{
			{path: "apps/api/internal/replies/store.go", fragment: "db.WithTenantWorker(ctx, s.Pool, tenantID)"},
			{path: "apps/api/internal/replies/store.go", fragment: "emitCanonical := !isDup && decision.Class.CountsAsEngagement()"},
			{path: "apps/api/internal/replies/store.go", fragment: "r.MatchMethod.Strong()"},
			{path: "apps/api/internal/replies/store.go", fragment: "!isSandbox && s.EngagementClassifier != nil"},
			{path: "apps/api/internal/replies/store.go", fragment: "s.EngagementClassifier.RecordProviderEvent("},
			{path: "apps/api/internal/engagementclassification/classifier.go", fragment: "R_TRUSTED_HUMAN_REPLY"},
			{path: "apps/api/internal/engagementclassification/classifier.go", fragment: "trustedHumanReplyReceipt(normalized)"},
			{path: "apps/api/main.go", fragment: "EngagementClassifier: replyEngagementClassifierForDeps("},
		},
	},
}

var subscriberEventsInsertPattern = regexp.MustCompile(
	`(?i)\binsert\s+into\s+(?:(?:public\.)?subscriber_events|(?:public\.)?"subscriber_events")\b`,
)

func TestProductionSubscriberEventWritersHaveReviewedF01Disposition(t *testing.T) {
	repositoryRoot := subscriberWriterRepositoryRoot(t)
	discovered := discoverSubscriberEventWriters(t, repositoryRoot)

	registrationsByKey := make(map[string]writerRegistration, len(subscriberEventWriterRegistrations))
	registrationsByName := make(map[string]writerRegistration, len(subscriberEventWriterRegistrations))
	for _, registration := range subscriberEventWriterRegistrations {
		validateWriterRegistration(t, repositoryRoot, registration)
		key := writerKey(registration.path, registration.fingerprint)
		if previous, exists := registrationsByKey[key]; exists {
			t.Errorf("duplicate writer registration key %s: %q and %q", key, previous.name, registration.name)
		}
		if previous, exists := registrationsByName[registration.name]; exists {
			t.Errorf("duplicate writer registration name %q (%s and %s)", registration.name, previous.path, registration.path)
		}
		registrationsByKey[key] = registration
		registrationsByName[registration.name] = registration
	}

	seen := make(map[string]bool, len(discovered))
	for _, writer := range discovered {
		key := writerKey(writer.path, writer.fingerprint)
		registration, ok := registrationsByKey[key]
		if !ok {
			t.Errorf("unregistered production INSERT INTO subscriber_events at %s:%d "+
				"(fingerprint %s); add an explicit reviewed disposition\nnormalized SQL: %s",
				writer.path, writer.line, writer.fingerprint, writer.normalized)
			continue
		}
		seen[key] = true
		for _, marker := range registration.requiredSQLMarkers {
			if !strings.Contains(writer.normalized, normalizeSQL(marker)) {
				t.Errorf("writer %q at %s:%d no longer proves required SQL invariant %q",
					registration.name, writer.path, writer.line, marker)
			}
		}
		if registration.disposition == dispositionForbidden ||
			registration.disposition == dispositionOpenNoncompliant {
			t.Errorf("production writer %q at %s:%d is %s: %s (%s)",
				registration.name, writer.path, writer.line, registration.disposition,
				registration.policy, registration.policyID)
		}
	}

	for key, registration := range registrationsByKey {
		if !seen[key] {
			t.Errorf("registered writer %q (%s, fingerprint %s) no longer exists; "+
				"remove or deliberately replace its reviewed disposition",
				registration.name, registration.path, registration.fingerprint)
		}
		if registration.disposition == dispositionDelegated {
			target, ok := registrationsByName[registration.delegate]
			if !ok {
				t.Errorf("delegated writer %q names missing target %q", registration.name, registration.delegate)
			} else if target.disposition != dispositionComposed {
				t.Errorf("delegated writer %q targets %q, whose disposition is %s rather than composed",
					registration.name, target.name, target.disposition)
			}
		}
	}

	if len(discovered) != len(subscriberEventWriterRegistrations) {
		t.Errorf("subscriber_events writer inventory mismatch: discovered %d statements, registered %d",
			len(discovered), len(subscriberEventWriterRegistrations))
	}
}

func validateWriterRegistration(t *testing.T, repositoryRoot string, registration writerRegistration) {
	t.Helper()
	if strings.TrimSpace(registration.name) == "" || strings.TrimSpace(registration.path) == "" {
		t.Errorf("writer registrations require non-empty name and path: %#v", registration)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(registration.fingerprint) {
		t.Errorf("writer %q has invalid/placeholder fingerprint %q", registration.name, registration.fingerprint)
	}
	switch registration.disposition {
	case dispositionComposed:
		if registration.hook == "" {
			t.Errorf("composed writer %q does not name its transactional hook", registration.name)
		}
		if len(registration.requiredSourceMarkers) == 0 {
			t.Errorf("composed writer %q has no source/composition evidence", registration.name)
		}
		if registration.policyID != "" || registration.policy != "" || registration.delegate != "" {
			t.Errorf("composed writer %q mixes incompatible disposition fields", registration.name)
		}
	case dispositionDelegated:
		if registration.delegate == "" {
			t.Errorf("delegated writer %q does not name its composed owner", registration.name)
		}
	case dispositionExplicitPolicy, dispositionForbidden, dispositionOpenNoncompliant:
		if !strings.HasPrefix(registration.policyID, "f01.") || strings.TrimSpace(registration.policy) == "" {
			t.Errorf("policy writer %q requires a stable f01 policy id and rationale", registration.name)
		}
		if len(registration.requiredSQLMarkers) == 0 {
			t.Errorf("policy writer %q has no mechanically checked SQL invariant", registration.name)
		}
	default:
		t.Errorf("writer %q has unknown disposition %q", registration.name, registration.disposition)
	}

	for _, marker := range registration.requiredSourceMarkers {
		body, err := os.ReadFile(filepath.Join(repositoryRoot, filepath.FromSlash(marker.path)))
		if err != nil {
			t.Errorf("writer %q source evidence: read %s: %v", registration.name, marker.path, err)
			continue
		}
		if !strings.Contains(string(body), marker.fragment) {
			t.Errorf("writer %q lacks required source/composition evidence %q in %s",
				registration.name, marker.fragment, marker.path)
		}
	}
	for _, marker := range registration.forbiddenSourceMarkers {
		body, err := os.ReadFile(filepath.Join(repositoryRoot, filepath.FromSlash(marker.path)))
		if err != nil {
			t.Errorf("writer %q negative source evidence: read %s: %v", registration.name, marker.path, err)
			continue
		}
		if strings.Contains(string(body), marker.fragment) {
			t.Errorf("writer %q still claims policy %q but now contains %q in %s; review and reclassify the disposition",
				registration.name, registration.policyID, marker.fragment, marker.path)
		}
	}
}

func discoverSubscriberEventWriters(t *testing.T, repositoryRoot string) []discoveredSubscriberEventWriter {
	t.Helper()
	var discovered []discoveredSubscriberEventWriter
	for _, relativeRoot := range []string{"apps/api", "services"} {
		absoluteRoot := filepath.Join(repositoryRoot, filepath.FromSlash(relativeRoot))
		err := filepath.WalkDir(absoluteRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				switch entry.Name() {
				case ".git", "node_modules", "testdata", "vendor":
					if path != absoluteRoot {
						return filepath.SkipDir
					}
				}
				return nil
			}
			if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
				return nil
			}

			fileSet := token.NewFileSet()
			parsed, err := parser.ParseFile(fileSet, path, nil, 0)
			if err != nil {
				return fmt.Errorf("parse %s: %w", path, err)
			}
			statementOccurrences := map[string]int{}
			relativePath, err := filepath.Rel(repositoryRoot, path)
			if err != nil {
				return err
			}
			relativePath = filepath.ToSlash(relativePath)
			ast.Inspect(parsed, func(node ast.Node) bool {
				literal, ok := node.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return true
				}
				value, err := strconv.Unquote(literal.Value)
				if err != nil || !subscriberEventsInsertPattern.MatchString(value) {
					return true
				}
				matches := subscriberEventsInsertPattern.FindAllStringIndex(value, -1)
				for range matches {
					normalized := normalizeSQL(value)
					occurrence := statementOccurrences[normalized]
					statementOccurrences[normalized] = occurrence + 1
					discovered = append(discovered, discoveredSubscriberEventWriter{
						path:        relativePath,
						line:        fileSet.Position(literal.Pos()).Line,
						fingerprint: subscriberWriterFingerprint(normalized, occurrence),
						normalized:  normalized,
					})
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk production Go sources under %s: %v", relativeRoot, err)
		}
	}
	sort.Slice(discovered, func(i, j int) bool {
		if discovered[i].path != discovered[j].path {
			return discovered[i].path < discovered[j].path
		}
		if discovered[i].line != discovered[j].line {
			return discovered[i].line < discovered[j].line
		}
		return discovered[i].fingerprint < discovered[j].fingerprint
	})
	return discovered
}

func subscriberWriterRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve writer coverage test source path")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".."))
	for _, required := range []string{"apps/api", "services"} {
		info, err := os.Stat(filepath.Join(repositoryRoot, required))
		if err != nil || !info.IsDir() {
			t.Fatalf("resolved repository root %s has no %s directory", repositoryRoot, required)
		}
	}
	return repositoryRoot
}

func normalizeSQL(input string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(input))), " ")
}

func subscriberWriterFingerprint(normalized string, occurrence int) string {
	sum := sha256.Sum256([]byte(subscriberEventsFingerprintSalt + "\x00" + normalized + "\x00" + strconv.Itoa(occurrence)))
	return hex.EncodeToString(sum[:])
}

func writerKey(path, fingerprint string) string {
	return filepath.ToSlash(path) + "\x00" + fingerprint
}
