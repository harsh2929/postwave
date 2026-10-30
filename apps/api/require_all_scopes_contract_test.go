// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

// TestRequireAllScopesBindingsMatchGeneratedPolicies is the reverse contract
// for conjunctive API-key authorization. OpenAPI drives routeauth, while these
// call sites remain the handler-local defence in depth. Inventorying the AST
// means a new, removed, or scope-mutated RequireAllScopes binding cannot ship
// as an "any" policy merely because a family default looked plausible.
func TestRequireAllScopesBindingsMatchGeneratedPolicies(t *testing.T) {
	t.Parallel()

	wantSourceCounts := map[string]int{
		"internal/analytics/handlers.go":                  2,
		"internal/campaignassuranceapi/handlers.go":       1,
		"internal/campaigns/handlers.go":                  2,
		"internal/campaigns/handlers_queue.go":            1,
		"internal/campaigns/handlers_send_domain.go":      1,
		"internal/predictive/predictive.go":               1,
		"internal/recipient_tz_send/recipient_tz_send.go": 1,
		"internal/resend_unopened/resend_unopened.go":     1,
		"internal/send_time_opt/send_time_opt.go":         1,
		"internal/server/analytics_realtime_routes.go":    1,
		// 5, not 1: reading an audit record that may contain PII, executing an
		// audit action, and configuring an audit sink each acquired their own
		// scope on top of ScopeAuditRead. A single audit scope previously meant
		// that anything able to read the audit log could also read the PII inside
		// it and reconfigure where it was shipped.
		"internal/server/audit_operations.go": 5,
		"internal/server/campaign_sending.go": 1,
		"internal/track/handlers.go":          1,
		"main.go":                             4,
	}
	wantSignatureCounts := map[string]int{
		"ScopeAuditRead+ScopeAuditConfigureRetention": 1,
		// The audit surface separates "may read the log" from "may read what is
		// IN the log". Pinning the exact combinations, not just the count, is the
		// point: dropping ScopeAuditReadPII from one of these would keep the
		// count at 5 and silently widen who can read personal data out of audit
		// records.
		"ScopeAuditRead+ScopeAuditReadPII":                          1,
		"ScopeAuditRead+ScopeAuditReadPII+ScopeAuditExecuteActions": 1,
		"ScopeAuditRead+ScopeAuditReadPII+ScopeAuditConfigureSinks": 2,
		"ScopeReadCampaigns+ScopeReadSubscribers":                   3,
		"ScopeReadCampaigns+ScopeReadReports+ScopeReadSubscribers":  1,
		"ScopeReadReports+ScopeReadSubscribers":                     4,
		"ScopeWriteCampaigns+ScopeSendTransactional":                10,
	}

	gotSourceCounts := map[string]int{}
	gotSignatureCounts := map[string]int{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != "." && strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "RequireAllScopes" {
				return true
			}
			rel := filepath.ToSlash(path)
			gotSourceCounts[rel]++
			names := make([]string, 0, len(call.Args))
			for _, argument := range call.Args {
				scope, ok := argument.(*ast.SelectorExpr)
				if !ok {
					t.Errorf("%s uses a non-selector RequireAllScopes argument; review the source-contract extractor", rel)
					continue
				}
				names = append(names, scope.Sel.Name)
			}
			gotSignatureCounts[strings.Join(names, "+")]++
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("scan RequireAllScopes bindings: %v", err)
	}
	if !reflect.DeepEqual(gotSourceCounts, wantSourceCounts) {
		t.Fatalf("RequireAllScopes source inventory = %v, want %v", gotSourceCounts, wantSourceCounts)
	}
	if !reflect.DeepEqual(gotSignatureCounts, wantSignatureCounts) {
		t.Fatalf("RequireAllScopes signatures = %v, want %v", gotSignatureCounts, wantSignatureCounts)
	}

	wantPolicies := map[string][]string{
		"GET /api/v1/campaigns/campaign-1/report.csv":                                         {"read:campaigns", "read:reports", "read:subscribers"},
		"GET /api/v1/clv-dashboard":                                                           {"read:reports", "read:subscribers"},
		"GET /api/v1/conversions":                                                             {"read:reports", "read:subscribers"},
		"GET /api/v1/predictive/profiles":                                                     {"read:reports", "read:subscribers"},
		"GET /api/v1/predictive/profiles/buyer@example.test":                                  {"read:reports", "read:subscribers"},
		"GET /api/v1/subscribers/subscriber-1/cross-channel-timeline":                         {"read:reports", "read:subscribers"},
		"GET /api/v1/track/events":                                                            {"read:reports", "read:subscribers"},
		"GET /api/v1/track/events.csv":                                                        {"read:reports", "read:subscribers"},
		"GET /api/v1/track/stream":                                                            {"read:reports", "read:subscribers"},
		"POST /api/v1/campaigns/campaign-1/assurance-runs/run-1/findings/finding-1/appeals":   {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/assurance-runs/run-1/findings/finding-1/overrides": {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/test-send":                                                    {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/test-send":                                         {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/queue":                                             {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/send":                                              {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/recurrence":                                        {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/resend-to-non-openers":                             {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/resend-unopened":                                   {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/resume":                                            {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/schedule-by-best-time":                             {"write:campaigns", "send:transactional"},
		"POST /api/v1/campaigns/campaign-1/tz-schedule":                                       {"write:campaigns", "send:transactional"},
		"POST /api/v1/safety/check":                                                           {"write:campaigns", "send:transactional"},
		"PUT /api/v1/audit/retention":                                                         {"audit:read", "audit:configure_retention"},
		"GET /api/v1/voice/sequences/sequence-1/participants":                                 {"read:campaigns", "read:subscribers"},
		"GET /api/v1/voice/sequences/sequence-1/stuck":                                        {"read:campaigns", "read:subscribers"},
		"POST /api/v1/voice/sequences/sequence-1/steps/1/variant":                             {"read:campaigns", "read:subscribers"},
	}
	keys := make([]string, 0, len(wantPolicies))
	for key := range wantPolicies {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		method, path, ok := strings.Cut(key, " ")
		if !ok {
			t.Fatalf("invalid test route key %q", key)
		}
		policy, found := routeauth.PolicyFor(method, path)
		if !found {
			t.Errorf("generated policy not found for %s", key)
			continue
		}
		if policy.APIKeyScopeMode != routeauth.ScopeModeAll {
			t.Errorf("%s scope mode = %q, want all", key, policy.APIKeyScopeMode)
		}
		if !reflect.DeepEqual(policy.APIKeyScopes, wantPolicies[key]) {
			t.Errorf("%s scopes = %v, want %v", key, policy.APIKeyScopes, wantPolicies[key])
		}
	}
}
