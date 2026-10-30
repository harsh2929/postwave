package automationclient

import (
	"fmt"
	"net/url"
	"strings"
)

const EventPath = "/v1/automations/event"

// TriggerPath fires ONE known automation for one subscriber. EventPath, by
// contrast, broadcasts an event and lets the dispatcher match it against every
// active flow.
//
// The flow_runs drainer wants this one: the producer already matched the flow
// (MatchFlowsForTagEventTx) before enqueueing, so re-broadcasting would redo
// that work and risk matching flows the producer deliberately excluded.
const TriggerPath = "/v1/automations/trigger"

func EventURL(baseRaw string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid automation base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported automation base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe automation base URL")
	}
	base.Path = strings.TrimRight(base.Path, "/") + EventPath
	return base.String(), nil
}

// TriggerURL builds the automation service's single-automation trigger endpoint.
// Same validation as EventURL — the base URL is operator-supplied config, so it
// is checked rather than trusted.
func TriggerURL(baseRaw string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid automation base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported automation base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe automation base URL")
	}
	base.Path = strings.TrimRight(base.Path, "/") + TriggerPath
	return base.String(), nil
}
