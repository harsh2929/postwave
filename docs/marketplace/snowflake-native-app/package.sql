-- © Moosewave. Proprietary and confidential.
--
-- Setup script for the Moosewave Audit Shareback Native App. Run
-- automatically by Snowflake when the customer installs the app from
-- Marketplace. Creates:
--
--   POSTWAVE_AUDIT.RAW              — landing table for OCSF rows
--   POSTWAVE_AUDIT.STAGE            — external stage on Moosewave S3
--   POSTWAVE_AUDIT.POLL_COPY        — task that COPYs new files
--   POSTWAVE_AUDIT.OCSF_VIEW        — flattened OCSF for Snowsight
--
-- The customer drives the POLL_COPY schedule (CRON or interval) —
-- Moosewave just writes to S3. Reverse-pull semantics.

CREATE APPLICATION ROLE IF NOT EXISTS app_role;
CREATE OR ALTER VERSIONED SCHEMA POSTWAVE_AUDIT;

CREATE TABLE IF NOT EXISTS POSTWAVE_AUDIT.RAW (
  filename       STRING,
  ingested_at    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  payload        VARIANT
);
GRANT SELECT ON TABLE POSTWAVE_AUDIT.RAW TO APPLICATION ROLE app_role;

-- The external stage is bound at install time via the manifest's
-- `external_stage` reference. The customer points it at the Moosewave
-- bucket subtree their listing entitlement covers.

CREATE OR REPLACE PROCEDURE POSTWAVE_AUDIT.RUN_COPY()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  COPY INTO POSTWAVE_AUDIT.RAW (filename, payload)
  FROM (
    SELECT METADATA$FILENAME, PARSE_JSON($1)
    FROM @reference('external_stage')
  )
  FILE_FORMAT = (TYPE = JSON STRIP_OUTER_ARRAY = FALSE)
  ON_ERROR = CONTINUE;
  RETURN 'ok';
END;
$$;
GRANT USAGE ON PROCEDURE POSTWAVE_AUDIT.RUN_COPY() TO APPLICATION ROLE app_role;

CREATE OR REPLACE VIEW POSTWAVE_AUDIT.OCSF_VIEW AS
SELECT
  payload:time::TIMESTAMP_NTZ      AS event_time,
  payload:class_uid::NUMBER        AS class_uid,
  payload:activity_id::NUMBER      AS activity_id,
  payload:severity_id::NUMBER      AS severity_id,
  payload:actor:user:name::STRING  AS actor_name,
  payload:src_endpoint:ip::STRING  AS client_ip,
  payload:metadata                 AS metadata,
  filename                         AS source_file,
  ingested_at
FROM POSTWAVE_AUDIT.RAW;
GRANT SELECT ON VIEW POSTWAVE_AUDIT.OCSF_VIEW TO APPLICATION ROLE app_role;
