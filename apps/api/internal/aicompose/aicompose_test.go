package aicompose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/postwave/apps/api/internal/concurrency"
)

// fakeVoice is a test double that returns canned responses based on the
// kind + an optional call counter for variant differentiation.
type fakeVoice struct {
	mu          sync.Mutex
	subjectCall int32
	draft       *CampaignDraft
	subjects    []string
	failKind    ChatKind
	failErr     error
}

func TestAIMaxInflightFromEnvIsBounded(t *testing.T) {
	previous, hadPrevious := os.LookupEnv("POSTWAVE_AI_MAX_INFLIGHT")
	t.Cleanup(func() {
		if hadPrevious {
			_ = os.Setenv("POSTWAVE_AI_MAX_INFLIGHT", previous)
		} else {
			_ = os.Unsetenv("POSTWAVE_AI_MAX_INFLIGHT")
		}
	})
	for _, tc := range []struct {
		value string
		want  int
	}{
		{"", defaultAIMaxInflight},
		{"0", defaultAIMaxInflight},
		{"-1", defaultAIMaxInflight},
		{"not-a-number", defaultAIMaxInflight},
		{"1025", defaultAIMaxInflight},
		{"1", 1},
		{"1024", maxAIMaxInflight},
	} {
		if err := os.Setenv("POSTWAVE_AI_MAX_INFLIGHT", tc.value); err != nil {
			t.Fatalf("Setenv: %v", err)
		}
		if got := aiMaxInflightFromEnv(); got != tc.want {
			t.Fatalf("value %q = %d, want %d", tc.value, got, tc.want)
		}
	}
}

func TestAcquireAISlotShedsWithoutLeakingCapacityDetail(t *testing.T) {
	previous := aiInflight
	aiInflight = concurrency.New(1)
	t.Cleanup(func() { aiInflight = previous })

	release, ok := acquireAISlot(httptest.NewRecorder())
	if !ok || release == nil {
		t.Fatal("first request did not acquire the only slot")
	}
	defer release()

	w := httptest.NewRecorder()
	if secondRelease, secondOK := acquireAISlot(w); secondOK || secondRelease != nil {
		t.Fatal("saturated limiter admitted a second request")
	}
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("saturation response = %d retry-after=%q", w.Code, w.Header().Get("Retry-After"))
	}
	if strings.Contains(w.Body.String(), "ai_at_capacity") {
		t.Fatalf("5xx response bypassed central redaction: %s", w.Body.String())
	}
}

func (f *fakeVoice) Generate(_ context.Context, _ string, kind ChatKind, _, _ string) (GenerateResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if kind == f.failKind && f.failErr != nil {
		return GenerateResult{}, f.failErr
	}
	switch kind {
	case KindCampaignDraft:
		if f.draft != nil {
			return GenerateResult{Text: "(draft)", Draft: f.draft}, nil
		}
		return GenerateResult{Text: "Hello world.\nSecond line."}, nil
	case KindSubjectLine:
		idx := int(atomic.AddInt32(&f.subjectCall, 1)) - 1
		if idx < len(f.subjects) {
			return GenerateResult{Text: f.subjects[idx]}, nil
		}
		return GenerateResult{Text: fmt.Sprintf("Variant subject %d", idx+1)}, nil
	default:
		return GenerateResult{Text: "free form"}, nil
	}
}

func TestComposeBroadcast_HappyPath(t *testing.T) {
	v := &fakeVoice{
		draft: &CampaignDraft{
			Name:        "Pricing announcement",
			Subject:     "Our new pricing is here",
			Body:        "<p>Hello!</p>",
			PreviewText: "We've updated our plans",
		},
		subjects: []string{"Try our new plans", "Pricing 2.0 just dropped"},
	}
	c := New(v)
	out, err := c.ComposeBroadcast(context.Background(), "tenant1", ComposeBroadcastInput{
		Brief:        "announce our pricing change",
		VariantCount: 2,
	})
	require.NoError(t, err)
	require.Equal(t, "Our new pricing is here", out.Primary.Subject)
	require.Equal(t, "<p>Hello!</p>", out.Primary.Body)
	// SubjectVariants starts with the primary's subject + N alternates.
	require.GreaterOrEqual(t, len(out.SubjectVariants), 2)
	require.Equal(t, "Our new pricing is here", out.SubjectVariants[0])
	require.Contains(t, out.SubjectVariants, "Try our new plans")
}

func TestComposeBroadcast_FallsBackOnUnstructuredDraft(t *testing.T) {
	v := &fakeVoice{draft: nil, subjects: []string{"Variant A"}}
	c := New(v)
	out, err := c.ComposeBroadcast(context.Background(), "tenant1", ComposeBroadcastInput{
		Brief:        "send a teaser",
		VariantCount: 1,
	})
	require.NoError(t, err)
	require.Equal(t, "Hello world.", out.Primary.Subject) // first line
	require.Contains(t, out.Primary.Body, "Hello world")
}

func TestComposeBroadcast_RejectsEmptyBrief(t *testing.T) {
	c := New(&fakeVoice{})
	_, err := c.ComposeBroadcast(context.Background(), "t1", ComposeBroadcastInput{Brief: "   "})
	require.ErrorIs(t, err, ErrBadRequest)
}

func TestComposeBroadcast_ClampsVariantCount(t *testing.T) {
	v := &fakeVoice{
		draft:    &CampaignDraft{Subject: "anchor", Body: "x"},
		subjects: []string{"v1", "v2", "v3", "v4", "v5", "v6"},
	}
	c := New(v)
	out, err := c.ComposeBroadcast(context.Background(), "t1", ComposeBroadcastInput{
		Brief:        "x",
		VariantCount: 99, // should clamp to MaxVariants = 4
	})
	require.NoError(t, err)
	// 1 (primary) + 4 (clamped variants) = 5 entries.
	require.LessOrEqual(t, len(out.SubjectVariants), 5)
}

func TestComposeBroadcast_DegradesGracefullyOnVariantFailure(t *testing.T) {
	v := &fakeVoice{
		draft:    &CampaignDraft{Subject: "primary", Body: "x"},
		failKind: KindSubjectLine,
		failErr:  errors.New("voice flake"),
	}
	c := New(v)
	out, err := c.ComposeBroadcast(context.Background(), "t1", ComposeBroadcastInput{
		Brief:        "x",
		VariantCount: 3,
	})
	require.NoError(t, err) // primary succeeded, variants gracefully empty
	require.Equal(t, []string{"primary"}, out.SubjectVariants)
}

func TestComposeBroadcast_PrimaryFailureSurfaces(t *testing.T) {
	v := &fakeVoice{failKind: KindCampaignDraft, failErr: ErrVoiceUnavailable}
	c := New(v)
	_, err := c.ComposeBroadcast(context.Background(), "t1", ComposeBroadcastInput{Brief: "x"})
	require.ErrorIs(t, err, ErrVoiceUnavailable)
}

func TestComposeVariants_HappyPath(t *testing.T) {
	v := &fakeVoice{subjects: []string{"V1", "V2", "V3"}}
	c := New(v)
	out, err := c.ComposeVariants(context.Background(), "t1", ComposeVariantsInput{
		Subject:      "Anchor subject",
		Body:         "Some body",
		VariantCount: 3,
	})
	require.NoError(t, err)
	require.Len(t, out.SubjectVariants, 3)
}

func TestComposeVariants_DefaultsTo3(t *testing.T) {
	v := &fakeVoice{}
	c := New(v)
	out, err := c.ComposeVariants(context.Background(), "t1", ComposeVariantsInput{
		Subject: "Hi",
	})
	require.NoError(t, err)
	require.Len(t, out.SubjectVariants, 3) // synthesized "Variant subject N"
}

func TestComposeVariantsUpToSupportsSubjectLabWithoutWeakeningGeneralCap(t *testing.T) {
	v := &fakeVoice{}
	c := New(v)

	general, err := c.ComposeVariants(context.Background(), "t1", ComposeVariantsInput{
		Subject:      "Anchor subject",
		VariantCount: 8,
	})
	require.NoError(t, err)
	require.Len(t, general.SubjectVariants, 4)

	lab, err := c.ComposeVariantsUpTo(context.Background(), "t1", ComposeVariantsInput{
		Subject:      "Anchor subject",
		VariantCount: 8,
	}, 8)
	require.NoError(t, err)
	require.Len(t, lab.SubjectVariants, 8)

	hardCapped, err := c.ComposeVariantsUpTo(context.Background(), "t1", ComposeVariantsInput{
		Subject:      "Anchor subject",
		VariantCount: 99,
	}, 99)
	require.NoError(t, err)
	require.Len(t, hardCapped.SubjectVariants, absoluteMaxVariants)
}

func TestComposeVariants_RejectsEmptySubject(t *testing.T) {
	c := New(&fakeVoice{})
	_, err := c.ComposeVariants(context.Background(), "t1", ComposeVariantsInput{Subject: ""})
	require.ErrorIs(t, err, ErrBadRequest)
}

func TestDedupeNonEmpty_StripsCaseInsensitiveDupes(t *testing.T) {
	got := dedupeNonEmpty([]string{"Hello", "HELLO", " hello ", "", "World"})
	require.Equal(t, []string{"Hello", "World"}, got)
}

func TestHTTPVoiceClient_ForwardsInternalAuthTenantAndKind(t *testing.T) {
	var sawAuth, sawTenant, sawKind string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawTenant = r.Header.Get("X-Tenant-ID")
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Kind   string `json:"kind"`
			Prompt string `json:"prompt"`
		}
		_ = json.Unmarshal(body, &req)
		sawKind = req.Kind
		_, _ = w.Write([]byte(`{"text":"ok","draft":{"name":"n","subject":"s","body":"b"}}`))
	}))
	defer srv.Close()
	c := NewHTTPVoiceClient(srv.URL, " internal-voice-token ")
	got, err := c.Generate(context.Background(), "tenant-abc", KindCampaignDraft, "brief", "ctx")
	require.NoError(t, err)
	require.Equal(t, "Bearer internal-voice-token", sawAuth)
	require.Equal(t, "tenant-abc", sawTenant)
	require.Equal(t, "campaign_draft", sawKind)
	require.Equal(t, "s", got.Draft.Subject)
}

func TestHTTPVoiceClient_503MapsToUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := NewHTTPVoiceClient(srv.URL, "")
	_, err := c.Generate(context.Background(), "t", KindCampaignDraft, "brief", "")
	require.ErrorIs(t, err, ErrVoiceUnavailable)
}

func TestHTTPVoiceClient_LimitsResponseBody(t *testing.T) {
	// Send a huge body — the client must cap at 256KB. We use a payload
	// large enough that an unbounded decoder would happily accept and
	// run away, but the limited reader truncates and JSON decode fails.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 300<<10))
	}))
	defer srv.Close()
	c := NewHTTPVoiceClient(srv.URL, "")
	_, err := c.Generate(context.Background(), "t", KindCampaignDraft, "brief", "")
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "decode voice response"))
}

func TestHTTPVoiceClientDoesNotFollowRedirectWithInternalCredential(t *testing.T) {
	targetCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetCalls++
		_, _ = w.Write([]byte(`{"text":"unexpected"}`))
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	client := NewHTTPVoiceClient(redirect.URL, "internal-token")
	_, err := client.Generate(context.Background(), "tenant-1", KindFreeForm, "brief", "")
	require.Error(t, err)
	require.Equal(t, 0, targetCalls)
	require.NotContains(t, err.Error(), target.URL)
}

func TestComposer_NilVoiceReturnsUnavailable(t *testing.T) {
	c := New(nil)
	_, err := c.ComposeBroadcast(context.Background(), "t1", ComposeBroadcastInput{Brief: "x"})
	require.ErrorIs(t, err, ErrVoiceUnavailable)
	_, err = c.ComposeVariants(context.Background(), "t1", ComposeVariantsInput{Subject: "x"})
	require.ErrorIs(t, err, ErrVoiceUnavailable)
}
