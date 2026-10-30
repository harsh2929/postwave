// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	maxActionTargetBytes      = 512
	maxTriggerNameBytes       = 256
	maxTriggerJSONPathBytes   = 512
	maxTriggerMatchValueBytes = 4096
	maxTriggerRegexBytes      = 1024
	maxTriggerTagRunes        = 64
)

// normalizeAndValidateTrigger applies the exact configuration contract the
// evaluator supports. It is deliberately called by both the HTTP handler and
// repository so non-HTTP callers cannot persist rules that only fail later in
// the action worker.
func normalizeAndValidateTrigger(in Trigger) (Trigger, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > maxTriggerNameBytes {
		return Trigger{}, fmt.Errorf(
			"%w: name is required and must not exceed %d bytes",
			ErrInvalidTrigger,
			maxTriggerNameBytes,
		)
	}
	if !utf8.ValidString(in.Name) || strings.IndexFunc(in.Name, unicode.IsControl) >= 0 {
		return Trigger{}, fmt.Errorf("%w: name contains unsupported characters", ErrInvalidTrigger)
	}

	in.MatchJSONPath = strings.TrimSpace(in.MatchJSONPath)
	if err := validateTriggerJSONPath("match_jsonpath", in.MatchJSONPath); err != nil {
		return Trigger{}, err
	}
	in.EmailJSONPath = strings.TrimSpace(in.EmailJSONPath)
	if err := validateTriggerJSONPath("email_jsonpath", in.EmailJSONPath); err != nil {
		return Trigger{}, err
	}

	in.MatchOperator = strings.TrimSpace(in.MatchOperator)
	if err := ValidateOperator(in.MatchOperator); err != nil {
		return Trigger{}, fmt.Errorf("%w: %v", ErrInvalidTrigger, err)
	}
	matchValue, err := normalizeAndValidateMatchValue(in.MatchOperator, in.MatchValue)
	if err != nil {
		return Trigger{}, err
	}
	in.MatchValue = matchValue

	in.ActionType = strings.TrimSpace(in.ActionType)
	if err := ValidateAction(in.ActionType); err != nil {
		return Trigger{}, fmt.Errorf("%w: %v", ErrInvalidTrigger, err)
	}
	in.ActionTargetID, err = normalizeAndValidateActionTarget(in.ActionType, in.ActionTargetID)
	if err != nil {
		return Trigger{}, err
	}
	return in, nil
}

// normalizeAndValidateTriggerPatch rejects malformed supplied fields before a
// repository call. The repository subsequently merges the patch with the
// locked current row and validates the complete resulting configuration.
func normalizeAndValidateTriggerPatch(p TriggerPatch) (TriggerPatch, error) {
	if p.Name != nil {
		value := strings.TrimSpace(*p.Name)
		if value == "" || len(value) > maxTriggerNameBytes {
			return TriggerPatch{}, fmt.Errorf(
				"%w: name is required and must not exceed %d bytes",
				ErrInvalidTrigger,
				maxTriggerNameBytes,
			)
		}
		if !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return TriggerPatch{}, fmt.Errorf("%w: name contains unsupported characters", ErrInvalidTrigger)
		}
		p.Name = &value
	}
	if p.MatchJSONPath != nil {
		value := strings.TrimSpace(*p.MatchJSONPath)
		if err := validateTriggerJSONPath("match_jsonpath", value); err != nil {
			return TriggerPatch{}, err
		}
		p.MatchJSONPath = &value
	}
	if p.EmailJSONPath != nil {
		value := strings.TrimSpace(*p.EmailJSONPath)
		if err := validateTriggerJSONPath("email_jsonpath", value); err != nil {
			return TriggerPatch{}, err
		}
		p.EmailJSONPath = &value
	}
	if p.MatchOperator != nil {
		value := strings.TrimSpace(*p.MatchOperator)
		if err := ValidateOperator(value); err != nil {
			return TriggerPatch{}, fmt.Errorf("%w: %v", ErrInvalidTrigger, err)
		}
		p.MatchOperator = &value
	}
	if p.MatchValue != nil && len(*p.MatchValue) > maxTriggerMatchValueBytes {
		return TriggerPatch{}, fmt.Errorf(
			"%w: match_value must not exceed %d bytes",
			ErrInvalidTrigger,
			maxTriggerMatchValueBytes,
		)
	}
	if p.MatchOperator != nil && p.MatchValue != nil {
		if _, err := normalizeAndValidateMatchValue(*p.MatchOperator, p.MatchValue); err != nil {
			return TriggerPatch{}, err
		}
	}
	if p.ActionType != nil {
		value := strings.TrimSpace(*p.ActionType)
		if err := ValidateAction(value); err != nil {
			return TriggerPatch{}, fmt.Errorf("%w: %v", ErrInvalidTrigger, err)
		}
		p.ActionType = &value
	}
	if p.ActionTargetID != nil {
		value := strings.TrimSpace(*p.ActionTargetID)
		if value == "" || len(value) > maxActionTargetBytes {
			return TriggerPatch{}, fmt.Errorf(
				"%w: action_target_id is required and must not exceed %d bytes",
				ErrInvalidTrigger,
				maxActionTargetBytes,
			)
		}
		p.ActionTargetID = &value
	}
	if p.ActionType != nil && p.ActionTargetID != nil {
		value, err := normalizeAndValidateActionTarget(*p.ActionType, *p.ActionTargetID)
		if err != nil {
			return TriggerPatch{}, err
		}
		p.ActionTargetID = &value
	}
	return p, nil
}

func normalizeAndValidateMatchValue(operator string, value *string) (*string, error) {
	if operator == OpExists {
		// exists has no comparison operand. Canonicalising away a stale value
		// keeps stored configuration honest and makes operator changes safe.
		return nil, nil
	}
	if value == nil {
		return nil, fmt.Errorf("%w: match_value is required for %s", ErrInvalidTrigger, operator)
	}
	if len(*value) > maxTriggerMatchValueBytes {
		return nil, fmt.Errorf(
			"%w: match_value must not exceed %d bytes",
			ErrInvalidTrigger,
			maxTriggerMatchValueBytes,
		)
	}
	if !utf8.ValidString(*value) {
		return nil, fmt.Errorf("%w: match_value must be valid UTF-8", ErrInvalidTrigger)
	}
	if operator == OpContains && *value == "" {
		return nil, fmt.Errorf("%w: match_value must not be empty for contains", ErrInvalidTrigger)
	}
	if operator == OpRegex {
		if *value == "" {
			return nil, fmt.Errorf("%w: match_value must not be empty for regex", ErrInvalidTrigger)
		}
		if len(*value) > maxTriggerRegexBytes {
			return nil, fmt.Errorf(
				"%w: regex must not exceed %d bytes",
				ErrInvalidTrigger,
				maxTriggerRegexBytes,
			)
		}
		if _, err := regexp.Compile(*value); err != nil {
			return nil, fmt.Errorf("%w: match_value is not a valid regular expression", ErrInvalidTrigger)
		}
	}
	return value, nil
}

func normalizeAndValidateActionTarget(actionType, raw string) (string, error) {
	target := strings.TrimSpace(raw)
	if target == "" || len(target) > maxActionTargetBytes {
		return "", fmt.Errorf(
			"%w: action_target_id is required and must not exceed %d bytes",
			ErrInvalidTrigger,
			maxActionTargetBytes,
		)
	}
	switch actionType {
	case ActionAddToSequence, ActionStartAutomation:
		id, err := uuid.Parse(target)
		if err != nil {
			return "", fmt.Errorf(
				"%w: action_target_id must be a UUID for %s",
				ErrInvalidTrigger,
				actionType,
			)
		}
		return id.String(), nil
	case ActionAddTag, ActionRemoveTag:
		if !utf8.ValidString(target) ||
			utf8.RuneCountInString(target) > maxTriggerTagRunes ||
			strings.IndexFunc(target, unicode.IsControl) >= 0 {
			return "", fmt.Errorf(
				"%w: tag target must be 1 to %d characters without control characters",
				ErrInvalidTrigger,
				maxTriggerTagRunes,
			)
		}
		return target, nil
	default:
		return "", fmt.Errorf("%w: unknown action type", ErrInvalidTrigger)
	}
}

func validateTriggerJSONPath(field, path string) error {
	if len(path) > maxTriggerJSONPathBytes {
		return fmt.Errorf(
			"%w: %s must not exceed %d bytes",
			ErrInvalidTrigger,
			field,
			maxTriggerJSONPathBytes,
		)
	}
	if _, err := parseJSONPath(path); err != nil {
		return fmt.Errorf(
			"%w: %s uses unsupported JSONPath syntax",
			ErrInvalidTrigger,
			field,
		)
	}
	return nil
}

func applyTriggerPatch(current Trigger, p TriggerPatch) Trigger {
	if p.Name != nil {
		current.Name = *p.Name
	}
	if p.Active != nil {
		current.Active = *p.Active
	}
	if p.MatchJSONPath != nil {
		current.MatchJSONPath = *p.MatchJSONPath
	}
	if p.MatchOperator != nil {
		current.MatchOperator = *p.MatchOperator
	}
	if p.MatchValue != nil {
		current.MatchValue = p.MatchValue
	}
	if p.EmailJSONPath != nil {
		current.EmailJSONPath = *p.EmailJSONPath
	}
	if p.ActionType != nil {
		current.ActionType = *p.ActionType
	}
	if p.ActionTargetID != nil {
		current.ActionTargetID = *p.ActionTargetID
	}
	return current
}
