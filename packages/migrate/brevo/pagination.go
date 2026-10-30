package brevo

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

type pageCursor struct {
	Kind    string `json:"kind"`
	Account string `json:"account"`
	Offset  int    `json:"offset"`
	Total   int    `json:"total"`
	LastID  int64  `json:"last_id"`
}

func decodePageCursor(raw, kind, account string) (pageCursor, error) {
	c := pageCursor{Kind: kind, Account: account, Total: -1}
	if raw == "" {
		return c, nil
	}
	if len(raw) > 4096 {
		return c, fmt.Errorf("brevo: invalid pagination cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, fmt.Errorf("brevo: invalid pagination cursor; restart preview")
	}
	if err = json.Unmarshal(b, &c); err != nil || c.Kind != kind || c.Account != account || c.Offset <= 0 || c.Total <= c.Offset || c.Total > 10_000_000 || c.LastID <= 0 {
		return c, fmt.Errorf("brevo: invalid or mismatched pagination cursor")
	}
	return c, nil
}

func nextPage(c pageCursor, count *int, ids []int64, present bool, limit int) (string, error) {
	if count == nil || *count < 0 || *count > 10_000_000 || !present || len(ids) > limit || c.Offset+len(ids) > *count || (c.Total >= 0 && c.Total != *count) || (len(ids) == 0 && c.Offset < *count) {
		return "", fmt.Errorf("brevo: %s pagination incomplete or changed; restart preview after pausing source edits", c.Kind)
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id <= 0 || seen[id] || id == c.LastID {
			return "", fmt.Errorf("brevo: repeated or invalid %s identity", c.Kind)
		}
		seen[id] = true
	}
	c.Offset += len(ids)
	c.Total = *count
	if c.Offset == c.Total {
		return "", nil
	}
	c.LastID = ids[len(ids)-1]
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b), nil
}
