// SPDX-License-Identifier: MIT

package csv

import (
	"strings"
	"testing"
)

// kindsByHeader detects a mapping for one header line and indexes the result by
// the header text, so a case asserts what a real upload would produce.
func kindsByHeader(t *testing.T, csvBody string) map[string]FieldKind {
	t.Helper()
	mapping, _, err := DetectMapping(strings.NewReader(csvBody))
	if err != nil {
		t.Fatalf("DetectMapping: %v", err)
	}
	out := map[string]FieldKind{}
	for _, col := range mapping.Columns {
		out[col.Name] = col.Kind
	}
	return out
}

// The name family is the whole point of the fix: a "first_name" column used to
// fall through to KindCustom, which created a brand-new custom field on every
// import instead of filling the subscriber's name.
func TestDetectMapping_NameFamilyHeaders(t *testing.T) {
	cases := []struct {
		name string
		body string
		want map[string]FieldKind
	}{
		{
			name: "snake case first and last",
			body: "email,first_name,last_name\na@b.com,Ada,Lovelace\n",
			want: map[string]FieldKind{
				"email":      KindEmail,
				"first_name": KindFirstName,
				"last_name":  KindLastName,
			},
		},
		{
			name: "spaced title case, as a spreadsheet exports it",
			body: "Email Address,First Name,Last Name\na@b.com,Ada,Lovelace\n",
			want: map[string]FieldKind{
				"Email Address": KindEmail,
				"First Name":    KindFirstName,
				"Last Name":     KindLastName,
			},
		},
		{
			name: "no separator and hyphenated",
			body: "email,FIRSTNAME,last-name\na@b.com,Ada,Lovelace\n",
			want: map[string]FieldKind{
				"email":     KindEmail,
				"FIRSTNAME": KindFirstName,
				"last-name": KindLastName,
			},
		},
		{
			name: "full name variants stay the single name destination",
			body: "email,Full Name\na@b.com,Ada Lovelace\n",
			want: map[string]FieldKind{"email": KindEmail, "Full Name": KindName},
		},
		{
			name: "plain name column is unchanged",
			body: "email,name\na@b.com,Ada Lovelace\n",
			want: map[string]FieldKind{"email": KindEmail, "name": KindName},
		},
		{
			name: "other vocabularies",
			body: "email,given_name,surname\na@b.com,Ada,Lovelace\n",
			want: map[string]FieldKind{
				"email":      KindEmail,
				"given_name": KindFirstName,
				"surname":    KindLastName,
			},
		},
		{
			name: "a name-shaped custom column is still custom",
			body: "email,nickname,company_name\na@b.com,Ada,Analytical Engines\n",
			want: map[string]FieldKind{
				"email":        KindEmail,
				"nickname":     KindCustom,
				"company_name": KindCustom,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := kindsByHeader(t, tc.body)
			for header, want := range tc.want {
				if got[header] != want {
					t.Errorf("column %q: got %q, want %q (all: %v)", header, got[header], want, got)
				}
			}
		})
	}
}

// Two columns can never share one destination: the importer refuses such a
// mapping outright ("each mapping target must receive exactly one source
// column"), so a detected mapping that contained one would dead-end the wizard.
func TestDetectMapping_SecondColumnForATakenDestinationBecomesCustom(t *testing.T) {
	got := kindsByHeader(t, "email,name,full_name,tags,labels\na@b.com,Ada Lovelace,Ada Lovelace,vip,beta\n")
	if got["name"] != KindName {
		t.Errorf("first name column: got %q, want %q", got["name"], KindName)
	}
	if got["full_name"] != KindCustom {
		t.Errorf("second full-name column: got %q, want %q", got["full_name"], KindCustom)
	}
	if got["tags"] != KindTags {
		t.Errorf("first tag column: got %q, want %q", got["tags"], KindTags)
	}
	if got["labels"] != KindCustom {
		t.Errorf("second tag column: got %q, want %q", got["labels"], KindCustom)
	}
}

// A file with first/last AND a full name keeps all three: three destinations,
// no collision, nothing pushed into a custom field.
func TestDetectMapping_FirstLastAndFullNameCoexist(t *testing.T) {
	got := kindsByHeader(t, "email,first_name,last_name,full_name\na@b.com,Ada,Lovelace,Ada Lovelace\n")
	want := map[string]FieldKind{
		"email":      KindEmail,
		"first_name": KindFirstName,
		"last_name":  KindLastName,
		"full_name":  KindName,
	}
	for header, kind := range want {
		if got[header] != kind {
			t.Errorf("column %q: got %q, want %q", header, got[header], kind)
		}
	}
}

// applyRow is the migration adapter's row shaper: the new kinds must land on the
// keys migration 0413 promotes into subscribers.first_name / .last_name.
func TestApplyRow_FirstAndLastNameLandOnTheirCanonicalKeys(t *testing.T) {
	mapping, _, err := DetectMapping(strings.NewReader("email,first_name,last_name\nada@example.com,Ada,Lovelace\n"))
	if err != nil {
		t.Fatalf("DetectMapping: %v", err)
	}
	sub, ok := applyRow([]string{"ada@example.com", "Ada", "Lovelace"}, mapping)
	if !ok {
		t.Fatal("row should apply")
	}
	if sub.CustomFields["first_name"] != "Ada" {
		t.Errorf("first_name: %v", sub.CustomFields["first_name"])
	}
	if sub.CustomFields["last_name"] != "Lovelace" {
		t.Errorf("last_name: %v", sub.CustomFields["last_name"])
	}
}

func TestNormalizeHeader(t *testing.T) {
	cases := map[string]string{
		"First Name":  "first_name",
		" first-name": "first_name",
		"FIRST__NAME": "first_name",
		"e-mail":      "e_mail",
		"2024 spend":  "2024_spend",
		"…":           "",
	}
	for in, want := range cases {
		if got := normalizeHeader(in); got != want {
			t.Errorf("normalizeHeader(%q) = %q, want %q", in, got, want)
		}
	}
}
