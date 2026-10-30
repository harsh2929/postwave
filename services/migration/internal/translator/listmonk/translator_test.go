package listmonk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
)

func TestCompileSegment_Equality(t *testing.T) {
	n := canonical.SegmentNode{Op: "condition", Field: "email", Comparator: "equals", Value: "a@b.com"}
	sql, args, err := CompileSegment(n)
	require.NoError(t, err)
	require.Equal(t, "subscribers.email = $1", sql)
	require.Equal(t, []interface{}{"a@b.com"}, args)
}

func TestCompileSegment_TagMembership(t *testing.T) {
	sql, args, err := CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "tags", Comparator: "equals", Value: "paid",
	})
	require.NoError(t, err)
	require.Equal(t, "$1 = ANY(subscribers.tags)", sql)
	require.Equal(t, []interface{}{"paid"}, args)

	sql, args, err = CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "tags", Comparator: "in", Value: []interface{}{"paid", "vip"},
	})
	require.NoError(t, err)
	require.Equal(t, "subscribers.tags && ARRAY[$1, $2]::text[]", sql)
	require.Equal(t, []interface{}{"paid", "vip"}, args)
}

func TestCompileSegment_AndOr(t *testing.T) {
	n := canonical.SegmentNode{
		Op: "and",
		Children: []canonical.SegmentNode{
			{Op: "condition", Field: "email", Comparator: "contains", Value: "@gmail.com"},
			{Op: "or", Children: []canonical.SegmentNode{
				{Op: "condition", Field: "custom.tier", Comparator: "equals", Value: "gold"},
				{Op: "condition", Field: "custom.tier", Comparator: "equals", Value: "platinum"},
			}},
		},
	}
	sql, args, err := CompileSegment(n)
	require.NoError(t, err)
	require.Equal(t,
		"(subscribers.email ILIKE $1) AND ((subscribers.custom_fields->>'tier' = $2) OR (subscribers.custom_fields->>'tier' = $3))",
		sql)
	require.Equal(t, []interface{}{"%@gmail.com%", "gold", "platinum"}, args)
}

func TestCompileSegment_Not(t *testing.T) {
	n := canonical.SegmentNode{
		Op: "not",
		Children: []canonical.SegmentNode{
			{Op: "condition", Field: "status", Comparator: "equals", Value: "blocklisted"},
		},
	}
	sql, args, err := CompileSegment(n)
	require.NoError(t, err)
	require.Equal(t, "NOT (subscribers.status = $1)", sql)
	require.Equal(t, []interface{}{"blocklisted"}, args)
}

func TestCompileSegment_Comparators(t *testing.T) {
	cases := []struct {
		cmp     string
		wantSQL string
	}{
		{"not_equals", "subscribers.email <> $1"},
		{"contains", "subscribers.email ILIKE $1"},
		{"not_contains", "subscribers.email NOT ILIKE $1"},
		{"starts_with", "subscribers.email ILIKE $1"},
		{"ends_with", "subscribers.email ILIKE $1"},
		{"gt", "subscribers.email > $1"},
		{"lt", "subscribers.email < $1"},
	}
	for _, tc := range cases {
		t.Run(tc.cmp, func(t *testing.T) {
			sql, _, err := CompileSegment(canonical.SegmentNode{
				Op: "condition", Field: "email", Comparator: tc.cmp, Value: "x",
			})
			require.NoError(t, err)
			require.Equal(t, tc.wantSQL, sql)
		})
	}
}

func TestCompileSegment_InAndEmptyEdgeCases(t *testing.T) {
	// in with values
	sql, args, err := CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "email", Comparator: "in",
		Value: []interface{}{"a@b.com", "c@d.com"},
	})
	require.NoError(t, err)
	require.Equal(t, "subscribers.email IN ($1, $2)", sql)
	require.Equal(t, []interface{}{"a@b.com", "c@d.com"}, args)

	// not_in with empty list -> always TRUE (no exclusion)
	sql, _, err = CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "email", Comparator: "not_in", Value: []interface{}{},
	})
	require.NoError(t, err)
	require.Equal(t, "TRUE", sql)

	// in with empty list -> always FALSE
	sql, _, err = CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "email", Comparator: "in", Value: []interface{}{},
	})
	require.NoError(t, err)
	require.Equal(t, "FALSE", sql)
}

func TestCompileSegment_CustomFieldExtraction(t *testing.T) {
	sql, _, err := CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "custom.city", Comparator: "equals", Value: "NYC",
	})
	require.NoError(t, err)
	require.Equal(t, "subscribers.custom_fields->>'city' = $1", sql)
}

func TestCompileSegment_SQLInjectionResistedInValueViaPlaceholder(t *testing.T) {
	// The value goes through a placeholder; only the field name is interpolated.
	sql, args, err := CompileSegment(canonical.SegmentNode{
		Op: "condition", Field: "custom.x", Comparator: "equals", Value: "'; DROP TABLE subscribers; --",
	})
	require.NoError(t, err)
	require.NotContains(t, sql, "DROP TABLE")
	require.Equal(t, []interface{}{"'; DROP TABLE subscribers; --"}, args)
}

func TestCompileSegment_UnknownOpReturnsError(t *testing.T) {
	_, _, err := CompileSegment(canonical.SegmentNode{Op: "xor"})
	require.Error(t, err)
}

func TestCompileSegment_EmptyBooleanGroupsFailClosed(t *testing.T) {
	_, _, err := CompileSegment(canonical.SegmentNode{Op: "and"})
	require.ErrorContains(t, err, "has no children")
	_, _, err = CompileSegment(canonical.SegmentNode{Op: "or"})
	require.ErrorContains(t, err, "has no children")
	_, _, err = CompileSegment(canonical.SegmentNode{Op: "not"})
	require.ErrorContains(t, err, "requires exactly one child")
}

func TestPersistAutomationRejectsNonExecutableAutomationBeforeDB(t *testing.T) {
	_, err := PersistAutomation(context.Background(), nil, "tenant", "job", canonical.Automation{
		Name:             "ActiveCampaign welcome",
		Status:           "paused",
		Triggers:         []canonical.AutomationTrigger{{Type: "custom_event", EventName: "activecampaign.automation.12"}},
		SourceDefinition: `{"id":"12","status":"active"}`,
	}, canonical.SourceActiveCampaign)
	require.Error(t, err)
	require.Contains(t, err.Error(), "no executable journey nodes")
}

func TestMailchimpMirrorFidelityAndConsentPolicy(t *testing.T) {
	consentAt := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	sub := canonical.Subscriber{
		Email:            "member@example.com",
		Status:           canonical.StatusEnabled,
		ConsentTimestamp: &consentAt,
		ConsentSource:    canonical.ConsentUnknown,
		SourcePlatform:   canonical.SourceMailchimp,
		Tags:             []string{"mailchimp:list:audience-1"},
		CustomFields: map[string]interface{}{
			"name":                      "Canonical Name",
			"postwave_mailchimp_status": "subscribed",
			"postwave_mailchimp_merge_fields": map[string]interface{}{
				"name":  "Snapshot Name",
				"FNAME": "Ada",
			},
			"postwave_mailchimp_groups": []map[string]interface{}{{
				"source_id":     "interest-1",
				"name":          "Weekly",
				"category":      "Frequency",
				"category_id":   "category-9",
				"type":          "checkboxes",
				"display_order": 7,
			}},
		},
	}

	fields := subscriberMirrorFields(sub)
	require.Equal(t, "Canonical Name", fields.MergeFields["name"], "ordinary canonical fields deterministically overlay the source snapshot")
	require.Equal(t, "Ada", fields.FirstName)
	require.Equal(t, "Frequency", fields.Groups[0]["category"])
	require.Equal(t, "category-9", fields.Groups[0]["category_id"])
	require.Equal(t, "checkbox", fields.Groups[0]["type"])
	require.Equal(t, 7, fields.Groups[0]["display_order"])
	require.Equal(t, "audience-1", fields.Groups[0]["audience_id"])
	require.Contains(t, fields.Groups[0]["registry_category"], "mailchimp:audience-1:category-9")
	require.Equal(t, consentAt, defensibleImportedConsentAt(sub, string(canonical.StatusEnabled), fields.MailchimpStatus))
	require.Nil(t, defensibleImportedConsentAt(sub, string(canonical.StatusBlocklisted), fields.MailchimpStatus))

	withoutTimestamp := sub
	withoutTimestamp.ConsentTimestamp = nil
	quarantined := quarantineMailchimpWithoutConsentEvidence(withoutTimestamp)
	require.Equal(t, canonical.StatusUnconfirmed, quarantined.Status)
	require.Equal(t, "disabled", toListmonkPayload(quarantined).Status, "unknown consent evidence must never produce an enabled Listmonk row")

	require.True(t, validMailchimpStatus("pending"))
	require.True(t, validMailchimpStatus("transactional"))
	require.Greater(t, mailchimpStatusRank("transactional"), mailchimpStatusRank("non_subscribed"))
	require.Greater(t, mailchimpStatusRank("cleaned"), mailchimpStatusRank("deleted"))
}

// --- client tests ---

func TestClient_CreateSubscriber(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/subscribers", r.URL.Path)
		require.Equal(t, http.MethodPost, r.Method)
		user, pass, ok := r.BasicAuth()
		require.True(t, ok)
		require.Equal(t, "admin", user)
		require.Equal(t, "pw", pass)
		var got SubscriberPayload
		require.NoError(t, json.NewDecoder(r.Body).Decode(&got))
		require.Equal(t, "x@y.com", got.Email)
		_, _ = w.Write([]byte(`{"data":{"id":42,"email":"x@y.com"}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, AdminUser: "admin", AdminPass: "pw", HTTPClient: srv.Client()}
	resp, err := c.CreateSubscriber(context.Background(), SubscriberPayload{Email: "x@y.com", Status: "enabled"})
	require.NoError(t, err)
	require.Equal(t, 42, resp.ID)
}

func TestClientURLBuilderPreservesBasePathAndQuery(t *testing.T) {
	calls := make([]string, 0, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.String())
		_, _ = w.Write([]byte(`{"data":{"results":[{"id":42,"email":"x@y.com"}]}}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL + "/listmonk///", AdminUser: "admin", AdminPass: "pw", HTTPClient: srv.Client()}
	ids, err := c.FindSubscribersByAttrib(context.Background(), "postwave_source_platform", "mailchimp", 10)
	require.NoError(t, err)
	require.Equal(t, []int{42}, ids)
	require.Len(t, calls, 1)
	require.True(t, strings.HasPrefix(calls[0], "/listmonk/api/subscribers?"), calls[0])
}

func TestClientRejectsUnsafeBaseURL(t *testing.T) {
	c := &Client{BaseURL: "https://user:pass@example.test", AdminUser: "admin", AdminPass: "pw", HTTPClient: http.DefaultClient}
	_, err := c.CreateSubscriber(context.Background(), SubscriberPayload{Email: "x@y.com", Status: "enabled"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe base URL")
}

func TestClientRejectsEncodedTraversalAndBackslashes(t *testing.T) {
	for _, path := range []string{
		"/api/%2e%2e/subscribers",
		"/api/%2E/subscribers",
		"/api\\subscribers",
	} {
		_, err := listmonkURL("https://listmonk.example.test", path)
		require.Error(t, err, path)
		require.Contains(t, err.Error(), "unsafe request path")
	}
}

func TestClient_ErrorBodyIsCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", int(listmonkErrorResponseMaxBytes)+1024)))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, AdminUser: "admin", AdminPass: "pw", HTTPClient: srv.Client()}
	_, err := c.CreateSubscriber(context.Background(), SubscriberPayload{Email: "x@y.com", Status: "enabled"})
	require.Error(t, err)
	require.Equal(t, int(listmonkErrorResponseMaxBytes), strings.Count(err.Error(), "x"))
}

func TestClient_SuccessBodyIsCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(listmonkJSONResponseMaxBytes)+1)))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, AdminUser: "admin", AdminPass: "pw", HTTPClient: srv.Client()}
	_, err := c.CreateSubscriber(context.Background(), SubscriberPayload{Email: "x@y.com", Status: "enabled"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "response body too large")
}

func TestClient_UpsertSubscriber_HandlesConflict(t *testing.T) {
	calls := []string{}
	var updated SubscriberPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			w.WriteHeader(http.StatusConflict)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/subscribers"):
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":7,"email":"x@y.com","name":"Existing","status":"enabled","tags":["mailchimp:list:list_a","vip"],"attribs":{"FNAME":"Alice","PLAN":"basic","postwave_source_id":"list:list_a:member:m1","postwave_source_ids":["list:list_a:member:m1"],"postwave_tags":["mailchimp:list:list_a","vip"]}}]}}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/subscribers/7":
			require.NoError(t, json.NewDecoder(r.Body).Decode(&updated))
			_, _ = w.Write([]byte(`{"data":{"id":7,"email":"x@y.com"}}`))
		default:
			t.Fatalf("unexpected call: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}
	resp, outcome, err := c.UpsertSubscriber(context.Background(), SubscriberPayload{
		Email:  "x@y.com",
		Status: "disabled",
		Tags:   []string{"mailchimp:list:list_b", "vip", "interest:abc"},
		Attribs: map[string]interface{}{
			"FNAME":               "Alice",
			"PLAN":                "pro",
			"postwave_source_id":  "list:list_b:member:m9",
			"postwave_tags":       []string{"mailchimp:list:list_b", "vip", "interest:abc"},
			"postwave_status_raw": "unconfirmed",
		},
	})
	require.NoError(t, err)
	require.Equal(t, 7, resp.ID)
	require.Equal(t, UpsertUpdated, outcome,
		"conflict→PUT path should report UpsertUpdated, not UpsertCreated")
	require.Len(t, calls, 3)
	require.Equal(t, "disabled", updated.Status, "status merge should keep stricter imported status")
	require.Equal(t, "Existing", updated.Name)
	require.ElementsMatch(t, []string{"mailchimp:list:list_a", "vip", "mailchimp:list:list_b", "interest:abc"}, updated.Tags)
	require.Equal(t, "basic", updated.Attribs["PLAN"], "primary existing value is kept when a custom field conflicts")
	require.ElementsMatch(t, []interface{}{"basic", "pro"}, conflictValues(updated.Attribs["postwave_field_conflicts"], "PLAN"))
	require.ElementsMatch(t, []interface{}{"list:list_a:member:m1", "list:list_b:member:m9"}, toInterfaceSlice(updated.Attribs["postwave_source_ids"]))
	require.ElementsMatch(t, []interface{}{"mailchimp:list:list_a", "vip", "mailchimp:list:list_b", "interest:abc"}, toInterfaceSlice(updated.Attribs["postwave_tags"]))
}

func TestSubscriberCrashMarkerDistinguishesPreexistingUpdateFromCreate(t *testing.T) {
	original := SubscriberResponse{ID: 7, Email: "x@y.com", Name: "Original", Status: "enabled", Attribs: map[string]interface{}{"local": "keep"}}
	t.Run("first update writes original before-image", func(t *testing.T) {
		var put SubscriberPayload
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				w.WriteHeader(http.StatusConflict)
			case http.MethodGet:
				raw, _ := json.Marshal(map[string]interface{}{"data": map[string]interface{}{"results": []SubscriberResponse{original}}})
				_, _ = w.Write(raw)
			case http.MethodPut:
				require.NoError(t, json.NewDecoder(r.Body).Decode(&put))
				_, _ = w.Write([]byte(`{"data":{"id":7,"email":"x@y.com"}}`))
			}
		}))
		defer srv.Close()
		client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}
		result, err := client.UpsertSubscriberWithSnapshot(context.Background(), SubscriberPayload{
			Email: "x@y.com", Status: "enabled",
			Attribs: map[string]interface{}{
				"postwave_migration_job_id": "job-1",
				migrationOperationAttrib:    string(UpsertCreated),
			},
		})
		require.NoError(t, err)
		require.Equal(t, UpsertUpdated, result.Outcome)
		require.Equal(t, "Original", result.Before.Name)
		require.Equal(t, string(UpsertUpdated), put.Attribs[migrationOperationAttrib])
		require.NotEmpty(t, put.Attribs[migrationAfterAttrib])
		storedBefore, err := subscriberSnapshotFromAttrib(put.Attribs[migrationBeforeAttrib])
		require.NoError(t, err)
		require.Equal(t, original, storedBefore)
	})

	t.Run("crashed update restores original snapshot", func(t *testing.T) {
		existing := SubscriberResponse{ID: 7, Email: "x@y.com", Name: "Migrated", Status: "disabled", Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-1",
			migrationOperationAttrib:    string(UpsertUpdated),
			migrationBeforeAttrib:       subscriberSnapshotMap(original),
		}}
		result := conflictUpsertFixture(t, existing)
		require.Equal(t, UpsertUpdated, result.Outcome)
		require.Equal(t, "Original", result.Before.Name)
		require.Equal(t, "Migrated", result.AttemptBefore.Name)
	})

	t.Run("crashed create remains delete-on-rollback", func(t *testing.T) {
		existing := SubscriberResponse{ID: 8, Email: "x@y.com", Name: "Created", Status: "enabled", Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-1",
			migrationOperationAttrib:    string(UpsertCreated),
		}}
		result := conflictUpsertFixture(t, existing)
		require.Equal(t, UpsertCreated, result.Outcome)
		require.Nil(t, result.Before)
		require.Equal(t, "Created", result.AttemptBefore.Name)
	})

	t.Run("crashed update refuses a later user edit", func(t *testing.T) {
		intended := SubscriberResponse{ID: 7, Email: "x@y.com", Name: "Migrated", Status: "disabled", Tags: []string{"imported"}, Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-1",
			migrationOperationAttrib:    string(UpsertUpdated),
			migrationBeforeAttrib:       subscriberSnapshotMap(original),
		}}
		stampTestSubscriberAfter(&intended)
		intended.Name = "Edited by user after migration"

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost:
				w.WriteHeader(http.StatusConflict)
			case http.MethodGet:
				raw, _ := json.Marshal(map[string]interface{}{"data": map[string]interface{}{"results": []SubscriberResponse{intended}}})
				_, _ = w.Write(raw)
			case http.MethodPut:
				t.Fatal("retry must not overwrite the later user edit")
			}
		}))
		defer srv.Close()
		client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}
		_, err := client.UpsertSubscriberWithSnapshot(context.Background(), SubscriberPayload{
			Email: "x@y.com", Status: "disabled",
			Attribs: map[string]interface{}{
				"postwave_migration_job_id": "job-1",
				migrationOperationAttrib:    string(UpsertCreated),
			},
		})
		require.ErrorContains(t, err, "changed after the unledgered migration write")
	})
}

func conflictUpsertFixture(t *testing.T, existing SubscriberResponse) SubscriberUpsertResult {
	t.Helper()
	stampTestSubscriberAfter(&existing)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		case http.MethodGet:
			raw, _ := json.Marshal(map[string]interface{}{"data": map[string]interface{}{"results": []SubscriberResponse{existing}}})
			_, _ = w.Write(raw)
		case http.MethodPut:
			raw, _ := json.Marshal(map[string]interface{}{"data": map[string]interface{}{"id": existing.ID, "email": existing.Email}})
			_, _ = w.Write(raw)
		}
	}))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}
	result, err := client.UpsertSubscriberWithSnapshot(context.Background(), SubscriberPayload{
		Email: existing.Email, Status: "disabled",
		Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-1",
			migrationOperationAttrib:    string(UpsertCreated),
		},
	})
	require.NoError(t, err)
	return result
}

func stampTestSubscriberAfter(sub *SubscriberResponse) {
	if sub == nil {
		return
	}
	payload := SubscriberPayload{
		Email: sub.Email, Name: sub.Name, Status: sub.Status,
		Tags: append([]string(nil), sub.Tags...), Lists: append([]int(nil), sub.Lists...), Attribs: copyAttribs(sub.Attribs),
	}
	stampSubscriberAfterFingerprint(&payload)
	sub.Attribs = payload.Attribs
}

func TestClientMigrationIsolationRequiresExactDedicatedTenant(t *testing.T) {
	shared := &Client{}
	require.ErrorContains(t, shared.ValidateMigrationIsolation("tenant-a"), "not tenant-dedicated")

	wrong := &Client{DedicatedTenant: true, DedicatedTenantID: "tenant-b"}
	require.ErrorContains(t, wrong.ValidateMigrationIsolation("tenant-a"), "bound to tenant")

	exact := &Client{DedicatedTenant: true, DedicatedTenantID: "tenant-a"}
	require.NoError(t, exact.ValidateMigrationIsolation("tenant-a"))
}

func TestMigrationScopedExternalNamesSeparateDuplicateDisplayNames(t *testing.T) {
	listA := migrationScopedSourceName("Newsletter", "123456789-job", "audience-a")
	listB := migrationScopedSourceName("Newsletter", "123456789-job", "audience-b")
	templateA := migrationScopedSourceName("Welcome", "123456789-job", "template-a")
	templateB := migrationScopedSourceName("Welcome", "123456789-job", "template-b")
	require.NotEqual(t, listA, listB)
	require.NotEqual(t, templateA, templateB)
	require.Contains(t, listA, "Newsletter")
	require.Contains(t, templateA, "Welcome")
}

func TestClientReconcilesExactListAndTemplateNames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/lists":
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":41,"name":"Audience (migration abc) [source 1234]","tags":["postwave-migration","tenant:tenant-a"]}],"total":1}}`))
		case "/api/lists/41":
			_, _ = w.Write([]byte(`{"data":{"id":41,"name":"Audience (migration abc) [source 1234]","tags":["postwave-migration","tenant:tenant-a"]}}`))
		case "/api/templates":
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":51,"name":"Welcome (migration abc) [source 5678]"}],"total":1}}`))
		case "/api/templates/51":
			_, _ = w.Write([]byte(`{"data":{"id":51,"name":"Welcome (migration abc) [source 5678]","body":"<p>owned</p>"}}`))
		}
	}))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}

	list, err := client.FindListByName(context.Background(), "Audience (migration abc) [source 1234]")
	require.NoError(t, err)
	require.Equal(t, 41, list.ID)
	template, err := client.FindTemplateByName(context.Background(), "Welcome (migration abc) [source 5678]")
	require.NoError(t, err)
	require.Equal(t, 51, template.ID)
}

func TestClientReconciliationFailsClosedPastSearchBound(t *testing.T) {
	item := `{"id":1,"name":"not-the-target"}`
	page := `{"data":{"results":[` + strings.TrimSuffix(strings.Repeat(item+",", 100), ",") + `],"total":10001}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(page)) }))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}

	_, err := client.FindListByName(context.Background(), "missing")
	require.ErrorContains(t, err, "exceeding the safe 10000-row bound")
}

func TestClientRejectsSubscriberOwnedByAnotherTenant(t *testing.T) {
	putCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":7,"email":"x@y.com","status":"enabled","attribs":{"postwave_tenant_id":"tenant-a"}}]}}`))
		case http.MethodPut:
			putCalled = true
			_, _ = w.Write([]byte(`{"data":{"id":7}}`))
		}
	}))
	defer srv.Close()
	c := (&Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}).ForTenant("tenant-b")

	_, _, err := c.UpsertSubscriber(context.Background(), SubscriberPayload{Email: "x@y.com", Status: "enabled"})
	require.ErrorContains(t, err, "different tenant")
	require.False(t, putCalled)
}

func TestWriteSubscribersReturnsPartialBatchErrors(t *testing.T) {
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		if posts == 2 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`failed`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"id":11,"email":"one@example.com"}}`))
	}))
	defer srv.Close()
	client := &Client{BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client()}

	result := WriteSubscribers(context.Background(), client, []canonical.Subscriber{
		{Email: "one@example.com", Status: canonical.StatusEnabled},
		{Email: "two@example.com", Status: canonical.StatusEnabled},
	})
	require.Equal(t, 1, result.Created)
	require.Equal(t, 1, result.Failed)
	require.Len(t, result.Errors, 1)
	require.ErrorContains(t, result.Errors[0], "two@example.com")
}

func TestMergeSubscriberPayload_AuthoritativeStatusReenablesMatchedSource(t *testing.T) {
	merged := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_source_ids":      []interface{}{"42"},
		},
	}, SubscriberPayload{
		Email:               "x@y.com",
		Status:              "enabled",
		AuthoritativeStatus: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	})

	require.Equal(t, "enabled", merged.Status)
	require.Nil(t, merged.Attribs["postwave_status_protected_source_ids"])
	raw, err := json.Marshal(merged)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "AuthoritativeStatus")
	require.NotContains(t, string(raw), "authoritative")
}

func TestMergeSubscriberPayload_AuthoritativeStatusKeepsUnrelatedSuppression(t *testing.T) {
	incoming := SubscriberPayload{
		Email:               "x@y.com",
		Status:              "enabled",
		AuthoritativeStatus: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	}
	first := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Attribs: map[string]interface{}{
			"local_suppression_reason": "manual",
		},
	}, incoming)

	require.Equal(t, "disabled", first.Status)
	require.ElementsMatch(t, []interface{}{"activecampaign:42"}, toInterfaceSlice(first.Attribs["postwave_status_protected_source_ids"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID:      7,
		Email:   "x@y.com",
		Status:  first.Status,
		Attribs: first.Attribs,
	}, incoming)
	require.Equal(t, "disabled", second.Status, "later source deltas must not re-enable a protected local suppression")
	require.ElementsMatch(t, []interface{}{"activecampaign:42"}, toInterfaceSlice(second.Attribs["postwave_status_protected_source_ids"]))
}

func TestMergeSubscriberPayload_ValidatedOwnershipTransferReplacesProtectedMergedState(t *testing.T) {
	existing := SubscriberResponse{
		ID: 7, Email: "shared@example.com", Name: "Old A", Status: "disabled",
		Tags: []string{"stale-a", "local-curation"},
		Attribs: map[string]interface{}{
			"postwave_source_platform":               "beehiiv",
			"postwave_source_id":                     "sub-a",
			"postwave_source_ids":                    []interface{}{"sub-a", "sub-b"},
			"postwave_tags":                          []interface{}{"stale-a"},
			"postwave_source_field_keys":             []interface{}{"plan"},
			"plan":                                   "stale-a",
			"postwave_status_protected_source_ids":   []interface{}{"beehiiv:sub-b"},
			"postwave_snapshot_protected_source_ids": []interface{}{"beehiiv:sub-b"},
		},
	}
	incoming := SubscriberPayload{
		Email: "shared@example.com", Name: "Current B", Status: "enabled",
		Tags: []string{"current-b"},
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "beehiiv",
			"postwave_source_id":         "sub-b",
			"postwave_source_field_keys": []string{"plan"},
			"postwave_tags":              []string{"current-b"},
			"plan":                       "current-b",
		},
		AuthoritativeStatus: true, AuthoritativeTags: true, AuthoritativeFields: true,
		TransferSourceFrom: "sub-a",
	}

	merged := mergeSubscriberPayload(existing, incoming)
	require.Equal(t, "enabled", merged.Status)
	require.Equal(t, "Current B", merged.Name)
	require.ElementsMatch(t, []string{"local-curation", "current-b"}, merged.Tags)
	require.Equal(t, "current-b", merged.Attribs["plan"])
	require.Equal(t, "sub-b", merged.Attribs["postwave_source_id"])
	require.ElementsMatch(t, []interface{}{"sub-a", "sub-b"}, toInterfaceSlice(merged.Attribs["postwave_source_ids"]))
	require.Nil(t, merged.Attribs["postwave_status_protected_source_ids"])
	require.Nil(t, merged.Attribs["postwave_snapshot_protected_source_ids"])

	invalid := incoming
	invalid.TransferSourceFrom = "sub-untracked"
	blocked := mergeSubscriberPayload(existing, invalid)
	require.Equal(t, "disabled", blocked.Status)
	require.Equal(t, "sub-a", blocked.Attribs["postwave_source_id"])
	require.Contains(t, blocked.Tags, "stale-a")
	require.Equal(t, "stale-a", blocked.Attribs["plan"])
}

func TestUpsertSubscriberRejectsUnprovenOwnershipTransferBeforePut(t *testing.T) {
	putCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/subscribers":
			w.WriteHeader(http.StatusConflict)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/subscribers"):
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":7,"email":"shared@example.com","status":"disabled","attribs":{"postwave_source_platform":"beehiiv","postwave_source_id":"sub-a","postwave_source_ids":["sub-a"]}}]}}`))
		case r.Method == http.MethodPut:
			putCalls++
			_, _ = w.Write([]byte(`{"data":{"id":7,"email":"shared@example.com"}}`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client()}
	_, err := client.UpsertSubscriberWithSnapshot(context.Background(), SubscriberPayload{
		Email: "shared@example.com", Status: "enabled",
		Attribs: map[string]interface{}{
			"postwave_source_platform": "beehiiv",
			"postwave_source_id":       "sub-b",
		},
		AuthoritativeStatus: true, AuthoritativeTags: true, AuthoritativeFields: true,
		TransferSourceFrom: "sub-a",
	})
	require.ErrorContains(t, err, "not proven by the Listmonk before-image")
	require.Zero(t, putCalls, "an unproven transfer must not mutate the send store before Moosewave persistence fails closed")
}

func TestMergeSubscriberPayload_AuthoritativeStatusDoesNotAdoptUnmatchedLocalStatus(t *testing.T) {
	first := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: "enabled", Attribs: map[string]interface{}{
			"local_profile":           true,
			"postwave_consent_source": "local_reviewed_consent",
		},
	}, SubscriberPayload{
		Email: "x@y.com", Status: "enabled", AuthoritativeStatus: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_consent_source":  "activecampaign_unknown",
		},
	})
	require.Equal(t, "enabled", first.Status)
	require.Equal(t, "local_reviewed_consent", first.Attribs["postwave_consent_source"])
	require.ElementsMatch(t, []interface{}{"activecampaign:42"}, toInterfaceSlice(first.Attribs["postwave_status_protected_source_ids"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: first.Status, Attribs: first.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeStatus: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_consent_source":  "activecampaign_unknown",
		},
	})
	require.Equal(t, "disabled", second.Status, "the normal fail-closed merge may become stricter")

	third := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: second.Status, Attribs: second.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "enabled", AuthoritativeStatus: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_consent_source":  "activecampaign_unknown",
		},
	})
	require.Equal(t, "disabled", third.Status, "an unmatched local row must not later be re-enabled merely because source metadata was merged onto it")
	require.Equal(t, "local_reviewed_consent", third.Attribs["postwave_consent_source"])
}

func TestMergeSubscriberPayload_AuthoritativeTagsReplaceOnlyMatchedSourceTags(t *testing.T) {
	existing := SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Tags:   []string{"old-activecampaign", "local-curation"},
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []interface{}{"old-activecampaign"},
		},
	}
	incoming := SubscriberPayload{
		Email:             existing.Email,
		Status:            "disabled",
		Tags:              []string{"new-activecampaign"},
		AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []string{"new-activecampaign"},
		},
	}

	merged := mergeSubscriberPayload(existing, incoming)
	require.ElementsMatch(t, []string{"local-curation", "new-activecampaign"}, merged.Tags)
	require.ElementsMatch(t, []interface{}{"new-activecampaign"}, toInterfaceSlice(merged.Attribs["postwave_tags"]))
	require.NotContains(t, merged.Tags, "old-activecampaign")
	raw, err := json.Marshal(merged)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "AuthoritativeTags")
}

func TestMergeSubscriberPayload_AuthoritativeTagsCanRemoveFinalSourceTag(t *testing.T) {
	merged := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Tags:   []string{"last-activecampaign-tag", "local-curation"},
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []interface{}{"last-activecampaign-tag"},
		},
	}, SubscriberPayload{
		Email:             "x@y.com",
		Status:            "disabled",
		AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	})

	require.Equal(t, []string{"local-curation"}, merged.Tags)
	require.NotContains(t, merged.Attribs, "postwave_tags")
	raw, err := json.Marshal(mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "only-source-tag@y.com", Status: "disabled",
		Tags: []string{"last-activecampaign-tag"},
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []interface{}{"last-activecampaign-tag"},
		},
	}, SubscriberPayload{
		Email: "only-source-tag@y.com", Status: "disabled", AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	}))
	require.NoError(t, err)
	require.Contains(t, string(raw), `"tags":[]`, "authoritative removal must reach Listmonk as an explicit empty tag snapshot")
}

func TestMergeSubscriberPayload_AuthoritativeTagsDoNotClaimLocalNameCollision(t *testing.T) {
	first := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Tags:   []string{"old-source", "shared-local"},
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []interface{}{"old-source"},
		},
	}, SubscriberPayload{
		Email:             "x@y.com",
		Status:            "disabled",
		Tags:              []string{"shared-local", "new-source"},
		AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []string{"shared-local", "new-source"},
		},
	})
	require.ElementsMatch(t, []string{"shared-local", "new-source"}, first.Tags)
	require.ElementsMatch(t, []interface{}{"new-source"}, toInterfaceSlice(first.Attribs["postwave_tags"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: "disabled", Tags: first.Tags, Attribs: first.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	})
	require.Equal(t, []string{"shared-local"}, second.Tags)
	require.NotContains(t, second.Attribs, "postwave_tags")
}

func TestMergeSubscriberPayload_AuthoritativeTagsPreserveDifferentSourceTags(t *testing.T) {
	first := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Tags:   []string{"old-hubspot", "local-curation"},
		Attribs: map[string]interface{}{
			"postwave_source_platform": "hubspot",
			"postwave_source_id":       "42",
			"postwave_tags":            []interface{}{"old-hubspot"},
		},
	}, SubscriberPayload{
		Email:             "x@y.com",
		Status:            "disabled",
		Tags:              []string{"new-activecampaign"},
		AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
			"postwave_tags":            []string{"new-activecampaign"},
		},
	})

	require.ElementsMatch(t, []string{"old-hubspot", "local-curation", "new-activecampaign"}, first.Tags)
	require.ElementsMatch(t, []interface{}{"old-hubspot", "new-activecampaign"}, toInterfaceSlice(first.Attribs["postwave_tags"]))
	require.ElementsMatch(t, []interface{}{"activecampaign:42"}, toInterfaceSlice(first.Attribs["postwave_snapshot_protected_source_ids"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: first.Status, Tags: first.Tags, Attribs: first.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeTags: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform": "activecampaign",
			"postwave_source_id":       "42",
		},
	})
	require.ElementsMatch(t, first.Tags, second.Tags, "later ActiveCampaign snapshots must not delete tags from a collided different-source row")
}

func TestMergeSubscriberPayload_AuthoritativeFieldsReplaceMatchedSourceSnapshot(t *testing.T) {
	merged := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []interface{}{"first_name", "obsolete_source_field"},
			"first_name":                 "Old source value",
			"obsolete_source_field":      "remove me",
			"local_note":                 "preserve me",
		},
	}, SubscriberPayload{
		Email:               "x@y.com",
		Status:              "disabled",
		AuthoritativeFields: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []string{"first_name", "current_source_field"},
			"first_name":                 "New source value",
			"current_source_field":       "new",
		},
	})

	require.Equal(t, "New source value", merged.Attribs["first_name"])
	require.Equal(t, "new", merged.Attribs["current_source_field"])
	require.Equal(t, "preserve me", merged.Attribs["local_note"])
	require.NotContains(t, merged.Attribs, "obsolete_source_field")
	require.ElementsMatch(t, []interface{}{"first_name", "current_source_field"}, toInterfaceSlice(merged.Attribs["postwave_source_field_keys"]))
	raw, err := json.Marshal(merged)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "AuthoritativeFields")
}

func TestMergeSubscriberPayload_AuthoritativeFieldsPreserveDifferentSourceSnapshot(t *testing.T) {
	first := mergeSubscriberPayload(SubscriberResponse{
		ID:     7,
		Email:  "x@y.com",
		Status: "disabled",
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "hubspot",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []interface{}{"company"},
			"company":                    "Existing HubSpot value",
		},
	}, SubscriberPayload{
		Email:               "x@y.com",
		Status:              "disabled",
		AuthoritativeFields: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []string{"company"},
			"company":                    "Incoming ActiveCampaign value",
		},
	})

	require.Equal(t, "Existing HubSpot value", first.Attribs["company"])
	require.ElementsMatch(t, []interface{}{"Existing HubSpot value", "Incoming ActiveCampaign value"}, conflictValues(first.Attribs["postwave_field_conflicts"], "company"))
	require.ElementsMatch(t, []interface{}{"activecampaign:42"}, toInterfaceSlice(first.Attribs["postwave_snapshot_protected_source_ids"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: first.Status, Attribs: first.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeFields: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []string{},
		},
	})
	require.Equal(t, "Existing HubSpot value", second.Attribs["company"])
}

func TestMergeSubscriberPayload_AuthoritativeFieldsDoNotClaimLocalNameCollision(t *testing.T) {
	first := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: "disabled",
		Attribs: map[string]interface{}{"company": "Local company"},
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeFields: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []string{"company", "plan"},
			"company":                    "Source company",
			"plan":                       "gold",
		},
	})
	require.Equal(t, "Local company", first.Attribs["company"])
	require.Equal(t, "gold", first.Attribs["plan"])
	require.ElementsMatch(t, []interface{}{"plan"}, toInterfaceSlice(first.Attribs["postwave_source_field_keys"]))

	second := mergeSubscriberPayload(SubscriberResponse{
		ID: 7, Email: "x@y.com", Status: first.Status, Attribs: first.Attribs,
	}, SubscriberPayload{
		Email: "x@y.com", Status: "disabled", AuthoritativeFields: true,
		Attribs: map[string]interface{}{
			"postwave_source_platform":   "activecampaign",
			"postwave_source_id":         "42",
			"postwave_source_field_keys": []string{"company", "plan"},
			"company":                    "Changed source company",
			"plan":                       "platinum",
		},
	})
	require.Equal(t, "Local company", second.Attribs["company"])
	require.Equal(t, "platinum", second.Attribs["plan"])
	require.ElementsMatch(t, []interface{}{"plan"}, toInterfaceSlice(second.Attribs["postwave_source_field_keys"]))
}

func conflictValues(value interface{}, key string) []interface{} {
	switch raw := value.(type) {
	case map[string]interface{}:
		return toInterfaceSlice(raw[key])
	case map[string][]interface{}:
		return raw[key]
	default:
		return nil
	}
}

func toInterfaceSlice(value interface{}) []interface{} {
	switch v := value.(type) {
	case []interface{}:
		return v
	case []string:
		out := make([]interface{}, len(v))
		for i, item := range v {
			out[i] = item
		}
		return out
	default:
		return nil
	}
}

func TestToListmonkPayload_TagsLandNativeAndInAttribs(t *testing.T) {
	sub := canonical.Subscriber{
		Email:  "x@y.com",
		Status: canonical.StatusEnabled,
		Tags:   []string{"vip", "newsletter", "VIP", ""},
		CustomFields: map[string]interface{}{
			"name": "Alice", "tier": "gold",
			"postwave_source_ids":                  []string{"poison-id"},
			"postwave_status_protected_source_ids": []string{"mailchimp:src-1"},
		},
		SourceID:       "src-1",
		SourcePlatform: canonical.SourceMailchimp,
		ConsentSource:  canonical.ConsentDoubleOptIn,
	}
	payload := toListmonkPayload(sub, "job_123")
	require.Equal(t, "Alice", payload.Name)
	require.Equal(t, "enabled", payload.Status)
	require.Equal(t, "src-1", payload.Attribs["postwave_source_id"])
	require.Equal(t, "mailchimp", payload.Attribs["postwave_source_platform"])
	require.Equal(t, "job_123", payload.Attribs["postwave_migration_job_id"])
	require.Equal(t, "double_optin", payload.Attribs["postwave_consent_source"])
	require.ElementsMatch(t, []string{"vip", "newsletter"}, payload.Tags)
	require.ElementsMatch(t, []string{"vip", "newsletter"}, payload.Attribs["postwave_tags"])
	require.Equal(t, "gold", payload.Attribs["tier"])
	require.NotContains(t, payload.Attribs, "postwave_status_protected_source_ids")
	require.Equal(t, "src-1", payload.Attribs["postwave_source_id"])
	collisions := payload.Attribs[sourceFieldNameCollisionAttrib].(map[string]interface{})
	require.Equal(t, []interface{}{[]string{"poison-id"}}, collisions["postwave_source_ids"])
	require.Equal(t, []interface{}{[]string{"mailchimp:src-1"}}, collisions["postwave_status_protected_source_ids"])

	authoritative := toListmonkPayloadWithOptions(sub, writeOptions{
		migrationJobID:      "job_123",
		authoritativeStatus: true,
		authoritativeTags:   true,
		authoritativeFields: true,
		transferSourceFrom:  "src-old",
	})
	require.True(t, authoritative.AuthoritativeStatus)
	require.True(t, authoritative.AuthoritativeTags)
	require.True(t, authoritative.AuthoritativeFields)
	require.Equal(t, "src-old", authoritative.TransferSourceFrom)
	require.ElementsMatch(t, []interface{}{"name", "tier"}, toInterfaceSlice(authoritative.Attribs["postwave_source_field_keys"]))
}

func TestMergeSubscriberAttribsReservedFieldCollisionLedgerIsAuthoritativeWithoutBecomingControlData(t *testing.T) {
	existing := map[string]interface{}{
		sourceFieldNameCollisionAttrib: map[string]interface{}{
			"postwave_status_protected_source_ids": []interface{}{"old source value"},
		},
		"postwave_source_field_keys": []string{},
	}
	incoming := map[string]interface{}{
		sourceFieldNameCollisionAttrib: map[string]interface{}{
			"postwave_status_protected_source_ids": []interface{}{"current source value"},
		},
		"postwave_source_field_keys": []string{},
	}

	authoritative := mergeSubscriberAttribs(existing, incoming, nil, true, true, false)
	ledger := authoritative[sourceFieldNameCollisionAttrib].(map[string]interface{})
	require.Equal(t, []interface{}{"current source value"}, ledger["postwave_status_protected_source_ids"])
	require.NotContains(t, authoritative, "postwave_status_protected_source_ids")

	merged := mergeSubscriberAttribs(existing, incoming, nil, false, false, false)
	ledger = merged[sourceFieldNameCollisionAttrib].(map[string]interface{})
	require.Equal(t, []interface{}{"old source value", "current source value"}, ledger["postwave_status_protected_source_ids"])
}

func TestBeehiivProviderProvenanceIsNotRegisteredAsTargetingField(t *testing.T) {
	subscriber := canonical.Subscriber{
		Email: "reader@example.com", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub_one",
		CustomFields: map[string]interface{}{
			"city":    "Delhi",
			"beehiiv": map[string]interface{}{"publication_id": "pub_main", "status": "active"},
		},
	}
	require.Equal(t, map[string]string{"city": "string"}, ImportedCustomFieldTypes(subscriber))
	payload := toListmonkPayloadWithOptions(subscriber, writeOptions{authoritativeFields: true})
	require.Equal(t, "Delhi", payload.Attribs["city"])
	require.NotContains(t, payload.Attribs, "beehiiv")
	require.ElementsMatch(t, []interface{}{"city"}, toInterfaceSlice(payload.Attribs["postwave_source_field_keys"]))
}

func TestBeehiivFieldCannotBeReinterpretedAsMailchimpControlMetadata(t *testing.T) {
	subscriber := canonical.Subscriber{
		Email: "reader@example.com", Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub_one",
		CustomFields: map[string]interface{}{
			"postwave_mailchimp_status": "unsubscribed",
		},
	}
	fields := subscriberMirrorFields(subscriber)
	require.Equal(t, "unsubscribed", fields.MergeFields["postwave_mailchimp_status"])
	require.Equal(t, "subscribed", fields.MailchimpStatus, "non-Mailchimp fields must not mutate Mailchimp control state")
}

func TestImportedConsentActionUsesIncomingSourceEvidence(t *testing.T) {
	now := time.Now().UTC()
	subscribed := canonical.Subscriber{
		SourcePlatform:   canonical.SourceMailchimp,
		Status:           canonical.StatusEnabled,
		ConsentTimestamp: &now,
		ConsentSource:    canonical.ConsentUnknown,
	}
	require.Equal(t, "imported", importedConsentAction(subscribed, "subscribed"))

	// A destination-side suppression may make the merged row blocklisted, but
	// it cannot turn this source record into a Mailchimp opt-out event.
	require.Empty(t, importedConsentAction(canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		Status:         canonical.StatusEnabled,
	}, "subscribed"))
	require.Empty(t, importedConsentAction(canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		Status:         canonical.StatusBlocklisted,
	}, "cleaned"), "a bounce is not an unsubscribe")
	require.Equal(t, "opted_out", importedConsentAction(canonical.Subscriber{
		SourcePlatform: canonical.SourceMailchimp,
		Status:         canonical.StatusDisabled,
	}, "unsubscribed"))
}

func TestMergeSubscriberPayloadPreservesUnrelatedExistingName(t *testing.T) {
	existing := SubscriberResponse{
		ID:      7,
		Email:   "person@example.com",
		Name:    "Locally Curated Name",
		Status:  "enabled",
		Attribs: map[string]interface{}{"local_profile": true},
	}
	incoming := SubscriberPayload{
		Email:  existing.Email,
		Name:   "Mailchimp Merge Name",
		Status: "enabled",
		Attribs: map[string]interface{}{
			"postwave_source_platform": "mailchimp",
			"postwave_source_id":       "member-1",
		},
	}
	require.Equal(t, "Locally Curated Name", mergeSubscriberPayload(existing, incoming).Name)

	existing.Attribs = map[string]interface{}{
		"postwave_source_platform": "mailchimp",
		"postwave_source_id":       "member-1",
	}
	require.Equal(t, "Mailchimp Merge Name", mergeSubscriberPayload(existing, incoming).Name, "same-source delta may refresh the source-owned name")
}

func TestMailchimpAudienceEvidenceRemainsAudienceScoped(t *testing.T) {
	group := []map[string]interface{}{{
		"source_id": "interest-1", "name": "VIP", "category": "Tier", "category_id": "cat-1",
	}}
	first := bindMailchimpGroupsToAudience(group, []string{"mailchimp:list:aud-1"})
	second := bindMailchimpGroupsToAudience(group, []string{"mailchimp:list:aud-2"})
	require.Equal(t, "aud-1", first[0]["audience_id"])
	require.Equal(t, "aud-2", second[0]["audience_id"])
	require.NotEqual(t, first[0]["registry_category"], second[0]["registry_category"])

	permissions := []interface{}{map[string]interface{}{"marketing_permission_id": "perm-1", "enabled": true}}
	firstPermissions := bindMailchimpPermissionsToAudience(permissions, []string{"mailchimp:list:aud-1"}).([]interface{})
	secondPermissions := bindMailchimpPermissionsToAudience(permissions, []string{"mailchimp:list:aud-2"}).([]interface{})
	require.Equal(t, "aud-1", firstPermissions[0].(map[string]interface{})["audience_id"])
	require.Equal(t, "aud-2", secondPermissions[0].(map[string]interface{})["audience_id"])
}

func TestMergeSubscriberTrackingMetadataKeepsFirstBeforeAndLatestAfter(t *testing.T) {
	firstBefore := map[string]interface{}{"status": "disabled", "name": "Original"}
	first := map[string]interface{}{
		"listmonk_before": firstBefore,
		"postwave_before": firstBefore,
		"listmonk_after":  map[string]interface{}{"status": "enabled", "name": "First"},
		"postwave_after":  map[string]interface{}{"subscriber": map[string]interface{}{"status": "enabled", "name": "First"}},
		"source_ids":      []string{"member-a"},
	}
	latestListmonk := map[string]interface{}{"status": "enabled", "name": "Second"}
	latestPostwave := map[string]interface{}{"subscriber": map[string]interface{}{"status": "enabled", "name": "Second"}}
	merged := mergeSubscriberTrackingMetadata(first, map[string]interface{}{
		"listmonk_before": map[string]interface{}{"status": "enabled", "name": "First"},
		"postwave_before": map[string]interface{}{"status": "enabled", "name": "First"},
		"listmonk_after":  latestListmonk,
		"postwave_after":  latestPostwave,
		"source_ids":      []string{"member-b"},
	})
	require.Equal(t, firstBefore, merged["listmonk_before"])
	require.Equal(t, firstBefore, merged["postwave_before"])
	require.Equal(t, latestListmonk, merged["listmonk_after"])
	require.Equal(t, latestPostwave, merged["postwave_after"])
	require.ElementsMatch(t, []string{"member-a", "member-b"}, merged["source_ids"])
}

func TestMergeSubscriberTrackingMetadataReplacesAuthoritativeTagOwnership(t *testing.T) {
	merged := mergeSubscriberTrackingMetadata(map[string]interface{}{
		"postwave_tag_joins_created":     []string{"old-tag-id", "retained-tag-id"},
		"postwave_source_field_keys":     []string{"obsolete", "retained"},
		"postwave_source_identity_owned": false,
	}, map[string]interface{}{
		"postwave_tag_joins_created":     []string{"retained-tag-id", "new-tag-id"},
		"postwave_source_field_keys":     []string{"retained", "new"},
		"postwave_source_identity_owned": true,
	}, true, true)

	require.ElementsMatch(t, []string{"retained-tag-id", "new-tag-id"}, merged["postwave_tag_joins_created"])
	require.ElementsMatch(t, []string{"retained", "new"}, merged["postwave_source_field_keys"])
	require.Equal(t, false, merged["postwave_source_identity_owned"], "a local/different-source identity must not become source-owned on a later delta")
}

func TestSourceOwnedSubscriberFieldKeysPreserveLocalCollisions(t *testing.T) {
	before := map[string]interface{}{
		"first_name": "Local first name",
		"custom_fields": map[string]interface{}{
			"company": "Local company",
		},
	}
	first := sourceOwnedSubscriberFieldKeys(before, nil, []string{"company", "first_name", "plan"}, false)
	require.Equal(t, []string{"plan"}, first)

	second := sourceOwnedSubscriberFieldKeys(before, first, []string{"company", "first_name", "plan", "tier"}, false)
	require.ElementsMatch(t, []string{"plan", "tier"}, second)
	require.True(t, containsSubscriberFieldKey(mergeStringUnion(first, second), "plan"))
	require.False(t, containsSubscriberFieldKey(mergeStringUnion(first, second), "first_name"))
}

func TestRollbackAfterImageRefusesLaterListmonkEdit(t *testing.T) {
	expected := SubscriberResponse{
		ID: 7, Email: "person@example.com", Name: "Imported", Status: "enabled",
		Tags: []string{"vip"}, Lists: []int{4}, Attribs: map[string]interface{}{"postwave_tenant_id": "tenant-a"},
	}
	current := expected
	current.Name = "Edited after migration"
	putCalled := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers/7":
			raw, _ := json.Marshal(map[string]interface{}{"data": current})
			_, _ = w.Write(raw)
		case r.Method == http.MethodPut:
			putCalled = true
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	client := &Client{
		BaseURL: srv.URL, AdminUser: "u", AdminPass: "p", HTTPClient: srv.Client(),
		TenantID: "tenant-a", DedicatedTenant: true, DedicatedTenantID: "tenant-a",
	}
	err := client.ValidateSubscriberUnchanged(context.Background(), 7, expected)
	require.ErrorIs(t, err, ErrRollbackConflict)
	require.False(t, putCalled)
}
