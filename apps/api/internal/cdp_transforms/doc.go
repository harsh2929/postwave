// SPDX-License-Identifier: AGPL-3.0-only
//
// Package cdp_transforms is the pure-Go engine that runs declarative
// "profile transforms" against a property map (typically a
// subscriber's custom_fields/merge_fields blob). The engine has no
// IO and no database dependency — callers feed it a property map
// and a list of ops, and get back the transformed map plus a
// per-op summary.
//
// Why a separate package: bulk-import, sync adapters, and the
// dedicated admin endpoints all want to apply the SAME ops to the
// same blob. Centralising them here means the registered set of ops
// is one source of truth.
//
// Op model. Each op is a {Type, Field, Args} triple. Types are
// strings ("lowercase", "trim", "default_value", ...) and resolve to
// handlers registered at package init. Field is the property key
// (dotted paths allowed). Args is op-specific data — see
// resolveOp for parsing.
//
// Idempotence. Every op is idempotent: applying the same op twice
// in a row yields the same result. Tests assert this.
package cdp_transforms
