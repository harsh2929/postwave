package tag_taxonomy

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// cascadeMergeTextArray rewrites `from`→`into` across each named
// table's tags text[] column, dedupes via array_agg(DISTINCT) so the
// resulting array carries no duplicates. Missing column / missing
// table errors are swallowed so feature-flagged deploys (e.g. a
// commerce-disabled tenant) still merge cleanly.
func cascadeMergeTextArray(ctx context.Context, tx pgx.Tx, tenantID, from, into string, tables ...string) error {
	for _, table := range tables {
		_, err := tx.Exec(ctx, `
UPDATE `+table+`
   SET tags = (
     SELECT array_agg(DISTINCT t) FROM unnest(
       array_remove(tags, $2::text) || ARRAY[$3::text]
     ) t
   )
 WHERE tenant_id = $1::uuid
   AND $2::text = ANY(tags)`, tenantID, from, into)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") {
				continue
			}
			return err
		}
	}
	return nil
}

// cascadeMergeSMSConvTags rewrites the per-row `tag` column in
// sms_conversation_tags from `from` to `into`. Conflicting (conv, into)
// rows are deleted first so the UPDATE can proceed without unique
// violations. No-op when the table is absent (sms feature disabled).
func cascadeMergeSMSConvTags(ctx context.Context, tx pgx.Tx, tenantID, from, into string) error {
	_, err := tx.Exec(ctx, `
DELETE FROM sms_conversation_tags
 WHERE tenant_id = $1::uuid
   AND tag = $2
   AND conversation_id IN (
     SELECT conversation_id FROM sms_conversation_tags
      WHERE tenant_id = $1::uuid AND tag = $3
   )`, tenantID, from, into)
	if err != nil {
		if strings.Contains(err.Error(), "does not exist") {
			return nil
		}
		return err
	}
	_, err = tx.Exec(ctx, `
UPDATE sms_conversation_tags
   SET tag = $3
 WHERE tenant_id = $1::uuid
   AND tag = $2`, tenantID, from, into)
	if err != nil && strings.Contains(err.Error(), "does not exist") {
		return nil
	}
	return err
}
