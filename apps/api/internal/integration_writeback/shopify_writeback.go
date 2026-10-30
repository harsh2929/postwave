// SPDX-License-Identifier: AGPL-3.0-only
//
// shopify_writeback.go — push tags + metafields onto a Shopify customer, found
// by email. GraphQL-first (REST customer writes are legacy as of 2024-10 and
// REST `tags` REPLACES the whole set): tagsAdd appends atomically, metafieldsSet
// upserts by ownerId+namespace+key. Auth: X-Shopify-Access-Token.
package integration_writeback

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	shopifyDefaultAPIVersion  = "2026-04"
	shopifyMetafieldNamespace = "postwave"
	writebackHTTPTimeout      = 20 * time.Second
)

// ShopifyWritebackAdapter writes customer tags + metafields via the Admin GraphQL API.
type ShopifyWritebackAdapter struct {
	HTTPClient *http.Client
}

func (a ShopifyWritebackAdapter) Provider() string { return ProviderShopify }

func (a ShopifyWritebackAdapter) client() *http.Client {
	// Policy-bound even when a client is injected — see egress.go.
	return egressClient(a.Provider(), a.HTTPClient)
}

// shopifyGraphQLEndpoint derives the Admin GraphQL URL from settings. An explicit
// api_base_url override (tests / staging) wins; otherwise it's composed from
// shop_domain + api_version.
func shopifyGraphQLEndpoint(settings map[string]any) (string, error) {
	if override := settingString(settings, "api_base_url"); override != "" {
		return strings.TrimRight(override, "/"), nil
	}
	shop := settingString(settings, "shop_domain")
	if shop == "" {
		return "", fmt.Errorf("shopify write-back requires shop_domain")
	}
	if !strings.Contains(shop, ".") {
		shop += ".myshopify.com"
	}
	version := settingString(settings, "api_version")
	if version == "" {
		version = shopifyDefaultAPIVersion
	}
	return fmt.Sprintf("https://%s/admin/api/%s/graphql.json", shop, version), nil
}

func (a ShopifyWritebackAdapter) WriteProfile(ctx context.Context, creds map[string]string, settings map[string]any, p ProfileWrite) (WriteResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"], creds["admin_api_access_token"])
	if token == "" {
		return WriteResult{}, fmt.Errorf("shopify write-back requires an access token")
	}
	endpoint, err := shopifyGraphQLEndpoint(settings)
	if err != nil {
		return WriteResult{}, err
	}
	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return WriteResult{}, fmt.Errorf("profile has no email")
	}

	gid, err := a.findCustomer(ctx, endpoint, token, email)
	if err != nil {
		return WriteResult{}, err
	}
	if gid == "" {
		// Not an error — the customer just doesn't exist on Shopify yet.
		return WriteResult{Matched: false}, nil
	}
	res := WriteResult{Matched: true}

	if len(p.Tags) > 0 {
		if err := a.tagsAdd(ctx, endpoint, token, gid, p.Tags); err != nil {
			return res, err
		}
		res.TagsWritten = len(p.Tags)
	}
	if len(p.Fields) > 0 {
		written, err := a.metafieldsSet(ctx, endpoint, token, gid, p.Fields)
		if err != nil {
			return res, err
		}
		res.FieldsWritten = written
	}
	return res, nil
}

// shopifyBatchSize bounds aliased operations per GraphQL request (Shopify's
// query-cost budget comfortably allows this many cheap lookups/tagsAdds).
const shopifyBatchSize = 25

// shopifyMetafieldsSetMax is Shopify's per-call cap on metafieldsSet inputs.
const shopifyMetafieldsSetMax = 25

// BatchWrite is the bulk path: per chunk it resolves all customers in ONE OR'd
// search query, sets every matched customer's metafields in batched
// metafieldsSet calls (≤25 inputs each), and adds tags via aliased tagsAdd
// mutations — turning ~3 requests per customer into ~3 requests per chunk.
// Matching is still by email and no customer is ever created (a miss is skipped).
func (a ShopifyWritebackAdapter) BatchWrite(ctx context.Context, creds map[string]string, settings map[string]any, profiles []ProfileWrite) (BatchResult, error) {
	token := firstNonEmpty(creds["token"], creds["access_token"], creds["admin_api_access_token"])
	if token == "" {
		return BatchResult{}, fmt.Errorf("shopify write-back requires an access token")
	}
	endpoint, err := shopifyGraphQLEndpoint(settings)
	if err != nil {
		return BatchResult{}, err
	}
	var agg BatchResult
	var firstErr error
	for start := 0; start < len(profiles); start += shopifyBatchSize {
		end := start + shopifyBatchSize
		if end > len(profiles) {
			end = len(profiles)
		}
		res, err := a.batchChunk(ctx, endpoint, token, profiles[start:end])
		agg.Matched += res.Matched
		agg.TagsWritten += res.TagsWritten
		agg.FieldsWritten += res.FieldsWritten
		agg.RowsFailed += res.RowsFailed
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return agg, firstErr
}

func (a ShopifyWritebackAdapter) batchChunk(ctx context.Context, endpoint, token string, chunk []ProfileWrite) (BatchResult, error) {
	byEmail := make(map[string]ProfileWrite, len(chunk))
	emails := make([]string, 0, len(chunk))
	for _, p := range chunk {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if email == "" {
			continue
		}
		if existing, dup := byEmail[email]; dup {
			byEmail[email] = mergeProfileWrites(existing, p)
		} else {
			byEmail[email] = p
			emails = append(emails, email)
		}
	}
	if len(emails) == 0 {
		return BatchResult{}, nil
	}

	// 1) Resolve all customers in one OR'd search.
	gidByEmail, err := a.findCustomers(ctx, endpoint, token, emails)
	if err != nil {
		return BatchResult{RowsFailed: len(emails)}, err
	}
	out := BatchResult{Matched: len(gidByEmail)}

	// 2) Batched metafieldsSet across every matched customer's fields.
	metafields := make([]map[string]any, 0)
	for email, gid := range gidByEmail {
		for key, val := range byEmail[email].Fields {
			metafields = append(metafields, map[string]any{
				"ownerId":   gid,
				"namespace": shopifyMetafieldNamespace,
				"key":       key,
				"type":      "single_line_text_field",
				"value":     val,
			})
		}
	}
	for mfStart := 0; mfStart < len(metafields); mfStart += shopifyMetafieldsSetMax {
		mfEnd := mfStart + shopifyMetafieldsSetMax
		if mfEnd > len(metafields) {
			mfEnd = len(metafields)
		}
		written, err := a.metafieldsSetBatch(ctx, endpoint, token, metafields[mfStart:mfEnd])
		out.FieldsWritten += written
		if err != nil {
			out.RowsFailed = len(gidByEmail)
			return out, err
		}
	}

	// 3) Aliased tagsAdd for every matched customer that has tags.
	type tagTarget struct {
		gid  string
		tags []string
	}
	targets := make([]tagTarget, 0, len(gidByEmail))
	for email, gid := range gidByEmail {
		if t := byEmail[email].Tags; len(t) > 0 {
			targets = append(targets, tagTarget{gid: gid, tags: t})
		}
	}
	for tStart := 0; tStart < len(targets); tStart += shopifyBatchSize {
		tEnd := tStart + shopifyBatchSize
		if tEnd > len(targets) {
			tEnd = len(targets)
		}
		query := bytes.Buffer{}
		query.WriteString("mutation(")
		vars := map[string]any{}
		decls := make([]string, 0)
		body := bytes.Buffer{}
		for i, tt := range targets[tStart:tEnd] {
			idVar := fmt.Sprintf("id%d", i)
			tagsVar := fmt.Sprintf("tags%d", i)
			decls = append(decls, fmt.Sprintf("$%s:ID!,$%s:[String!]!", idVar, tagsVar))
			body.WriteString(fmt.Sprintf("a%d:tagsAdd(id:$%s,tags:$%s){userErrors{message}} ", i, idVar, tagsVar))
			vars[idVar] = tt.gid
			vars[tagsVar] = tt.tags
		}
		query.WriteString(strings.Join(decls, ","))
		query.WriteString("){")
		query.WriteString(body.String())
		query.WriteString("}")
		// Parse the aliased response so per-customer userErrors aren't swallowed
		// (the single-profile path checks them too).
		var aliasResp map[string]struct {
			UserErrors []shopifyUserError `json:"userErrors"`
		}
		if err := a.graphql(ctx, endpoint, token, query.String(), vars, &aliasResp); err != nil {
			out.RowsFailed = len(gidByEmail) // a failed tag write compromises the matched set
			return out, err
		}
		// Every alias we asked for must be present, with no userErrors.
		for i := range targets[tStart:tEnd] {
			v, ok := aliasResp[fmt.Sprintf("a%d", i)]
			if !ok {
				out.RowsFailed = len(gidByEmail)
				return out, fmt.Errorf("shopify tagsAdd response missing alias a%d", i)
			}
			if uerr := shopifyUserErrors(v.UserErrors); uerr != nil {
				out.RowsFailed = len(gidByEmail)
				return out, uerr
			}
		}
		for _, tt := range targets[tStart:tEnd] {
			out.TagsWritten += len(tt.tags)
		}
	}
	return out, nil
}

// shopifyEscapeSearchValue escapes a value for inclusion inside a single-quoted
// Shopify search term (email:'...'), so an address containing a quote/backslash
// can't break out of the term and alter the search.
func shopifyEscapeSearchValue(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return strings.ReplaceAll(s, `'`, `\'`)
}

// findCustomers resolves many emails to GIDs in a single OR'd search query.
// Emails MUST be pre-lowercased/trimmed (batchChunk normalises them); the
// returned map is keyed by that normalised email.
func (a ShopifyWritebackAdapter) findCustomers(ctx context.Context, endpoint, token string, emails []string) (map[string]string, error) {
	terms := make([]string, 0, len(emails))
	for _, e := range emails {
		terms = append(terms, "email:'"+shopifyEscapeSearchValue(e)+"'")
	}
	const q = `query($q:String!){customers(first:250,query:$q){edges{node{id email}}}}`
	var out struct {
		Customers struct {
			Edges []struct {
				Node struct {
					ID    string `json:"id"`
					Email string `json:"email"`
				} `json:"node"`
			} `json:"edges"`
		} `json:"customers"`
	}
	if err := a.graphql(ctx, endpoint, token, q, map[string]any{"q": strings.Join(terms, " OR ")}, &out); err != nil {
		return nil, err
	}
	gidByEmail := make(map[string]string, len(out.Customers.Edges))
	want := make(map[string]bool, len(emails))
	for _, e := range emails {
		want[e] = true
	}
	for _, edge := range out.Customers.Edges {
		em := strings.ToLower(strings.TrimSpace(edge.Node.Email))
		if em != "" && edge.Node.ID != "" && want[em] {
			gidByEmail[em] = edge.Node.ID
		}
	}
	return gidByEmail, nil
}

func (a ShopifyWritebackAdapter) metafieldsSetBatch(ctx context.Context, endpoint, token string, inputs []map[string]any) (int, error) {
	const m = `mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{id}userErrors{field message}}}`
	var out struct {
		MetafieldsSet struct {
			Metafields []struct {
				ID string `json:"id"`
			} `json:"metafields"`
			UserErrors []shopifyUserError `json:"userErrors"`
		} `json:"metafieldsSet"`
	}
	if err := a.graphql(ctx, endpoint, token, m, map[string]any{"metafields": inputs}, &out); err != nil {
		return 0, err
	}
	if err := shopifyUserErrors(out.MetafieldsSet.UserErrors); err != nil {
		return 0, err
	}
	return len(out.MetafieldsSet.Metafields), nil
}

func (a ShopifyWritebackAdapter) findCustomer(ctx context.Context, endpoint, token, email string) (string, error) {
	const q = `query($q:String!){customers(first:1,query:$q){edges{node{id}}}}`
	var out struct {
		Customers struct {
			Edges []struct {
				Node struct {
					ID string `json:"id"`
				} `json:"node"`
			} `json:"edges"`
		} `json:"customers"`
	}
	// Shopify search: email:'foo@bar.com' (quoted to handle +/. in addresses;
	// escaped so a quote/backslash in the address can't alter the query).
	if err := a.graphql(ctx, endpoint, token, q, map[string]any{"q": "email:'" + shopifyEscapeSearchValue(email) + "'"}, &out); err != nil {
		return "", err
	}
	if len(out.Customers.Edges) == 0 {
		return "", nil
	}
	return out.Customers.Edges[0].Node.ID, nil
}

func (a ShopifyWritebackAdapter) tagsAdd(ctx context.Context, endpoint, token, gid string, tags []string) error {
	const m = `mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{field message}}}`
	var out struct {
		TagsAdd struct {
			UserErrors []shopifyUserError `json:"userErrors"`
		} `json:"tagsAdd"`
	}
	if err := a.graphql(ctx, endpoint, token, m, map[string]any{"id": gid, "tags": tags}, &out); err != nil {
		return err
	}
	return shopifyUserErrors(out.TagsAdd.UserErrors)
}

func (a ShopifyWritebackAdapter) metafieldsSet(ctx context.Context, endpoint, token, gid string, fields map[string]string) (int, error) {
	const m = `mutation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{id}userErrors{field message}}}`
	inputs := make([]map[string]any, 0, len(fields))
	for key, val := range fields {
		inputs = append(inputs, map[string]any{
			"ownerId":   gid,
			"namespace": shopifyMetafieldNamespace,
			"key":       key,
			"type":      "single_line_text_field",
			"value":     val,
		})
	}
	var out struct {
		MetafieldsSet struct {
			Metafields []struct {
				ID string `json:"id"`
			} `json:"metafields"`
			UserErrors []shopifyUserError `json:"userErrors"`
		} `json:"metafieldsSet"`
	}
	if err := a.graphql(ctx, endpoint, token, m, map[string]any{"metafields": inputs}, &out); err != nil {
		return 0, err
	}
	if err := shopifyUserErrors(out.MetafieldsSet.UserErrors); err != nil {
		return 0, err
	}
	return len(out.MetafieldsSet.Metafields), nil
}

type shopifyUserError struct {
	Field   []string `json:"field"`
	Message string   `json:"message"`
}

func shopifyUserErrors(errs []shopifyUserError) error {
	if len(errs) == 0 {
		return nil
	}
	msgs := make([]string, 0, len(errs))
	for _, e := range errs {
		msgs = append(msgs, e.Message)
	}
	return fmt.Errorf("shopify userErrors: %s", strings.Join(msgs, "; "))
}

// graphql POSTs a query and unmarshals data into out; top-level GraphQL errors
// (including THROTTLED) surface as a Go error.
func (a ShopifyWritebackAdapter) graphql(ctx context.Context, endpoint, token, query string, vars map[string]any, out any) error {
	payload, _ := json.Marshal(map[string]any{"query": query, "variables": vars})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("X-Shopify-Access-Token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client().Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("shopify rate limited (429); retry after %s", resp.Header.Get("Retry-After"))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("shopify graphql http %d: %s", resp.StatusCode, truncate(string(body), 300))
	}
	var env struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return fmt.Errorf("shopify graphql decode: %w", err)
	}
	if len(env.Errors) > 0 {
		return fmt.Errorf("shopify graphql error: %s", env.Errors[0].Message)
	}
	if out != nil && len(env.Data) > 0 {
		return json.Unmarshal(env.Data, out)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
