// SPDX-License-Identifier: AGPL-3.0-only

package listmonk

import (
	"context"
	"errors"
	"net/http"
	"strconv"
)

// List is the part of Listmonk's list object the gateway reads. Listmonk
// returns many more fields (uuid, type, optin, tags, counts); decoding only
// these keeps an unrelated change to the engine's payload from breaking the
// caller.
type List struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// GetList reads one list by its engine id: GET /api/lists/{id}.
//
// The id is Listmonk's, and Listmonk is shared by every tenant on this
// engine, so callers must already have proven the tenant owns it (through
// list_id_map) before asking. A missing list is an *HTTPError — Listmonk
// v6.1.0 answers 400 {"message":"List not found"}, not 404.
func (c *Client) GetList(ctx context.Context, id int64) (*List, error) {
	if id <= 0 {
		return nil, errors.New("listmonk: list id must be positive")
	}
	var out struct {
		Data List `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/lists/"+strconv.FormatInt(id, 10), nil, &out); err != nil {
		return nil, err
	}
	if out.Data.ID != id {
		return nil, errors.New("listmonk: list response did not describe the requested list")
	}
	return &out.Data, nil
}
