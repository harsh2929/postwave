package handlers

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/services/voice/internal/generation"
)

// Public sequence canvases are deliberately bounded. These limits keep
// recursive validation, JSONB writes, and future runtime traversal predictable
// even when a caller bypasses the desktop UI.
const (
	sequenceMaxNodes           = 100
	sequenceMaxDepth           = 3
	sequenceMaxOps             = 100
	sequenceMaxPosition        = 10_000
	sequenceMaxDelaySeconds    = 365 * 24 * 60 * 60
	sequenceMaxNameRunes       = 200
	sequenceMaxSubjectRunes    = 255
	sequenceMaxBodyRunes       = 262_144
	sequenceMaxTemplateIDRunes = 128
	sequenceMaxTagRunes        = 128
	sequenceMaxPredicateValue  = 512
)

var sequenceConditionPredicates = map[string]struct{}{
	"opened_previous":    {},
	"clicked_any":        {},
	"tag_present":        {},
	"custom_property_eq": {},
	"product_event":      {},
}

func validateSequenceUpdateShape(req updateSequenceRequest) error {
	if req.Name == nil && req.Status == nil && req.Emails == nil && req.Steps == nil &&
		req.Ops == nil && len(req.Goal) == 0 && req.StuckAfterDays == nil {
		return errors.New("patch must include at least one recognized sequence field")
	}
	stepSurfaces := 0
	if req.Emails != nil {
		stepSurfaces++
	}
	if req.Steps != nil {
		stepSurfaces++
	}
	if req.Ops != nil {
		stepSurfaces++
	}
	if stepSurfaces > 1 {
		return errors.New("send only one of `emails`, `steps`, or `ops`")
	}
	if req.Name != nil {
		if err := validateSingleLine("name", *req.Name, sequenceMaxNameRunes, true); err != nil {
			return err
		}
	}
	if req.Ops != nil {
		if err := validateSequenceOps(*req.Ops); err != nil {
			return err
		}
	}
	return nil
}

func validateSequenceOps(ops []sequenceOp) error {
	if len(ops) == 0 {
		return errors.New("ops must contain at least one operation")
	}
	if len(ops) > sequenceMaxOps {
		return fmt.Errorf("ops exceeds the maximum of %d operations", sequenceMaxOps)
	}
	for i, op := range ops {
		switch strings.ToLower(strings.TrimSpace(op.Op)) {
		case "insert":
			if op.Step == nil || op.Patch != nil || op.StepID != 0 || op.BeforeID != 0 || op.AfterID < 0 || op.AfterID > sequenceMaxPosition {
				return fmt.Errorf("op %d: insert accepts only step and optional after_id between 0 and %d", i, sequenceMaxPosition)
			}
		case "move":
			if op.StepID < 1 || op.StepID > sequenceMaxPosition || op.Step != nil || op.Patch != nil || op.AfterID != 0 || op.BeforeID < 0 || op.BeforeID > sequenceMaxPosition {
				return fmt.Errorf("op %d: move requires bounded step_id and accepts only optional before_id between 0 and %d", i, sequenceMaxPosition)
			}
		case "update":
			if op.StepID < 1 || op.StepID > sequenceMaxPosition || op.Patch == nil || op.Step != nil || op.AfterID != 0 || op.BeforeID != 0 {
				return fmt.Errorf("op %d: update requires only step_id and patch", i)
			}
		case "delete":
			if op.StepID < 1 || op.StepID > sequenceMaxPosition || op.Step != nil || op.Patch != nil || op.AfterID != 0 || op.BeforeID != 0 {
				return fmt.Errorf("op %d: delete requires only step_id", i)
			}
		default:
			return fmt.Errorf("op %d: unsupported operation", i)
		}
	}
	return nil
}

// validateSteps validates a non-empty sequence tree. Empty top-level arrays
// are handled by callers as an intentional canvas clear; empty condition
// branches are allowed.
func validateSteps(steps []generation.Step) error {
	if len(steps) == 0 {
		return errors.New("steps required")
	}
	state := sequenceStepValidationState{}
	return state.validateSlice(steps, 1)
}

type sequenceStepValidationState struct {
	nodes int
}

func (s *sequenceStepValidationState) validateSlice(steps []generation.Step, depth int) error {
	if depth > sequenceMaxDepth {
		return fmt.Errorf("sequence nesting exceeds maximum depth %d", sequenceMaxDepth)
	}
	positions := make(map[int]struct{}, len(steps))
	for i := range steps {
		s.nodes++
		if s.nodes > sequenceMaxNodes {
			return fmt.Errorf("sequence exceeds maximum of %d total steps", sequenceMaxNodes)
		}
		step := &steps[i]
		if step.Position < 1 || step.Position > sequenceMaxPosition {
			return fmt.Errorf("step %d: position must be between 1 and %d", i, sequenceMaxPosition)
		}
		if _, exists := positions[step.Position]; exists {
			return fmt.Errorf("duplicate step position %d", step.Position)
		}
		positions[step.Position] = struct{}{}
		if err := validateStepPayload(step); err != nil {
			return fmt.Errorf("step %d: %w", i, err)
		}
		if step.Condition != nil {
			if len(step.Condition.YesBranch) > 0 {
				if err := s.validateSlice(step.Condition.YesBranch, depth+1); err != nil {
					return fmt.Errorf("step %d yes_branch: %w", i, err)
				}
			}
			if len(step.Condition.NoBranch) > 0 {
				if err := s.validateSlice(step.Condition.NoBranch, depth+1); err != nil {
					return fmt.Errorf("step %d no_branch: %w", i, err)
				}
			}
		}
	}
	return nil
}

func validateStepPayload(step *generation.Step) error {
	payloadCount := 0
	if step.Email != nil {
		payloadCount++
	}
	if step.Delay != nil {
		payloadCount++
	}
	if step.Condition != nil {
		payloadCount++
	}
	if step.Tag != nil {
		payloadCount++
	}

	switch step.Type {
	case generation.StepTypeEmail:
		if step.Email == nil || payloadCount != 1 {
			return errors.New("email step requires exactly one matching email payload")
		}
		return validateEmailConfig(*step.Email)
	case generation.StepTypeDelay:
		if step.Delay == nil || payloadCount != 1 {
			return errors.New("delay step requires exactly one matching delay payload")
		}
		return validateDelayConfig(*step.Delay)
	case generation.StepTypeCondition:
		if step.Condition == nil || payloadCount != 1 {
			return errors.New("condition step requires exactly one matching condition payload")
		}
		return validateConditionConfig(*step.Condition)
	case generation.StepTypeTagAdd, generation.StepTypeTagRemove:
		if step.Tag == nil || payloadCount != 1 {
			return errors.New("tag step requires exactly one matching tag payload")
		}
		return validateSingleLine("tag", step.Tag.Tag, sequenceMaxTagRunes, true)
	case generation.StepTypeExit:
		if payloadCount != 0 {
			return errors.New("exit step must not include a payload")
		}
		return nil
	default:
		return errors.New("unsupported step type")
	}
}

func validateEmailConfig(email generation.EmailConfig) error {
	if err := validateSingleLine("email subject", email.Subject, sequenceMaxSubjectRunes, true); err != nil {
		return err
	}
	if err := validateBody("email body", email.Body); err != nil {
		return err
	}
	if err := validateBody("email body_html", email.BodyHTML); err != nil {
		return err
	}
	if err := validateBody("email body_mjml", email.BodyMJML); err != nil {
		return err
	}
	if strings.TrimSpace(email.Body) == "" && strings.TrimSpace(email.BodyHTML) == "" && strings.TrimSpace(email.BodyMJML) == "" {
		return errors.New("email body, body_html, or body_mjml required")
	}
	if email.DelaySeconds < 0 || email.DelaySeconds > sequenceMaxDelaySeconds {
		return fmt.Errorf("email delay_seconds must be between 0 and %d", sequenceMaxDelaySeconds)
	}
	if email.TemplateID != "" {
		if err := validateSingleLine("template_id", email.TemplateID, sequenceMaxTemplateIDRunes, false); err != nil {
			return err
		}
	}
	if err := generation.ValidateVariants(email.Variants); err != nil {
		return err
	}
	for i, variant := range email.Variants {
		if err := validateSingleLine("variant subject", variant.Subject, sequenceMaxSubjectRunes, true); err != nil {
			return fmt.Errorf("variant %d: %w", i, err)
		}
		if err := validateBody("variant body", variant.Body); err != nil {
			return fmt.Errorf("variant %d: %w", i, err)
		}
		if err := validateBody("variant body_html", variant.BodyHTML); err != nil {
			return fmt.Errorf("variant %d: %w", i, err)
		}
	}
	return nil
}

func validateGeneratedEmails(emails []generation.GeneratedEmail) error {
	if len(emails) > sequenceMaxNodes {
		return fmt.Errorf("emails exceeds maximum of %d entries", sequenceMaxNodes)
	}
	positions := make(map[int]struct{}, len(emails))
	for i, email := range emails {
		if email.Position < 1 || email.Position > sequenceMaxPosition {
			return fmt.Errorf("email %d: position must be between 1 and %d", i, sequenceMaxPosition)
		}
		if _, duplicate := positions[email.Position]; duplicate {
			return fmt.Errorf("duplicate email position %d", email.Position)
		}
		positions[email.Position] = struct{}{}
		if err := validateSingleLine("email subject", email.Subject, sequenceMaxSubjectRunes, true); err != nil {
			return fmt.Errorf("email %d: %w", i, err)
		}
		if err := validateBody("email body", email.Body); err != nil {
			return fmt.Errorf("email %d: %w", i, err)
		}
		if err := validateBody("email body_html", email.BodyHTML); err != nil {
			return fmt.Errorf("email %d: %w", i, err)
		}
		if err := validateBody("email body_mjml", email.BodyMJML); err != nil {
			return fmt.Errorf("email %d: %w", i, err)
		}
		if strings.TrimSpace(email.Body) == "" && strings.TrimSpace(email.BodyHTML) == "" && strings.TrimSpace(email.BodyMJML) == "" {
			return fmt.Errorf("email %d: body, body_html, or body_mjml required", i)
		}
		if email.DelaySeconds < 0 || email.DelaySeconds > sequenceMaxDelaySeconds {
			return fmt.Errorf("email %d: delay_seconds must be between 0 and %d", i, sequenceMaxDelaySeconds)
		}
	}
	return nil
}

func validateDelayConfig(delay generation.DelayConfig) error {
	if delay.Seconds < 1 || delay.Seconds > sequenceMaxDelaySeconds {
		return fmt.Errorf("delay seconds must be between 1 and %d", sequenceMaxDelaySeconds)
	}
	if delay.Unit == "" && delay.Value == 0 {
		return nil
	}
	multipliers := map[string]int{"minutes": 60, "hours": 3600, "days": 86400}
	multiplier, ok := multipliers[strings.ToLower(strings.TrimSpace(delay.Unit))]
	if !ok || delay.Value < 1 || delay.Value > sequenceMaxDelaySeconds/multiplier {
		return errors.New("delay value/unit must describe a positive duration of at most 365 days using minutes, hours, or days")
	}
	return nil
}

func validateConditionConfig(condition generation.ConditionConfig) error {
	predicate := strings.ToLower(strings.TrimSpace(condition.Predicate))
	if _, ok := sequenceConditionPredicates[predicate]; !ok {
		return errors.New("condition predicate must be opened_previous, clicked_any, tag_present, custom_property_eq, or product_event")
	}
	if err := validateSingleLine("condition value", condition.Value, sequenceMaxPredicateValue, false); err != nil {
		return err
	}
	if (predicate == "tag_present" || predicate == "product_event" || predicate == "custom_property_eq") && strings.TrimSpace(condition.Value) == "" {
		return fmt.Errorf("condition value required for %s", predicate)
	}
	return nil
}

func validateSingleLine(field, value string, maxRunes int, required bool) error {
	trimmed := strings.TrimSpace(value)
	if required && trimmed == "" {
		return fmt.Errorf("%s required", field)
	}
	if utf8.RuneCountInString(value) > maxRunes {
		return fmt.Errorf("%s exceeds %d characters", field, maxRunes)
	}
	for _, r := range value {
		if r == '\r' || r == '\n' || r == 0 || unicode.IsControl(r) {
			return fmt.Errorf("%s must be a single printable line", field)
		}
	}
	return nil
}

func validateBody(field, value string) error {
	if utf8.RuneCountInString(value) > sequenceMaxBodyRunes {
		return fmt.Errorf("%s exceeds %d characters", field, sequenceMaxBodyRunes)
	}
	for _, r := range value {
		if r == 0 || (unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t') {
			return fmt.Errorf("%s contains unsupported control characters", field)
		}
	}
	return nil
}

func sequenceAuthoringEqual(a, b generation.Sequence) bool {
	return a.Name == b.Name &&
		a.Status == b.Status &&
		a.StuckAfterDays == b.StuckAfterDays &&
		reflect.DeepEqual(a.Emails, b.Emails) &&
		reflect.DeepEqual(a.Steps, b.Steps) &&
		reflect.DeepEqual(a.Goal, b.Goal)
}
