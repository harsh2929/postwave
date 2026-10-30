# AI data routing and tenant-owned credentials

This document describes the production data boundary for Moosewave's in-app
tool-calling agent. It is intended for customer security review as well as
operators.

## Supported provider

The in-app agent currently supports Anthropic only. `PUT
/api/v1/ai-agent/config` rejects any other provider before storing a
credential. Moosewave never guesses a provider and never sends an OpenAI,
Gemini, or other credential to Anthropic.

## Routing decision

For each authenticated tenant request, the API reads and decrypts that
tenant's agent configuration before it sends prompt data:

- If no tenant credential row exists, the request may use the platform's
  configured Anthropic credential.
- If a valid tenant Anthropic credential exists, that credential is used for
  the request.
- If the row exists but the database, KMS, decryption, credential, or provider
  selection fails, the request fails with `503`. It is not retried with the
  platform credential and no prompt is sent to the platform model account.

The same rule applies to stateless JSON chat, SSE chat, and persisted-session
chat. Automated tests assert that the platform client receives zero calls on
the configured-BYOK failure path.

## Data sent to the model

The in-app agent sends the user's message, supplied conversation history (or
the tenant's persisted session history), the system instruction, and the
schemas/results of tools permitted by the caller's scopes. Tool execution is
governed by the authenticated tenant and API-key scopes. A tenant-owned model
credential changes credential ownership and provider billing; it does not
remove Anthropic from the data path.

The tenant LLM credential applies only to `/api/v1/ai-agent/*`. Campaign copy,
safety evaluation, natural-language analytics, and voice-service model calls
are separate product surfaces and do not inherit this credential unless their
own contract explicitly says so.

## Credential storage and KMS BYOK

The credential is never returned by the configuration API. It is stored in
`ai_llm_provider_config.api_key_ciphertext` using versioned envelope
encryption. Without a tenant data-at-rest key it uses Moosewave's platform
envelope cipher. With an active tenant AWS KMS key it uses the tenant envelope
format and that key; rotation re-encrypts the column before the old key may be
retired. See [BYOK wiring](../byok.md) for the exact lifecycle and current
coverage.

## Operational verification

Investigate any `ai-agent: tenant LLM resolution failed closed` event as an
availability or key-management incident. Do not add a platform fallback to
that branch: the failure is an intentional privacy boundary.
