// SPDX-License-Identifier: AGPL-3.0-only

package publictrack

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// The beacon carries the edge-measured ASN into the observation, and refuses an
// untrusted one.
//
// This is the path that makes network_asn non-NULL at all. It sat accepted
// end-to-end and never populated: the column, the constraints and the trust
// helper all existed while nothing called them, so every row in the product
// carried NULL and the machine-source registry — which MATCHES on ASN — had
// nothing to match.
//
// It is also the path where believing the header wrongly does the most damage.
// This beacon is the one place where the TCP peer genuinely IS the engaging
// client, so it is the highest-value ASN to learn and the most attractive one to
// forge: a sender who could choose their own ASN could choose their own
// human/machine classification.
func TestTheBeaconCarriesAnEdgeMeasuredASNAndRefusesAnUntrustedOne(t *testing.T) {
	const body = `{"email":"buyer@example.com","event_name":"viewed"}`

	request := func(d *Deps, remoteAddr, asnHeader string) *fakeRecorder {
		fr := &fakeRecorder{out: &subscribers.SubscriberEvent{ID: 1}}
		d.Subs = fr
		req := httptest.NewRequest("POST", "http://shop.example.com/api/public/track/event",
			strings.NewReader(body))
		req.Host = "shop.example.com"
		req.Header.Set("Content-Type", "application/json")
		if asnHeader != "" {
			req.Header.Set(middleware.ClientASNHeader, asnHeader)
		}
		req.RemoteAddr = remoteAddr
		d.PublicTrackEvent(httptest.NewRecorder(), req)
		return fr
	}

	t.Run("an untrusted peer's ASN header is ignored", func(t *testing.T) {
		if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
			t.Fatalf("SetTrustedProxyCIDRs: %v", err)
		}
		t.Cleanup(func() { _ = middleware.SetTrustedProxyCIDRs(nil) })

		d := &Deps{ResolveTenant: staticResolver("t1", nil), TrustForwardedIPHeaders: true}
		fr := request(d, "203.0.113.9:5555", "13335")
		if fr.calls == 0 {
			t.Fatal("the recorder was never called; the assertion below would be vacuous")
		}
		if fr.gotInput.NetworkASN != nil {
			t.Fatalf("an untrusted peer's ASN header was honoured as %d — a sender "+
				"could choose its own classification", *fr.gotInput.NetworkASN)
		}
		// The provenance matters as much as the value. A refused header recorded
		// as `edge_measured` would tell an operator the edge measured something
		// it actually rejected — a lie about how the row was learned, on the one
		// field the machine-source registry matches against.
		if fr.gotInput.NetworkASNSource != engagementclassification.NetworkASNUnmeasured {
			t.Fatalf("provenance = %q for a refused header, want unmeasured",
				fr.gotInput.NetworkASNSource)
		}
	})

	t.Run("a trusted peer's ASN is measured and its provenance recorded", func(t *testing.T) {
		if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
			t.Fatalf("SetTrustedProxyCIDRs: %v", err)
		}
		t.Cleanup(func() { _ = middleware.SetTrustedProxyCIDRs(nil) })

		d := &Deps{ResolveTenant: staticResolver("t1", nil), TrustForwardedIPHeaders: true}
		fr := request(d, "10.1.2.3:5555", "13335")
		if fr.calls == 0 {
			t.Fatal("the recorder was never called")
		}
		if fr.gotInput.NetworkASN == nil || *fr.gotInput.NetworkASN != 13335 {
			t.Fatalf("a trusted edge's ASN was not carried into the observation: %v",
				fr.gotInput.NetworkASN)
		}
		if fr.gotInput.NetworkASNSource != engagementclassification.NetworkASNEdgeMeasured {
			t.Fatalf("provenance = %q, want edge_measured — an operator must be able "+
				"to tell a measured value from an absent one",
				fr.gotInput.NetworkASNSource)
		}
	})

	t.Run("no trusted edge configured is reported as unconfigured, not as absent", func(t *testing.T) {
		_ = middleware.SetTrustedProxyCIDRs(nil)
		d := &Deps{ResolveTenant: staticResolver("t1", nil)}
		fr := request(d, "10.1.2.3:5555", "13335")
		if fr.calls == 0 {
			t.Fatal("the recorder was never called")
		}
		if fr.gotInput.NetworkASN != nil {
			t.Fatalf("an ASN was recorded with no trusted edge configured: %d",
				*fr.gotInput.NetworkASN)
		}
		// The distinction that stops "the signal is switched off" being read as
		// "no machine traffic this week".
		if fr.gotInput.NetworkASNSource != engagementclassification.NetworkASNEdgeUnconfigured {
			t.Fatalf("provenance = %q, want edge_unconfigured", fr.gotInput.NetworkASNSource)
		}
	})
}
