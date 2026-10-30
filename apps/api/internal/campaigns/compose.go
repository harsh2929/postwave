package campaigns

// compose.go — Workstream 2 (D): dynamic content regions.
//
// Mailchimp's "merge tag block" pattern lets an author wrap part of a
// body in `{{#if KEY}}A{{else}}B{{/if}}`; subscribers who match KEY
// see branch A, everyone else gets B. We parse the body into a tree
// of regions so the UI can:
//
//   1. list every conditional region with its KEY
//   2. let the operator toggle each branch (true / false / default)
//      and re-render the preview locally without round-tripping the
//      server
//   3. surface a "+ Region" button that inserts an empty
//      `{{#if}}…{{else}}…{{/if}}` skeleton
//
// No migration: regions are derived from the existing body_html on
// every GET. Cheap O(N) scan with a small stack — bodies don't nest
// deep in practice.

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Region is one conditional block found in a campaign body.
//
// Branches are stored as raw HTML strings so the UI can paste them
// directly into the preview iframe. Range is the [start, end) byte
// slice inside the original body — handy when the editor wants to
// highlight or replace a region in-place. Nested regions are
// surfaced as Children of the parent region.
type Region struct {
	Key         string   `json:"key"`
	Start       int      `json:"start"`
	End         int      `json:"end"`
	TrueBranch  string   `json:"true_branch"`
	FalseBranch string   `json:"false_branch"`
	HasElse     bool     `json:"has_else"`
	Children    []Region `json:"children,omitempty"`
}

// RegionsResponse is returned by GET /api/v1/campaigns/{id}/regions.
type RegionsResponse struct {
	CampaignID string   `json:"campaign_id"`
	Source     string   `json:"source"` // "body_html" or "plain_text"
	Regions    []Region `json:"regions"`
}

// MountCompose wires the dynamic content endpoint.
func MountCompose(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/regions", d.GetRegions)
}

func (d *Deps) GetRegions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	c, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	source := "body_html"
	body := c.BodyHTML
	if strings.TrimSpace(body) == "" {
		body = c.PlainText
		source = "plain_text"
	}
	regions, perr := ParseRegions(body)
	if perr != nil {
		httperror.WriteInternal(w, d.Logger, perr, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, RegionsResponse{
		CampaignID: id,
		Source:     source,
		Regions:    regions,
	})
}

// frame is the in-progress region accumulator on the parse stack.
type frame struct {
	key        string
	body       strings.Builder
	regionFrom int
	hasElse    bool
	// elseAt is the byte length of body at the moment we hit
	// `{{else}}`. -1 until then. Used to slice body into the
	// true vs false branch on close.
	elseAt   int
	children []Region
}

// ParseRegions walks the body and returns the top-level
// `{{#if KEY}}…{{else}}…{{/if}}` blocks. Unmatched `{{/if}}` and
// `{{else}}` outside a region are dropped (the editor may be mid-
// keystroke), but a mismatched `{{#if}}` that never closes returns an
// error so the operator sees the problem before send.
//
// Algorithm: linear scan over the body, tracking a stack of "open
// region" frames. Each tag is a delimited slice — we accept whitespace
// inside the braces (`{{ #if foo }}` is equivalent to `{{#if foo}}`)
// and treat the key as anything non-whitespace inside the open tag.
func ParseRegions(body string) ([]Region, error) {
	var top []Region
	var stack []*frame

	// emit writes a literal chunk to the innermost branch on the
	// stack, or to nothing when the stack is empty (top-level
	// literals don't need to be retained — the region tree only
	// cares about conditional blocks).
	emit := func(chunk string) {
		if len(stack) == 0 || chunk == "" {
			return
		}
		stack[len(stack)-1].body.WriteString(chunk)
	}

	i := 0
	for i < len(body) {
		open := strings.Index(body[i:], "{{")
		if open < 0 {
			emit(body[i:])
			break
		}
		open += i
		if open > i {
			emit(body[i:open])
		}
		closeIdx := strings.Index(body[open:], "}}")
		if closeIdx < 0 {
			// Unterminated tag — flush as literal so the tree stays
			// consistent and bail out of the scan.
			emit(body[open:])
			break
		}
		closeIdx += open
		inner := strings.TrimSpace(body[open+2 : closeIdx])
		tagEnd := closeIdx + 2

		switch {
		case strings.HasPrefix(inner, "#if"):
			key := strings.TrimSpace(strings.TrimPrefix(inner, "#if"))
			if key == "" {
				return nil, fmt.Errorf("dynamic region missing key at byte %d", open)
			}
			stack = append(stack, &frame{
				key:        key,
				regionFrom: open,
				elseAt:     -1,
			})
		case inner == "else":
			if len(stack) == 0 {
				// Stray {{else}} — drop silently.
				break
			}
			cur := stack[len(stack)-1]
			cur.hasElse = true
			cur.elseAt = cur.body.Len()
		case inner == "/if":
			if len(stack) == 0 {
				// Stray close — drop silently.
				break
			}
			f := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			full := f.body.String()
			region := Region{
				Key:      f.key,
				Start:    f.regionFrom,
				End:      tagEnd,
				HasElse:  f.hasElse,
				Children: f.children,
			}
			if f.hasElse && f.elseAt >= 0 && f.elseAt <= len(full) {
				region.TrueBranch = full[:f.elseAt]
				region.FalseBranch = full[f.elseAt:]
			} else {
				region.TrueBranch = full
			}
			if len(stack) == 0 {
				top = append(top, region)
			} else {
				parent := stack[len(stack)-1]
				parent.children = append(parent.children, region)
				// Embed the closed region's raw source into the
				// parent's branch text so a downstream renderer
				// that wants the original markup can still get it.
				parent.body.WriteString(body[f.regionFrom:tagEnd])
			}
		default:
			// Plain merge tag like `{{ first_name }}` — preserve as
			// literal inside the current branch.
			emit(body[open:tagEnd])
		}

		i = tagEnd
	}
	if len(stack) > 0 {
		return nil, fmt.Errorf("dynamic region {{#if %s}} is not closed", stack[len(stack)-1].key)
	}
	if top == nil {
		top = []Region{}
	}
	return top, nil
}
