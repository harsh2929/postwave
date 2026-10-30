// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestSourceArchiveCustomObjectRecordsResumeWithinAndAcrossSchemas(t *testing.T) {
	var schemaRequests, recordRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/customObjects/schemas":
			schemaRequests++
			if got := r.URL.Query().Get("showFields"); got != "all" {
				t.Fatalf("showFields = %q, want all", got)
			}
			offset := r.URL.Query().Get("offset")
			switch offset {
			case "0":
				writeJSON(t, w, map[string]any{"schemas": []any{map[string]any{"id": "schema-one"}}, "meta": map[string]any{"total": 2}})
			case "1":
				writeJSON(t, w, map[string]any{"schemas": []any{map[string]any{"id": "schema-two"}}, "meta": map[string]any{"total": 2}})
			case "2":
				writeJSON(t, w, map[string]any{"schemas": []any{}, "meta": map[string]any{"total": 2}})
			default:
				t.Fatalf("schema offset = %q", offset)
			}
		case "/api/3/customObjects/records/schema-one":
			recordRequests++
			offset := r.URL.Query().Get("offset")
			if offset == "0" {
				writeJSON(t, w, map[string]any{
					"records": []any{map[string]any{"id": "record-1", "schemaId": "schema-one", "updatedTimestamp": "2026-06-01T12:30:00Z", "fields": []any{map[string]any{"id": "score", "value": 7}}}},
					"meta":    map[string]any{"total": 2},
				})
				return
			}
			if offset == "1" {
				writeJSON(t, w, map[string]any{
					"records": []any{map[string]any{"externalId": "external-2", "schemaId": "schema-one", "relationships": map[string]any{"primary-contact": []any{"14"}}}},
					"meta":    map[string]any{"total": 2},
				})
				return
			}
			t.Fatalf("record offset = %q", offset)
		case "/api/3/customObjects/records/schema-two":
			recordRequests++
			writeJSON(t, w, map[string]any{"records": []any{}, "meta": map[string]any{"total": 0}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(context.Background(), sess, customObjectRecordSelector+":0")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].SourceID != "schema-one:record-1" || items[0].ResourceType != "activecampaign_custom_object_record" {
		t.Fatalf("first records = %#v", items)
	}
	if sourceMapString(items[0].Payload, "activecampaign_schema_id") != "schema-one" {
		t.Fatalf("schema context missing from payload: %#v", items[0].Payload)
	}
	if items[0].OccurredAt == nil || items[0].OccurredAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-06-01T12:30:00Z" {
		t.Fatalf("custom-object occurred_at = %v", items[0].OccurredAt)
	}
	if !strings.HasPrefix(next, "custom_object_records~0~") || !strings.HasSuffix(next, ":1") {
		t.Fatalf("nested cursor = %q", next)
	}

	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].SourceID != "schema-one:external-2" || next != customObjectRecordSelector+":1" {
		t.Fatalf("continued records = %#v next=%q", items, next)
	}
	if schemaRequests != 2 {
		t.Fatalf("schema requests during record continuation = %d, want selector plus parent revalidation", schemaRequests)
	}

	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 || next != customObjectRecordSelector+":2" {
		t.Fatalf("empty second schema = %#v next=%q", items, next)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 || next != "ecommerce_connections:0" {
		t.Fatalf("custom-object terminal = %#v next=%q", items, next)
	}
	if schemaRequests != 4 || recordRequests != 3 {
		t.Fatalf("requests schemas=%d records=%d, want 4/3 including continuation parent revalidation", schemaRequests, recordRequests)
	}
}

func TestSourceArchiveEcommercePreservesConnectionsCustomersOrdersAndProducts(t *testing.T) {
	var orderSelectorRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/connections":
			writeJSON(t, w, map[string]any{"connections": []any{map[string]any{"id": "connection-1", "service": "shopify", "externalid": "shop-1"}}})
		case "/api/3/ecomCustomers":
			writeJSON(t, w, map[string]any{"ecomCustomers": []any{map[string]any{"id": "customer-1", "email": "buyer@example.com", "totalRevenue": "8800"}}})
		case "/api/3/ecomOrders":
			if r.URL.Query().Get("limit") == "1" {
				orderSelectorRequests++
				if r.URL.Query().Get("offset") == "0" {
					writeJSON(t, w, map[string]any{"ecomOrders": []any{map[string]any{"id": "order-1"}}, "meta": map[string]any{"total": 1}})
				} else {
					writeJSON(t, w, map[string]any{"ecomOrders": []any{}, "meta": map[string]any{"total": 1}})
				}
				return
			}
			writeJSON(t, w, map[string]any{"ecomOrders": []any{map[string]any{"id": "order-1", "externalid": "external-order", "totalPrice": 8800}}})
		case "/api/3/ecomOrders/order-1/orderProducts":
			if r.URL.RawQuery != "" {
				t.Fatalf("order-products query = %q, want documented unpaginated request", r.URL.RawQuery)
			}
			writeJSON(t, w, map[string]any{"ecomOrderProducts": []any{
				map[string]any{"id": "product-1", "orderid": "order-1", "sku": "SKU-1", "quantity": "2", "updatedDate": "2026-06-02T12:30:00Z"},
				map[string]any{"externalid": "line-2", "orderid": "order-1", "name": "Course"},
			}})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(context.Background(), sess, "ecommerce_connections:0")
	if err != nil || len(items) != 1 || items[0].ResourceType != "activecampaign_ecommerce_connection" || next != "ecommerce_customers:0" {
		t.Fatalf("connections = %#v next=%q err=%v", items, next, err)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 1 || items[0].ResourceType != "activecampaign_ecommerce_customer" || next != "ecommerce_orders:0" {
		t.Fatalf("customers = %#v next=%q err=%v", items, next, err)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 1 || items[0].SourceID != "order-1" || next != ecommerceProductSelector+":0" {
		t.Fatalf("orders = %#v next=%q err=%v", items, next, err)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 2 || items[0].SourceID != "order-1:product-1" || items[1].SourceID != "order-1:line-2" {
		t.Fatalf("products = %#v next=%q err=%v", items, next, err)
	}
	if sourceMapString(items[0].Payload, "activecampaign_order_id") != "order-1" || sourceMapString(items[0].Payload, "sku") != "SKU-1" {
		t.Fatalf("product context not preserved: %#v", items[0].Payload)
	}
	if items[0].OccurredAt == nil || items[0].OccurredAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-06-02T12:30:00Z" {
		t.Fatalf("product occurred_at = %v", items[0].OccurredAt)
	}
	if next != ecommerceProductSelector+":1" {
		t.Fatalf("product cursor = %q, want next order", next)
	}
	if orderSelectorRequests != 1 {
		t.Fatalf("order selector requests = %d, want 1", orderSelectorRequests)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 0 || next != smsBroadcastSelector+":0" {
		t.Fatalf("product terminal = %#v next=%q err=%v", items, next, err)
	}
}

func TestSourceArchiveSMSBroadcastPreservesMetricsFailuresAndRecipientPages(t *testing.T) {
	var detailRequests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/sms/broadcasts":
			if r.Method != http.MethodGet || r.URL.Query().Get("filters[status]") != "sent" || r.URL.Query().Get("limit") != "1" {
				t.Fatalf("bad broadcast list request: %s %s", r.Method, r.URL.RawQuery)
			}
			if r.URL.Query().Get("offset") == "0" {
				writeJSON(t, w, map[string]any{"broadcasts": []any{map[string]any{"id": 42, "name": "Launch", "status": "sent", "body": "Summary body"}}, "meta": map[string]any{"total": 1}})
			} else {
				writeJSON(t, w, map[string]any{"broadcasts": []any{}, "meta": map[string]any{"total": 1}})
			}
		case "/api/3/sms/broadcasts/42":
			detailRequests++
			writeJSON(t, w, map[string]any{"id": 42, "name": "Launch", "status": "sent", "body": "Full body", "sent_date": "2026-06-03T12:30:00Z", "list_ids": []any{9}})
		case "/api/3/sms/broadcasts/metrics":
			if r.Method != http.MethodPost {
				t.Fatalf("metrics method = %s", r.Method)
			}
			var body struct {
				IDs []int `json:"ids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) != 1 || body.IDs[0] != 42 {
				t.Fatalf("metrics body = %#v err=%v", body, err)
			}
			writeJSON(t, w, map[string]any{"metrics": []any{map[string]any{"id": 42, "sends": 2, "deliveries": 1, "failures": 1, "optOuts": 1}}})
		case "/api/3/sms/broadcasts/metrics/42/failures":
			writeJSON(t, w, map[string]any{"failures": []any{map[string]any{"errorCode": "30003", "errorSource": "twilio", "count": 1}}})
		case "/api/3/sms/broadcasts/42/recipients":
			offset := r.URL.Query().Get("offset")
			if offset == "0" {
				writeJSON(t, w, map[string]any{"recipients": []any{map[string]any{"id": 7, "phoneNumber": "+12025550101", "sentDate": "2026-06-03T12:31:00Z", "deliverability": "delivered", "optOut": "yes", "replies": []any{map[string]any{"message": "STOP"}}}}, "meta": map[string]any{"total": 2, "limit": 100, "offset": 0}})
			} else if offset == "1" {
				writeJSON(t, w, map[string]any{"recipients": []any{map[string]any{"id": 8, "phoneNumber": "+12025550102", "deliverability": "failed", "details": map[string]any{"errorCode": "30003"}}}, "meta": map[string]any{"total": 2, "limit": 100, "offset": 1}})
			} else {
				t.Fatalf("recipient offset = %q", offset)
			}
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(context.Background(), sess, "sms_messages:0")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].ResourceType != "activecampaign_sms_broadcast" || items[1].ResourceType != "activecampaign_sms_broadcast_recipient" {
		t.Fatalf("first SMS page = %#v", items)
	}
	if items[0].SourceID != "42" || sourceMapString(interfaceMap(items[0].Payload["detail"]), "body") != "Full body" {
		t.Fatalf("broadcast detail not preserved: %#v", items[0])
	}
	if items[0].OccurredAt == nil || items[0].OccurredAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-06-03T12:30:00Z" {
		t.Fatalf("broadcast occurred_at = %v", items[0].OccurredAt)
	}
	metric := interfaceMap(items[0].Payload["metrics"])
	if fmt.Sprint(metric["optOuts"]) != "1" {
		t.Fatalf("metrics not preserved: %#v", items[0].Payload)
	}
	failures, ok := items[0].Payload["failures"].([]map[string]interface{})
	if !ok || len(failures) != 1 || sourceMapString(failures[0], "errorCode") != "30003" {
		t.Fatalf("failures not preserved: %T %#v", items[0].Payload["failures"], items[0].Payload["failures"])
	}
	if sourceMapString(items[1].Payload, "optOut") != "yes" || sourceMapString(items[1].Payload, "activecampaign_broadcast_id") != "42" {
		t.Fatalf("recipient evidence not preserved: %#v", items[1].Payload)
	}
	if items[1].OccurredAt == nil || items[1].OccurredAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-06-03T12:31:00Z" {
		t.Fatalf("recipient occurred_at = %v", items[1].OccurredAt)
	}
	if !strings.HasPrefix(next, "sms_broadcast_recipients~0~") || !strings.HasSuffix(next, ":1") {
		t.Fatalf("recipient cursor = %q", next)
	}

	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 1 || items[0].SourceID != "42:8" || next != smsBroadcastSelector+":1" {
		t.Fatalf("continued recipients = %#v next=%q err=%v", items, next, err)
	}
	if detailRequests != 1 {
		t.Fatalf("detail requests during recipient continuation = %d, want 1", detailRequests)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 0 || next != nonEmailContactResource+":0" {
		t.Fatalf("SMS terminal = %#v next=%q err=%v", items, next, err)
	}
}

func TestSourceArchiveNonEmailContactsPreservesHydratedEvidenceAndIDCursor(t *testing.T) {
	var detailIDs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/3/contacts":
			if r.URL.Query().Get("orders[id]") != "ASC" || r.URL.Query().Get("limit") != strconv.Itoa(pageSize) {
				t.Fatalf("bad contacts query: %s", r.URL.RawQuery)
			}
			switch r.URL.Query().Get("id_greater") {
			case "":
				writeJSON(t, w, map[string]any{"contacts": []any{
					map[string]any{"id": "1", "email": "addressable@example.com"},
					map[string]any{"id": "5", "email": "", "phone": "+12025550105"},
				}, "meta": map[string]any{"total": 3}})
			case "5":
				writeJSON(t, w, map[string]any{"contacts": []any{map[string]any{"id": "9", "email": "not-an-address", "phone": "+12025550109"}}, "meta": map[string]any{"total": 3}})
			case "9":
				writeJSON(t, w, map[string]any{"contacts": []any{}, "meta": map[string]any{"total": 3}})
			default:
				t.Fatalf("id_greater = %q", r.URL.Query().Get("id_greater"))
			}
		case "/api/3/contacts/5", "/api/3/contacts/9":
			id := strings.TrimPrefix(r.URL.Path, "/api/3/contacts/")
			detailIDs = append(detailIDs, id)
			writeJSON(t, w, map[string]any{
				"contact":      map[string]any{"id": id, "email": map[string]string{"5": "", "9": "not-an-address"}[id], "phone": "+1202555010" + id, "udate": "2026-06-04T12:30:00Z", "custom_unknown": "preserved"},
				"contactLists": []any{map[string]any{"id": "membership-" + id, "list": "4", "status": "1", "sdate": "2025-01-02 03:04:05"}},
				"contactTags":  []any{map[string]any{"id": "tag-link-" + id, "tag": "8"}},
				"fieldValues":  []any{map[string]any{"id": "field-" + id, "field": "12", "value": "gold"}},
				"deals":        []any{map[string]any{"id": "deal-" + id, "title": "Phone lead"}},
				"activities":   []any{map[string]any{"id": "activity-" + id, "type": "sms"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
	items, next, err := ad.ListSourceArchive(context.Background(), sess, nonEmailContactResource+":0")
	if err != nil || len(items) != 1 || items[0].SourceID != "5" || next != nonEmailContactResource+":5" {
		t.Fatalf("first non-email page = %#v next=%q err=%v", items, next, err)
	}
	if sourceMapString(interfaceMap(items[0].Payload["contact"]), "custom_unknown") != "preserved" {
		t.Fatalf("contact raw fields not preserved: %#v", items[0].Payload)
	}
	if items[0].OccurredAt == nil || items[0].OccurredAt.UTC().Format("2006-01-02T15:04:05Z") != "2026-06-04T12:30:00Z" {
		t.Fatalf("non-email occurred_at = %v", items[0].OccurredAt)
	}
	for _, key := range []string{"contactLists", "contactTags", "fieldValues", "deals", "activities"} {
		if rows, ok := items[0].Payload[key].([]map[string]interface{}); !ok || len(rows) != 1 {
			t.Fatalf("%s = %T %#v, want one preserved relationship", key, items[0].Payload[key], items[0].Payload[key])
		}
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 1 || items[0].SourceID != "9" || next != nonEmailContactResource+":9" {
		t.Fatalf("second non-email page = %#v next=%q err=%v", items, next, err)
	}
	items, next, err = ad.ListSourceArchive(context.Background(), sess, next)
	if err != nil || len(items) != 0 || next != "" {
		t.Fatalf("non-email terminal = %#v next=%q err=%v", items, next, err)
	}
	if strings.Join(detailIDs, ",") != "5,9" {
		t.Fatalf("hydrated contact IDs = %v, want only non-email contacts", detailIDs)
	}
}

func TestSourceArchiveRejectsCrossResourceIdentityMismatches(t *testing.T) {
	t.Run("obsolete ecommerce product continuation", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/3/ecomOrders" || r.URL.Query().Get("offset") != "4" || r.URL.Query().Get("limit") != "1" {
				t.Fatalf("unexpected parent revalidation request %s?%s", r.URL.Path, r.URL.RawQuery)
			}
			writeJSON(t, w, map[string]any{"ecomOrders": []any{map[string]any{"id": "order-5"}}, "meta": map[string]any{"total": 5}})
		}))
		defer srv.Close()
		ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
		items, next, err := ad.ListSourceArchive(
			context.Background(),
			sess,
			encodeNestedArchiveCursor("ecommerce_order_products", 4, "order-5", 100),
		)
		assertSourceArchiveWarning(t, items, next, err, "ecommerce_order_products", ecommerceProductSelector+":5", "unsupported product continuation offset 100")
	})

	t.Run("custom object record schema", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/customObjects/schemas":
				writeJSON(t, w, map[string]any{"schemas": []any{map[string]any{"id": "expected"}}, "meta": map[string]any{"total": 1}})
			case "/api/3/customObjects/records/expected":
				writeJSON(t, w, map[string]any{"records": []any{map[string]any{"id": "record", "schemaId": "wrong"}}, "meta": map[string]any{"total": 1}})
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
		}))
		defer srv.Close()
		ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
		items, next, err := ad.ListSourceArchive(context.Background(), sess, customObjectRecordSelector+":0")
		assertSourceArchiveWarning(t, items, next, err, "custom_object_records", customObjectRecordSelector+":1", "returned record for schema wrong")
	})

	t.Run("ecommerce product order", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/ecomOrders":
				writeJSON(t, w, map[string]any{"ecomOrders": []any{map[string]any{"id": "expected"}}, "meta": map[string]any{"total": 1}})
			case "/api/3/ecomOrders/expected/orderProducts":
				writeJSON(t, w, map[string]any{"ecomOrderProducts": []any{map[string]any{"id": "product", "orderid": "wrong"}}, "meta": map[string]any{"total": 1}})
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
		}))
		defer srv.Close()
		ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
		items, next, err := ad.ListSourceArchive(context.Background(), sess, ecommerceProductSelector+":0")
		assertSourceArchiveWarning(t, items, next, err, "ecommerce_order_products", ecommerceProductSelector+":1", "returned product for order wrong")
	})

	t.Run("SMS broadcast detail", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/sms/broadcasts":
				writeJSON(t, w, map[string]any{"broadcasts": []any{map[string]any{"id": 42, "status": "sent"}}, "meta": map[string]any{"total": 1}})
			case "/api/3/sms/broadcasts/42":
				writeJSON(t, w, map[string]any{"id": 43, "status": "sent"})
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
		}))
		defer srv.Close()
		ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
		items, next, err := ad.ListSourceArchive(context.Background(), sess, smsBroadcastSelector+":0")
		assertSourceArchiveWarning(t, items, next, err, "sms_broadcasts", smsBroadcastSelector+":1", "detail identity mismatch")
	})

	t.Run("non-email contact detail", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/3/contacts":
				writeJSON(t, w, map[string]any{"contacts": []any{map[string]any{"id": "5", "phone": "+12025550105"}}, "meta": map[string]any{"total": 1}})
			case "/api/3/contacts/5":
				writeJSON(t, w, map[string]any{"contact": map[string]any{"id": "6", "phone": "+12025550106"}})
			default:
				t.Fatalf("unexpected path %s", r.URL.Path)
			}
		}))
		defer srv.Close()
		ad, sess := activeCampaignArchiveTestAdapter(srv.URL)
		items, next, err := ad.ListSourceArchive(context.Background(), sess, nonEmailContactResource+":0")
		assertSourceArchiveWarning(t, items, next, err, nonEmailContactResource, "", "detail identity mismatch")
	})
}

func TestMergeInterfaceMapsAllocatesWhenOnlyPrimaryHasValues(t *testing.T) {
	got := mergeInterfaceMaps(map[string]interface{}{"detail_only": "preserved"}, nil)
	if sourceMapString(got, "detail_only") != "preserved" {
		t.Fatalf("merged map = %#v", got)
	}
}

func activeCampaignArchiveTestAdapter(serverURL string) (*Adapter, adapter.Session) {
	return New(), adapter.Session{AccessToken: "secret", Extra: map[string]string{"api_url": serverURL + "/api/3"}}
}

func assertSourceArchiveWarning(t *testing.T, items []canonical.SourceArchiveItem, next string, err error, resource, wantNext, contains string) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if next != wantNext {
		t.Fatalf("next = %q, want %q", next, wantNext)
	}
	if len(items) != 1 || items[0].SourceID != "source_archive_warning:"+resource || len(items[0].Warnings) != 1 {
		t.Fatalf("warning items = %#v", items)
	}
	if !strings.Contains(items[0].Warnings[0], contains) {
		t.Fatalf("warning = %q, want %q", items[0].Warnings[0], contains)
	}
}
