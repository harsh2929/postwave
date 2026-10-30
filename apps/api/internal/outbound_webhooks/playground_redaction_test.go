// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestInspectablePlaygroundHeadersRedactsCredentials(t *testing.T) {
	t.Parallel()

	headers, count := inspectablePlaygroundHeaders(map[string]string{
		"Content-Type":              "application/json",
		"X-Postwave-Signature":      "t=1700000000,v1=request-bound-signature",
		"X-Postwave-Key-Id":         "key-id-1",
		"X-Request-Id":              "request-123",
		"aUtHoRiZaTiOn":             "Bearer live-bearer-token",
		"CoOkIe":                    "session=live-cookie",
		"X-API-Key":                 "live-api-key",
		"X-Innocent-Looking-Header": "Bearer credential-hidden-by-value",
		"X-AuthToken":               "opaque-camel-secret",
		"X-Prefixed":                "prefix Bearer embedded-header-secret",
	}, &AuthConfig{
		BearerToken: "server-side-bearer-token",
		Headers: map[string]string{
			"X-Custom-Auth": "live-custom-auth",
			"X-Tenant-ID":   "opaque-custom-credential",
		},
	})

	if count != 8 {
		t.Fatalf("redacted header count = %d, want 8; headers=%v", count, headers)
	}
	for _, name := range []string{
		"Authorization", "Cookie", "X-Api-Key", "X-Innocent-Looking-Header",
		"X-Authtoken", "X-Prefixed", "X-Custom-Auth", "X-Tenant-Id",
	} {
		if got := headers[name]; got != playgroundRedactedValue {
			t.Errorf("%s = %q, want redacted placeholder", name, got)
		}
	}
	if got := headers["Content-Type"]; got != "application/json" {
		t.Errorf("Content-Type = %q, want preserved", got)
	}
	if got := headers["X-Postwave-Signature"]; got != "t=1700000000,v1=request-bound-signature" {
		t.Errorf("Moosewave signature = %q, want preserved", got)
	}
	if got := headers["X-Postwave-Key-Id"]; got != "key-id-1" {
		t.Errorf("Moosewave key id = %q, want preserved", got)
	}
	if got := headers["X-Request-Id"]; got != "request-123" {
		t.Errorf("request id = %q, want preserved", got)
	}

	encoded, err := json.Marshal(headers)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"live-bearer-token", "live-cookie", "live-api-key",
		"credential-hidden-by-value", "server-side-bearer-token",
		"opaque-camel-secret", "embedded-header-secret", "live-custom-auth",
		"opaque-custom-credential",
	} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("inspectable headers leaked %q: %s", secret, encoded)
		}
	}
}

func TestRedactPlaygroundCredentialTextRemovesEchoedAuthValues(t *testing.T) {
	t.Parallel()

	auth := &AuthConfig{
		BearerToken: "bearer-secret-123",
		Headers: map[string]string{
			"X-Custom-Auth": "custom-secret-456",
			"X-Second-Auth": "custom-secret-456",
		},
		MTLSCertPEM: "certificate-secret-789",
		MTLSKeyPEM:  "private-key-secret-012",
	}
	raw := "receiver echoed bearer-secret-123 and custom-secret-456; " +
		"transport mentioned certificate-secret-789 and private-key-secret-012"

	redacted, count := redactPlaygroundCredentialText(raw, auth)
	if count != 4 {
		t.Fatalf("redacted value count = %d, want 4; value=%q", count, redacted)
	}
	for _, secret := range []string{
		"bearer-secret-123", "custom-secret-456",
		"certificate-secret-789", "private-key-secret-012",
	} {
		if strings.Contains(redacted, secret) {
			t.Errorf("redacted text leaked %q: %s", secret, redacted)
		}
	}
	if got := strings.Count(redacted, playgroundRedactedValue); got != 4 {
		t.Errorf("placeholder count = %d, want 4; value=%q", got, redacted)
	}
}

func TestRedactInspectablePlaygroundTextRemovesUnconfiguredCredentialShapes(t *testing.T) {
	t.Parallel()

	awsKey := "AKIA" + "IOSFODNN7EXAMPLE"
	raw := "receiver echoed Bearer standalone-token and api_key=standalone-key; " +
		"token=standalone-query; AWS key " + awsKey + " and JWT " +
		"eyJhbGciOiJIUzI1NiJ9.payload.signature"

	redacted, count := redactInspectablePlaygroundText(raw, nil)
	if count != 5 {
		t.Fatalf("redacted value count = %d, want 5; value=%q", count, redacted)
	}
	for _, secret := range []string{
		"standalone-token", "standalone-key", "standalone-query", awsKey,
		"eyJhbGciOiJIUzI1NiJ9.payload.signature",
	} {
		if strings.Contains(redacted, secret) {
			t.Errorf("inspectable text leaked %q: %s", secret, redacted)
		}
	}
}

func TestRedactInspectablePlaygroundResponseTextRedactsSensitiveJSONKeys(t *testing.T) {
	t.Parallel()

	raw := `{"accepted":true,"authorization":"opaque-auth-value","nested":{"token":"opaque-token-value","request_id":"request-123"}}`
	redacted, count := redactInspectablePlaygroundResponseText(raw, nil, "")
	if count != 2 {
		t.Fatalf("redacted JSON count = %d, want 2; value=%q", count, redacted)
	}
	for _, secret := range []string{"opaque-auth-value", "opaque-token-value"} {
		if strings.Contains(redacted, secret) {
			t.Errorf("inspectable JSON leaked %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "request-123") {
		t.Errorf("inspectable JSON dropped safe data: %s", redacted)
	}
}

func TestRedactInspectablePlaygroundResponseTextRedactsNumericDestinationBeforeStructuredReturn(t *testing.T) {
	t.Parallel()

	const (
		destination = "https://hooks.example.test/hooks/public?code=900719925474099312345678901"
		secret      = "900719925474099312345678901"
		safeNumber  = "9007199254740993"
	)
	raw := `{"token":"forces a structured redaction","destination_echo":` + secret + `,"safe":` + safeNumber + `}`

	redacted, count := redactInspectablePlaygroundResponseText(raw, nil, destination)
	if count < 2 {
		t.Fatalf("redaction count = %d, want at least 2; value=%q", count, redacted)
	}
	if strings.Contains(redacted, secret) {
		t.Fatalf("structured response leaked numeric destination atom %q: %s", secret, redacted)
	}

	decoder := json.NewDecoder(strings.NewReader(redacted))
	decoder.UseNumber()
	var decoded map[string]any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("decode redacted response: %v; value=%q", err, redacted)
	}
	if got := decoded["destination_echo"]; got != playgroundRedactedValue {
		t.Errorf("destination_echo = %#v, want redacted placeholder", got)
	}
	if got, ok := decoded["safe"].(json.Number); !ok || got.String() != safeNumber {
		t.Errorf("safe number = %#v, want exact json.Number %q", decoded["safe"], safeNumber)
	}
}

func TestRedactInspectablePlaygroundResponseTextRedactsNumericAuthBeforeStructuredReturn(t *testing.T) {
	t.Parallel()

	const (
		secret     = "1e400"
		safeNumber = "1e399"
	)
	raw := `{"authorization":"forces a structured redaction","auth_echo":` + secret + `,"safe":` + safeNumber + `}`

	redacted, count := redactInspectablePlaygroundResponseText(raw, &AuthConfig{BearerToken: secret}, "")
	if count < 2 {
		t.Fatalf("redaction count = %d, want at least 2; value=%q", count, redacted)
	}
	if strings.Contains(redacted, secret) {
		t.Fatalf("structured response leaked numeric auth value %q: %s", secret, redacted)
	}

	decoder := json.NewDecoder(strings.NewReader(redacted))
	decoder.UseNumber()
	var decoded map[string]any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("decode redacted response: %v; value=%q", err, redacted)
	}
	if got := decoded["auth_echo"]; got != playgroundRedactedValue {
		t.Errorf("auth_echo = %#v, want redacted placeholder", got)
	}
	if got, ok := decoded["safe"].(json.Number); !ok || got.String() != safeNumber {
		t.Errorf("safe number = %#v, want exact json.Number %q", decoded["safe"], safeNumber)
	}
}

func TestRedactPlaygroundSensitiveDataCanonicalScalarCoverage(t *testing.T) {
	t.Parallel()

	type namedInt int64
	type namedFloat float64
	tests := []struct {
		name      string
		value     any
		canonical string
	}{
		{name: "json number", value: json.Number("900719925474099312345678901e-7"), canonical: "900719925474099312345678901e-7"},
		{name: "null", value: nil, canonical: "null"},
		{name: "bool", value: true, canonical: "true"},
		{name: "int", value: int(-4242), canonical: "-4242"},
		{name: "int8", value: int8(-42), canonical: "-42"},
		{name: "int16", value: int16(-4242), canonical: "-4242"},
		{name: "int32", value: int32(-4242), canonical: "-4242"},
		{name: "int64", value: int64(-4242), canonical: "-4242"},
		{name: "uint", value: uint(4242), canonical: "4242"},
		{name: "uint8", value: uint8(42), canonical: "42"},
		{name: "uint16", value: uint16(4242), canonical: "4242"},
		{name: "uint32", value: uint32(4242), canonical: "4242"},
		{name: "uint64", value: uint64(4242), canonical: "4242"},
		{name: "uintptr", value: uintptr(4242), canonical: "4242"},
		{name: "float32", value: float32(12.5), canonical: "12.5"},
		{name: "float64", value: float64(12.75), canonical: "12.75"},
		{name: "float64 exponent", value: float64(1e-9), canonical: "1e-9"},
		{name: "float64 JSON fixed threshold", value: float64(1e20), canonical: "100000000000000000000"},
		{name: "named int", value: namedInt(-4242), canonical: "-4242"},
		{name: "named float", value: namedFloat(1e-9), canonical: "1e-9"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, count := redactPlaygroundSensitiveData(
				test.value,
				&AuthConfig{BearerToken: test.canonical},
				"",
			)
			if count < 1 || got != playgroundRedactedValue {
				t.Fatalf("redaction = (%#v, %d), want (%q, >=1)", got, count, playgroundRedactedValue)
			}
		})
	}

	exact := json.Number("900719925474099312345678901e-7")
	got, count := redactPlaygroundSensitiveData(exact, nil, "")
	if count != 0 {
		t.Fatalf("safe exact number redaction count = %d, want 0", count)
	}
	gotNumber, ok := got.(json.Number)
	if !ok || gotNumber.String() != exact.String() {
		t.Fatalf("safe exact number = %#v, want exact json.Number %q", got, exact)
	}
}

func TestRedactInspectablePlaygroundResponseTextNeverRevealsEncryptedDestination(t *testing.T) {
	t.Parallel()

	const destination = "https://hooks.example.test/hooks/a7Qx9?code=b3Lm8&trace=request-123"
	raw := `{"accepted":true,"request_uri":"/hooks/a7Qx9?code=b3Lm8&trace=request-123","path_token":"a7Qx9","query_token":"b3Lm8","safe":"request-456"}`
	redacted, count := redactInspectablePlaygroundResponseText(raw, nil, destination)
	if count < 3 {
		t.Fatalf("destination redaction count = %d, want at least 3; value=%q", count, redacted)
	}
	for _, secret := range []string{
		destination,
		"/hooks/a7Qx9?code=b3Lm8&trace=request-123",
		"a7Qx9",
		"b3Lm8",
	} {
		if strings.Contains(redacted, secret) {
			t.Errorf("inspectable response leaked encrypted destination value %q: %s", secret, redacted)
		}
	}
	if !strings.Contains(redacted, "request-456") {
		t.Errorf("inspectable response dropped unrelated receiver evidence: %s", redacted)
	}
}

func TestRedactInspectablePlaygroundResponseTextRedactsDestinationQueryNames(t *testing.T) {
	t.Parallel()

	const destination = "https://hooks.example.test/hook?b3Lm8&c7Np2=x"
	for _, raw := range []string{
		`{"b3Lm8":"bare query name","echoed_name":"c7Np2","safe":"request-456"}`,
		"receiver echoed bare query atom b3Lm8 and query lhs c7Np2",
	} {
		redacted, count := redactInspectablePlaygroundResponseText(raw, nil, destination)
		if count < 2 {
			t.Fatalf("destination query-name redaction count = %d, want at least 2; value=%q", count, redacted)
		}
		for _, secret := range []string{"b3Lm8", "c7Np2"} {
			if strings.Contains(redacted, secret) {
				t.Errorf("inspectable response leaked destination query name %q: %s", secret, redacted)
			}
		}
		if !strings.Contains(redacted, "request-456") && strings.HasPrefix(raw, "{") {
			t.Errorf("inspectable response dropped unrelated receiver evidence: %s", redacted)
		}
	}
}

func TestCredentialLikePlaygroundValueCoverage(t *testing.T) {
	t.Parallel()

	awsKey := "AKIA" + "IOSFODNN7EXAMPLE"
	for _, value := range []string{
		"Basic dXNlcjpwYXNz", "github_pat_livevalue", "xoxb-live-token",
		"sk_live_example", awsKey, "access_token=live",
		"eyJhbGciOiJIUzI1NiJ9.payload.signature",
	} {
		if !credentialLikePlaygroundValue(value) {
			t.Errorf("credential-like value was not detected: %q", value)
		}
	}
	for _, value := range []string{
		"application/json", "request-123", "t=1700000000,v1=request-bound-signature",
	} {
		if credentialLikePlaygroundValue(value) {
			t.Errorf("non-credential value was over-redacted: %q", value)
		}
	}
}

func TestInspectablePlaygroundURLRedactsCredentialLocations(t *testing.T) {
	t.Parallel()

	raw := "https://live-user:live-password@hooks.example.test/opaque-custom-secret/ghp_path-token" +
		"?token=live-query-token&opaque=Bearer%20live-value-token&tenant=opaque-custom-secret&trace=request-123" +
		"#access_token=live-fragment-token"
	safe, count := inspectablePlaygroundURL(raw, &AuthConfig{
		Headers: map[string]string{"X-Custom-Auth": "opaque-custom-secret"},
	})
	if count != 7 {
		t.Fatalf("redacted URL count = %d, want 7; URL=%q", count, safe)
	}
	for _, secret := range []string{
		"live-user", "live-password", "live-query-token", "live-value-token",
		"live-fragment-token", "opaque-custom-secret", "ghp_path-token",
	} {
		if strings.Contains(safe, secret) {
			t.Errorf("inspectable URL leaked %q: %s", secret, safe)
		}
	}
	if !strings.Contains(safe, "trace=request-123") {
		t.Errorf("non-sensitive query value was not preserved: %s", safe)
	}
}

func TestRedactPlaygroundCredentialDataBuildsSafeCurlBody(t *testing.T) {
	t.Parallel()

	auth := &AuthConfig{
		Headers: map[string]string{"X-Custom-Auth": "opaque-custom-secret"},
	}
	raw := map[string]any{
		"event": map[string]any{
			"type":         "subscriber.created",
			"access_token": "live-body-token",
			"note":         "Bearer live-body-bearer",
			"custom_value": "opaque-custom-secret",
			"request_id":   "request-123",
		},
	}

	safe, count := redactPlaygroundCredentialData(raw, auth)
	if count != 3 {
		t.Fatalf("redacted body count = %d, want 3; body=%v", count, safe)
	}
	encoded, err := json.Marshal(safe)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"live-body-token", "live-body-bearer", "opaque-custom-secret",
	} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("safe body leaked %q: %s", secret, encoded)
		}
	}
	if !strings.Contains(string(encoded), "request-123") {
		t.Errorf("safe body dropped non-sensitive data: %s", encoded)
	}
}
