-- Take a reflection out of the morning-brief delivery rotation after one
-- failed render, so a template/content-schema bug doesn't cause perpetual
-- retries. morning-brief filters on `delivered_at IS NULL AND
-- delivery_failed_at IS NULL`; failures get logged for ops to investigate.
alter table reflections
  add column delivery_failed_at timestamptz,
  add column delivery_error text;
