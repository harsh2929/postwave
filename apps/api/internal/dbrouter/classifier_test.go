// SPDX-License-Identifier: AGPL-3.0-only

package dbrouter

import "testing"

func TestIsReadOnlyQuery(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		// --- plain reads ---
		{"simple select", `SELECT id, email FROM subscribers WHERE tenant_id = $1`, true},
		{"select star", `SELECT * FROM flow_runs`, true},
		{"select lowercase", `select id from campaigns`, true},
		{"table shorthand", `TABLE subscribers`, true},
		{"values", `VALUES (1), (2)`, true},
		{"select with join", `SELECT s.id FROM subscribers s JOIN lists l ON l.id = s.list_id`, true},
		{"select with subquery", `SELECT id FROM subscribers WHERE id IN (SELECT subscriber_id FROM list_subscribers)`, true},

		// --- leading whitespace / comments ---
		{"leading whitespace", "   \n\t  SELECT 1", true},
		{"leading line comment", "-- pick a row\nSELECT id FROM subscribers", true},
		{"leading block comment", "/* pick a row */ SELECT id FROM subscribers", true},
		{"multiple leading comments", "-- one\n/* two */\n  SELECT 1", true},

		// --- plain writes ---
		{"insert", `INSERT INTO subscribers (email) VALUES ('a@b.com')`, false},
		{"update", `UPDATE subscribers SET status = 'active' WHERE id = $1`, false},
		{"delete", `DELETE FROM subscribers WHERE id = $1`, false},
		{"merge", `MERGE INTO subscribers USING src ON true WHEN MATCHED THEN UPDATE SET status = 'x'`, false},
		{"truncate", `TRUNCATE TABLE flow_runs`, false},
		{"create table", `CREATE TABLE foo (id uuid)`, false},
		{"alter table", `ALTER TABLE subscribers ADD COLUMN x text`, false},
		{"drop table", `DROP TABLE foo`, false},
		{"call procedure", `CALL do_thing($1)`, false},
		{"copy", `COPY subscribers TO STDOUT`, false},
		{"vacuum", `VACUUM ANALYZE subscribers`, false},
		{"do block", `DO $$ BEGIN UPDATE t SET a=1; END $$`, false},

		// --- nextval / setval anywhere ---
		{"nextval in select", `SELECT nextval('subscribers_id_seq')`, false},
		{"nextval uppercase", `SELECT NEXTVAL('subscribers_id_seq')`, false},
		{"setval", `SELECT setval('subscribers_id_seq', 100)`, false},
		{"nextval inside with select", `WITH x AS (SELECT nextval('seq') AS n) SELECT * FROM x`, false},

		// --- FOR UPDATE / FOR SHARE ---
		{"select for update", `SELECT id FROM subscribers WHERE id = $1 FOR UPDATE`, false},
		{"select for update lowercase", `select id from subscribers where id = $1 for update`, false},
		{"select for no key update", `SELECT id FROM subscribers FOR NO KEY UPDATE`, false},
		{"select for share", `SELECT id FROM subscribers FOR SHARE`, false},
		{"select for key share", `SELECT id FROM subscribers FOR KEY SHARE`, false},
		{"for update inside with", `WITH x AS (SELECT id FROM subscribers FOR UPDATE) SELECT * FROM x`, false},
		{
			"for update as string literal, not clause",
			`SELECT id FROM subscribers WHERE note = 'please FOR UPDATE later'`,
			true,
		},

		// --- WITH ... SELECT, no write CTE ---
		{"with select simple", `WITH x AS (SELECT 1) SELECT * FROM x`, true},
		{
			"with select multiple ctes",
			`WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b`,
			true,
		},
		{
			"with recursive select",
			`WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM cte WHERE n < 10) SELECT * FROM cte`,
			true,
		},
		{
			"with column list",
			`WITH x (id, email) AS (SELECT id, email FROM subscribers) SELECT * FROM x`,
			true,
		},
		{
			"with materialized select",
			`WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x`,
			true,
		},
		{
			"with not materialized select",
			`WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x`,
			true,
		},

		// --- tricky: WITH containing a data-modifying CTE ---
		{
			"with update cte",
			`WITH x AS (UPDATE subscribers SET status = 'x' RETURNING id) SELECT * FROM x`,
			false,
		},
		{
			"with insert cte",
			`WITH x AS (INSERT INTO subscribers (email) VALUES ('a@b.com') RETURNING id) SELECT * FROM x`,
			false,
		},
		{
			"with delete cte",
			`WITH x AS (DELETE FROM subscribers WHERE id = $1 RETURNING id) SELECT * FROM x`,
			false,
		},
		{
			"with second cte is write",
			`WITH a AS (SELECT 1), b AS (UPDATE t SET x = 1 RETURNING id) SELECT * FROM a, b`,
			false,
		},

		// --- tricky: WITH whose final statement is a write ---
		{
			"with select cte but delete main statement",
			`WITH x AS (SELECT id FROM subscribers WHERE inactive) DELETE FROM subscribers WHERE id IN (SELECT id FROM x)`,
			false,
		},
		{
			"with select cte but insert main statement",
			`WITH x AS (SELECT 1 AS n) INSERT INTO log (n) SELECT n FROM x`,
			false,
		},
		{
			"with select cte but update main statement",
			`WITH x AS (SELECT id FROM a) UPDATE b SET flag = true FROM x WHERE b.id = x.id`,
			false,
		},

		// --- malformed / empty ---
		{"empty string", ``, false},
		{"only whitespace", "   \n\t", false},
		{"only comment", "-- nothing else", false},
		{"garbage", `EXPLAIN SELECT 1`, false}, // unrecognized leading keyword: conservative write
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsReadOnlyQuery(tc.sql)
			if got != tc.want {
				t.Errorf("IsReadOnlyQuery(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}
