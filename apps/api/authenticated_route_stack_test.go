package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/ai_agent"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/sms"
)

func TestAuthenticatedRouteStackPreservesSecurityOrder(t *testing.T) {
	t.Parallel()

	var invoked []string
	stack := authenticatedRouteStack{
		authenticateAPIKey: recordingRouteMiddleware(&invoked, "api-key"),
		meterAPIKey:        recordingRouteMiddleware(&invoked, "key-rate-limit"),
		resolveTenant:      recordingRouteMiddleware(&invoked, "tenant"),
		authorizeRoute:     recordingRouteMiddleware(&invoked, "route-policy"),
		recordAPIKeyCalls: []routeMiddleware{
			recordingRouteMiddleware(&invoked, "api-key-recorder"),
		},
		applyImpersonation:   recordingRouteMiddleware(&invoked, "impersonation"),
		stampContextEpoch:    recordingRouteMiddleware(&invoked, "context-epoch"),
		enforceAdminIP:       recordingRouteMiddleware(&invoked, "admin-ip"),
		resolveAuditScopes:   recordingRouteMiddleware(&invoked, "audit-scopes"),
		requireMFA:           recordingRouteMiddleware(&invoked, "mfa"),
		enforceTenantRegion:  recordingRouteMiddleware(&invoked, "region"),
		meterCommercialUsage: recordingRouteMiddleware(&invoked, "commercial-usage"),
	}
	router := chi.NewRouter()
	router.Group(func(protected chi.Router) {
		stack.apply(protected)
		protected.Get("/test", func(w http.ResponseWriter, _ *http.Request) {
			invoked = append(invoked, "handler")
			w.WriteHeader(http.StatusNoContent)
		})
	})

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/test", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	want := []string{
		"api-key", "key-rate-limit", "tenant", "route-policy",
		"api-key-recorder", "impersonation", "context-epoch", "admin-ip", "audit-scopes",
		"mfa", "region", "commercial-usage", "handler",
	}
	if !reflect.DeepEqual(invoked, want) {
		t.Fatalf("middleware order = %v, want %v", invoked, want)
	}
}

func TestAuthenticatedRouteStackRejectsIncompleteBoundary(t *testing.T) {
	t.Parallel()

	stack := completeTestAuthenticatedRouteStack()
	stack.requireMFA = nil
	deferredPanicContains(t, "requireMFA", func() {
		stack.apply(chi.NewRouter())
	})
}

// The per-API-key rate limit and the call recorder used to be caller-supplied
// hooks, and the second authenticated group passed none — leaving the whole
// send/write surface (transactional emails, campaign sends, subscriber writes)
// unmetered and unrecorded. They are stack fields now, so a group that forgets
// them cannot be mounted at all.
func TestAuthenticatedRouteStackRejectsMissingKeyMeteringAndRecording(t *testing.T) {
	t.Parallel()

	stack := completeTestAuthenticatedRouteStack()
	stack.meterAPIKey = nil
	deferredPanicContains(t, "meterAPIKey", func() {
		stack.apply(chi.NewRouter())
	})

	stack = completeTestAuthenticatedRouteStack()
	stack.recordAPIKeyCalls = nil
	deferredPanicContains(t, "recordAPIKeyCalls", func() {
		stack.apply(chi.NewRouter())
	})

	stack = completeTestAuthenticatedRouteStack()
	stack.meterCommercialUsage = nil
	deferredPanicContains(t, "meterCommercialUsage", func() {
		stack.apply(chi.NewRouter())
	})
}

// Every authenticated group in main.go must go through the same stack value.
// Since the metering hooks are no longer arguments, "apply(r)" appearing twice
// is now sufficient to prove both groups are metered — but assert the hooks are
// wired to the stack rather than re-introduced per call site.
func TestMainWiresKeyMeteringIntoTheSharedStack(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	text := root.main
	for _, want := range []string{
		"meterAPIKey:        keyRateLimit.Middleware,",
		"recordAPIKeyCalls: []routeMiddleware{",
		"meterCommercialUsage: usagegate.APIOperationMiddleware(commercialUsageMeter),",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("main.go does not wire %q into the shared authenticated stack", want)
		}
	}
	if strings.Contains(root.all, "authenticatedRouteHooks") {
		t.Fatal("composition root re-introduced per-call-site authenticated route hooks")
	}
}

func TestMainUsesSharedAuthenticatedRouteStack(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	const apply = "authenticatedRoutes.apply(r)"
	if inRun, inRoot := strings.Count(root.run, apply), strings.Count(root.all, apply); inRun != 2 || inRoot != 2 {
		t.Fatalf("authenticated route stack mounts = %d in run() and %d in the composition root, want 2 and 2",
			inRun, inRoot)
	}
	for _, forbidden := range []string{
		"r.Use(routeauth.Middleware)",
		"r.Use(impersonate.Middleware(",
		"r.Use(middleware.RequireMFAIfPolicy(",
		"r.Use(regions.EnforceRegion(",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses authenticatedRouteStack with %q", forbidden)
		}
	}
}

// stepup/policy.go declares step-up requirements per route template, but the
// middleware that reads that policy is mounted per route GROUP. When it was
// mounted on only one of the two authenticated groups, every policy entry whose
// route lives in the other one — POST /api/v1/scim/tokens, which mints a bearer
// that can provision and deprovision workspace people — declared a requirement
// that nothing ever consulted. Pin one mount per group.
func TestEveryAuthenticatedGroupMountsStepUp(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	const apply, stepUp = "authenticatedRoutes.apply(r)", "r.Use(stepup.Middleware("
	groups := strings.Count(root.run, apply)
	mounts := strings.Count(root.run, stepUp)
	if groups == 0 {
		t.Fatal("no authenticated route groups found in run() — the marker changed")
	}
	if mounts != groups {
		t.Fatalf("stepup.Middleware mounts in run() = %d, authenticated groups = %d: a group "+
			"without the gate silently ignores every stepup policy entry whose route "+
			"it carries", mounts, groups)
	}
	if rootGroups, rootMounts := strings.Count(root.all, apply), strings.Count(root.all, stepUp); rootGroups != groups ||
		rootMounts != mounts {
		t.Fatalf("composition root has %d authenticated groups and %d stepup.Middleware mounts, run() has "+
			"%d and %d: both belong to run() and nowhere else", rootGroups, rootMounts, groups, mounts)
	}
	// Equal totals are not one mount per group: a second mount in one group
	// hides a missing mount in the other. And text is not a mount: a mount in a
	// group nested inside this one gates only the nested group's routes, and a
	// comment gates nothing. So each group must mount the gate itself, as one of
	// its own statements after the stack is applied, and the group read with
	// every helper it calls must hold no other mount.
	authenticated := authenticatedRouteGroups(t, root)
	if len(authenticated) != groups {
		t.Fatalf("run() has %d function literals that apply the authenticated stack as a statement, want "+
			"%d, one per %q", len(authenticated), groups, apply)
	}
	for index, group := range authenticated {
		if group.stepUpAfterApply != 1 || group.stepUpBeforeApply != 0 {
			t.Errorf("authenticated group %d/%d has %d statement(s) of its own that mount "+
				"r.Use(stepup.Middleware(...)) after %s and %d before it; want exactly 1, after. A mount in a "+
				"nested group, a helper or a comment does not gate this group's routes",
				index+1, len(authenticated), group.stepUpAfterApply, apply, group.stepUpBeforeApply)
		}
		if got := strings.Count(root.withCalledFunctions(group.body), stepUp); got != 1 {
			t.Errorf("authenticated group %d/%d mounts stepup.Middleware %d times, counting the helpers it "+
				"calls; want exactly 1", index+1, len(authenticated), got)
		}
	}
}

// authenticatedRouteGroup is one authenticated route group of run(): a function
// literal whose router parameter r is passed to the shared authenticated stack
// by one of the literal's own statements, authenticatedRoutes.apply(r).
type authenticatedRouteGroup struct {
	// body is the source of the literal's body.
	body string
	// stepUpAfterApply and stepUpBeforeApply count the literal's own
	// statements that mount step-up on r, r.Use(stepup.Middleware(...)), after
	// and before the stack is applied. Statements of nested literals and of
	// called helpers are not the literal's own.
	stepUpAfterApply, stepUpBeforeApply int
}

// authenticatedRouteGroups returns, in source order, every function literal in
// run() that applies the shared authenticated stack to its router parameter as
// one of its own statements: the authenticated route groups.
func authenticatedRouteGroups(t *testing.T, root apiCompositionRootSource) []authenticatedRouteGroup {
	t.Helper()
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "main.go", root.main, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse main.go: %v", err)
	}
	var run *ast.FuncDecl
	for _, declaration := range file.Decls {
		if function, ok := declaration.(*ast.FuncDecl); ok && function.Recv == nil && function.Name.Name == "run" {
			run = function
		}
	}
	if run == nil {
		t.Fatal("main.go declares no run()")
	}
	source := func(node ast.Node) string {
		return root.main[fileSet.Position(node.Pos()).Offset:fileSet.Position(node.End()).Offset]
	}
	// isStepUpMount reports whether statement is r.Use(stepup.Middleware(...)).
	isStepUpMount := func(statement ast.Stmt) bool {
		expression, ok := statement.(*ast.ExprStmt)
		if !ok {
			return false
		}
		use, ok := expression.X.(*ast.CallExpr)
		if !ok || len(use.Args) != 1 {
			return false
		}
		method, ok := use.Fun.(*ast.SelectorExpr)
		if !ok || method.Sel.Name != "Use" {
			return false
		}
		if receiver, isIdent := method.X.(*ast.Ident); !isIdent || receiver.Name != "r" {
			return false
		}
		middleware, ok := use.Args[0].(*ast.CallExpr)
		if !ok {
			return false
		}
		constructor, ok := middleware.Fun.(*ast.SelectorExpr)
		if !ok || constructor.Sel.Name != "Middleware" {
			return false
		}
		pkg, isIdent := constructor.X.(*ast.Ident)
		return isIdent && pkg.Name == "stepup"
	}
	var groups []authenticatedRouteGroup
	ast.Inspect(run.Body, func(node ast.Node) bool {
		literal, ok := node.(*ast.FuncLit)
		if !ok {
			return true
		}
		applied := -1
		for index, statement := range literal.Body.List {
			if expression, isExpression := statement.(*ast.ExprStmt); isExpression &&
				source(expression) == "authenticatedRoutes.apply(r)" {
				applied = index
				break
			}
		}
		if applied < 0 {
			return true
		}
		// r must be the literal's own router, or the stack is applied to an
		// enclosing router and this literal is not a group of its own.
		params := literal.Type.Params.List
		if len(params) == 0 || len(params[0].Names) == 0 || params[0].Names[0].Name != "r" {
			t.Fatalf("a function literal in run() applies the authenticated stack to r, but its first "+
				"parameter is not r: %.120s", source(literal))
		}
		group := authenticatedRouteGroup{body: source(literal.Body)}
		for index, statement := range literal.Body.List {
			switch {
			case !isStepUpMount(statement):
			case index > applied:
				group.stepUpAfterApply++
			default:
				group.stepUpBeforeApply++
			}
		}
		groups = append(groups, group)
		return true
	})
	return groups
}

func TestAgentInteractiveReleaseHoldPrecedesAuthenticatedRouteSideEffects(t *testing.T) {
	t.Parallel()

	type counters struct {
		auth, session, routeAuth, telemetry, idempotency, repo, provider int
	}
	tests := []struct {
		name           string
		method         string
		path           string
		auth           string
		cookie         string
		body           string
		idempotencyKey string
	}{
		{name: "unauthenticated chat", method: http.MethodPost, path: "/api/v1/ai-agent/chat", body: `{"message":"password=chat-secret"}`},
		{name: "api key session list", method: http.MethodGet, path: "/api/v1/ai-agent/sessions", auth: "Bearer pw_live_secret"},
		{name: "session cookie messages", method: http.MethodGet, path: "/api/v1/ai-agent/sessions/session-secret/messages", cookie: "pw_session=session-secret"},
		{name: "admin config write", method: http.MethodPut, path: "/api/v1/ai-agent/config", auth: "Bearer pw_live_admin", body: `{"apiKey":"provider-secret"}`},
		{name: "idempotent session chat", method: http.MethodPost, path: "/api/v1/ai-agent/sessions/session-secret/chat", auth: "Bearer pw_live_secret", body: `{"message":"body-secret"}`, idempotencyKey: "idempotency-secret"},
		{name: "future family path", method: http.MethodPatch, path: "/api/v1/ai-agent/future/provider-secret", auth: "Bearer pw_live_secret", body: `{"secret":"future-secret"}`, idempotencyKey: "future-key"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			calls := &counters{}
			router := chi.NewRouter()
			mountAuthenticatedRoutesBehindAgentHold(router, func(protected chi.Router) {
				protected.Use(countingMiddleware(&calls.auth))
				protected.Use(countingMiddleware(&calls.session))
				protected.Use(countingMiddleware(&calls.routeAuth))
				protected.Use(countingMiddleware(&calls.telemetry))
				protected.Use(countingMiddleware(&calls.idempotency))
				// This trap models the repository/provider handler that would be
				// mounted only after a future explicit release.
				if ai_agent.AgentInteractiveReleased {
					protected.HandleFunc("/api/v1/ai-agent/*", func(w http.ResponseWriter, _ *http.Request) {
						calls.repo++
						calls.provider++
						w.WriteHeader(http.StatusNoContent)
					})
				}
			})

			body := &countingReadCloser{reader: strings.NewReader(test.body)}
			request := httptest.NewRequest(test.method, test.path, body)
			if test.auth != "" {
				request.Header.Set("Authorization", test.auth)
			}
			if test.cookie != "" {
				request.Header.Set("Cookie", test.cookie)
			}
			if test.idempotencyKey != "" {
				request.Header.Set("Idempotency-Key", test.idempotencyKey)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q, want private, no-store", got)
			}
			if got := response.Header().Get("Pragma"); got != "no-cache" {
				t.Fatalf("Pragma = %q, want no-cache", got)
			}
			var frame struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &frame); err != nil {
				t.Fatalf("decode response: %v; body=%s", err, response.Body.String())
			}
			if frame.Code != ai_agent.AgentInteractiveReleaseHoldCode {
				t.Fatalf("code = %q, want %q", frame.Code, ai_agent.AgentInteractiveReleaseHoldCode)
			}
			if body.reads != 0 {
				t.Fatalf("request body reads = %d, want 0", body.reads)
			}
			if got := *calls; got != (counters{}) {
				t.Fatalf("side-effect counters = %+v, want all zero", got)
			}
			for _, secret := range []string{"pw_live", "session-secret", "provider-secret", "body-secret", "idempotency-secret", "future-secret", "future-key"} {
				if strings.Contains(response.Body.String(), secret) {
					t.Fatalf("response leaked %q: %s", secret, response.Body.String())
				}
			}
		})
	}
}

func TestMainMountsAgentInteractiveReleaseHoldBeforeAuthenticatedBoundary(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	outer := strings.Index(source, "mountAuthenticatedRoutesBehindAgentHold(r, func")
	authenticated := strings.Index(source, "authenticatedRoutes.apply(r)")
	if outer < 0 || authenticated < 0 || outer >= authenticated {
		t.Fatalf("agent hold mount index=%d must precede authenticated stack index=%d", outer, authenticated)
	}
	if !strings.Contains(source, "if ai_agent.AgentInteractiveReleased {\n\t\t\tai_agent.MountAgentRoutes(r, agentChat)") {
		t.Fatal("future agent handlers are not guarded by AgentInteractiveReleased")
	}
}

func TestPrivacyIncidentHeadersWrapAuthenticationAndTenantResolution(t *testing.T) {
	t.Parallel()

	passthrough := func(next http.Handler) http.Handler { return next }
	tests := []struct {
		name    string
		prepare func(*authenticatedRouteStack, *http.Request)
	}{
		{
			name: "malformed bearer is protected before API-key authentication",
			prepare: func(stack *authenticatedRouteStack, request *http.Request) {
				stack.authenticateAPIKey = apikeys.MiddlewareWithOptions(
					nil,
					nil,
					apikeys.MiddlewareOptions{},
				)
				stack.resolveTenant = passthrough
				request.Header.Set("Authorization", "Bearer malformed")
			},
		},
		{
			name: "missing tenant is protected before tenant resolution",
			prepare: func(stack *authenticatedRouteStack, _ *http.Request) {
				stack.authenticateAPIKey = passthrough
				stack.resolveTenant = middleware.TenantMiddleware(nil)
			},
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			stack := completeTestAuthenticatedRouteStack()
			request := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/privacy/incidents",
				http.NoBody,
			)
			test.prepare(&stack, request)

			router := chi.NewRouter()
			router.Group(func(protected chi.Router) {
				protected.Use(privacy.ProtectIncidentResponses)
				stack.apply(protected)
				protected.Get("/api/v1/privacy/incidents", func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusNoContent)
				})
			})

			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401; body=%s", response.Code, response.Body.String())
			}
			assertPrivacyIncidentCredentialHeaders(t, response.Header())
		})
	}
}

func TestMainMountsPrivacyIncidentHeadersBeforeAuthenticatedBoundary(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	start := strings.Index(source, "var partitionRotator")
	if start < 0 {
		t.Fatal("authenticated route-group start marker is missing")
	}
	endOffset := strings.Index(source[start:], "authenticatedRoutes.apply(r)")
	if endOffset < 0 {
		t.Fatal("first authenticated route-stack application is missing")
	}
	outerBoundary := source[start : start+endOffset]
	if !strings.Contains(outerBoundary, "r.Use(privacy.ProtectIncidentResponses)") {
		t.Fatal("privacy incident response protection does not precede authentication")
	}
}

func TestRoute42HeadersWrapAuthenticationTenantAuthorizationAndHandlers(t *testing.T) {
	t.Parallel()

	passthrough := func(next http.Handler) http.Handler { return next }
	tests := []struct {
		name       string
		path       string
		prepare    func(*authenticatedRouteStack, *http.Request)
		handler    http.HandlerFunc
		wantStatus int
	}{
		{
			name: "malformed bearer",
			path: "/api/v1/sms/suppressions",
			prepare: func(stack *authenticatedRouteStack, request *http.Request) {
				stack.authenticateAPIKey = apikeys.MiddlewareWithOptions(nil, nil, apikeys.MiddlewareOptions{})
				stack.resolveTenant = passthrough
				request.Header.Set("Authorization", "Bearer malformed")
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name: "missing tenant",
			path: "/api/v1/sms/quiet-hours",
			prepare: func(stack *authenticatedRouteStack, _ *http.Request) {
				stack.authenticateAPIKey = passthrough
				stack.resolveTenant = middleware.TenantMiddleware(nil)
			},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name: "authorization refusal",
			path: "/api/v1/sms/keyword-responses",
			prepare: func(stack *authenticatedRouteStack, _ *http.Request) {
				stack.authorizeRoute = func(http.Handler) http.Handler {
					return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						w.Header().Set("Cache-Control", "public, max-age=60")
						w.WriteHeader(http.StatusForbidden)
					})
				}
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name: "successful handler override",
			path: "/api/v1/sms/suppressions",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Cache-Control", "public, max-age=60")
				w.Header().Del("Pragma")
				w.Header().Del("X-Content-Type-Options")
				w.WriteHeader(http.StatusNoContent)
			},
			wantStatus: http.StatusNoContent,
		},
		{
			name: "item not found",
			path: "/api/v1/sms/quiet-hours/00000000-0000-4000-8000-000000000001",
			handler: func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "not found", http.StatusNotFound)
			},
			wantStatus: http.StatusNotFound,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			stack := completeTestAuthenticatedRouteStack()
			request := httptest.NewRequest(http.MethodGet, test.path, http.NoBody)
			if test.prepare != nil {
				test.prepare(&stack, request)
			}
			handler := test.handler
			if handler == nil {
				handler = func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }
			}
			router := chi.NewRouter()
			router.Group(func(protected chi.Router) {
				protected.Use(sms.ProtectRoute42Responses)
				stack.apply(protected)
				protected.Get(test.path, handler)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			assertRoute42PrivateHeaders(t, response.Header())
		})
	}
}

func TestProtectRoute42ResponsesDoesNotLeakToAdjacentRoutes(t *testing.T) {
	t.Parallel()
	handler := sms.ProtectRoute42Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	for _, path := range []string{
		"/api/v1/sms/suppressions-export",
		"/api/v1/sms/quiet-hours-preview",
		"/api/v1/sms/keyword-responses-archive",
		"/api/v1/sms/campaigns",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, http.NoBody))
		if got := response.Header().Get("Cache-Control"); got != "" {
			t.Errorf("%s Cache-Control = %q, want untouched", path, got)
		}
		if got := response.Header().Get("Pragma"); got != "" {
			t.Errorf("%s Pragma = %q, want untouched", path, got)
		}
		if got := response.Header().Get("X-Content-Type-Options"); got != "" {
			t.Errorf("%s X-Content-Type-Options = %q, want untouched", path, got)
		}
	}
}

func TestProtectRoute42ResponsesRestampsBeforeOuterPanicRecovery(t *testing.T) {
	t.Parallel()
	panicHandler := sms.ProtectRoute42Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Del("Pragma")
		w.Header().Del("X-Content-Type-Options")
		panic("route42 panic before response commit")
	}))
	recoveringOuter := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() != nil {
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		panicHandler.ServeHTTP(w, r)
	})
	response := httptest.NewRecorder()
	recoveringOuter.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/sms/suppressions/query", http.NoBody))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.Code)
	}
	assertRoute42PrivateHeaders(t, response.Header())
}

func TestRootRoute42HeadersWrapEarlyRefusalsAndRouterNotFound(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		path       string
		method     string
		configure  func(chi.Router)
		request    func() *http.Request
		wantStatus int
	}{
		{
			name:   "control byte",
			method: http.MethodGet,
			path:   "/api/v1/sms/suppressions/item",
			configure: func(router chi.Router) {
				router.Use(rejectControlBytesInPath)
				router.Get("/api/v1/sms/suppressions/item", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			},
			request: func() *http.Request {
				req := httptest.NewRequest(http.MethodGet, "/api/v1/sms/suppressions/item", http.NoBody)
				req.URL.Path += "\x00"
				return req
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "root body limit",
			method: http.MethodPost,
			path:   "/api/v1/sms/suppressions/query",
			configure: func(router chi.Router) {
				router.Use(httpbody.LimitRequests(4, nil))
				router.Post("/api/v1/sms/suppressions/query", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			},
			request: func() *http.Request {
				return httptest.NewRequest(http.MethodPost, "/api/v1/sms/suppressions/query", strings.NewReader("12345"))
			},
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name:   "csrf",
			method: http.MethodPost,
			path:   "/api/v1/sms/quiet-hours",
			configure: func(router chi.Router) {
				router.Use(middleware.AllowedOriginsCSRF([]string{"https://app.moosewave.com"}))
				router.Post("/api/v1/sms/quiet-hours", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			},
			request: func() *http.Request {
				req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/quiet-hours", http.NoBody)
				req.AddCookie(&http.Cookie{Name: "pw_session", Value: "session"})
				return req
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name:   "client version",
			method: http.MethodGet,
			path:   "/api/v1/sms/keyword-responses",
			configure: func(router chi.Router) {
				router.Use(middleware.ClientVersion(map[string]string{"web": "2.0.0"}))
				router.Get("/api/v1/sms/keyword-responses", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
			},
			request: func() *http.Request {
				req := httptest.NewRequest(http.MethodGet, "/api/v1/sms/keyword-responses", http.NoBody)
				req.Header.Set("X-Postwave-Client", "web")
				req.Header.Set("X-Postwave-Version", "1.0.0")
				return req
			},
			wantStatus: http.StatusUpgradeRequired,
		},
		{
			name:   "route family not found",
			method: http.MethodGet,
			path:   "/api/v1/sms/quiet-hours/00000000-0000-4000-8000-000000000001/unknown",
			configure: func(router chi.Router) {
				router.NotFound(sms.ProtectRoute42Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusNotFound)
				})).ServeHTTP)
			},
			request: func() *http.Request {
				return httptest.NewRequest(http.MethodGet, "/api/v1/sms/quiet-hours/00000000-0000-4000-8000-000000000001/unknown", http.NoBody)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "route family method not allowed",
			method: http.MethodPost,
			path:   "/api/v1/sms/keyword-responses/00000000-0000-4000-8000-000000000001",
			configure: func(router chi.Router) {
				router.MethodNotAllowed(sms.ProtectRoute42Responses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusMethodNotAllowed)
				})).ServeHTTP)
				router.Delete("/api/v1/sms/keyword-responses/00000000-0000-4000-8000-000000000001", func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusNoContent)
				})
			},
			request: func() *http.Request {
				return httptest.NewRequest(http.MethodPost, "/api/v1/sms/keyword-responses/00000000-0000-4000-8000-000000000001", http.NoBody)
			},
			wantStatus: http.StatusMethodNotAllowed,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			router := chi.NewRouter()
			router.Use(sms.ProtectRoute42Responses)
			test.configure(router)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, test.request())
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			assertRoute42PrivateHeaders(t, response.Header())
		})
	}
}

func TestMainMountsRoute42HeadersBeforeAuthenticatedBoundary(t *testing.T) {
	t.Parallel()
	sourceBytes, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	start := strings.Index(source, "var partitionRotator")
	if start < 0 {
		t.Fatal("authenticated route-group start marker is missing")
	}
	endOffset := strings.Index(source[start:], "authenticatedRoutes.apply(r)")
	if endOffset < 0 {
		t.Fatal("first authenticated route-stack application is missing")
	}
	outerBoundary := source[start : start+endOffset]
	if !strings.Contains(outerBoundary, "r.Use(sms.ProtectRoute42Responses)") {
		t.Fatal("Route42 response protection does not precede authentication")
	}
	metricsAt := strings.Index(source, "r.Use(observability.HTTPRequestMetrics)")
	recovererAt := strings.Index(source, "r.Use(jsonRecoverer(logger))")
	rootGuardAt := strings.Index(source, "r.Use(sms.ProtectRoute42Responses)")
	rejectAt := strings.Index(source, "r.Use(rejectControlBytesInPath)")
	bodyLimitAt := strings.Index(source, "r.Use(httpbody.LimitRequests(")
	csrfAt := strings.Index(source, "r.Use(middleware.AllowedOriginsCSRF(")
	clientVersionAt := strings.Index(source, "r.Use(middleware.ClientVersion(")
	if recovererAt < 0 || rootGuardAt <= recovererAt || metricsAt < 0 || rootGuardAt <= metricsAt || rejectAt <= rootGuardAt || bodyLimitAt <= rootGuardAt ||
		csrfAt <= rootGuardAt || clientVersionAt <= rootGuardAt {
		t.Fatalf("root Route42 guard ordering recoverer=%d metrics=%d guard=%d reject=%d body=%d csrf=%d client=%d",
			recovererAt, metricsAt, rootGuardAt, rejectAt, bodyLimitAt, csrfAt, clientVersionAt)
	}
	for _, marker := range []string{
		"r.NotFound(sms.ProtectRoute42Responses(",
		"r.MethodNotAllowed(sms.ProtectRoute42Responses(",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("Route42 router-level refusal protection is missing %q", marker)
		}
	}
}

func assertRoute42PrivateHeaders(t *testing.T, header http.Header) {
	t.Helper()
	if got := header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	if got := header.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
	if got := header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

func assertPrivacyIncidentCredentialHeaders(t *testing.T, header http.Header) {
	t.Helper()
	if got := header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	vary := strings.Join(header.Values("Vary"), ",")
	for _, dimension := range []string{"Authorization", "Cookie"} {
		if !strings.Contains(vary, dimension) {
			t.Fatalf("Vary = %q, missing %s", vary, dimension)
		}
	}
}

func completeTestAuthenticatedRouteStack() authenticatedRouteStack {
	passthrough := func(next http.Handler) http.Handler { return next }
	return authenticatedRouteStack{
		authenticateAPIKey:   passthrough,
		meterAPIKey:          passthrough,
		recordAPIKeyCalls:    []routeMiddleware{passthrough},
		resolveTenant:        passthrough,
		stampContextEpoch:    passthrough,
		authorizeRoute:       passthrough,
		applyImpersonation:   passthrough,
		enforceAdminIP:       passthrough,
		resolveAuditScopes:   passthrough,
		requireMFA:           passthrough,
		enforceTenantRegion:  passthrough,
		meterCommercialUsage: passthrough,
	}
}

func recordingRouteMiddleware(invoked *[]string, name string) routeMiddleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*invoked = append(*invoked, name)
			next.ServeHTTP(w, r)
		})
	}
}

func countingMiddleware(counter *int) routeMiddleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*counter++
			next.ServeHTTP(w, r)
		})
	}
}

type countingReadCloser struct {
	reader io.Reader
	reads  int
}

func (r *countingReadCloser) Read(p []byte) (int, error) {
	r.reads++
	return r.reader.Read(p)
}

func (*countingReadCloser) Close() error { return nil }

func deferredPanicContains(t *testing.T, want string, run func()) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil || !strings.Contains(recovered.(string), want) {
			t.Fatalf("panic = %v, want substring %q", recovered, want)
		}
	}()
	run()
}
