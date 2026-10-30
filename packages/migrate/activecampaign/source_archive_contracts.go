// SPDX-License-Identifier: MIT

package activecampaign

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const (
	nonEmailContactResource    = "non_email_contacts"
	customObjectRecordSelector = "custom_object_record_schemas"
	ecommerceProductSelector   = "ecommerce_order_product_orders"
	smsBroadcastSelector       = "sms_broadcasts"
)

// listNonEmailContacts preserves contacts that cannot be represented in the
// destination's email-keyed subscriber model. The cursor value is the last
// numeric contact ID, matching ActiveCampaign's documented large-account
// pagination strategy.
func (a *Adapter) listNonEmailContacts(ctx context.Context, sess adapter.Session, lastContactID int) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	values.Set("limit", strconv.Itoa(pageSize))
	values.Set("orders[id]", "ASC")
	if lastContactID > 0 {
		values.Set("id_greater", strconv.Itoa(lastContactID))
	}
	contacts, total, err := listCollectionPage[acContact](a, ctx, sess, "/contacts?"+values.Encode(), "contacts")
	if err != nil {
		return sourceArchiveContractWarning(nonEmailContactResource, "activecampaign_non_email_contact", err, "")
	}
	nextID, err := validateAscendingActiveCampaignContactIDs(contacts, lastContactID)
	if err != nil {
		return sourceArchiveContractWarning(nonEmailContactResource, "activecampaign_non_email_contact", err, "")
	}
	out := make([]canonical.SourceArchiveItem, 0)
	for _, contact := range contacts {
		if activeCampaignEmailAddressable(contact.Email) {
			continue
		}
		detail, err := a.fetchContactDetail(ctx, sess, contact)
		if err != nil {
			return sourceArchiveContractWarning(nonEmailContactResource, "activecampaign_non_email_contact", err, "")
		}
		if detailID := strings.TrimSpace(detail.Contact.ID); detailID == "" || detailID != strings.TrimSpace(contact.ID) {
			return sourceArchiveContractWarning(nonEmailContactResource, "activecampaign_non_email_contact", fmt.Errorf("contact detail identity mismatch for %s", contact.ID), "")
		}
		// A collection row can race an address update. Preserve the hydrated
		// row here only when it is still outside the email-keyed model.
		if activeCampaignEmailAddressable(detail.Contact.Email) {
			continue
		}
		payload, err := activeCampaignContactDetailPayload(detail)
		if err != nil {
			return sourceArchiveContractWarning(nonEmailContactResource, "activecampaign_non_email_contact", err, "")
		}
		sourceID := strings.TrimSpace(contact.ID)
		if sourceID == "" {
			sourceID = stableSourceArchiveFallbackID("activecampaign_non_email_contact", payload)
		}
		item := mapGenericSourceArchive(payload, sourceID, "activecampaign_non_email_contact")
		item.OccurredAt = firstParsedTime(
			detail.Contact.UpdatedTimestamp,
			detail.Contact.UpdatedAt,
			detail.Contact.CreatedUTCTimestamp,
			detail.Contact.CreatedTimestamp,
			detail.Contact.CreatedAt,
		)
		out = append(out, item)
	}
	if len(contacts) == 0 {
		return out, "", nil
	}
	if activeCampaignContactsHaveNextPage(contacts, total, contactCursor{Mode: contactCursorModeID, Value: lastContactID}, pageSize) {
		return out, fmt.Sprintf("%s:%d", nonEmailContactResource, nextID), nil
	}
	return out, "", nil
}

func activeCampaignEmailAddressable(email string) bool {
	email = strings.TrimSpace(email)
	if email == "" {
		return false
	}
	separator := strings.LastIndexByte(email, '@')
	return separator > 0 && separator < len(email)-1
}

func activeCampaignContactDetailPayload(detail acContactDetail) (map[string]interface{}, error) {
	payload := map[string]interface{}{
		"contract": "non_email_contact_v3",
	}
	contact, err := marshalObjectMap(detail.Contact)
	if err != nil {
		return nil, fmt.Errorf("activecampaign: preserve non-email contact: %w", err)
	}
	for key, value := range detail.Contact.Extra {
		contact[key] = value
	}
	payload["contact"] = contact
	payload["contactLists"] = rawRelationshipRows(detail.ContactLists, func(row acContactList) map[string]interface{} { return row.Raw })
	payload["contactTags"] = rawRelationshipRows(detail.ContactTags, func(row acContactTag) map[string]interface{} { return row.Raw })
	payload["fieldValues"] = rawRelationshipRows(detail.FieldValues, func(row acFieldValue) map[string]interface{} { return row.Raw })
	payload["deals"] = rawRelationshipRows(detail.Deals, func(row acDeal) map[string]interface{} { return row.Raw })
	if len(detail.Activities) > 0 {
		payload["activities"] = detail.Activities
	}
	return payload, nil
}

func marshalObjectMap(value interface{}) (map[string]interface{}, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func rawRelationshipRows[T any](rows []T, raw func(T) map[string]interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		if preserved := raw(row); len(preserved) > 0 {
			out = append(out, cloneInterfaceMap(preserved))
			continue
		}
		mapped, err := marshalObjectMap(row)
		if err == nil {
			out = append(out, mapped)
		}
	}
	return out
}

func (a *Adapter) listCustomObjectRecordSchema(ctx context.Context, sess adapter.Session, schemaOffset int) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(schemaOffset))
	values.Set("showFields", "all")
	schemas, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, "/customObjects/schemas?"+values.Encode(), "schemas")
	if err != nil {
		return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", err, "ecommerce_connections:0")
	}
	if len(schemas) == 0 {
		if total > schemaOffset {
			return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema page %d was empty before provider total %d", schemaOffset, total), "ecommerce_connections:0")
		}
		return nil, "ecommerce_connections:0", nil
	}
	schemaID := stringFromAny(schemas[0]["id"])
	if schemaID == "" {
		return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema at offset %d has no id", schemaOffset), nextCustomObjectSchemaCursor(schemaOffset+1))
	}
	return a.listCustomObjectRecordPage(ctx, sess, schemaOffset, schemaID, 0)
}

func (a *Adapter) listCustomObjectRecordPage(ctx context.Context, sess adapter.Session, schemaOffset int, schemaID string, recordOffset int) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	values.Set("limit", strconv.Itoa(pageSize))
	values.Set("offset", strconv.Itoa(recordOffset))
	path := "/customObjects/records/" + url.PathEscape(schemaID) + "?" + values.Encode()
	records, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, path, "records")
	if err != nil {
		return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema %s: %w", schemaID, err), nextCustomObjectSchemaCursor(schemaOffset+1))
	}
	if len(records) == 0 && total > recordOffset {
		return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema %s record page %d was empty before provider total %d", schemaID, recordOffset, total), nextCustomObjectSchemaCursor(schemaOffset+1))
	}
	if err := validateActiveCampaignOffsetPage(len(records), total, recordOffset); err != nil {
		return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema %s: %w", schemaID, err), nextCustomObjectSchemaCursor(schemaOffset+1))
	}
	out := make([]canonical.SourceArchiveItem, 0, len(records))
	for _, record := range records {
		if recordSchemaID := strings.TrimSpace(stringFromAny(record["schemaId"])); recordSchemaID != "" && recordSchemaID != schemaID {
			return sourceArchiveContractWarning("custom_object_records", "activecampaign_custom_object_record", fmt.Errorf("schema %s returned record for schema %s", schemaID, recordSchemaID), nextCustomObjectSchemaCursor(schemaOffset+1))
		}
		payload := cloneInterfaceMap(record)
		payload["activecampaign_schema_id"] = schemaID
		sourceID := firstNonEmpty(stringFromAny(record["id"]), stringFromAny(record["externalId"]), stableSourceArchiveFallbackID("activecampaign_custom_object_record", payload))
		out = append(out, mapGenericSourceArchive(payload, schemaID+":"+sourceID, "activecampaign_custom_object_record"))
	}
	nextOffset := nextActiveCampaignPageOffset(len(records), total, recordOffset, pageSize)
	if nextOffset > 0 {
		return out, encodeNestedArchiveCursor("custom_object_records", schemaOffset, schemaID, nextOffset), nil
	}
	return out, nextCustomObjectSchemaCursor(schemaOffset + 1), nil
}

func nextCustomObjectSchemaCursor(offset int) string {
	return fmt.Sprintf("%s:%d", customObjectRecordSelector, offset)
}

func (a *Adapter) listEcommerceOrderProductOrder(ctx context.Context, sess adapter.Session, orderOffset int) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(orderOffset))
	orders, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, "/ecomOrders?"+values.Encode(), "ecomOrders")
	if err != nil {
		return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", err, smsBroadcastSelector+":0")
	}
	if len(orders) == 0 {
		if total > orderOffset {
			return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", fmt.Errorf("order page %d was empty before provider total %d", orderOffset, total), smsBroadcastSelector+":0")
		}
		return nil, smsBroadcastSelector + ":0", nil
	}
	orderID := stringFromAny(orders[0]["id"])
	if orderID == "" {
		return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", fmt.Errorf("order at offset %d has no id", orderOffset), nextEcommerceOrderCursor(orderOffset+1))
	}
	return a.listEcommerceOrderProductPage(ctx, sess, orderOffset, orderID, 0)
}

func (a *Adapter) listEcommerceOrderProductPage(ctx context.Context, sess adapter.Session, orderOffset int, orderID string, productOffset int) ([]canonical.SourceArchiveItem, string, error) {
	// ActiveCampaign's documented order-products operation has no pagination
	// parameters or metadata contract. Fetch it exactly once per parent order.
	// A non-zero child offset can only come from an obsolete/tampered cursor;
	// surface the resulting completeness gap and advance instead of replaying.
	if productOffset != 0 {
		return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", fmt.Errorf("order %s has unsupported product continuation offset %d", orderID, productOffset), nextEcommerceOrderCursor(orderOffset+1))
	}
	path := "/ecomOrders/" + url.PathEscape(orderID) + "/orderProducts"
	products, _, err := listCollectionPage[map[string]interface{}](a, ctx, sess, path, "ecomOrderProducts")
	if err != nil {
		return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", fmt.Errorf("order %s: %w", orderID, err), nextEcommerceOrderCursor(orderOffset+1))
	}
	out := make([]canonical.SourceArchiveItem, 0, len(products))
	for _, product := range products {
		if productOrderID := strings.TrimSpace(stringFromAny(product["orderid"])); productOrderID != "" && productOrderID != orderID {
			return sourceArchiveContractWarning("ecommerce_order_products", "activecampaign_ecommerce_order_product", fmt.Errorf("order %s returned product for order %s", orderID, productOrderID), nextEcommerceOrderCursor(orderOffset+1))
		}
		payload := cloneInterfaceMap(product)
		payload["activecampaign_order_id"] = orderID
		sourceID := firstNonEmpty(stringFromAny(product["id"]), stringFromAny(product["externalid"]), stableSourceArchiveFallbackID("activecampaign_ecommerce_order_product", payload))
		out = append(out, mapGenericSourceArchive(payload, orderID+":"+sourceID, "activecampaign_ecommerce_order_product"))
	}
	return out, nextEcommerceOrderCursor(orderOffset + 1), nil
}

func nextEcommerceOrderCursor(offset int) string {
	return fmt.Sprintf("%s:%d", ecommerceProductSelector, offset)
}

func (a *Adapter) listSMSBroadcast(ctx context.Context, sess adapter.Session, broadcastOffset int) ([]canonical.SourceArchiveItem, string, error) {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(broadcastOffset))
	values.Set("filters[status]", "sent")
	broadcasts, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, "/sms/broadcasts?"+values.Encode(), "broadcasts")
	if err != nil {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", err, nonEmailContactResource+":0")
	}
	if len(broadcasts) == 0 {
		if total > broadcastOffset {
			return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", fmt.Errorf("broadcast page %d was empty before provider total %d", broadcastOffset, total), nonEmailContactResource+":0")
		}
		return nil, nonEmailContactResource + ":0", nil
	}
	broadcastID := stringFromAny(broadcasts[0]["id"])
	if broadcastID == "" {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", fmt.Errorf("broadcast at offset %d has no id", broadcastOffset), nextSMSBroadcastCursor(broadcastOffset+1))
	}
	if !strings.EqualFold(stringFromAny(broadcasts[0]["status"]), "sent") {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", fmt.Errorf("filtered broadcast %s was not sent", broadcastID), nextSMSBroadcastCursor(broadcastOffset+1))
	}

	detail, err := a.fetchSMSBroadcastDetail(ctx, sess, broadcastID)
	if err != nil {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", err, nextSMSBroadcastCursor(broadcastOffset+1))
	}
	if !strings.EqualFold(strings.TrimSpace(stringFromAny(detail["status"])), "sent") {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", fmt.Errorf("SMS broadcast %s detail was not sent", broadcastID), nextSMSBroadcastCursor(broadcastOffset+1))
	}
	metric, err := a.fetchSMSBroadcastMetric(ctx, sess, broadcastID)
	if err != nil {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", err, nextSMSBroadcastCursor(broadcastOffset+1))
	}
	failures, err := a.fetchSMSBroadcastFailures(ctx, sess, broadcastID)
	if err != nil {
		return sourceArchiveContractWarning("sms_broadcasts", "activecampaign_sms_broadcast", err, nextSMSBroadcastCursor(broadcastOffset+1))
	}
	payload := map[string]interface{}{
		"contract": "sms_broadcast_v3",
		"summary":  cloneInterfaceMap(broadcasts[0]),
		"detail":   detail,
		"metrics":  metric,
		"failures": failures,
	}
	broadcastItem := mapGenericSourceArchive(payload, broadcastID, "activecampaign_sms_broadcast")
	broadcastItem.OccurredAt = firstParsedTime(
		stringFromAny(detail["sent_date"]),
		stringFromAny(detail["updated_at"]),
		stringFromAny(detail["created_at"]),
		stringFromAny(broadcasts[0]["sent_date"]),
	)
	out := []canonical.SourceArchiveItem{broadcastItem}
	recipients, nextOffset, err := a.fetchSMSBroadcastRecipientPage(ctx, sess, broadcastID, 0)
	if err != nil {
		warning, next, _ := sourceArchiveContractWarning("sms_broadcast_recipients", "activecampaign_sms_broadcast_recipient", err, nextSMSBroadcastCursor(broadcastOffset+1))
		return append(out, warning...), next, nil
	}
	out = append(out, recipients...)
	if nextOffset > 0 {
		return out, encodeNestedArchiveCursor("sms_broadcast_recipients", broadcastOffset, broadcastID, nextOffset), nil
	}
	return out, nextSMSBroadcastCursor(broadcastOffset + 1), nil
}

func (a *Adapter) listSMSBroadcastRecipientContinuation(ctx context.Context, sess adapter.Session, broadcastOffset int, broadcastID string, recipientOffset int) ([]canonical.SourceArchiveItem, string, error) {
	recipients, nextOffset, err := a.fetchSMSBroadcastRecipientPage(ctx, sess, broadcastID, recipientOffset)
	if err != nil {
		return sourceArchiveContractWarning("sms_broadcast_recipients", "activecampaign_sms_broadcast_recipient", err, nextSMSBroadcastCursor(broadcastOffset+1))
	}
	if nextOffset > 0 {
		return recipients, encodeNestedArchiveCursor("sms_broadcast_recipients", broadcastOffset, broadcastID, nextOffset), nil
	}
	return recipients, nextSMSBroadcastCursor(broadcastOffset + 1), nil
}

func nextSMSBroadcastCursor(offset int) string {
	return fmt.Sprintf("%s:%d", smsBroadcastSelector, offset)
}

func (a *Adapter) revalidateCustomObjectSchemaParent(ctx context.Context, sess adapter.Session, offset int, expectedID string) error {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(offset))
	values.Set("showFields", "all")
	_, err := a.revalidateNestedArchiveParent(ctx, sess, "/customObjects/schemas?"+values.Encode(), "schemas", "custom object schema", offset, expectedID)
	return err
}

func (a *Adapter) revalidateEcommerceOrderParent(ctx context.Context, sess adapter.Session, offset int, expectedID string) error {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(offset))
	_, err := a.revalidateNestedArchiveParent(ctx, sess, "/ecomOrders?"+values.Encode(), "ecomOrders", "ecommerce order", offset, expectedID)
	return err
}

func (a *Adapter) revalidateSMSBroadcastParent(ctx context.Context, sess adapter.Session, offset int, expectedID string) error {
	values := url.Values{}
	values.Set("limit", "1")
	values.Set("offset", strconv.Itoa(offset))
	values.Set("filters[status]", "sent")
	parent, err := a.revalidateNestedArchiveParent(ctx, sess, "/sms/broadcasts?"+values.Encode(), "broadcasts", "sent SMS broadcast", offset, expectedID)
	if err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(stringFromAny(parent["status"])), "sent") {
		return fmt.Errorf("sent SMS broadcast %s at offset %d no longer has sent status", strings.TrimSpace(expectedID), offset)
	}
	return nil
}

func (a *Adapter) revalidateNestedArchiveParent(
	ctx context.Context,
	sess adapter.Session,
	path, responseKey, label string,
	offset int,
	expectedID string,
) (map[string]interface{}, error) {
	expectedID = strings.TrimSpace(expectedID)
	if expectedID == "" {
		return nil, fmt.Errorf("%s continuation at offset %d has no parent id", label, offset)
	}
	parents, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, path, responseKey)
	if err != nil {
		return nil, fmt.Errorf("revalidate %s %s at offset %d: %w", label, expectedID, offset, err)
	}
	if err := validateActiveCampaignOffsetPage(len(parents), total, offset); err != nil {
		return nil, fmt.Errorf("revalidate %s %s at offset %d: %w", label, expectedID, offset, err)
	}
	if len(parents) != 1 {
		return nil, fmt.Errorf("%s %s is no longer present at offset %d (provider total %d)", label, expectedID, offset, total)
	}
	actualID := strings.TrimSpace(stringFromAny(parents[0]["id"]))
	if actualID == "" {
		return nil, fmt.Errorf("%s at offset %d no longer has an id; expected %s", label, offset, expectedID)
	}
	if actualID != expectedID {
		return nil, fmt.Errorf("%s at offset %d changed from %s to %s", label, offset, expectedID, actualID)
	}
	return parents[0], nil
}

func (a *Adapter) fetchSMSBroadcastDetail(ctx context.Context, sess adapter.Session, broadcastID string) (map[string]interface{}, error) {
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodGet, "/sms/broadcasts/"+url.PathEscape(broadcastID), nil, &raw); err != nil {
		return nil, fmt.Errorf("activecampaign: retrieve SMS broadcast %s: %w", broadcastID, err)
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("activecampaign: SMS broadcast %s detail was empty", broadcastID)
	}
	if payload := firstRawMessage(raw, "broadcast", "message"); len(payload) > 0 {
		var detail map[string]interface{}
		if err := json.Unmarshal(payload, &detail); err != nil {
			return nil, fmt.Errorf("activecampaign: decode SMS broadcast %s detail: %w", broadcastID, err)
		}
		return validateSMSBroadcastDetailIdentity(detail, broadcastID)
	}
	return validateSMSBroadcastDetailIdentity(rawMessageMapToInterface(raw), broadcastID)
}

func validateSMSBroadcastDetailIdentity(detail map[string]interface{}, broadcastID string) (map[string]interface{}, error) {
	gotID := strings.TrimSpace(stringFromAny(detail["id"]))
	if gotID == "" || gotID != strings.TrimSpace(broadcastID) {
		return nil, fmt.Errorf("activecampaign: SMS broadcast detail identity mismatch for %s", broadcastID)
	}
	return detail, nil
}

func (a *Adapter) fetchSMSBroadcastMetric(ctx context.Context, sess adapter.Session, broadcastID string) (map[string]interface{}, error) {
	id, err := strconv.Atoi(strings.TrimSpace(broadcastID))
	if err != nil || id <= 0 {
		return nil, fmt.Errorf("activecampaign: SMS broadcast %s has non-numeric id", broadcastID)
	}
	body, err := json.Marshal(map[string]interface{}{"ids": []int{id}})
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := a.do(ctx, sess, http.MethodPost, "/sms/broadcasts/metrics", bytes.NewReader(body), &raw); err != nil {
		return nil, fmt.Errorf("activecampaign: retrieve SMS broadcast %s metrics: %w", broadcastID, err)
	}
	metrics, err := requiredJSONObjectArray(raw, "metrics")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: decode SMS broadcast %s metrics: %w", broadcastID, err)
	}
	for _, metric := range metrics {
		if stringFromAny(metric["id"]) == broadcastID {
			return metric, nil
		}
	}
	return nil, fmt.Errorf("activecampaign: SMS metrics omitted broadcast %s", broadcastID)
}

func (a *Adapter) fetchSMSBroadcastFailures(ctx context.Context, sess adapter.Session, broadcastID string) ([]map[string]interface{}, error) {
	var raw map[string]json.RawMessage
	path := "/sms/broadcasts/metrics/" + url.PathEscape(broadcastID) + "/failures"
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &raw); err != nil {
		return nil, fmt.Errorf("activecampaign: retrieve SMS broadcast %s failures: %w", broadcastID, err)
	}
	failures, err := requiredJSONObjectArray(raw, "failures")
	if err != nil {
		return nil, fmt.Errorf("activecampaign: decode SMS broadcast %s failures: %w", broadcastID, err)
	}
	return failures, nil
}

func (a *Adapter) fetchSMSBroadcastRecipientPage(ctx context.Context, sess adapter.Session, broadcastID string, offset int) ([]canonical.SourceArchiveItem, int, error) {
	values := url.Values{}
	values.Set("limit", strconv.Itoa(pageSize))
	values.Set("offset", strconv.Itoa(offset))
	path := "/sms/broadcasts/" + url.PathEscape(broadcastID) + "/recipients?" + values.Encode()
	recipients, total, err := listCollectionPage[map[string]interface{}](a, ctx, sess, path, "recipients")
	if err != nil {
		return nil, 0, fmt.Errorf("activecampaign: retrieve SMS broadcast %s recipients: %w", broadcastID, err)
	}
	if len(recipients) == 0 && total > offset {
		return nil, 0, fmt.Errorf("activecampaign: SMS broadcast %s recipient page %d was empty before provider total %d", broadcastID, offset, total)
	}
	if err := validateActiveCampaignOffsetPage(len(recipients), total, offset); err != nil {
		return nil, 0, fmt.Errorf("activecampaign: SMS broadcast %s recipient pagination: %w", broadcastID, err)
	}
	out := make([]canonical.SourceArchiveItem, 0, len(recipients))
	for _, recipient := range recipients {
		payload := cloneInterfaceMap(recipient)
		payload["activecampaign_broadcast_id"] = broadcastID
		recipientID := firstNonEmpty(stringFromAny(recipient["id"]), stableSourceArchiveFallbackID("activecampaign_sms_broadcast_recipient", payload))
		out = append(out, mapGenericSourceArchive(payload, broadcastID+":"+recipientID, "activecampaign_sms_broadcast_recipient"))
	}
	return out, nextActiveCampaignPageOffset(len(recipients), total, offset, pageSize), nil
}

func sourceArchiveContractWarning(resource, resourceType string, err error, next string) ([]canonical.SourceArchiveItem, string, error) {
	return []canonical.SourceArchiveItem{activeCampaignSourceArchiveWarning(resource, resourceType, err)}, next, nil
}

func encodeNestedArchiveCursor(kind string, parentOffset int, parentID string, childOffset int) string {
	encodedID := base64.RawURLEncoding.EncodeToString([]byte(parentID))
	return fmt.Sprintf("%s~%d~%s:%d", kind, parentOffset, encodedID, childOffset)
}

func decodeNestedArchiveResource(resource, wantKind string) (parentOffset int, parentID string, ok bool) {
	parts := strings.Split(resource, "~")
	if len(parts) != 3 || parts[0] != wantKind {
		return 0, "", false
	}
	parentOffset, err := strconv.Atoi(parts[1])
	if err != nil || parentOffset < 0 {
		return 0, "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || strings.TrimSpace(string(decoded)) == "" {
		return 0, "", false
	}
	return parentOffset, string(decoded), true
}

func firstRawMessage(raw map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, key := range keys {
		if payload := raw[key]; len(payload) > 0 && !bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
			return payload
		}
	}
	return nil
}
