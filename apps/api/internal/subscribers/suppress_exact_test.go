package subscribers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSuppressRequiresOneExactStrongSubscriberRevision(t *testing.T) {
	d := &Deps{}
	for _, header := range []string{
		"",
		"*",
		`W/"subscriber:s:v1"`,
		`"subscriber:s:v1", "subscriber:s:v2"`,
	} {
		req := subscriberTenantRequest(
			http.MethodPost,
			"/api/v1/subscribers/s/suppress",
			"",
		)
		if header != "" {
			req.Header.Set("If-Match", header)
		}
		rec := httptest.NewRecorder()
		d.Suppress(rec, req)
		if rec.Code != http.StatusPreconditionRequired ||
			!strings.Contains(rec.Body.String(), "precondition_required") {
			t.Fatalf("If-Match %q: status/body = %d %s", header, rec.Code, rec.Body.String())
		}
	}
}
