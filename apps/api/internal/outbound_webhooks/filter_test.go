// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseFilter_EmptyMatchesEverything(t *testing.T) {
	f, err := ParseFilter("")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{}))
	require.True(t, f.Matches(map[string]any{"anything": 1}))
}

func TestFilter_Equality(t *testing.T) {
	f, err := ParseFilter("subscriber.status == active")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"status": "active"},
	}))
	require.False(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"status": "unsubscribed"},
	}))
}

func TestFilter_NumericCompare(t *testing.T) {
	f, err := ParseFilter("campaign.recipients_count > 1000")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"campaign": map[string]any{"recipients_count": 5000.0},
	}))
	require.False(t, f.Matches(map[string]any{
		"campaign": map[string]any{"recipients_count": 100.0},
	}))
}

func TestFilter_NumericComparisonPreservesExactJSONSemantics(t *testing.T) {
	tests := []struct {
		expression string
		value      any
		want       bool
	}{
		{"payload.value > 9007199254740992", json.Number("9007199254740993"), true},
		{"payload.value < 9007199254740994", json.Number("9007199254740993"), true},
		{"payload.value == 1000", json.Number("1e3"), true},
		{"payload.value == 0.1", json.Number("0.100"), true},
		{"payload.value > 0.10000000000000000000", json.Number("0.10000000000000000001"), true},
		{"payload.value > 9e399", json.Number("1e400"), true},
		{"payload.value > 9223372036854775806", int64(9223372036854775807), true},
		{"payload.value > 18446744073709551614", uint64(18446744073709551615), true},
		{"payload.value == \"5\"", 5, false},
		{"payload.value == \"5\"", "5", true},
		{"payload.value > \"5\"", 6, false},
		{"payload.value > 1e999999999", json.Number("2"), false},
	}
	for _, test := range tests {
		t.Run(test.expression, func(t *testing.T) {
			filter, err := ParseFilter(test.expression)
			require.NoError(t, err)
			require.Equal(t, test.want, filter.Matches(map[string]any{
				"payload": map[string]any{"value": test.value},
			}))
		})
	}
}

func TestFilter_ArrayIncludes(t *testing.T) {
	f, err := ParseFilter("subscriber.tags includes vip")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"tags": []any{"customer", "vip"}},
	}))
	require.False(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"tags": []any{"customer"}},
	}))
}

func TestFilter_AndOr(t *testing.T) {
	f, err := ParseFilter("subscriber.status == active && subscriber.country == US")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"status": "active", "country": "US"},
	}))
	require.False(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"status": "active", "country": "CA"},
	}))

	g, err := ParseFilter("subscriber.country == US || subscriber.country == CA")
	require.NoError(t, err)
	require.True(t, g.Matches(map[string]any{
		"subscriber": map[string]any{"country": "CA"},
	}))
	require.False(t, g.Matches(map[string]any{
		"subscriber": map[string]any{"country": "DE"},
	}))
}

func TestFilter_StringOps(t *testing.T) {
	f, err := ParseFilter("subscriber.email endswith @example.com")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"email": "alice@example.com"},
	}))
	require.False(t, f.Matches(map[string]any{
		"subscriber": map[string]any{"email": "alice@other.com"},
	}))
}

func TestTransform_FieldSelection(t *testing.T) {
	template := map[string]any{
		"email": "/subscriber/email",
		"name":  "/subscriber/first_name",
	}
	payload := []byte(`{"subscriber":{"email":"a@b.com","first_name":"Ada","secret":"redact"},"event":"x"}`)
	out, err := Transform(template, payload)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(out, &got))
	require.Equal(t, "a@b.com", got["email"])
	require.Equal(t, "Ada", got["name"])
	_, hasSecret := got["secret"]
	require.False(t, hasSecret)
}

func TestTransform_NilTemplatePassthrough(t *testing.T) {
	payload := []byte(`{"x":1}`)
	out, err := Transform(nil, payload)
	require.NoError(t, err)
	require.Equal(t, string(payload), string(out))
}

func TestTransform_MissingPointersOmitted(t *testing.T) {
	template := map[string]any{
		"email":   "/subscriber/email",
		"missing": "/no/such/path",
	}
	payload := []byte(`{"subscriber":{"email":"a@b.com"}}`)
	out, err := Transform(template, payload)
	require.NoError(t, err)
	var got map[string]any
	require.NoError(t, json.Unmarshal(out, &got))
	require.Equal(t, "a@b.com", got["email"])
	_, has := got["missing"]
	require.False(t, has)
}

func TestTransform_PreservesExactJSONNumberSpellings(t *testing.T) {
	template := map[string]any{
		"large":    "/payload/large",
		"decimal":  "/payload/decimal",
		"exponent": "/payload/exponent",
		"huge":     "/payload/huge",
	}
	payload := []byte(`{"payload":{"large":9007199254740993,"decimal":0.10000000000000000001,"exponent":1e+30,"huge":1e400}}`)
	out, err := Transform(template, payload)
	require.NoError(t, err)
	require.Equal(t,
		`{"decimal":0.10000000000000000001,"exponent":1e+30,"huge":1e400,"large":9007199254740993}`,
		string(out),
	)
	for _, exact := range []string{
		"9007199254740993",
		"0.10000000000000000001",
		"1e+30",
		"1e400",
	} {
		require.Contains(t, string(out), exact)
	}
}

func TestFilter_RejectsAmbiguousOperatorWithoutWhitespace(t *testing.T) {
	// Adversarial: the legacy parser misread `a!=b` as field=`a`,
	// op=`!=`, val=`b` purely from a substring search with no
	// whitespace requirement, which caused field names containing
	// operator characters (e.g. data.contains_html) to mis-parse.
	cases := []string{
		"subscriber.foo!=bar",  // no spaces at all
		"subscriber.foo!= bar", // partial whitespace (right only)
		"subscriber.foo !=bar", // partial whitespace (left only)
	}
	for _, expr := range cases {
		_, err := ParseFilter(expr)
		require.Error(t, err, expr)
	}
	// A string-typed value containing operator characters is
	// allowed (legitimate use case: matching literal strings):
	_, err := ParseFilter(`field == bar==baz`)
	require.NoError(t, err)
}

func TestFilter_OperatorPrecedence_LongestFirst(t *testing.T) {
	// "field >= value" must parse as >= (not as >); regression
	// guard for the operator-ordering change.
	f, err := ParseFilter("campaign.count >= 100")
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"campaign": map[string]any{"count": 100.0},
	}))
}

func TestFilter_QuotedLogicalTokensRemainLiteral(t *testing.T) {
	f, err := ParseFilter(`event.label == "A && B || C" && event.kind == notice`)
	require.NoError(t, err)
	require.True(t, f.Matches(map[string]any{
		"event": map[string]any{"label": "A && B || C", "kind": "notice"},
	}))
}

func TestFilter_RejectsEmptyClausesAndUnterminatedQuotes(t *testing.T) {
	for _, expression := range []string{
		`event.kind == notice ||`,
		`&& event.kind == notice`,
		`event.kind == notice && || event.id == 1`,
		`event.label == "unterminated`,
	} {
		_, err := ParseFilter(expression)
		require.Error(t, err, expression)
	}
}

func TestFilter_NumericComparisonNeverTreatsInvalidValuesAsEqual(t *testing.T) {
	f, err := ParseFilter("campaign.count >= not-a-number")
	require.NoError(t, err)
	require.False(t, f.Matches(map[string]any{
		"campaign": map[string]any{"count": 10.0},
	}))

	g, err := ParseFilter("campaign.count <= 10")
	require.NoError(t, err)
	require.False(t, g.Matches(map[string]any{
		"campaign": map[string]any{"count": "10"},
	}))
}

func TestFilter_FractionalNumberDoesNotEqualTruncatedInteger(t *testing.T) {
	f, err := ParseFilter("campaign.score == 5")
	require.NoError(t, err)
	require.False(t, f.Matches(map[string]any{
		"campaign": map[string]any{"score": 5.2},
	}))
}

func TestTransform_RFC6901EscapesAndRootSemantics(t *testing.T) {
	template := map[string]any{
		"slash":     "/a~1b",
		"tilde":     "/m~0n",
		"empty_key": "/",
		"document":  "",
	}
	payload := []byte(`{"a/b":"slash-value","m~n":"tilde-value","":"empty-value"}`)
	out, err := Transform(template, payload)
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(out, &got))
	require.Equal(t, "slash-value", got["slash"])
	require.Equal(t, "tilde-value", got["tilde"])
	require.Equal(t, "empty-value", got["empty_key"])
	require.IsType(t, map[string]any{}, got["document"])
}

func TestValidateTransform_RejectsNonStringsAndMalformedPointers(t *testing.T) {
	require.Error(t, ValidateTransform(map[string]any{"email": 42}))
	require.Error(t, ValidateTransform(map[string]any{"email": "subscriber/email"}))
	require.Error(t, ValidateTransform(map[string]any{"email": "/subscriber/~2email"}))
}

func TestDeliveryPolicyBounds(t *testing.T) {
	tooLongFilter := "event.value == " + strings.Repeat("x", maxFilterExpressionBytes)
	_, err := ParseFilter(tooLongFilter)
	require.Error(t, err)

	tooManyFields := make(map[string]any, maxTransformFields+1)
	for i := 0; i <= maxTransformFields; i++ {
		tooManyFields[strconv.Itoa(i)] = "/event/id"
	}
	require.Error(t, ValidateTransform(tooManyFields))
}

func TestUpdateInput_DeliveryPolicyNullMeansClearAndOmittedMeansUnchanged(t *testing.T) {
	var clear UpdateInput
	require.NoError(t, json.Unmarshal(
		[]byte(`{"filter_expression":null,"transform_template":null}`),
		&clear,
	))
	require.True(t, clear.changesFilterExpression())
	require.True(t, clear.changesTransformTemplate())
	require.Nil(t, clear.FilterExpression)
	require.Nil(t, clear.TransformTemplate)

	var unchanged UpdateInput
	require.NoError(t, json.Unmarshal([]byte(`{"description":"kept"}`), &unchanged))
	require.False(t, unchanged.changesFilterExpression())
	require.False(t, unchanged.changesTransformTemplate())
}
