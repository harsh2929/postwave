package apidocs

import (
	"encoding/json"
	"slices"
	"testing"
)

type assetContractOperation struct {
	OperationID    string                     `json:"operationId"`
	RequiredScopes []string                   `json:"x-required-scopes"`
	RequiredRole   string                     `json:"x-required-role"`
	Description    string                     `json:"description"`
	Parameters     []map[string]any           `json:"parameters"`
	RequestBody    map[string]any             `json:"requestBody"`
	Responses      map[string]json.RawMessage `json:"responses"`
}

func assetContractDocument(t *testing.T) struct {
	Paths      map[string]map[string]json.RawMessage `json:"paths"`
	Components struct {
		Schemas map[string]map[string]any `json:"schemas"`
	} `json:"components"`
} {
	t.Helper()
	var document struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	return document
}

func TestAssetOpenAPICoversEveryMountedRouteAndScope(t *testing.T) {
	document := assetContractDocument(t)
	routes := []struct {
		method, path, scope, role, success string
	}{
		{method: "get", path: "/api/v1/assets", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "post", path: "/api/v1/assets", scope: "write:campaigns", role: "editor", success: "201"},
		{method: "get", path: "/api/v1/assets/{id}", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "patch", path: "/api/v1/assets/{id}", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "delete", path: "/api/v1/assets/{id}", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "get", path: "/api/v1/assets/{id}/usage", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "get", path: "/api/v1/assets/{id}/blob", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "post", path: "/api/v1/assets/bulk-delete", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "get", path: "/api/v1/assets/folders", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "post", path: "/api/v1/assets/folders", scope: "write:campaigns", role: "editor", success: "201"},
		{method: "patch", path: "/api/v1/assets/folders/{id}", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "delete", path: "/api/v1/assets/folders/{id}", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "get", path: "/api/v1/assets/tags", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "patch", path: "/api/v1/assets/{id}/folder", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "get", path: "/api/v1/assets/{id}/tags", scope: "read:campaigns", role: "viewer", success: "200"},
		{method: "post", path: "/api/v1/assets/{id}/tags", scope: "write:campaigns", role: "editor", success: "200"},
		{method: "delete", path: "/api/v1/assets/{id}/tags/{tag}", scope: "write:campaigns", role: "editor", success: "200"},
	}
	for _, route := range routes {
		route := route
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			t.Parallel()
			raw, ok := document.Paths[route.path][route.method]
			if !ok {
				t.Fatal("operation missing")
			}
			var operation assetContractOperation
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if operation.OperationID == "" {
				t.Fatal("operationId missing")
			}
			if !slices.Equal(operation.RequiredScopes, []string{route.scope}) {
				t.Fatalf("scopes = %v, want [%s]", operation.RequiredScopes, route.scope)
			}
			if operation.RequiredRole != route.role {
				t.Fatalf("role = %q, want %q", operation.RequiredRole, route.role)
			}
			if _, ok := operation.Responses[route.success]; !ok {
				t.Fatalf("success response %s missing", route.success)
			}
			for _, status := range []string{"401", "403"} {
				if _, ok := operation.Responses[status]; !ok {
					t.Fatalf("authorization response %s missing", status)
				}
			}
		})
	}
}

func TestAssetUploadAndDeleteContractsAreExact(t *testing.T) {
	document := assetContractDocument(t)
	var upload assetContractOperation
	if err := json.Unmarshal(document.Paths["/api/v1/assets"]["post"], &upload); err != nil {
		t.Fatalf("decode upload operation: %v", err)
	}
	content, ok := upload.RequestBody["content"].(map[string]any)
	if !ok {
		t.Fatalf("upload content missing: %#v", upload.RequestBody)
	}
	for _, mediaType := range []string{"application/json", "multipart/form-data"} {
		if _, ok := content[mediaType]; !ok {
			t.Fatalf("upload content type %s missing", mediaType)
		}
	}
	if _, ok := upload.Responses["200"]; ok {
		t.Fatal("upload still advertises the old 200 success status")
	}
	if _, ok := upload.Responses["201"]; !ok {
		t.Fatal("upload 201 response missing")
	}

	var deleteOperation assetContractOperation
	if err := json.Unmarshal(document.Paths["/api/v1/assets/{id}"]["delete"], &deleteOperation); err != nil {
		t.Fatalf("decode delete operation: %v", err)
	}
	if _, ok := deleteOperation.Responses["409"]; !ok {
		t.Fatal("referenced-asset 409 response missing")
	}
	conflict := document.Components.Schemas["AssetReferenceConflict"]
	if conflict["additionalProperties"] != false {
		t.Fatalf("reference conflict schema is permissive: %#v", conflict)
	}
}

func TestAssetSchemasCarryWireBounds(t *testing.T) {
	document := assetContractDocument(t)
	asset := document.Components.Schemas["Asset"]
	properties, ok := asset["properties"].(map[string]any)
	if !ok || asset["additionalProperties"] != false {
		t.Fatalf("Asset schema is not strict: %#v", asset)
	}
	for _, field := range []string{
		"id", "tenantId", "filename", "mime", "bytes", "width", "height", "url",
		"createdAt", "updatedAt", "version", "altText", "referencesCount", "lastUsedAt", "folderId",
	} {
		if _, ok := properties[field]; !ok {
			t.Fatalf("Asset.%s missing", field)
		}
	}
	if properties["bytes"].(map[string]any)["maximum"] != float64(10485760) {
		t.Fatalf("asset byte limit drifted: %#v", properties["bytes"])
	}
	if properties["width"].(map[string]any)["maximum"] != float64(16384) ||
		properties["height"].(map[string]any)["maximum"] != float64(16384) {
		t.Fatal("asset dimension limits drifted")
	}
	list := document.Components.Schemas["AssetListResponse"]
	listProperties, ok := list["properties"].(map[string]any)
	if !ok || list["additionalProperties"] != false {
		t.Fatalf("AssetListResponse schema is not strict: %#v", list)
	}
	required, ok := list["required"].([]any)
	if !ok || !slices.Contains(required, "nextCursor") {
		t.Fatalf("AssetListResponse does not require nextCursor: %#v", list)
	}
	nextCursor, ok := listProperties["nextCursor"].(map[string]any)
	if !ok || nextCursor["format"] != "uuid" {
		t.Fatalf("AssetListResponse.nextCursor is not a UUID-or-null cursor: %#v", nextCursor)
	}

	bulk := document.Components.Schemas["AssetBulkDeleteInput"]
	bulkProperties := bulk["properties"].(map[string]any)
	items := bulkProperties["items"].(map[string]any)
	if items["maxItems"] != float64(1000) || items["uniqueItems"] != true {
		t.Fatalf("bulk item bounds drifted: %#v", items)
	}
	item := items["items"].(map[string]any)
	itemRequired, ok := item["required"].([]any)
	if !ok || !slices.Contains(itemRequired, "id") || !slices.Contains(itemRequired, "expected_version") {
		t.Fatalf("bulk items are not version-bound: %#v", item)
	}
	bulkResponse := document.Components.Schemas["AssetBulkDeleteResponse"]
	bulkResponseProperties := bulkResponse["properties"].(map[string]any)
	if _, ok := bulkResponseProperties["receipts"].(map[string]any); !ok {
		t.Fatalf("bulk response lacks versioned receipts: %#v", bulkResponse)
	}
	tags := document.Components.Schemas["AssetTagWriteInput"]
	if _, ok := tags["oneOf"].([]any); !ok {
		t.Fatalf("mutually-exclusive tag input missing: %#v", tags)
	}
}
