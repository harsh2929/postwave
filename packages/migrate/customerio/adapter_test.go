// SPDX-License-Identifier: MIT

package customerio

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func boolPointer(value bool) *bool { return &value }

func stringPointer(value string) *string { return &value }

func testPreferenceEvidence(topicStates, channelStates map[string]bool, emailConfigured bool) cioProfilePreferenceEvidence {
	_, emailPresent := channelStates["email"]
	return cioProfilePreferenceEvidence{
		TopicStates:                  topicStates,
		ChannelStates:                channelStates,
		TopicEvidenceComplete:        true,
		EmailChannelConfigured:       emailConfigured,
		EmailChannelEvidenceComplete: !emailConfigured || emailPresent,
		EvidenceSource:               "test",
	}
}

func testSession() adapter.Session {
	workspaceID := "42"
	region := "us"
	return adapter.Session{
		AccessToken: "secret",
		AccountID:   workspaceID,
		Source:      canonical.SourceCustomerIO,
		Extra: map[string]string{
			RegionExtraKey:               region,
			WorkspaceIDExtraKey:          workspaceID,
			WorkspaceFingerprintExtraKey: workspaceFingerprint(region, workspaceID),
		},
	}
}

func fastAdapter(server *httptest.Server) *Adapter {
	a := New()
	a.BaseURL = server.URL
	a.limiter = adapter.NewTokenBucket(100000, time.Second, 100000)
	return a
}

func TestMapCustomerUsesImmutableCIOIDAndNeverInventsConsent(t *testing.T) {
	detail := cioCustomerDetail{
		Identifiers: cioIdentifiers{
			CIOID: "cio-immutable",
			ID:    "publisher-mutable",
			Email: stringPointer("person@example.com"),
		},
		Attributes: map[string]json.RawMessage{
			"first_name": json.RawMessage(`"Ada"`),
			"created_at": json.RawMessage(`"1700000000"`),
		},
		Timestamps:   map[string]int64{"email": 1700000100},
		Unsubscribed: boolPointer(false),
	}
	subscriber, err := mapCustomer(detail, testPreferenceEvidence(nil, nil, false), nil, []string{"customerio:segment:7"}, nil)
	require.NoError(t, err)
	require.Equal(t, "cio-immutable", subscriber.SourceID)
	require.Equal(t, canonical.StatusEnabled, subscriber.Status)
	require.Nil(t, subscriber.ConsentTimestamp, "profile/email creation is not opt-in proof")
	require.Equal(t, canonical.ConsentUnknown, subscriber.ConsentSource)
	require.Equal(t, "Ada", subscriber.CustomFields["first_name"])
	metadata := subscriber.CustomFields["customerio_source"].(map[string]interface{})
	require.Equal(t, "publisher-mutable", metadata["publisher_id"])
	require.Equal(t, int64(1700000000), metadata["created_at"])
	require.Equal(t, int64(1700000100), metadata["email_added_at"])
}

func TestMapCustomerStatusIsConservative(t *testing.T) {
	base := cioCustomerDetail{
		Identifiers:  cioIdentifiers{CIOID: "c1", Email: stringPointer("person@example.com")},
		Attributes:   map[string]json.RawMessage{},
		Unsubscribed: boolPointer(false),
	}
	topics := []cioSubscriptionTopic{{ID: "1", Identifier: "topic_1"}}

	t.Run("all topics opted out", func(t *testing.T) {
		got, err := mapCustomer(base, testPreferenceEvidence(map[string]bool{"topic_1": false}, nil, false), topics, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusDisabled, got.Status)
	})
	t.Run("missing global evidence", func(t *testing.T) {
		copy := base
		copy.Unsubscribed = nil
		got, err := mapCustomer(copy, testPreferenceEvidence(nil, nil, false), nil, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusUnconfirmed, got.Status)
	})
	t.Run("global unsubscribe", func(t *testing.T) {
		copy := base
		copy.Unsubscribed = boolPointer(true)
		got, err := mapCustomer(copy, testPreferenceEvidence(map[string]bool{"topic_1": true}, nil, false), topics, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusDisabled, got.Status)
	})
	t.Run("ESP suppression", func(t *testing.T) {
		got, err := mapCustomer(base, testPreferenceEvidence(map[string]bool{"topic_1": true}, nil, false), topics, nil, []cioSuppression{{Type: "bounces"}})
		require.NoError(t, err)
		require.Equal(t, canonical.StatusBlocklisted, got.Status)
	})
	t.Run("email channel opted out", func(t *testing.T) {
		got, err := mapCustomer(base, testPreferenceEvidence(map[string]bool{"topic_1": true}, map[string]bool{"email": false}, true), topics, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusDisabled, got.Status)
	})
	t.Run("email channel opted in", func(t *testing.T) {
		got, err := mapCustomer(base, testPreferenceEvidence(map[string]bool{"topic_1": true}, map[string]bool{"email": true}, true), topics, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusEnabled, got.Status)
	})
	t.Run("configured email channel with absent evidence", func(t *testing.T) {
		got, err := mapCustomer(base, testPreferenceEvidence(map[string]bool{"topic_1": true}, nil, true), topics, nil, nil)
		require.NoError(t, err)
		require.Equal(t, canonical.StatusUnconfirmed, got.Status)
	})
}

func TestMapNewsletterArchiveRequiresExplicitDefaultLanguageContent(t *testing.T) {
	newsletter := func(contents ...cioResource) cioNewsletterEvidence {
		return cioNewsletterEvidence{
			Resource: cioResource{ID: "30", Name: "Sent Email", Type: "email", SentAt: 1700000300},
			Contents: contents,
		}
	}
	content := func(id string, raw map[string]interface{}) cioResource {
		return cioResource{ID: id, Type: "email", Raw: raw}
	}

	t.Run("translation is never selected when default is absent", func(t *testing.T) {
		_, materialized, reason, err := mapNewsletterArchive(newsletter(
			content("301", map[string]interface{}{"language": "es", "subject": "Hola", "body": "<p>Hola</p>"}),
		))
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		require.False(t, materialized)
		require.Empty(t, reason)
		require.Contains(t, err.Error(), "no default content")
	})

	t.Run("missing language is not treated as an empty language", func(t *testing.T) {
		_, materialized, _, err := mapNewsletterArchive(newsletter(
			content("301", map[string]interface{}{"subject": "Unspecified", "body": "<p>Unspecified</p>"}),
		))
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		require.False(t, materialized)
	})

	t.Run("multiple empty-language A B contents select the lowest stable representative", func(t *testing.T) {
		archive, materialized, reason, err := mapNewsletterArchive(newsletter(
			content("10", map[string]interface{}{"language": "", "body": "<p>Second</p>"}),
			content("2", map[string]interface{}{"language": "", "body": "<p>First</p>"}),
		))
		require.NoError(t, err)
		require.True(t, materialized)
		require.Empty(t, reason)
		require.Equal(t, "2", archive.Report["selected_content_id"])
		require.Equal(t, []string{"2", "10"}, archive.Report["default_content_ids"])
		require.Equal(t, "<p>First</p>", archive.HTML)
		require.Contains(t, strings.Join(archive.Warnings, " "), "lowest stable content ID")
		require.Contains(t, strings.Join(archive.Warnings, " "), "representative archive")
	})

	t.Run("non-string language metadata is rejected", func(t *testing.T) {
		_, materialized, _, err := mapNewsletterArchive(newsletter(
			content("301", map[string]interface{}{"language": 7, "body": "<p>Invalid</p>"}),
		))
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		require.False(t, materialized)
		require.Contains(t, err.Error(), "invalid language metadata")
	})
}

func TestMapNewsletterArchiveComposesOnlyProvableLayoutAndPreservesRawEvidence(t *testing.T) {
	raw := map[string]interface{}{
		"id":       float64(302),
		"language": "",
		"subject":  "Default",
		"layout":   "<html><body>{{   content   }}</body></html>",
		"body":     "\n<p>Exact body</p>\n",
	}
	newsletter := cioNewsletterEvidence{
		Resource: cioResource{ID: "30", Name: "Sent Email", Type: "email", SentAt: 1700000300},
		Contents: []cioResource{{ID: "302", Type: "email", Raw: raw}},
	}

	archive, materialized, reason, err := mapNewsletterArchive(newsletter)
	require.NoError(t, err)
	require.True(t, materialized)
	require.Empty(t, reason)
	require.Equal(t, "<html><body>\n<p>Exact body</p>\n</body></html>", archive.HTML)
	require.Contains(t, strings.Join(archive.Warnings, " "), "deterministic composition")
	require.Contains(t, strings.Join(archive.Warnings, " "), "not provider-rendered output")
	variants := archive.Report["content_variants"].([]map[string]interface{})
	require.Equal(t, raw["layout"], variants[0]["layout"])
	require.Equal(t, raw["body"], variants[0]["body"])
}

func TestMapNewsletterArchiveFallsBackToSourceEvidenceWhenCompositionIsUnsafe(t *testing.T) {
	tests := []struct {
		name        string
		layout      interface{}
		includeBody bool
		wantReason  string
	}{
		{name: "layout omits content slot", layout: "<html><body>fixed</body></html>", includeBody: true, wantReason: "0 documented {{content}} slots"},
		{name: "layout repeats content slot", layout: "{{content}}<hr>{{ content }}", includeBody: true, wantReason: "2 documented {{content}} slots"},
		{name: "layout has invalid type", layout: map[string]interface{}{"html": "{{content}}"}, includeBody: true, wantReason: "layout is not a string"},
		{name: "body is absent", layout: "<html>{{content}}</html>", includeBody: false, wantReason: "no non-empty string body"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw := map[string]interface{}{"id": float64(302), "language": "", "layout": tc.layout}
			if tc.includeBody {
				raw["body"] = "<p>Exact body</p>"
			}
			newsletter := cioNewsletterEvidence{
				Resource: cioResource{ID: "30", Name: "Sent Email", Type: "email", SentAt: 1700000300},
				Contents: []cioResource{{ID: "302", Type: "email", Raw: raw}},
			}

			archive, materialized, reason, err := mapNewsletterArchive(newsletter)
			require.NoError(t, err)
			require.False(t, materialized)
			require.Empty(t, archive)
			require.Contains(t, reason, tc.wantReason)

			newsletter.ArchiveSourceOnlyReason = reason
			items := buildSourceArchive(&customerIOSnapshot{Newsletters: []cioNewsletterEvidence{newsletter}})
			require.NotEmpty(t, items)
			var newsletterItem canonical.SourceArchiveItem
			for _, item := range items {
				if item.ResourceType == resourceNewsletter {
					newsletterItem = item
					break
				}
			}
			require.Equal(t, resourceNewsletter, newsletterItem.ResourceType)
			require.Contains(t, strings.Join(newsletterItem.Warnings, " "), "source evidence only")
			contents := newsletterItem.Payload["contents"].([]map[string]interface{})
			require.Equal(t, tc.layout, contents[0]["layout"])
			if tc.includeBody {
				require.Equal(t, raw["body"], contents[0]["body"])
			}
		})
	}
}

func TestDesignEmailLanguagesAndTranslationResponsesFailClosed(t *testing.T) {
	t.Run("languages are strict unique and deterministic", func(t *testing.T) {
		languages, err := parseDesignEmailLanguages(map[string]interface{}{
			"available_languages": []interface{}{"fr", "en"},
		})
		require.NoError(t, err)
		require.Equal(t, []string{"en", "fr"}, languages)
	})

	for name, payload := range map[string]map[string]interface{}{
		"missing array": {},
		"wrong shape":   {"available_languages": "en"},
		"empty code":    {"available_languages": []interface{}{""}},
		"padded code":   {"available_languages": []interface{}{" en "}},
		"non-string":    {"available_languages": []interface{}{7}},
		"duplicate":     {"available_languages": []interface{}{"en", "en"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseDesignEmailLanguages(payload)
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		})
	}

	valid := map[string]interface{}{
		"email_translation": map[string]interface{}{
			"language_group_id": "template-1",
			"language":          "es",
			"is_template":       true,
			"content":           map[string]interface{}{"html": "<p>Hola</p>"},
		},
	}
	require.NoError(t, validateDesignEmailTranslation(valid, "template-1", "es"))

	invalid := map[string]map[string]interface{}{
		"wrong envelope": {"email": map[string]interface{}{"language_group_id": "template-1", "language": "es"}},
		"wrong parent": {"email_translation": map[string]interface{}{
			"language_group_id": "template-2", "language": "es", "is_template": true, "content": map[string]interface{}{},
		}},
		"wrong language": {"email_translation": map[string]interface{}{
			"language_group_id": "template-1", "language": "fr", "is_template": true, "content": map[string]interface{}{},
		}},
		"not a template": {"email_translation": map[string]interface{}{
			"language_group_id": "template-1", "language": "es", "is_template": false, "content": map[string]interface{}{},
		}},
		"missing content": {"email_translation": map[string]interface{}{
			"language_group_id": "template-1", "language": "es", "is_template": true,
		}},
	}
	for name, response := range invalid {
		t.Run(name, func(t *testing.T) {
			err := validateDesignEmailTranslation(response, "template-1", "es")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		})
	}
}

func TestMapDesignEmailTemplatePreservesExactSourceHTML(t *testing.T) {
	html := "\n<x-base>\n  <x-paragraph>Hello {{customer.first_name}}</x-paragraph>\n</x-base>\n"
	evidence := cioDesignEmailEvidence{
		Summary: cioResource{ID: "template-1", Name: "Source template"},
		Detail: cioResource{
			ID:   "template-1",
			Name: "Source template",
			Raw: map[string]interface{}{
				"id":          "template-1",
				"is_template": true,
				"content": map[string]interface{}{
					"subject": "Hello",
					"html":    html,
				},
			},
		},
	}

	template, editable, err := mapDesignEmailTemplate(evidence)
	require.NoError(t, err)
	require.True(t, editable)
	require.Equal(t, html, template.HTML)
	require.Contains(t, strings.Join(template.Warnings, " "), "exact source content, not provider-rendered output")

	evidence.Detail.Raw["content"].(map[string]interface{})["html"] = map[string]interface{}{"unexpected": true}
	_, editable, err = mapDesignEmailTemplate(evidence)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.False(t, editable)
}

func TestAuthenticateBindsSelectedWorkspace(t *testing.T) {
	var header string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/workspaces", r.URL.Path)
		require.Equal(t, "Bearer key", r.Header.Get("Authorization"))
		header = r.Header.Get("X-Workspace-Id")
		_, _ = w.Write([]byte(`{"workspaces":[{"id":1,"name":"One"},{"id":2,"name":"Two"}]}`))
	}))
	defer server.Close()

	a := fastAdapter(server)
	_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "key"})
	require.ErrorIs(t, err, adapter.ErrAuth)

	session, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "key", AccountID: "2", Extra: map[string]string{RegionExtraKey: "EU"}})
	require.NoError(t, err)
	require.Equal(t, "2", header)
	require.Equal(t, "2", session.AccountID)
	require.Equal(t, "eu", session.Extra[RegionExtraKey])
	require.Equal(t, "2", session.Extra[WorkspaceIDExtraKey])
	require.NotEmpty(t, AccountFingerprint(session))

	tampered := session
	tampered.Extra = cloneStringMap(session.Extra)
	tampered.Extra[RegionExtraKey] = "us"
	require.Empty(t, AccountFingerprint(tampered))
}

func TestAuthenticateRejectsInvalidCredentialsAndRegion(t *testing.T) {
	_, err := New().Authenticate(context.Background(), adapter.Credentials{})
	require.ErrorIs(t, err, adapter.ErrAuth)
	_, err = New().Authenticate(context.Background(), adapter.Credentials{APIKey: "key", Extra: map[string]string{RegionExtraKey: "apac"}})
	require.ErrorIs(t, err, adapter.ErrAuth)
}

func TestCustomerIOSnapshotIsCompleteAndFailClosed(t *testing.T) {
	var mu sync.Mutex
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
		require.Equal(t, "42", r.Header.Get("X-Workspace-Id"))
		mu.Lock()
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/segments":
			writeJSON(t, w, `{"segments":[{"id":7,"name":"Power Users","description":"active","type":"dynamic","state":"finished","created_at":1700000000}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_topics":
			writeJSON(t, w, `{"topics":[{"id":1,"identifier":"topic_1","name":"Product","description":"Product mail","subscribed_by_default":false}]}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_channels":
			writeJSON(t, w, `{"channels":[{"id":1,"type":"email","name":"Email","description":"Email messages","subscribed_by_default":true}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/customers":
			var body struct {
				Filter map[string]interface{} `json:"filter"`
			}
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			if _, withoutEmail := body.Filter["not"]; withoutEmail {
				writeJSON(t, w, `{"identifiers":[{"id":"phone-only","email":null,"cio_id":"c3"}],"next":""}`)
				return
			}
			if r.URL.Query().Get("start") == "email-page-2" {
				writeJSON(t, w, `{"identifiers":[{"id":"publisher-2","email":"same@example.com","cio_id":"c2"},{"id":"publisher-4","email":null,"cio_id":"c4"}],"next":""}`)
				return
			}
			writeJSON(t, w, `{"identifiers":[{"id":"publisher-1","email":null,"cio_id":"c1"}],"next":"email-page-2"}`)
		case strings.HasPrefix(r.URL.Path, "/v1/esp/suppression/"):
			if strings.HasSuffix(r.URL.Path, "/bounces") {
				writeJSON(t, w, `{"category":"bounces","suppressions":[{"created":1700000200,"email":"blocked@example.com","reason":"hard bounce","status":"550"}]}`)
				return
			}
			writeJSON(t, w, `{"suppressions":[]}`)
		case r.URL.Path == "/v1/customers/c1/attributes":
			require.Equal(t, "cio_id", r.URL.Query().Get("id_type"))
			writeJSON(t, w, `{"customer":{"id":"publisher-1","identifiers":{"id":"publisher-1","email":null,"cio_id":"c1"},"attributes":{"email":"same@example.com","first_name":"Ada","created_at":"1690000000","_cio_subscription_preferences_computed":"{\"topics\":{\"topic_1\":true},\"channels\":{\"email\":true}}"},"timestamps":{"email":1690000100},"unsubscribed":false,"devices":[]}}`)
		case r.URL.Path == "/v1/customers/c2/attributes":
			writeJSON(t, w, `{"customer":{"id":"publisher-2","identifiers":{"id":"publisher-2","email":"same@example.com","cio_id":"c2"},"attributes":{"email":"same@example.com","first_name":"Grace","_cio_subscription_preferences_computed":"{\"topics\":{\"topic_1\":false},\"channels\":{\"email\":false}}"},"timestamps":{"unsubscribed":1690000200},"unsubscribed":true,"devices":[]}}`)
		case r.URL.Path == "/v1/customers/c4/attributes":
			writeJSON(t, w, `{"customer":{"id":"publisher-4","identifiers":{"id":"publisher-4","email":null,"cio_id":"c4"},"attributes":{"email":""},"timestamps":{},"unsubscribed":false,"devices":[]}}`)
		case r.URL.Path == "/v1/customers/c1/subscription_preferences":
			writeJSON(t, w, `{"customer":{"id":"publisher-1","identifiers":{"id":"publisher-1","email":"same@example.com","cio_id":"c1"},"topics":[{"id":1,"subscribed":true,"name":"Product"}],"channels":[{"id":1,"type":"email","subscribed":true,"name":"Email"}],"unsubscribed":false}}`)
		case r.URL.Path == "/v1/customers/c2/subscription_preferences":
			writeJSON(t, w, `{"customer":{"id":"publisher-2","identifiers":{"id":"publisher-2","email":"same@example.com","cio_id":"c2"},"topics":[{"id":"1","subscribed":false,"name":"Product"}],"channels":{"email":false},"unsubscribed":true}}`)
		case r.URL.Path == "/v1/segments/7/membership":
			writeJSON(t, w, `{"segment_id":7,"identifiers":[{"id":"publisher-1","email":"same@example.com","cio_id":"c1"},{"id":"phone-only","email":null,"cio_id":"c3"}],"next":""}`)
		case r.URL.Path == "/v1/segments/7/customer_count":
			writeJSON(t, w, `{"segment_id":7,"count":2}`)
		case r.URL.Path == "/v1/campaigns":
			writeJSON(t, w, `{"campaigns":[{"id":10,"name":"Onboarding","type":"event","state":"running","event_name":"signup","created":1700000000,"actions":[{"id":101,"type":"email"}]}]}`)
		case r.URL.Path == "/v1/campaigns/10/actions":
			if r.URL.Query().Get("start") == "action-page-2" {
				writeJSON(t, w, `{"actions":[{"id":102,"campaign_id":10,"type":"twilio","body":"hello"}],"next":""}`)
				return
			}
			writeJSON(t, w, `{"actions":[{"id":101,"campaign_id":10,"type":"email","subject":"Welcome","body":"<p>Hi</p>"}],"next":"action-page-2"}`)
		case r.URL.Path == "/v1/broadcasts":
			writeJSON(t, w, `{"broadcasts":[{"id":20,"name":"Breaking news","type":"broadcast","state":"running","created":1700000000}]}`)
		case r.URL.Path == "/v1/broadcasts/20/actions":
			writeJSON(t, w, `{"actions":[{"id":201,"broadcast_id":20,"type":"email","subject":"News","body":"<p>News</p>"}]}`)
		case r.URL.Path == "/v1/broadcasts/20/triggers":
			writeJSON(t, w, `{"triggers":[{"id":902,"broadcast_id":20,"created_at":1700000600,"processed_at":1700000610},{"id":901,"broadcast_id":20,"created_at":1700000500,"processed_at":1700000510}]}`)
		case r.URL.Path == "/v1/newsletters":
			require.Equal(t, "asc", r.URL.Query().Get("sort"))
			writeJSON(t, w, `{"newsletters":[{"id":30,"name":"Sent Email","type":"email","sent_at":1700000300,"created":1700000000},{"id":31,"name":"Draft Email","type":"email","sent_at":null,"created":1700000001},{"id":32,"name":"Sent SMS","type":"twilio","sent_at":1700000400,"created":1700000002}],"next":""}`)
		case r.URL.Path == "/v1/newsletters/30/contents":
			writeJSON(t, w, `{"contents":[{"id":302,"newsletter_id":30,"type":"email","subject":"Variant Default","layout":"<html><body>{{ content }}</body></html>","body":"<p>Default</p>","language":""},{"id":301,"newsletter_id":30,"type":"email","subject":"Variant Translation","body":"<p>Translation</p>","language":"es"}]}`)
		case r.URL.Path == "/v1/newsletters/31/contents":
			writeJSON(t, w, `{"contents":[{"id":311,"newsletter_id":31,"type":"email","subject":"Draft","body":"<p>Draft</p>"}]}`)
		case r.URL.Path == "/v1/newsletters/32/contents":
			writeJSON(t, w, `{"contents":[{"id":321,"newsletter_id":32,"type":"twilio","body":"hello"}]}`)
		case r.URL.Path == "/v1/transactional":
			writeJSON(t, w, `{"messages":[{"id":40,"name":"Receipt","type":"email","created_at":1700000000,"updated_at":1700000100}]}`)
		case r.URL.Path == "/v1/transactional/40/contents":
			writeJSON(t, w, `{"contents":[{"id":401,"type":"email","subject":"Receipt","body":"<p>Paid</p>"}]}`)
		case r.URL.Path == "/v1/design_studio/emails":
			require.Equal(t, "true", r.URL.Query().Get("is_template"))
			writeJSON(t, w, `{"emails":[{"id":"tmpl-html","name":"HTML Template","is_template":true,"created":1700000000},{"id":"tmpl-text","name":"Text Template","is_template":true,"created":1700000001}],"folders":[],"meta":{"pagination":{"page":1,"limit":1000,"total":2}}}`)
		case r.URL.Path == "/v1/design_studio/emails/tmpl-html":
			writeJSON(t, w, `{"email":{"id":"tmpl-html","name":"HTML Template","is_template":true,"created":1700000000,"updated":1700000100,"available_languages":["es"],"content":{"subject":"Hello","preheader_text":"Preview","html":"<p>Hello</p>","text":"Hello"},"envelope":{},"transformers":{}}}`)
		case r.URL.Path == "/v1/design_studio/emails/tmpl-html/languages/es":
			writeJSON(t, w, `{"email_translation":{"language_group_id":"tmpl-html","language":"es","is_template":true,"content":{"subject":"Hola","html":"<p>Hola</p>"}}}`)
		case r.URL.Path == "/v1/design_studio/emails/tmpl-text":
			writeJSON(t, w, `{"email":{"id":"tmpl-text","name":"Text Template","is_template":true,"created":1700000001,"updated":1700000101,"available_languages":[],"content":{"subject":"Text","html":"","text":"Only text"},"envelope":{},"transformers":{}}}`)
		case r.URL.Path == "/v1/object_types":
			writeJSON(t, w, `{"types":[{"id":"1","name":"Companies","singular_name":"Company","enabled":true}]}`)
		case r.URL.Path == "/v1/optouts":
			writeJSON(t, w, `{"optouts":[{"customer_id":"publisher-1","cio_id":"c1","optouts":[{"channel":"sms","from":"+15551234567"}]}],"next":""}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()

	a := fastAdapter(server)
	session := testSession()
	report, err := a.Discover(context.Background(), session)
	require.NoError(t, err)
	require.Equal(t, 2, report.SubscribersTotal)
	require.Equal(t, 2, report.ProfilesWithoutEmailTotal, "not-exists and unusable exists-filter profiles are both excluded")
	require.Equal(t, 2, report.SegmentsTotal, "one source segment plus one subscription topic")
	require.Equal(t, 1, report.SubscriptionChannelsTotal)
	require.Equal(t, 2, report.AutomationsTotal)
	require.Equal(t, 1, report.ArchiveTotal, "only sent email newsletters are campaign history")
	require.Equal(t, 1, report.TemplatesTotal, "text-only template is rebuild evidence")
	require.Equal(t, 5, report.CampaignsTotal)
	require.Equal(t, 1, report.CustomObjectsTotal)
	require.Equal(t, 1, report.SMSCampaignsTotal)
	require.Equal(t, 20, report.SourceArchiveTotal)
	require.Equal(t, 1, report.SnapshotMembershipCounts["customerio:segment:7"])
	require.Equal(t, 1, report.SnapshotMembershipCounts["customerio:topic:topic_1"])
	require.Len(t, report.Audiences, 2)
	require.Contains(t, strings.Join(report.Warnings, " "), "share 1 email")
	require.Contains(t, report.CustomFields, "customerio_source")
	nonEmailCount, nonEmailDigest, err := a.CustomerIONonEmailIdentityFingerprint(context.Background(), session)
	require.NoError(t, err)
	require.Equal(t, 2, nonEmailCount)
	require.Equal(t, nonEmailProfileIdentityDigest(map[string]struct{}{"c3": {}, "c4": {}}), nonEmailDigest)
	require.NotEqual(t, nonEmailProfileIdentityDigest(map[string]struct{}{"c3": {}, "c5": {}}), nonEmailDigest, "same-count non-email cio_id replacement must change shadow evidence")

	subscribers, next, err := a.ListSubscribers(context.Background(), session, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, subscribers, 2)
	require.Equal(t, "c1", subscribers[0].SourceID)
	require.Equal(t, canonical.StatusEnabled, subscribers[0].Status)
	require.Nil(t, subscribers[0].ConsentTimestamp)
	require.ElementsMatch(t, []string{"customerio:segment:7", "customerio:topic:topic_1"}, subscribers[0].Tags)
	sourceMetadata := subscribers[0].CustomFields["customerio_source"].(map[string]interface{})
	require.Equal(t, map[string]interface{}{"email": true}, sourceMetadata["channel_preferences"])
	require.True(t, sourceMetadata["email_channel_evidence_complete"].(bool))
	require.Equal(t, "c2", subscribers[1].SourceID)
	require.Equal(t, canonical.StatusDisabled, subscribers[1].Status)

	segments, err := a.ListSegments(context.Background(), session)
	require.NoError(t, err)
	require.Len(t, segments, 2)
	require.Equal(t, "condition", segments[0].QueryAST.Op)
	require.Contains(t, segments[0].SourceDefinition, "static_membership_snapshot")

	archive, next, err := a.ListCampaignArchive(context.Background(), session, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, archive, 1)
	require.Equal(t, "customerio:newsletter:30", archive[0].SourceID)
	require.Equal(t, "Variant Default", archive[0].Subject, "the explicit default wins even when a translation has the lower stable ID")
	require.Equal(t, "<html><body><p>Default</p></body></html>", archive[0].HTML)
	require.Equal(t, "302", archive[0].Report["selected_content_id"])
	require.Len(t, archive[0].Warnings, 3)
	require.Contains(t, strings.Join(archive[0].Warnings, " "), "not provider-rendered output")

	templates, next, err := a.ListTemplates(context.Background(), session, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, templates, 1)
	require.Equal(t, "tmpl-html", templates[0].SourceID)
	require.Contains(t, templates[0].SourceDefinition, `"language":"es"`)
	require.Contains(t, strings.Join(templates[0].Warnings, " "), "exact source content, not provider-rendered output")

	sourceArchive, next, err := a.ListSourceArchive(context.Background(), session, "")
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, sourceArchive, report.SourceArchiveTotal)
	counts := map[string]int{}
	for _, item := range sourceArchive {
		counts[item.ResourceType]++
		require.Equal(t, canonical.SourceCustomerIO, item.SourcePlatform)
		if item.ResourceType == resourceBroadcastWorkflow {
			payload, marshalErr := json.Marshal(item.Payload)
			require.NoError(t, marshalErr)
			require.Contains(t, string(payload), `"triggers":[{"broadcast_id":20,"created_at":1700000500,"id":901,"processed_at":1700000510},{"broadcast_id":20,"created_at":1700000600,"id":902,"processed_at":1700000610}]`)
		}
		if item.ResourceType == resourceNewsletter && item.SourceID == "customerio:newsletter:30" {
			contents := item.Payload["contents"].([]interface{})
			require.Len(t, contents, 2)
			var defaultContent map[string]interface{}
			for _, rawContent := range contents {
				content := rawContent.(map[string]interface{})
				if language, exists := content["language"].(string); exists && language == "" {
					defaultContent = content
					break
				}
			}
			require.Equal(t, "<p>Default</p>", defaultContent["body"])
			require.Equal(t, "<html><body>{{ content }}</body></html>", defaultContent["layout"])
		}
	}
	require.Equal(t, 1, counts[resourceCampaignWorkflow])
	require.Equal(t, 1, counts[resourceBroadcastWorkflow])
	require.Equal(t, 3, counts[resourceNewsletter])
	require.Equal(t, 1, counts[resourceTransactionalMessage])
	require.Equal(t, 1, counts[resourceDesignEmailRebuild])
	require.Equal(t, 1, counts[resourceSubscriptionChannel])
	require.Equal(t, 1, counts[resourceESPSuppression])
	require.Equal(t, 8, counts[resourceMigrationChecklist])

	automations, err := a.ListAutomations(context.Background(), session)
	require.NoError(t, err)
	require.Len(t, automations, 2)
	require.Equal(t, "Onboarding", automations[0].Name)
	require.Equal(t, "draft", automations[0].Status)
	require.Empty(t, automations[0].Triggers)
	require.Empty(t, automations[0].Nodes)
	require.Empty(t, automations[0].Edges)
	require.Contains(t, automations[0].SourceDefinition, `"migration_mode":"rebuild_review"`)
	require.Contains(t, automations[0].SourceDefinition, `"source_id":"customerio:campaign:10"`)
	require.Contains(t, automations[0].SourceDefinition, `"id":102`)
	require.Contains(t, automations[1].SourceDefinition, `"source_id":"customerio:broadcast:20"`)
	require.Contains(t, automations[1].SourceDefinition, `"triggers":[{"broadcast_id":20,"created_at":1700000500,"id":901,"processed_at":1700000510},{"broadcast_id":20,"created_at":1700000600,"id":902,"processed_at":1700000610}]`)
	require.True(t, a.Capabilities().Supports.Automations)
	require.Equal(t, "rebuild_review", a.Capabilities().Supports.AutomationMode)
	require.False(t, a.Capabilities().Supports.SMS)

	mu.Lock()
	joinedRequests := strings.Join(requests, "\n")
	mu.Unlock()
	require.Contains(t, joinedRequests, "POST /v1/customers?limit=1000&start=email-page-2")
	require.Contains(t, joinedRequests, "GET /v1/subscription_channels")
	require.Contains(t, joinedRequests, "GET /v1/campaigns/10/actions?start=action-page-2")
	require.Contains(t, joinedRequests, "GET /v1/broadcasts/20/triggers")
}

func TestBroadcastTriggerInventoryIsBoundedAndValidated(t *testing.T) {
	t.Run("preserves and sorts raw trigger evidence", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "/v1/broadcasts/20/triggers", r.URL.Path)
			writeJSON(t, w, `{"triggers":[{"id":2,"broadcast_id":20,"created_at":1700000010,"processed_at":1700000020},{"id":1,"broadcast_id":20,"created_at":1700000000,"processed_at":0}]}`)
		}))
		defer server.Close()

		triggers, err := fastAdapter(server).listBroadcastTriggers(context.Background(), testSession(), "20")
		require.NoError(t, err)
		require.Len(t, triggers, 2)
		require.Equal(t, "1", triggers[0].ID)
		require.Equal(t, int64(1700000000), triggers[0].CreatedAt)
		require.Equal(t, "2", triggers[1].ID)
		require.Equal(t, int64(1700000020), sourceInt64(triggers[1].Raw, "processed_at"))
	})

	for name, body := range map[string]string{
		"duplicate trigger":    `{"triggers":[{"id":1,"broadcast_id":20},{"id":1,"broadcast_id":20}]}`,
		"mismatched broadcast": `{"triggers":[{"id":1,"broadcast_id":21}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(t, w, body)
			}))
			defer server.Close()
			_, err := fastAdapter(server).listBroadcastTriggers(context.Background(), testSession(), "20")
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
		})
	}

	t.Run("over safety bound", func(t *testing.T) {
		var body strings.Builder
		body.WriteString(`{"triggers":[`)
		body.WriteString(strings.Repeat(`{"id":1},`, maxUnpagedResources))
		body.WriteString(`{"id":1}]}`)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(t, w, body.String())
		}))
		defer server.Close()
		_, err := fastAdapter(server).listBroadcastTriggers(context.Background(), testSession(), "20")
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	})
}

func TestCustomerSearchRejectsEmptyNonTerminalPage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, `{"identifiers":[],"next":"again"}`)
	}))
	defer server.Close()
	a := fastAdapter(server)
	_, err := a.listCustomerIdentifiers(context.Background(), testSession(), true)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestCustomerSearchRejectsDuplicateCIOIDAcrossPages(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("start") == "next" {
			writeJSON(t, w, `{"identifiers":[{"cio_id":"dup"}],"next":""}`)
			return
		}
		writeJSON(t, w, `{"identifiers":[{"cio_id":"dup"}],"next":"next"}`)
	}))
	defer server.Close()
	a := fastAdapter(server)
	_, err := a.listCustomerIdentifiers(context.Background(), testSession(), true)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestRequiredCollectionEnvelopesFailClosed(t *testing.T) {
	tests := []struct {
		name string
		key  string
		run  func(*Adapter) error
	}{
		{
			name: "workspaces",
			key:  "workspaces",
			run: func(a *Adapter) error {
				_, err := a.Authenticate(context.Background(), adapter.Credentials{APIKey: "secret", AccountID: "42"})
				return err
			},
		},
		{
			name: "customer search identifiers",
			key:  "identifiers",
			run: func(a *Adapter) error {
				_, err := a.listCustomerIdentifiers(context.Background(), testSession(), true)
				return err
			},
		},
		{
			name: "segments",
			key:  "segments",
			run: func(a *Adapter) error {
				_, err := a.listSegments(context.Background(), testSession())
				return err
			},
		},
		{
			name: "subscription topics",
			key:  "topics",
			run: func(a *Adapter) error {
				_, err := a.listTopics(context.Background(), testSession())
				return err
			},
		},
		{
			name: "subscription channels",
			key:  "channels",
			run: func(a *Adapter) error {
				_, err := a.listSubscriptionChannels(context.Background(), testSession())
				return err
			},
		},
		{
			name: "ESP suppressions",
			key:  "suppressions",
			run: func(a *Adapter) error {
				_, err := a.listSuppressions(context.Background(), testSession())
				return err
			},
		},
		{
			name: "campaign actions",
			key:  "actions",
			run: func(a *Adapter) error {
				_, err := a.listCampaignActions(context.Background(), testSession(), "10")
				return err
			},
		},
		{
			name: "broadcast triggers",
			key:  "triggers",
			run: func(a *Adapter) error {
				_, err := a.listBroadcastTriggers(context.Background(), testSession(), "20")
				return err
			},
		},
		{
			name: "Design Studio emails",
			key:  "emails",
			run: func(a *Adapter) error {
				_, err := a.listDesignEmails(context.Background(), testSession())
				return err
			},
		},
		{
			name: "channel opt-outs",
			key:  "optouts",
			run: func(a *Adapter) error {
				_, err := a.listOptouts(context.Background(), testSession())
				return err
			},
		},
		{
			name: "raw root collection",
			key:  "campaigns",
			run: func(a *Adapter) error {
				_, err := a.listRawCollection(context.Background(), testSession(), "/v1/campaigns", "campaigns", "campaign")
				return err
			},
		},
		{
			name: "cursor root collection",
			key:  "newsletters",
			run: func(a *Adapter) error {
				_, err := a.listNewsletters(context.Background(), testSession())
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, response := range []struct {
				name string
				body string
			}{
				{name: "missing", body: `{}`},
				{name: "null", body: `{"` + test.key + `":null}`},
			} {
				t.Run(response.name, func(t *testing.T) {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						writeJSON(t, w, response.body)
					}))
					defer server.Close()

					err := test.run(fastAdapter(server))
					require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
					require.Contains(t, err.Error(), "required")
				})
			}
		})
	}
}

func TestRequiredChildCollectionEnvelopesFailClosed(t *testing.T) {
	tests := []struct {
		name       string
		key        string
		parentPath string
		parentBody string
		childPath  string
		run        func(*Adapter) error
	}{
		{
			name:       "broadcast actions",
			key:        "actions",
			parentPath: "/v1/broadcasts",
			parentBody: `{"broadcasts":[{"id":20}]}`,
			childPath:  "/v1/broadcasts/20/actions",
			run: func(a *Adapter) error {
				_, err := a.listBroadcasts(context.Background(), testSession())
				return err
			},
		},
		{
			name:       "newsletter contents",
			key:        "contents",
			parentPath: "/v1/newsletters",
			parentBody: `{"newsletters":[{"id":30,"type":"email","sent_at":null}],"next":""}`,
			childPath:  "/v1/newsletters/30/contents",
			run: func(a *Adapter) error {
				_, err := a.listNewsletters(context.Background(), testSession())
				return err
			},
		},
		{
			name:       "transactional contents",
			key:        "contents",
			parentPath: "/v1/transactional",
			parentBody: `{"messages":[{"id":40}]}`,
			childPath:  "/v1/transactional/40/contents",
			run: func(a *Adapter) error {
				_, err := a.listTransactional(context.Background(), testSession())
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, response := range []struct {
				name string
				body string
			}{
				{name: "missing", body: `{}`},
				{name: "null", body: `{"` + test.key + `":null}`},
			} {
				t.Run(response.name, func(t *testing.T) {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						switch r.URL.Path {
						case test.parentPath:
							writeJSON(t, w, test.parentBody)
						case test.childPath:
							writeJSON(t, w, response.body)
						default:
							t.Fatalf("unexpected request %s", r.URL.RequestURI())
						}
					}))
					defer server.Close()

					err := test.run(fastAdapter(server))
					require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
					require.Contains(t, err.Error(), "required")
				})
			}
		})
	}
}

func TestSegmentMembershipRequiresIdentifiersEnvelopeEvenWhenCountIsZero(t *testing.T) {
	for _, response := range []struct {
		name string
		body string
	}{
		{name: "missing", body: `{"segment_id":7,"next":""}`},
		{name: "null", body: `{"segment_id":7,"identifiers":null,"next":""}`},
	} {
		t.Run(response.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/customer_count") {
					writeJSON(t, w, `{"segment_id":7,"count":0}`)
					return
				}
				writeJSON(t, w, response.body)
			}))
			defer server.Close()

			evidence := 0
			_, err := fastAdapter(server).snapshotSegmentMembership(
				context.Background(), testSession(), cioSegment{ID: "7"},
				map[string]cioIdentifiers{}, map[string]struct{}{}, map[string]*profileSnapshotInput{}, &evidence,
			)
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), "required")
		})
	}
}

func TestCustomerPreferenceTopicsEnvelopeIsRequired(t *testing.T) {
	response := &cioCustomerPreferencesResponse{}
	_, err := reconcileProfilePreferences(cioCustomerDetail{}, nil, nil, response)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "required customer subscription topics")
}

func TestNewsletterInventoryRejectsMalformedSemanticFieldsAndCursors(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "missing type", body: `{"newsletters":[{"id":30,"sent_at":1700000000}],"next":""}`, want: "channel type"},
		{name: "non-string type", body: `{"newsletters":[{"id":30,"type":7,"sent_at":1700000000}],"next":""}`, want: "channel type"},
		{name: "unsupported type", body: `{"newsletters":[{"id":30,"type":"sms","sent_at":1700000000}],"next":""}`, want: "unsupported channel type"},
		{name: "missing sent at", body: `{"newsletters":[{"id":30,"type":"email"}],"next":""}`, want: "omitted sent_at"},
		{name: "string sent at", body: `{"newsletters":[{"id":30,"type":"email","sent_at":"1700000000"}],"next":""}`, want: "non-integer sent_at"},
		{name: "fractional sent at", body: `{"newsletters":[{"id":30,"type":"email","sent_at":1700000000.5}],"next":""}`, want: "invalid sent_at"},
		{name: "zero sent at", body: `{"newsletters":[{"id":30,"type":"email","sent_at":0}],"next":""}`, want: "invalid sent_at"},
		{name: "numeric cursor", body: `{"newsletters":[],"next":123}`, want: "non-string next cursor"},
		{name: "null cursor", body: `{"newsletters":[],"next":null}`, want: "invalid next cursor"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				require.Equal(t, "/v1/newsletters", r.URL.Path)
				writeJSON(t, w, test.body)
			}))
			defer server.Close()

			_, err := fastAdapter(server).listNewsletters(context.Background(), testSession())
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), test.want)
		})
	}
}

func TestNewsletterInventoryRejectsMalformedContentType(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "missing", body: `{"contents":[{"id":301,"newsletter_id":30}]}`},
		{name: "non-string", body: `{"contents":[{"id":301,"newsletter_id":30,"type":7}]}`},
		{name: "unsupported", body: `{"contents":[{"id":301,"newsletter_id":30,"type":"sms"}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/newsletters":
					writeJSON(t, w, `{"newsletters":[{"id":30,"type":"email","sent_at":null}],"next":""}`)
				case "/v1/newsletters/30/contents":
					writeJSON(t, w, test.body)
				default:
					t.Fatalf("unexpected request %s", r.URL.RequestURI())
				}
			}))
			defer server.Close()

			_, err := fastAdapter(server).listNewsletters(context.Background(), testSession())
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), "channel type")
		})
	}
}

func TestCustomerIOResponseDecodingRejectsDuplicateJSONKeys(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "duplicate envelope", body: `{"segments":[],"segments":[]}`},
		{name: "duplicate nested identity", body: `{"segments":[{"id":1,"id":2}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(t, w, test.body)
			}))
			defer server.Close()

			_, err := fastAdapter(server).listSegments(context.Background(), testSession())
			require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
			require.Contains(t, err.Error(), "duplicate")
		})
	}

	_, err := parseResource(json.RawMessage(`{"id":1,"id":2}`), "test resource")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.Contains(t, err.Error(), "duplicate")
}

func TestSuppressionAndOptoutInventoriesRejectDuplicates(t *testing.T) {
	t.Run("ESP suppression", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(t, w, `{"category":"blocks","suppressions":[{"created":1700000000,"email":"blocked@example.com","reason":"blocked","status":"550"},{"created":1700000000,"email":"blocked@example.com","reason":"blocked","status":"550"}]}`)
		}))
		defer server.Close()
		_, err := fastAdapter(server).listSuppressions(context.Background(), testSession())
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	})

	t.Run("channel optout", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(t, w, `{"optouts":[{"customer_id":"one","cio_id":"c1","optouts":[{"channel":"sms","from":"+15551234567"}]},{"customer_id":"one","cio_id":"c1","optouts":[{"channel":"sms","from":"+15551234567"}]}],"next":""}`)
		}))
		defer server.Close()
		_, err := fastAdapter(server).listOptouts(context.Background(), testSession())
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	})
}

func TestSegmentMembershipRequiresProviderCount(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/customer_count"):
			writeJSON(t, w, `{"segment_id":7,"count":2}`)
		case strings.HasSuffix(r.URL.Path, "/membership"):
			writeJSON(t, w, `{"segment_id":7,"identifiers":[{"cio_id":"c1"}],"next":""}`)
		default:
			t.Fatalf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	profiles := map[string]*profileSnapshotInput{"c1": {}}
	identities := map[string]cioIdentifiers{"c1": {CIOID: "c1"}, "c2": {CIOID: "c2"}}
	evidence := 0
	_, err := fastAdapter(server).snapshotSegmentMembership(context.Background(), testSession(), cioSegment{ID: "7"}, identities, map[string]struct{}{"c1": {}, "c2": {}}, profiles, &evidence)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestSnapshotCursorRejectsChangedSameCountSnapshot(t *testing.T) {
	session := testSession()
	a := New()
	a.limiter = adapter.NewTokenBucket(100000, time.Second, 100000)
	subscribers := make([]canonical.Subscriber, customerSearchPageSize+1)
	for index := range subscribers {
		subscribers[index] = canonical.Subscriber{
			Email:          fmt.Sprintf("person-%d@example.com", index),
			Status:         canonical.StatusEnabled,
			ConsentSource:  canonical.ConsentUnknown,
			SourceID:       fmt.Sprintf("cio-%04d", index),
			SourcePlatform: canonical.SourceCustomerIO,
		}
	}
	a.snapshots[AccountFingerprint(session)] = &customerIOSnapshot{Subscribers: subscribers, Fingerprint: strings.Repeat("a", 64)}
	page, next, err := a.ListSubscribers(context.Background(), session, "")
	require.NoError(t, err)
	require.Len(t, page, customerSearchPageSize)
	require.NotEmpty(t, next)
	a.snapshots[AccountFingerprint(session)].Fingerprint = strings.Repeat("b", 64)
	_, _, err = a.ListSubscribers(context.Background(), session, next)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
}

func TestSnapshotCursorRejectsForgedOffsets(t *testing.T) {
	fingerprint := strings.Repeat("a", 64)
	for _, cursor := range []string{
		encodeSnapshotCursor(fingerprint, "subscribers", 0),
		encodeSnapshotCursor(fingerprint, "subscribers", 1),
		encodeSnapshotCursor(fingerprint, "subscribers", 2000),
	} {
		_, err := decodeSnapshotCursor(cursor, fingerprint, "subscribers", 2000, customerSearchPageSize)
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	}
	offset, err := decodeSnapshotCursor(encodeSnapshotCursor(fingerprint, "subscribers", 1000), fingerprint, "subscribers", 2000, customerSearchPageSize)
	require.NoError(t, err)
	require.Equal(t, 1000, offset)
}

func TestDoMapsRateLimitAndRejectsRedirect(t *testing.T) {
	t.Run("HTTP date retry-after", func(t *testing.T) {
		retryAt := time.Now().UTC().Add(3 * time.Second).Truncate(time.Second)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", retryAt.Format(http.TimeFormat))
			w.WriteHeader(http.StatusTooManyRequests)
		}))
		defer server.Close()
		a := fastAdapter(server)
		err := a.do(context.Background(), testSession(), http.MethodGet, "/v1/test", nil, nil)
		var limited *adapter.ErrRateLimited
		require.ErrorAs(t, err, &limited)
		require.Greater(t, limited.RetryAfter, time.Second)
	})

	t.Run("redirect", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://example.com/steal", http.StatusFound)
		}))
		defer server.Close()
		a := fastAdapter(server)
		err := a.do(context.Background(), testSession(), http.MethodGet, "/v1/test", nil, nil)
		require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	})
}

func TestRetryAfterIsBounded(t *testing.T) {
	now := time.Date(2026, time.July, 18, 0, 0, 0, 0, time.UTC)
	require.Equal(t, maxRetryAfter, parseRetryAfter("9223372036854775807", now))
	require.Equal(t, maxRetryAfter, parseRetryAfter(now.Add(30*24*time.Hour).Format(http.TimeFormat), now))
	require.Equal(t, 5*time.Second, parseRetryAfter("-1", now))
}

func TestResolveBaseAndCapabilities(t *testing.T) {
	require.Equal(t, defaultBaseUS, resolveBase(adapter.Session{}))
	require.Equal(t, defaultBaseEU, resolveBase(adapter.Session{Extra: map[string]string{RegionExtraKey: "eu"}}))
	caps := New().Capabilities()
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.True(t, caps.Supports.CampaignArchive)
	require.True(t, caps.Supports.Templates)
	require.True(t, caps.Supports.Automations)
	require.Equal(t, "rebuild_review", caps.Supports.AutomationMode)
	require.False(t, caps.Supports.ConsentTimestamps)
	require.False(t, caps.Supports.Reports)
	require.False(t, caps.Supports.SMS)
}

func TestListPaidSubsUnsupported(t *testing.T) {
	_, err := New().ListPaidSubs(context.Background(), adapter.Session{}, "")
	require.ErrorIs(t, err, adapter.ErrUnsupported)
}

func writeJSON(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	_, err := w.Write([]byte(body))
	require.NoError(t, err)
}

func cloneStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
