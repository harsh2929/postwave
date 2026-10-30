// SPDX-License-Identifier: AGPL-3.0-only
package zerocopy_triggers

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
)

const (
	hardMaxRowsPerPoll         = 1000
	hardMaxSerializedPollBytes = 8 << 20 // 8 MiB
	hardMaxSerializedRowBytes  = 1 << 20 // 1 MiB
	hardMaxQueryBytes          = 64 << 10
	hardMaxProviderErrorBytes  = 4 << 10
	defaultWarehouseQueryTTL   = 30 * time.Second
)

var forbiddenReadOnlySQLTokens = map[string]struct{}{
	"ALTER": {}, "ANALYZE": {}, "BEGIN": {}, "CALL": {}, "COMMIT": {},
	"COPY": {}, "CREATE": {}, "DELETE": {}, "DROP": {}, "EXEC": {},
	"EXECUTE": {}, "GET": {}, "GRANT": {}, "INSERT": {}, "INTO": {},
	"LIST": {}, "LOAD": {}, "LOCK": {}, "MERGE": {}, "PUT": {},
	"REMOVE": {}, "RESET": {}, "REVOKE": {}, "ROLLBACK": {}, "SET": {},
	"SHARE": {}, "SHOW": {}, "TRUNCATE": {}, "UNLOAD": {}, "UPDATE": {},
	"USE": {}, "VACUUM": {},
}

// validateReadOnlyQuery accepts one conservative SQL statement: SELECT, or a
// WITH/CTE whose executable statement is SELECT. Comments and multiple
// statements are rejected so keywords cannot be hidden from this portable
// scanner. The database's read-only transaction and SELECT-only credential are
// independent enforcement layers for functions/UDFs the scanner cannot model.
func validateReadOnlyQuery(query string) error {
	query = strings.TrimSpace(query)
	if query == "" {
		return fmt.Errorf("query is required")
	}
	if len(query) > hardMaxQueryBytes {
		return fmt.Errorf("query exceeds %d bytes", hardMaxQueryBytes)
	}
	if strings.HasSuffix(query, ";") {
		query = strings.TrimSpace(strings.TrimSuffix(query, ";"))
	}
	tokens, err := readOnlySQLTokens(query)
	if err != nil {
		return err
	}
	if len(tokens) == 0 || (tokens[0] != "SELECT" && tokens[0] != "WITH") {
		return fmt.Errorf("query must be a SELECT or WITH/CTE statement")
	}
	seenSelect := false
	for _, token := range tokens {
		if token == "SELECT" {
			seenSelect = true
		}
		if _, forbidden := forbiddenReadOnlySQLTokens[token]; forbidden {
			return fmt.Errorf("query contains unsupported non-read-only token %s", token)
		}
	}
	if !seenSelect {
		return fmt.Errorf("WITH query must terminate in SELECT")
	}
	return nil
}

func readOnlySQLTokens(query string) ([]string, error) {
	tokens := make([]string, 0, 16)
	for i := 0; i < len(query); {
		ch := query[i]
		switch {
		case unicode.IsSpace(rune(ch)):
			i++
		case ch == ';':
			return nil, fmt.Errorf("query must contain exactly one statement")
		case ch == '-' && i+1 < len(query) && query[i+1] == '-':
			return nil, fmt.Errorf("SQL comments are not supported in zero-copy queries")
		case ch == '/' && i+1 < len(query) && query[i+1] == '*':
			return nil, fmt.Errorf("SQL comments are not supported in zero-copy queries")
		case ch == '\'' || ch == '"' || ch == '`':
			quote := ch
			i++
			closed := false
			for i < len(query) {
				if query[i] != quote {
					i++
					continue
				}
				if i+1 < len(query) && query[i+1] == quote {
					i += 2
					continue
				}
				i++
				closed = true
				break
			}
			if !closed {
				return nil, fmt.Errorf("query contains an unterminated quoted value")
			}
		case ch == '$' && i+1 < len(query) && (query[i+1] == '$' || unicode.IsLetter(rune(query[i+1])) || query[i+1] == '_'):
			return nil, fmt.Errorf("dollar-quoted SQL is not supported in zero-copy queries")
		case unicode.IsLetter(rune(ch)) || ch == '_':
			start := i
			i++
			for i < len(query) && (unicode.IsLetter(rune(query[i])) || unicode.IsDigit(rune(query[i])) || query[i] == '_') {
				i++
			}
			tokens = append(tokens, strings.ToUpper(query[start:i]))
		default:
			i++
		}
	}
	return tokens, nil
}

func requireReadOnlyCredential(secret map[string]any) error {
	value, ok := secret["read_only"]
	if !ok {
		return fmt.Errorf("zerocopy credentials: read_only=true attestation is required")
	}
	switch v := value.(type) {
	case bool:
		if v {
			return nil
		}
	case string:
		if strings.EqualFold(strings.TrimSpace(v), "true") {
			return nil
		}
	}
	return fmt.Errorf("zerocopy credentials: read_only must be true")
}

func effectivePollLimit(requested int) int {
	if requested <= 0 || requested > hardMaxRowsPerPoll {
		return hardMaxRowsPerPoll
	}
	return requested
}

func addSerializedPayloadBytes(payload map[string]any, total int) (int, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return total, fmt.Errorf("serialize warehouse row: %w", err)
	}
	if len(raw) > hardMaxSerializedRowBytes {
		return total, fmt.Errorf("warehouse row exceeds %d serialized bytes", hardMaxSerializedRowBytes)
	}
	total += len(raw)
	if total > hardMaxSerializedPollBytes {
		return total, fmt.Errorf("warehouse poll exceeds %d serialized bytes", hardMaxSerializedPollBytes)
	}
	return total, nil
}

func boundedProviderError(raw []byte) string {
	if len(raw) > hardMaxProviderErrorBytes {
		raw = raw[:hardMaxProviderErrorBytes]
	}
	return strings.TrimSpace(string(raw))
}
