package sms

import (
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	smsCampaignRecipientsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_campaign_recipients_total",
		Help: "SMS campaign recipients by provider and queue outcome.",
	}, []string{"provider", "result"})

	smsProviderSendsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_provider_sends_total",
		Help: "SMS provider send attempts by provider and result.",
	}, []string{"provider", "result"})

	smsInboundMessagesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_inbound_messages_total",
		Help: "Inbound SMS messages by provider and classified action.",
	}, []string{"provider", "action"})

	smsDeliveryCallbacksTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_delivery_callbacks_total",
		Help: "SMS delivery callbacks by provider and normalized status.",
	}, []string{"provider", "status"})

	smsEstimatedCostMicrosTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_estimated_cost_micros_total",
		Help: "Estimated queued SMS segment cost in micros by provider.",
	}, []string{"provider"})

	smsActualCostMicrosTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sms_actual_cost_micros_total",
		Help: "Actual SMS provider cost in micros by provider when returned by the provider.",
	}, []string{"provider"})

	// smsBandwidthSecondaryTokenTotal counts inbound Bandwidth
	// webhooks accepted via the rotation-grace secondary token.
	// Non-zero immediately after a rotation is expected; sustained
	// values past the operator-defined grace window indicate
	// upstream still hasn't been updated to the new token.
	smsBandwidthSecondaryTokenTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sms_bandwidth_secondary_token_accepted_total",
		Help: "Bandwidth webhook POSTs accepted via the secondary (rotation-grace) token. Should drop to zero within the operator's grace window.",
	})
)

func observeSMSCampaignRecipients(provider, result string, count int) {
	if count <= 0 {
		return
	}
	smsCampaignRecipientsTotal.WithLabelValues(metricLabel(provider, ProviderTwilio), metricLabel(result, "unknown")).Add(float64(count))
}

// observeBandwidthSecondaryTokenAccepted records one accepted
// webhook verified via the secondary (rotation-grace) token.
func observeBandwidthSecondaryTokenAccepted() {
	smsBandwidthSecondaryTokenTotal.Inc()
}

func observeSMSProviderSend(provider string, err error, priceMicros int64) {
	result := "sent"
	if err != nil {
		result = "failed"
	}
	provider = metricLabel(provider, ProviderTwilio)
	smsProviderSendsTotal.WithLabelValues(provider, result).Inc()
	if priceMicros > 0 {
		smsActualCostMicrosTotal.WithLabelValues(provider).Add(float64(priceMicros))
	}
}

func observeSMSInbound(provider, action string) {
	smsInboundMessagesTotal.WithLabelValues(metricLabel(provider, ProviderTwilio), metricLabel(action, "message")).Inc()
}

func observeSMSDelivery(provider, status string) {
	smsDeliveryCallbacksTotal.WithLabelValues(metricLabel(provider, ProviderTwilio), metricLabel(status, "unknown")).Inc()
}

func observeSMSEstimatedCost(provider string, micros int64) {
	if micros <= 0 {
		return
	}
	smsEstimatedCostMicrosTotal.WithLabelValues(metricLabel(provider, ProviderTwilio)).Add(float64(micros))
}

func metricLabel(value, fallback string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = fallback
	}
	value = strings.NewReplacer(" ", "_", "-", "_", ".", "_", ":", "_").Replace(value)
	if len(value) > 64 {
		value = value[:64]
	}
	return value
}
