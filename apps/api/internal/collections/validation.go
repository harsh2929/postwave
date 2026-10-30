// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"strings"
	"unicode"
	"unicode/utf8"
)

var errDuplicateJSONKey = errors.New("JSON objects must not contain duplicate keys")
var errJSONNestingTooDeep = errors.New("JSON nesting exceeds the collection limit")
var errInvalidJSONUnicode = errors.New("JSON strings must be valid UTF-8 with well-formed Unicode surrogate pairs")

const maxRequestJSONNesting = MaxNestedDepth + 4

var reservedObjectKeys = map[string]struct{}{
	"__proto__":   {},
	"constructor": {},
	"prototype":   {},
}

type inputValidationError struct {
	Code    string
	Message string
}

func (e *inputValidationError) Error() string { return e.Message }

func normalizeCreateInput(in CreateInput) (CreateInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.CollectionType = strings.TrimSpace(in.CollectionType)
	in.SourceType = strings.TrimSpace(in.SourceType)
	if in.CollectionType == "" {
		in.CollectionType = string(TypeContent)
	}
	if in.SourceType == "" {
		in.SourceType = string(SourceManual)
	}
	if err := validateName(in.Name); err != nil {
		return CreateInput{}, &inputValidationError{Code: "invalid_name", Message: err.Error()}
	}
	if !isValidCollectionType(in.CollectionType) {
		return CreateInput{}, &inputValidationError{
			Code: "invalid_collection_type", Message: "collection_type must be one of: " + validCollectionTypeList,
		}
	}
	if !isValidSourceType(in.SourceType) {
		return CreateInput{}, &inputValidationError{
			Code: "invalid_source_type", Message: "source_type must be one of: " + validSourceTypeList,
		}
	}
	if err := validateRows(in.Data); err != nil {
		return CreateInput{}, &inputValidationError{Code: "invalid_data", Message: err.Error()}
	}
	return in, nil
}

func normalizeUpdateInput(in UpdateInput) (UpdateInput, error) {
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if err := validateName(name); err != nil {
			return UpdateInput{}, &inputValidationError{Code: "invalid_name", Message: err.Error()}
		}
		in.Name = &name
	}
	if in.CollectionType != nil {
		collectionType := strings.TrimSpace(*in.CollectionType)
		if !isValidCollectionType(collectionType) {
			return UpdateInput{}, &inputValidationError{
				Code: "invalid_collection_type", Message: "collection_type must be one of: " + validCollectionTypeList,
			}
		}
		in.CollectionType = &collectionType
	}
	if in.SourceType != nil {
		sourceType := strings.TrimSpace(*in.SourceType)
		if !isValidSourceType(sourceType) {
			return UpdateInput{}, &inputValidationError{
				Code: "invalid_source_type", Message: "source_type must be one of: " + validSourceTypeList,
			}
		}
		in.SourceType = &sourceType
	}
	if in.dataSet {
		if err := validateRows(in.Data); err != nil {
			return UpdateInput{}, &inputValidationError{Code: "invalid_data", Message: err.Error()}
		}
	}
	return in, nil
}

func normalizeListOptions(opts ListOptions) (ListOptions, error) {
	opts.Query = strings.TrimSpace(opts.Query)
	if utf8.RuneCountInString(opts.Query) > MaxListSearchLength {
		return ListOptions{}, &inputValidationError{
			Code: "invalid_query", Message: fmt.Sprintf("q must be %d characters or fewer", MaxListSearchLength),
		}
	}
	for _, r := range opts.Query {
		if isUnsafeTextRune(r) {
			return ListOptions{}, &inputValidationError{
				Code: "invalid_query", Message: "q must not contain control or bidirectional formatting characters",
			}
		}
	}
	opts.CollectionType = strings.TrimSpace(opts.CollectionType)
	if opts.CollectionType != "" && !isValidCollectionType(opts.CollectionType) {
		return ListOptions{}, &inputValidationError{
			Code: "invalid_collection_type", Message: "collection_type must be one of: " + validCollectionTypeList,
		}
	}
	return opts, nil
}

func validateName(s string) error {
	if s == "" {
		return errors.New("name required")
	}
	if strings.TrimSpace(s) != s {
		return errors.New("name must not contain leading or trailing whitespace")
	}
	if !utf8.ValidString(s) {
		return errors.New("name must be valid UTF-8")
	}
	if utf8.RuneCountInString(s) > MaxNameLength {
		return fmt.Errorf("name must be %d characters or fewer", MaxNameLength)
	}
	for _, r := range s {
		if isUnsafeTextRune(r) {
			return errors.New("name must not contain control or bidirectional formatting characters")
		}
	}
	return nil
}

// validateRows enforces the persistence contract even when Repo is called by
// a non-HTTP caller. The HTTP body cap alone is insufficient: a tiny encoded
// request can still describe pathological nesting/member counts, and mutation
// responses echo the stored data back through a smaller desktop response cap.
func validateRows(rows []RowValue) error {
	if len(rows) > MaxRows {
		return fmt.Errorf("a collection may hold at most %d rows", MaxRows)
	}
	nodes := 0
	for rowIndex, row := range rows {
		if row == nil {
			return fmt.Errorf("row %d must be an object, not null", rowIndex+1)
		}
		if len(row) > MaxColumnsPerRow {
			return fmt.Errorf("row %d may contain at most %d fields", rowIndex+1, MaxColumnsPerRow)
		}
		nodes++
		for key, value := range row {
			if err := validateObjectKey(key); err != nil {
				return fmt.Errorf("row %d: %w", rowIndex+1, err)
			}
			if err := validateJSONValue(value, 1, &nodes); err != nil {
				return fmt.Errorf("row %d field %q: %w", rowIndex+1, key, err)
			}
		}
		encoded, err := marshalCollectionJSON(row)
		if err != nil {
			return fmt.Errorf("row %d is not valid JSON: %w", rowIndex+1, err)
		}
		if len(encoded) > MaxEncodedRowBytes {
			return fmt.Errorf("row %d may encode to at most %d bytes", rowIndex+1, MaxEncodedRowBytes)
		}
	}
	encoded, err := marshalCollectionJSON(rows)
	if err != nil {
		return fmt.Errorf("collection data is not valid JSON: %w", err)
	}
	if len(encoded) > MaxDataBytes {
		return fmt.Errorf("collection data may encode to at most %d bytes", MaxDataBytes)
	}
	return nil
}

func validateObjectKey(key string) error {
	if !utf8.ValidString(key) {
		return errors.New("field names must be valid UTF-8")
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("field names must not be empty or whitespace-only")
	}
	if utf8.RuneCountInString(key) > MaxFieldNameLength {
		return fmt.Errorf("field names must be %d characters or fewer", MaxFieldNameLength)
	}
	for _, r := range key {
		if isUnsafeTextRune(r) {
			return errors.New("field names must not contain control or bidirectional formatting characters")
		}
	}
	if _, reserved := reservedObjectKeys[key]; reserved {
		return fmt.Errorf("field name %q is reserved", key)
	}
	return nil
}

func validateJSONValue(value any, depth int, nodes *int) error {
	if depth > MaxNestedDepth {
		return fmt.Errorf("values may be nested at most %d levels", MaxNestedDepth)
	}
	(*nodes)++
	if *nodes > MaxTotalValueNodes {
		return fmt.Errorf("collection may contain at most %d JSON value nodes", MaxTotalValueNodes)
	}

	switch typed := value.(type) {
	case nil, bool:
		return nil
	case int:
		return validateSignedJSONInteger(int64(typed))
	case int8:
		return validateSignedJSONInteger(int64(typed))
	case int16:
		return validateSignedJSONInteger(int64(typed))
	case int32:
		return validateSignedJSONInteger(int64(typed))
	case int64:
		return validateSignedJSONInteger(typed)
	case uint:
		return validateUnsignedJSONInteger(uint64(typed))
	case uint8:
		return validateUnsignedJSONInteger(uint64(typed))
	case uint16:
		return validateUnsignedJSONInteger(uint64(typed))
	case uint32:
		return validateUnsignedJSONInteger(uint64(typed))
	case uint64:
		return validateUnsignedJSONInteger(typed)
	case string:
		if !utf8.ValidString(typed) {
			return errors.New("strings must be valid UTF-8")
		}
		if len(typed) > MaxStringValueBytes {
			return fmt.Errorf("strings may contain at most %d UTF-8 bytes", MaxStringValueBytes)
		}
		if strings.ContainsRune(typed, '\x00') {
			return errors.New("strings must not contain NUL characters")
		}
		return nil
	case json.Number:
		return validateExactJSONNumber(typed)
	case float32:
		return validateJSONFloat(float64(typed))
	case float64:
		return validateJSONFloat(typed)
	case []any:
		if len(typed) > MaxNestedMembers {
			return fmt.Errorf("nested arrays may contain at most %d items", MaxNestedMembers)
		}
		for _, item := range typed {
			if err := validateJSONValue(item, depth+1, nodes); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		if len(typed) > MaxNestedMembers {
			return fmt.Errorf("nested objects may contain at most %d fields", MaxNestedMembers)
		}
		for key, item := range typed {
			if err := validateObjectKey(key); err != nil {
				return err
			}
			if err := validateJSONValue(item, depth+1, nodes); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported JSON value type %T", value)
	}
}

func validateExactJSONNumber(value json.Number) error {
	parsedFloat, err := value.Float64()
	if err != nil || math.IsNaN(parsedFloat) || math.IsInf(parsedFloat, 0) {
		return errors.New("numbers must be finite and representable")
	}
	parsed, ok := new(big.Rat).SetString(value.String())
	if !ok {
		return errors.New("numbers must use valid JSON decimal syntax")
	}
	absValue := new(big.Rat).Abs(parsed)
	minMagnitude, _ := new(big.Rat).SetString("1e-300")
	maxMagnitude, _ := new(big.Rat).SetString("1e300")
	if parsed.Sign() != 0 && (absValue.Cmp(minMagnitude) < 0 || absValue.Cmp(maxMagnitude) > 0) {
		return errors.New("nonzero numbers must have an absolute magnitude from 1e-300 through 1e300")
	}
	if parsed.IsInt() && new(big.Int).Abs(parsed.Num()).Cmp(big.NewInt(MaxSafeJSONInteger)) > 0 {
		return unsafeJSONIntegerError()
	}
	return nil
}

func validateSignedJSONInteger(value int64) error {
	if value < -MaxSafeJSONInteger || value > MaxSafeJSONInteger {
		return unsafeJSONIntegerError()
	}
	return nil
}

func validateUnsignedJSONInteger(value uint64) error {
	if value > uint64(MaxSafeJSONInteger) {
		return unsafeJSONIntegerError()
	}
	return nil
}

func validateJSONFloat(value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return errors.New("numbers must be finite")
	}
	absValue := math.Abs(value)
	if absValue != 0 && (absValue < MinAbsJSONNumber || absValue > MaxAbsJSONNumber) {
		return errors.New("nonzero numbers must have an absolute magnitude from 1e-300 through 1e300")
	}
	if math.Trunc(value) == value && math.Abs(value) > float64(MaxSafeJSONInteger) {
		return unsafeJSONIntegerError()
	}
	return nil
}

func unsafeJSONIntegerError() error {
	return fmt.Errorf("integer numbers must stay within the interoperable JSON safe range -%d to %d; encode larger identifiers as strings", MaxSafeJSONInteger, MaxSafeJSONInteger)
}

func isUnsafeTextRune(r rune) bool {
	if unicode.IsControl(r) {
		return true
	}
	// Reject invisible direction changes that can visually reorder operator-
	// facing names/columns in tables, logs, and confirmation dialogs.
	return r == '\u061c' || r == '\u200e' || r == '\u200f' ||
		r == '\u2028' || r == '\u2029' ||
		(r >= '\u202a' && r <= '\u202e') ||
		(r >= '\u2066' && r <= '\u2069')
}

// rejectDuplicateJSONKeys runs on the bounded original request bytes before
// persistence. encoding/json otherwise silently keeps the last duplicate key,
// which makes signed/audited input ambiguous and can hide a different value
// from an upstream validator.
func rejectDuplicateJSONKeys(raw []byte) error {
	if err := rejectMalformedJSONSurrogates(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := walkJSONValue(decoder, 0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func rejectMalformedJSONSurrogates(raw []byte) error {
	if !utf8.Valid(raw) {
		return errInvalidJSONUnicode
	}
	inString := false
	for index := 0; index < len(raw); index++ {
		switch raw[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(raw) {
				continue
			}
			if raw[index+1] != 'u' {
				index++
				continue
			}
			codePoint, ok := decodeHexQuad(raw, index+2)
			if !ok {
				continue // the standard JSON decoder reports malformed escapes
			}
			index += 5
			switch {
			case codePoint >= 0xd800 && codePoint <= 0xdbff:
				if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
					return errInvalidJSONUnicode
				}
				low, ok := decodeHexQuad(raw, index+3)
				if !ok || low < 0xdc00 || low > 0xdfff {
					return errInvalidJSONUnicode
				}
				index += 6
			case codePoint >= 0xdc00 && codePoint <= 0xdfff:
				return errInvalidJSONUnicode
			}
		}
	}
	return nil
}

func decodeHexQuad(raw []byte, start int) (uint16, bool) {
	if start+4 > len(raw) {
		return 0, false
	}
	var value uint16
	for _, char := range raw[start : start+4] {
		value <<= 4
		switch {
		case char >= '0' && char <= '9':
			value |= uint16(char - '0')
		case char >= 'a' && char <= 'f':
			value |= uint16(char-'a') + 10
		case char >= 'A' && char <= 'F':
			value |= uint16(char-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func walkJSONValue(decoder *json.Decoder, depth int) error {
	if depth > maxRequestJSONNesting {
		return errJSONNestingTooDeep
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key must be a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return errDuplicateJSONKey
			}
			seen[key] = struct{}{}
			if err := walkJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	case '[':
		for decoder.More() {
			if err := walkJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	default:
		return errors.New("invalid JSON delimiter")
	}
}

func rawJSONIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func marshalCollectionJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
