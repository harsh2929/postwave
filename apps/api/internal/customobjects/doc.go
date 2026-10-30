// Package customobjects implements the CDP custom-objects backend:
// tenant-defined object types (Order, Wishlist, ReturnRequest,
// SubscriptionPlan, etc.) with their own properties, plus records of
// each type that can be referenced from segment predicates, flow
// branches, and template merge tags.
//
// What this package owns:
//
//   - Type CRUD: list/create/read/update/disable/delete on
//     custom_object_types. Each type carries a bounded JSON-Schema-style
//     document used to validate record properties before persistence. Mutable
//     fields and destructive cascades are bound to the exact loaded version.
//
//   - Record CRUD: bounded list/search/create/update/read/delete on
//     custom_object_records. The natural (tenant, type, external_id) key is
//     retained, but version zero is create-only and positive versions are
//     compare-and-swap updates; there is no last-writer-wins path.
//
//   - Validation: a small JSON-Schema subset (string, number,
//     integer, boolean, array, object; required[]; enum; minLength/
//     maxLength; minimum/maximum). Records that fail validation are
//     rejected at the API boundary with a structured error.
//
//   - Segment predicate plug-in: BuildSegmentPredicate returns the
//     SQL fragment that lets a segment query "subscribers who have a
//     custom_object of type X whose property Y matches Z". The
//     segments compiler calls into here so the registry's
//     "CustomObjects" predicate category is genuinely queryable.
//
// What this package does NOT do:
//
//   - General graph modelling. Subscriber links are supported through
//     profile_object_links, but arbitrary object-to-object relationships
//     (Order → LineItems → Product) remain a separate concern.
//
//   - Bulk import via warehouse sync — that's the warehouse
//     package's job; integrations use the same create-only/exact-version write
//     contract exposed here.
//
// Tables read/written: custom_object_types, custom_object_records, and
// profile_object_links (created by migration 0201 and versioned by migration
// 1999).
package customobjects
