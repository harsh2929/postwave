// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

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

const projectionWriterFingerprintSalt = "postwave.campaign-report-writer-coverage.v1"

type projectionWriterDisposition string

const (
	projectionWriterComposed projectionWriterDisposition = "transactionally_composed"
	projectionWriterExcluded projectionWriterDisposition = "deliberately_excluded"
)

type projectionWriterRegistration struct {
	table       string
	name        string
	path        string
	fingerprint string
	disposition projectionWriterDisposition
	policyID    string
	rationale   string
	markers     []string
}

// This is the reviewed ownership ledger for both sides of the compatibility
// boundary. A new direct canonical writer or legacy report writer fails until
// it is either composed or assigned a narrow, mechanically checked exclusion.
// Report-only sent/conversion and PII-rich migration history are not silently
// coerced into subscriber_events.
var projectionWriterRegistrations = []projectionWriterRegistration{
	{table: "subscriber_events", name: "Listmonk canonical provider event", path: "apps/api/internal/listmonk_events/handler.go", fingerprint: "1a3e962db9c50ef826621268395937d9e75b84125afa39862e32eb9fa2ca8be2", disposition: projectionWriterComposed, markers: []string{"CampaignReportProjector.ProjectCanonicalEvent(", "EligibleCanonicalEventType(string(ev.EventType))", "if d.EngagementClassifier != nil || projectCampaignReport"}},
	{table: "subscriber_events", name: "ESP canonical provider event", path: "apps/api/internal/webhooks/deliverability.go", fingerprint: "69d7785e8057dc01b6228a47719190602067fda94e4bb9b8e2b60e24cfdc8da6", disposition: projectionWriterComposed, markers: []string{"CampaignReportProjector.ProjectCanonicalEvent(", "EligibleCanonicalEventType(ev.EventType)", "if d.EngagementClassifier != nil || projectCampaignReport"}},
	{table: "subscriber_events", name: "subscriber event with source id", path: "apps/api/internal/subscribers/event_ingest.go", fingerprint: "b826fe3acc07adde2e47811b951987973de01440543c1f9d326cf451c8c4fae4", disposition: projectionWriterComposed, markers: []string{"CampaignReportProjector.ProjectCanonicalEvent(", "projectCampaignReport && !out.Deduped", "if r.EngagementClassifier != nil || projectCampaignReport"}},
	{table: "subscriber_events", name: "subscriber event without source id", path: "apps/api/internal/subscribers/event_ingest.go", fingerprint: "e19290ce5cfd12ce5183239a75909cc00d5108660dd3ca43c015d10da04ef8b3", disposition: projectionWriterComposed, markers: []string{"CampaignReportProjector.ProjectCanonicalEvent(", "projectCampaignReport && !out.Deduped", "if r.EngagementClassifier != nil || projectCampaignReport"}},
	{table: "subscriber_events", name: "strong human reply", path: "apps/api/internal/replies/store.go", fingerprint: "24d8a86220b8544e57c18dfe2e8888d45fd7a8475852e20a7024482f74004618", disposition: projectionWriterComposed, markers: []string{"CampaignReportProjector.ProjectCanonicalEvent(", "EventType: \"replied\"", "if s.EngagementClassifier != nil {"}},

	{table: "subscriber_events", name: "anonymous attribution without campaign", path: "apps/api/internal/subscribers/anonymous_events_attribute.go", fingerprint: "e56a12f63c361a58b27b972f33429951ac89d53c9f1394e1e370bdcf39877e9f", disposition: projectionWriterExcluded, policyID: "projection.policy.campaignless-anonymous.v1", rationale: "attribution intentionally writes campaign_id NULL, so no tenant campaign report row can be formed", markers: []string{"$3, NULL, NULL, NULL, NULL"}},
	{table: "subscriber_events", name: "trigger replay identified marker", path: "apps/api/internal/trigger_replayer/trigger_replayer.go", fingerprint: "4e32bacc97b43b2978c147bad6580b9c227057c369d5b2b3dacb5d07dd4c941f", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-domain-event.v1", rationale: "identified is a subscriber timeline marker outside the report event vocabulary", markers: []string{"'identified'"}},
	{table: "subscriber_events", name: "lifecycle transition", path: "apps/api/internal/lifecycle/lifecycle.go", fingerprint: "3f2c5ee68d558559c7443ca1ca3dc976ce8a552c49fa7b01e2654c4047de1c46", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-domain-event.v1", rationale: "lifecycle_stage_changed is a domain event, not campaign engagement", markers: []string{"'lifecycle_stage_changed'"}},
	{table: "subscriber_events", name: "MCP custom event with source id", path: "apps/api/internal/mcp/handlers_tools.go", fingerprint: "a405986faac112e72cfada3f1385c6d7f9463d72e81a9927e48b8381465a7165", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-custom.v1", rationale: "MCP fixes event_type to custom and retains caller event_name only in metadata", markers: []string{"'custom'"}},
	{table: "subscriber_events", name: "MCP custom event without source id", path: "apps/api/internal/mcp/handlers_tools.go", fingerprint: "0a2e0853777924117d7f84b681d980c74cea67def666186130f02bc99950e304", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-custom.v1", rationale: "MCP fixes event_type to custom and retains caller event_name only in metadata", markers: []string{"'custom'"}},
	{table: "subscriber_events", name: "MCP batch custom event with source id", path: "apps/api/internal/mcp/batch_tools.go", fingerprint: "a405986faac112e72cfada3f1385c6d7f9463d72e81a9927e48b8381465a7165", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-custom.v1", rationale: "batch MCP events are fixed custom domain events", markers: []string{"'custom'"}},
	{table: "subscriber_events", name: "MCP batch custom event without source id", path: "apps/api/internal/mcp/batch_tools.go", fingerprint: "0a2e0853777924117d7f84b681d980c74cea67def666186130f02bc99950e304", disposition: projectionWriterExcluded, policyID: "projection.policy.nonreport-custom.v1", rationale: "batch MCP events are fixed custom domain events", markers: []string{"'custom'"}},
	{table: "subscriber_events", name: "sandbox synthetic promotion", path: "apps/api/internal/sandbox/events.go", fingerprint: "40d4aa6ba2389a4902193bd37aa63350134d01c67d7b059a11cd364e893ce7fa", disposition: projectionWriterExcluded, policyID: "projection.policy.synthetic-sandbox.v1", rationale: "sandbox rows are synthetic and must not enter recipient campaign reports", markers: []string{"FROM sandbox_events"}},

	{table: "campaign_report_events", name: "Listmonk legacy peer adopted by projection", path: "apps/api/internal/listmonk_events/handler.go", fingerprint: "abac5c6d20bb7c86c17cb78334983eed133691d75dd1e45fa046b9440a9c84ca", disposition: projectionWriterComposed, markers: []string{"persistCampaignReport(ctx, tx", "CampaignReportProjector.ProjectCanonicalEvent("}},
	{table: "campaign_report_events", name: "Mailchimp compatibility report ingest", path: "apps/api/internal/compat/repo.go", fingerprint: "823b167db4369ce434216fb147bc676391e7d46282f67ee8d2382e0b7fa741b2", disposition: projectionWriterExcluded, policyID: "projection.policy.legacy-compat-report-only.v1", rationale: "the compatibility route has no canonical subscriber event identity to bind", markers: []string{"func (r *Repo) RecordCampaignEvent"}},
	{table: "campaign_report_events", name: "conversion attribution mirror", path: "apps/api/internal/conversions/attribution.go", fingerprint: "eeb72d6745d05c93ccb6bdc00b77120d94b15360aec768db1b53cf88bd9c9a43", disposition: projectionWriterExcluded, policyID: "projection.policy.report-only-conversion.v1", rationale: "conversion does not yet exist in the canonical subscriber event vocabulary", markers: []string{"'conversion'"}},
	{table: "campaign_report_events", name: "conversion repository mirror", path: "apps/api/internal/conversions/conversions.go", fingerprint: "eeb72d6745d05c93ccb6bdc00b77120d94b15360aec768db1b53cf88bd9c9a43", disposition: projectionWriterExcluded, policyID: "projection.policy.report-only-conversion.v1", rationale: "conversion does not yet exist in the canonical subscriber event vocabulary", markers: []string{"'conversion'"}},
	{table: "campaign_report_events", name: "onboarding sample report data", path: "apps/api/internal/onboarding/sample_data.go", fingerprint: "ccfde3f0905d16ad20b56f3b81211091f59bd2ca7ae86aa5037d14e23a8022df", disposition: projectionWriterExcluded, policyID: "projection.policy.synthetic-onboarding.v1", rationale: "sample rows are synthetic demonstrations rather than canonical recipient evidence", markers: []string{"sampleCampaignEvents"}},
	{table: "campaign_report_events", name: "migration campaign archive replay", path: "services/migration/internal/translator/listmonk/archive.go", fingerprint: "06fa6fa1025b429048664ed3fcc07cca42962f8e57d8bd20dd4bf758668501d6", disposition: projectionWriterExcluded, policyID: "projection.policy.migration-report-history.v1", rationale: "imported history carries report-only geo/device/client/revenue dimensions and must remain rollback-owned until a lossless canonical import protocol exists", markers: []string{"ResourceCampaignEvent", "DestinationPostwaveCampaignEvent"}},
}

type discoveredProjectionWriter struct {
	table       string
	path        string
	line        int
	fingerprint string
	normalized  string
}

var (
	subscriberInsertPattern = regexp.MustCompile(`(?i)\binsert\s+into\s+(?:(?:public\.)?subscriber_events|(?:public\.)?"subscriber_events")\b`)
	reportInsertPattern     = regexp.MustCompile(`(?i)\binsert\s+into\s+(?:(?:public\.)?campaign_report_events|(?:public\.)?"campaign_report_events")\b`)
)

func TestProductionEventWritersHaveReviewedReportProjectionDisposition(t *testing.T) {
	root := projectionWriterRepositoryRoot(t)
	discovered := discoverProjectionWriters(t, root)
	registered := make(map[string]projectionWriterRegistration, len(projectionWriterRegistrations))
	for _, registration := range projectionWriterRegistrations {
		validateProjectionWriterRegistration(t, root, registration)
		key := projectionWriterKey(registration.table, registration.path, registration.fingerprint)
		if prior, ok := registered[key]; ok {
			t.Errorf("duplicate projection writer registration %q and %q", prior.name, registration.name)
		}
		registered[key] = registration
	}
	seen := make(map[string]bool, len(discovered))
	for _, writer := range discovered {
		key := projectionWriterKey(writer.table, writer.path, writer.fingerprint)
		registration, ok := registered[key]
		if !ok {
			t.Errorf("unregistered production INSERT INTO %s at %s:%d fingerprint=%s\nnormalized SQL: %s",
				writer.table, writer.path, writer.line, writer.fingerprint, writer.normalized)
			continue
		}
		seen[key] = true
		_ = registration
	}
	for key, registration := range registered {
		if !seen[key] {
			t.Errorf("registered writer %q (%s %s fingerprint=%s) was not found",
				registration.name, registration.table, registration.path, registration.fingerprint)
		}
	}
	if len(discovered) != len(projectionWriterRegistrations) {
		t.Errorf("projection writer inventory mismatch: discovered=%d registered=%d", len(discovered), len(projectionWriterRegistrations))
	}
}

func validateProjectionWriterRegistration(t *testing.T, root string, registration projectionWriterRegistration) {
	t.Helper()
	if strings.TrimSpace(registration.name) == "" || strings.TrimSpace(registration.path) == "" {
		t.Errorf("projection writer registration requires a name and path: %#v", registration)
	}
	if registration.table != "subscriber_events" && registration.table != "campaign_report_events" {
		t.Errorf("writer %q has invalid table %q", registration.name, registration.table)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(registration.fingerprint) {
		t.Errorf("writer %q has placeholder/invalid fingerprint %q", registration.name, registration.fingerprint)
	}
	if registration.disposition == projectionWriterComposed {
		if registration.policyID != "" || registration.rationale != "" {
			t.Errorf("composed writer %q mixes an exclusion policy", registration.name)
		}
	} else if registration.disposition == projectionWriterExcluded {
		if !strings.HasPrefix(registration.policyID, "projection.policy.") || strings.TrimSpace(registration.rationale) == "" {
			t.Errorf("excluded writer %q needs a stable policy and rationale", registration.name)
		}
	} else {
		t.Errorf("writer %q has invalid disposition %q", registration.name, registration.disposition)
	}
	if len(registration.markers) == 0 {
		t.Errorf("writer %q has no mechanically checked source marker", registration.name)
	}
	body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(registration.path)))
	if err != nil {
		t.Errorf("read writer %q source: %v", registration.name, err)
		return
	}
	for _, marker := range registration.markers {
		if !strings.Contains(string(body), marker) {
			t.Errorf("writer %q lacks policy/composition marker %q", registration.name, marker)
		}
	}
}

func discoverProjectionWriters(t *testing.T, repositoryRoot string) []discoveredProjectionWriter {
	t.Helper()
	var discovered []discoveredProjectionWriter
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
			relativePath, err := filepath.Rel(repositoryRoot, path)
			if err != nil {
				return err
			}
			relativePath = filepath.ToSlash(relativePath)
			occurrences := map[string]int{}
			ast.Inspect(parsed, func(node ast.Node) bool {
				literal, ok := node.(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return true
				}
				value, err := strconv.Unquote(literal.Value)
				if err != nil {
					return true
				}
				for _, candidate := range []struct {
					table   string
					pattern *regexp.Regexp
				}{
					{table: "subscriber_events", pattern: subscriberInsertPattern},
					{table: "campaign_report_events", pattern: reportInsertPattern},
				} {
					if !candidate.pattern.MatchString(value) {
						continue
					}
					normalized := normalizeProjectionWriterSQL(value)
					occurrenceKey := candidate.table + "\x00" + normalized
					occurrence := occurrences[occurrenceKey]
					occurrences[occurrenceKey] = occurrence + 1
					discovered = append(discovered, discoveredProjectionWriter{
						table: candidate.table, path: relativePath,
						line:        fileSet.Position(literal.Pos()).Line,
						fingerprint: projectionWriterFingerprint(candidate.table, normalized, occurrence),
						normalized:  normalized,
					})
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk production Go source under %s: %v", relativeRoot, err)
		}
	}
	sort.Slice(discovered, func(i, j int) bool {
		if discovered[i].path != discovered[j].path {
			return discovered[i].path < discovered[j].path
		}
		if discovered[i].line != discovered[j].line {
			return discovered[i].line < discovered[j].line
		}
		return discovered[i].table < discovered[j].table
	})
	return discovered
}

func projectionWriterRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve projection writer coverage source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".."))
	for _, required := range []string{"apps/api", "services"} {
		if info, err := os.Stat(filepath.Join(root, required)); err != nil || !info.IsDir() {
			t.Fatalf("resolved repository root %s has no %s", root, required)
		}
	}
	return root
}

func normalizeProjectionWriterSQL(input string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(input))), " ")
}

func projectionWriterFingerprint(table, normalized string, occurrence int) string {
	sum := sha256.Sum256([]byte(projectionWriterFingerprintSalt + "\x00" + table + "\x00" + normalized + "\x00" + strconv.Itoa(occurrence)))
	return hex.EncodeToString(sum[:])
}

func projectionWriterKey(table, path, fingerprint string) string {
	return table + "\x00" + filepath.ToSlash(path) + "\x00" + fingerprint
}
