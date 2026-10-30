// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNestedSourceArchiveCursorRejectsChangedParentAtStoredOffset(t *testing.T) {
	tests := []struct {
		name        string
		kind        string
		parentPath  string
		responseKey string
		parent      map[string]any
		resource    string
		wantNext    string
		checkQuery  func(*testing.T, *http.Request)
	}{
		{
			name:        "custom object schema",
			kind:        "custom_object_records",
			parentPath:  "/api/3/customObjects/schemas",
			responseKey: "schemas",
			parent:      map[string]any{"id": "replacement-parent"},
			resource:    "custom_object_records",
			wantNext:    customObjectRecordSelector + ":3",
			checkQuery: func(t *testing.T, r *http.Request) {
				if got := r.URL.Query().Get("showFields"); got != "all" {
					t.Fatalf("showFields = %q", got)
				}
			},
		},
		{
			name:        "legacy ecommerce order",
			kind:        "ecommerce_order_products",
			parentPath:  "/api/3/ecomOrders",
			responseKey: "ecomOrders",
			parent:      map[string]any{"id": "replacement-parent"},
			resource:    "ecommerce_order_products",
			wantNext:    ecommerceProductSelector + ":3",
		},
		{
			name:        "SMS broadcast",
			kind:        "sms_broadcast_recipients",
			parentPath:  "/api/3/sms/broadcasts",
			responseKey: "broadcasts",
			parent:      map[string]any{"id": "replacement-parent", "status": "sent"},
			resource:    "sms_broadcast_recipients",
			wantNext:    smsBroadcastSelector + ":3",
			checkQuery: func(t *testing.T, r *http.Request) {
				if got := r.URL.Query().Get("filters[status]"); got != "sent" {
					t.Fatalf("status filter = %q", got)
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var requests int
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != tc.parentPath {
					t.Fatalf("child request escaped parent validation: %s", r.URL.Path)
				}
				if r.URL.Query().Get("limit") != "1" || r.URL.Query().Get("offset") != "2" {
					t.Fatalf("parent revalidation query = %q", r.URL.RawQuery)
				}
				if tc.checkQuery != nil {
					tc.checkQuery(t, r)
				}
				writeJSON(t, w, map[string]any{
					tc.responseKey: []any{tc.parent},
					"meta":         map[string]any{"total": 3},
				})
			}))
			defer srv.Close()

			ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
			items, next, err := ad.ListSourceArchive(
				context.Background(),
				sess,
				encodeNestedArchiveCursor(tc.kind, 2, "stored-parent", 1),
			)
			assertSourceArchiveWarning(t, items, next, err, tc.resource, tc.wantNext, "changed from stored-parent to replacement-parent")
			if requests != 1 {
				t.Fatalf("requests = %d, want only parent revalidation", requests)
			}
		})
	}
}

func TestNestedSourceArchiveCursorRejectsDeletedParentAtStoredOffset(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/api/3/sms/broadcasts" {
			t.Fatalf("child request escaped deleted-parent validation: %s", r.URL.Path)
		}
		writeJSON(t, w, map[string]any{
			"broadcasts": []any{},
			"meta":       map[string]any{"total": 2},
		})
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(
		context.Background(),
		sess,
		encodeNestedArchiveCursor("sms_broadcast_recipients", 2, "42", 100),
	)
	assertSourceArchiveWarning(t, items, next, err, "sms_broadcast_recipients", smsBroadcastSelector+":3", "no longer present at offset 2")
	if requests != 1 {
		t.Fatalf("requests = %d, want only parent revalidation", requests)
	}
}

func TestLegacyEcommerceChildCursorResumesOnlyAfterParentRevalidation(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/3/ecomOrders":
			writeJSON(t, w, map[string]any{
				"ecomOrders": []any{map[string]any{"id": "order-1"}},
				"meta":       map[string]any{"total": 1},
			})
		case "/api/3/ecomOrders/order-1/orderProducts":
			writeJSON(t, w, map[string]any{
				"ecomOrderProducts": []any{map[string]any{"id": "product-1", "orderid": "order-1"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(
		context.Background(),
		sess,
		encodeNestedArchiveCursor("ecommerce_order_products", 0, "order-1", 0),
	)
	if err != nil || len(items) != 1 || items[0].SourceID != "order-1:product-1" || next != ecommerceProductSelector+":1" {
		t.Fatalf("items = %#v next=%q err=%v", items, next, err)
	}
	if len(paths) != 2 || paths[0] != "/api/3/ecomOrders" || paths[1] != "/api/3/ecomOrders/order-1/orderProducts" {
		t.Fatalf("request order = %#v, want parent validation before child fetch", paths)
	}
}
