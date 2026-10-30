-- When two subscribers have the same sequence enrollment, email re-pointing
-- keeps the survivor's row and removes the now-redundant row keyed by the
-- duplicate email.  Tenant RLS already constrains the operation, but the
-- application role lacked the table privilege needed to complete it.

BEGIN;

GRANT DELETE ON sequence_enrollments TO postwave_app;

COMMIT;
