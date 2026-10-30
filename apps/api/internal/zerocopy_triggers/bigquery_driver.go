// SPDX-License-Identifier: AGPL-3.0-only
//
// bigquery_driver.go — a real BigQuery warehouse Driver over the REST
// jobs.query API. BigQuery is not database/sql, so it gets its own driver
// rather than the SQLDriver. The OAuth access token is supplied by the
// CredentialResolver (the resolved secret carries an "access_token"); minting
// it from a service account is a deployment concern, which keeps this driver a
// dependency-free net/http client that is fully unit-testable.

package zerocopy_triggers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// bigQueryCursorParam is the named query parameter the cursor binds to. The
// operator query references it as @last_seen_cursor (BigQuery named-param form);
// we also accept the SQLDriver's :last_seen_cursor token and rewrite it.
const bigQueryCursorParam = "@last_seen_cursor"

const hardMaxBigQueryBytesBilled int64 = 1 << 30 // 1 GiB per poll

// BigQueryDriver polls BigQuery via the REST jobs.query endpoint.
type BigQueryDriver struct {
	Lookup   ConnectionLookup
	Resolver CredentialResolver
	// BaseURL defaults to https://bigquery.googleapis.com; overridable for tests.
	BaseURL string
	// HTTPClient is optional; nil falls back to a 30s-timeout client.
	HTTPClient *http.Client
}

func (d *BigQueryDriver) httpClient() *http.Client {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (d *BigQueryDriver) baseURL() string {
	if strings.TrimSpace(d.BaseURL) != "" {
		return strings.TrimRight(d.BaseURL, "/")
	}
	return "https://bigquery.googleapis.com"
}

// bqQueryRequest / bqQueryResponse model the subset of the jobs.query
// request+response we use. See cloud.google.com/bigquery/docs/reference/rest.
type bqQueryRequest struct {
	Query              string    `json:"query"`
	UseLegacySQL       bool      `json:"useLegacySql"`
	MaxResults         int       `json:"maxResults,omitempty"`
	ParameterMode      string    `json:"parameterMode,omitempty"`
	QueryParameters    []bqParam `json:"queryParameters,omitempty"`
	TimeoutMs          int64     `json:"timeoutMs,omitempty"`
	JobTimeoutMs       string    `json:"jobTimeoutMs,omitempty"`
	MaximumBytesBilled string    `json:"maximumBytesBilled,omitempty"`
}

type bqParam struct {
	Name           string       `json:"name"`
	ParameterType  bqParamType  `json:"parameterType"`
	ParameterValue bqParamValue `json:"parameterValue"`
}

type bqParamType struct {
	Type string `json:"type"`
}

type bqParamValue struct {
	Value string `json:"value"`
}

type bqQueryResponse struct {
	JobComplete bool `json:"jobComplete"`
	Schema      struct {
		Fields []struct {
			Name string `json:"name"`
		} `json:"fields"`
	} `json:"schema"`
	Rows []struct {
		F []struct {
			V json.RawMessage `json:"v"`
		} `json:"f"`
	} `json:"rows"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

// Poll implements Driver against BigQuery.
func (d *BigQueryDriver) Poll(ctx context.Context, t Trigger, max int) ([]DriverRow, error) {
	if d.Lookup == nil || d.Resolver == nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: not configured (nil lookup/resolver)")
	}
	if strings.TrimSpace(t.TenantID) == "" || strings.TrimSpace(t.ConnectionID) == "" {
		return nil, fmt.Errorf("zerocopy bigquery driver: tenant_id and connection_id are required")
	}
	if err := validateReadOnlyQuery(t.Query); err != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: query policy: %w", err)
	}
	conn, connectionErr := d.Lookup.LookupConnection(ctx, t.TenantID, t.ConnectionID)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: lookup connection: %w", connectionErr)
	}
	if !strings.EqualFold(strings.TrimSpace(conn.Provider), "bigquery") || !strings.EqualFold(strings.TrimSpace(t.Provider), "bigquery") {
		return nil, fmt.Errorf("zerocopy bigquery driver: trigger and connection providers must both be bigquery")
	}
	if !strings.EqualFold(strings.TrimSpace(conn.Status), "active") {
		return nil, fmt.Errorf("zerocopy bigquery driver: warehouse connection must be active")
	}
	if direction := strings.ToLower(strings.TrimSpace(conn.Direction)); direction != "import" && direction != "bidirectional" {
		return nil, fmt.Errorf("zerocopy bigquery driver: warehouse connection direction must be import or bidirectional")
	}
	secret, connectionErr := d.Resolver.Resolve(ctx, t.TenantID, conn.CredentialsRef)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: resolve credentials: %w", connectionErr)
	}
	if err := requireReadOnlyCredential(secret); err != nil {
		return nil, err
	}
	token := mapString(secret, "access_token")
	project := firstNonEmpty(mapString(conn.Config, "project"), mapString(conn.Config, "project_id"))
	if token == "" || project == "" {
		return nil, fmt.Errorf("zerocopy bigquery driver: missing access_token or project")
	}

	// Rewrite the SQLDriver-style :last_seen_cursor token to BigQuery's named
	// @last_seen_cursor form, and bind the cursor as a STRING query parameter.
	query := strings.ReplaceAll(t.Query, cursorPlaceholder, bigQueryCursorParam)
	limit := effectivePollLimit(max)
	reqBody := bqQueryRequest{
		Query: query, UseLegacySQL: false, MaxResults: limit,
		TimeoutMs:          defaultWarehouseQueryTTL.Milliseconds(),
		JobTimeoutMs:       strconv.FormatInt(defaultWarehouseQueryTTL.Milliseconds(), 10),
		MaximumBytesBilled: strconv.FormatInt(hardMaxBigQueryBytesBilled, 10),
	}
	if strings.Contains(query, bigQueryCursorParam) {
		reqBody.ParameterMode = "NAMED"
		reqBody.QueryParameters = []bqParam{{
			Name:           "last_seen_cursor",
			ParameterType:  bqParamType{Type: "STRING"},
			ParameterValue: bqParamValue{Value: t.LastSeenCursor},
		}}
	}

	body, connectionErr := json.Marshal(reqBody)
	if connectionErr != nil {
		return nil, connectionErr
	}
	queryCtx, cancel := context.WithTimeout(ctx, defaultWarehouseQueryTTL)
	defer cancel()
	endpoint := fmt.Sprintf("%s/bigquery/v2/projects/%s/queries", d.baseURL(), url.PathEscape(project))
	req, connectionErr := http.NewRequestWithContext(queryCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if connectionErr != nil {
		return nil, connectionErr
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, connectionErr := d.httpClient().Do(req)
	if connectionErr != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: request: %w", connectionErr)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, hardMaxSerializedPollBytes+1))
	if readErr != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: read response: %w", readErr)
	}
	if len(raw) > hardMaxSerializedPollBytes {
		return nil, fmt.Errorf("zerocopy bigquery driver: response exceeds %d bytes", hardMaxSerializedPollBytes)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("zerocopy bigquery driver: status %d: %s", resp.StatusCode, boundedProviderError(raw))
	}
	var parsed bqQueryResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("zerocopy bigquery driver: decode: %w", err)
	}
	if len(parsed.Errors) > 0 {
		return nil, fmt.Errorf("zerocopy bigquery driver: query error: %s", boundedProviderError([]byte(parsed.Errors[0].Message)))
	}
	if !parsed.JobComplete {
		return nil, fmt.Errorf("zerocopy bigquery driver: query did not complete within the bounded job timeout")
	}

	cols := make([]string, len(parsed.Schema.Fields))
	for i, f := range parsed.Schema.Fields {
		cols[i] = f.Name
	}
	out := make([]DriverRow, 0, min(len(parsed.Rows), limit))
	serializedBytes := 0
	for _, r := range parsed.Rows {
		payload := make(map[string]any, len(cols))
		for i, cell := range r.F {
			if i >= len(cols) {
				break
			}
			payload[cols[i]] = decodeBQCell(cell.V)
		}
		serializedBytes, connectionErr = addSerializedPayloadBytes(payload, serializedBytes)
		if connectionErr != nil {
			return nil, fmt.Errorf("zerocopy bigquery driver: %w", connectionErr)
		}
		out = append(out, DriverRow{
			CursorValue: stringifyCell(payload[t.CursorColumn]),
			ProfileKey:  stringifyCell(payload[t.ProfileKeyColumn]),
			Payload:     payload,
		})
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

// decodeBQCell unwraps a BigQuery cell value. Scalars arrive as JSON strings
// (BigQuery serialises every scalar as a string); we surface the string and let
// numeric coercion happen downstream. A nested object/array is returned as-is.
func decodeBQCell(v json.RawMessage) any {
	s := strings.TrimSpace(string(v))
	if s == "" || s == "null" {
		return nil
	}
	if s[0] == '"' {
		var str string
		if err := json.Unmarshal(v, &str); err == nil {
			// Numeric-looking strings stay strings here; cursor/profile-key
			// stringification handles them uniformly.
			if _, err := strconv.ParseFloat(str, 64); err == nil {
				return str
			}
			return str
		}
	}
	var any2 any
	if err := json.Unmarshal(v, &any2); err == nil {
		return any2
	}
	return s
}
