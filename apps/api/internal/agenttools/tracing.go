// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// tracer is the package tracer. It resolves against the global provider the
// runtime installs (observability.InitTracing); until then it is a no-op, so
// adding spans here costs nothing when tracing is disabled.
var tracer = otel.Tracer("github.com/postwave/postwave/apps/api/internal/agenttools")

// startToolSpan opens an OTel GenAI `execute_tool` span for one tool
// invocation, so agent tool use is observable and eval-able (which tool,
// what outcome, how long) without leaking subscriber PII — only the tool
// name, surface, and tenant id are recorded.
func startToolSpan(ctx context.Context, c Caller, name string) (context.Context, trace.Span) {
	ctx, span := tracer.Start(ctx, "execute_tool "+name, trace.WithSpanKind(trace.SpanKindInternal))
	attrs := []attribute.KeyValue{
		attribute.String("gen_ai.operation.name", "execute_tool"),
		attribute.String("gen_ai.tool.name", name),
		attribute.String("postwave.agent.surface", string(c.Surface)),
		attribute.Bool("postwave.agent.sandbox", c.Sandbox),
	}
	if c.TenantID != "" {
		attrs = append(attrs, attribute.String("postwave.tenant_id", c.TenantID))
	}
	span.SetAttributes(attrs...)
	return ctx, span
}

// finishToolSpan records the result + error on the span and ends it.
func finishToolSpan(span trace.Span, res *Result, err error) {
	if res != nil {
		span.SetAttributes(
			attribute.String("postwave.agent.outcome", string(res.Outcome)),
			attribute.Int("postwave.agent.latency_ms", res.LatencyMs),
		)
	}
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}
