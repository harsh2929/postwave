# Redistributable Asset Stubs

These placeholders are licensed under the included [MIT license](LICENSE).
They let developers and independent operators exercise the same runtime path
contract as Moosewave Cloud without using Moosewave's tuned prompts, templates,
or evaluation data.

They are intentionally simple and uncalibrated. Set the corresponding env vars
to these paths only for local development or smoke tests:

- `DIAGNOSTICIAN_PROMPTS_PATH=proprietary-stubs/prompts/diagnostician`
- `DIAGNOSTICIAN_EVAL_CASES_PATH=proprietary-stubs/eval/diagnostician-cases`
- `VOICE_PROMPTS_PATH=proprietary-stubs/prompts/voice`
- `VOICE_TEMPLATES_PATH=proprietary-stubs/templates/voice-templates`

They are examples, not calibrated production assets and not a supported
self-hosted product. Operators outside Moosewave Cloud must provide and review
their own production assets.
