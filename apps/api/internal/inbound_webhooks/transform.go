// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/itchyny/gojq"
)

const inboundTransformMaxOutputBytes = 5 << 20
const inboundTransformExecutionLimit = 250 * time.Millisecond

func ValidateTransformJQ(expr string) error {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil
	}
	if strings.Contains(expr, "import ") || strings.Contains(expr, "include ") {
		return errors.New("transform_jq: import/include are not allowed")
	}
	_, err := gojq.Parse(expr)
	if err != nil {
		return fmt.Errorf("transform_jq: %w", err)
	}
	return nil
}

func ApplyTransformJQ(expr string, body []byte) ([]byte, error) {
	return ApplyTransformJQContext(context.Background(), expr, body)
}

// ApplyTransformJQContext executes tenant-authored jq under a hard wall-clock
// budget and the caller's cancellation signal. gojq is otherwise capable of
// evaluating recursive/non-terminating expressions indefinitely, which would
// let one signed public ingest pin an API worker forever.
func ApplyTransformJQContext(
	parent context.Context,
	expr string,
	body []byte,
) ([]byte, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return body, nil
	}
	query, err := gojq.Parse(expr)
	if err != nil {
		return nil, fmt.Errorf("parse jq: %w", err)
	}
	code, err := gojq.Compile(query)
	if err != nil {
		return nil, fmt.Errorf("compile jq: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var input any
	if err := dec.Decode(&input); err != nil {
		return nil, fmt.Errorf("decode json: %w", err)
	}
	ctx, cancel := context.WithTimeout(parent, inboundTransformExecutionLimit)
	defer cancel()
	iter := code.RunWithContext(ctx, input)
	v, ok := iter.Next()
	if !ok {
		return []byte("null"), nil
	}
	if err, ok := v.(error); ok {
		return nil, safeTransformExecutionError(err)
	}
	if next, ok := iter.Next(); ok {
		if err, isErr := next.(error); isErr {
			return nil, safeTransformExecutionError(err)
		}
		return nil, errors.New("transform_jq: expression produced multiple results")
	}
	out, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	if len(out) > inboundTransformMaxOutputBytes {
		return nil, errors.New("transform_jq: output exceeds 5 MiB")
	}
	return out, nil
}

func safeTransformExecutionError(err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("transform_jq: execution exceeded 250ms limit")
	case errors.Is(err, context.Canceled):
		return errors.New("transform_jq: execution cancelled")
	default:
		return err
	}
}
