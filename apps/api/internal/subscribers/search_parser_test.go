package subscribers

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseSearch(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want SearchQuery
	}{
		{
			name: "empty",
			raw:  "",
			want: SearchQuery{},
		},
		{
			name: "plain free text",
			raw:  "alice",
			want: SearchQuery{FreeText: "alice"},
		},
		{
			name: "tag positive",
			raw:  "tag:vip",
			want: SearchQuery{Tags: []Term{{Value: "vip"}}},
		},
		{
			name: "tag negated",
			raw:  "-tag:beta",
			want: SearchQuery{Tags: []Term{{Value: "beta", Negated: true}}},
		},
		{
			name: "domain shorthand",
			raw:  "@acme.com",
			want: SearchQuery{Domains: []Term{{Value: "acme.com"}}},
		},
		{
			name: "negated domain",
			raw:  "-@acme.com",
			want: SearchQuery{Domains: []Term{{Value: "acme.com", Negated: true}}},
		},
		{
			name: "name with quotes",
			raw:  `name:"jane doe"`,
			want: SearchQuery{Names: []Term{{Value: "jane doe"}}},
		},
		{
			name: "mixed",
			raw:  "tag:vip -tag:beta @acme.com alice",
			want: SearchQuery{
				FreeText: "alice",
				Tags:     []Term{{Value: "vip"}, {Value: "beta", Negated: true}},
				Domains:  []Term{{Value: "acme.com"}},
			},
		},
		{
			name: "status maps lower",
			raw:  "status:Subscribed",
			want: SearchQuery{Statuses: []Term{{Value: "subscribed"}}},
		},
		{
			name: "free text preserves negation",
			raw:  "alice -spam",
			want: SearchQuery{FreeText: "alice -spam"},
		},
		{
			name: "empty value ignored",
			raw:  "tag:",
			want: SearchQuery{},
		},
		{
			name: "signup source positive",
			raw:  "source:embedded_form",
			want: SearchQuery{SignupSources: []Term{{Value: "embedded_form"}}},
		},
		{
			name: "signup source long form",
			raw:  "signup_source:hosted_page",
			want: SearchQuery{SignupSources: []Term{{Value: "hosted_page"}}},
		},
		{
			name: "signup source negated",
			raw:  "-source:import",
			want: SearchQuery{SignupSources: []Term{{Value: "import", Negated: true}}},
		},
		{
			name: "signup source unknown normalises to unknown bucket",
			raw:  "source:badvalue",
			want: SearchQuery{SignupSources: []Term{{Value: "unknown"}}},
		},
		{
			name: "topic positive lowercases slug",
			raw:  "topic:Newsletter",
			want: SearchQuery{Topics: []Term{{Value: "newsletter"}}},
		},
		{
			name: "topic negated long form",
			raw:  "-topics:promos",
			want: SearchQuery{Topics: []Term{{Value: "promos", Negated: true}}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseSearch(tc.raw)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v\nwant %#v", got, tc.want)
			}
		})
	}
}

func TestSearchQueryHelpers(t *testing.T) {
	if !(SearchQuery{}).IsEmpty() {
		t.Fatal("zero SearchQuery should be empty")
	}
	if (SearchQuery{FreeText: "x"}).IsEmpty() {
		t.Fatal("free text query is not empty")
	}
	if (SearchQuery{Tags: []Term{{Value: "v"}}}).IsEmpty() {
		t.Fatal("tag-only query is not empty")
	}
	if (SearchQuery{}).HasStructured() {
		t.Fatal("zero has no structured terms")
	}
	if !(SearchQuery{Tags: []Term{{Value: "v"}}}).HasStructured() {
		t.Fatal("tag-only is structured")
	}
}

func TestBuildSearchWhere(t *testing.T) {
	cases := []struct {
		name       string
		q          SearchQuery
		wantParts  []string // substrings expected in the SQL
		wantArgs   int      // total args (incl. the seed tenant_id at $1)
		extraArgs0 []any    // seed args passed in (defaults to []any{"tid"})
	}{
		{
			name:      "tenant only",
			q:         SearchQuery{},
			wantParts: []string{"WHERE tenant_id = $1::uuid"},
			wantArgs:  1,
		},
		{
			name:      "free text uses tsv + trgm",
			q:         SearchQuery{FreeText: "alice"},
			wantParts: []string{"search_tsv @@ websearch_to_tsquery", "lower(email::text) LIKE"},
			wantArgs:  2,
		},
		{
			name:      "tag positive uses && tags",
			q:         SearchQuery{Tags: []Term{{Value: "vip"}}},
			wantParts: []string{"tags && ARRAY[$2]::text[]"},
			wantArgs:  2,
		},
		{
			name:      "tag negation uses NOT",
			q:         SearchQuery{Tags: []Term{{Value: "beta", Negated: true}}},
			wantParts: []string{"NOT (tags && ARRAY[$2]::text[])"},
			wantArgs:  2,
		},
		{
			name:      "domain anchored on @",
			q:         SearchQuery{Domains: []Term{{Value: "acme.com"}}},
			wantParts: []string{"lower(email::text) LIKE '%@' || lower($2)"},
			wantArgs:  2,
		},
		{
			name: "mixed AND-anded with two clauses",
			q: SearchQuery{
				Tags:    []Term{{Value: "vip"}},
				Domains: []Term{{Value: "acme.com"}, {Value: "ex.com", Negated: true}},
			},
			wantParts: []string{" AND "},
			wantArgs:  4,
		},
		{
			name: "status unknown is dropped",
			q: SearchQuery{
				Statuses: []Term{{Value: "garbage"}},
			},
			wantParts: []string{"WHERE tenant_id = $1::uuid"},
			wantArgs:  1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			seed := tc.extraArgs0
			if seed == nil {
				seed = []any{"tid"}
			}
			gotSQL, gotArgs := buildSearchWhere(tc.q, seed)
			for _, p := range tc.wantParts {
				if !strings.Contains(gotSQL, p) {
					t.Fatalf("missing %q in SQL: %s", p, gotSQL)
				}
			}
			if len(gotArgs) != tc.wantArgs {
				t.Fatalf("args=%d want %d (sql=%s)", len(gotArgs), tc.wantArgs, gotSQL)
			}
		})
	}
}
