CREATE OR REPLACE FUNCTION wm_assert_control_account_party_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  invalid_count bigint;
  invalid_balance numeric;
BEGIN
  SELECT count(*)::bigint, COALESCE(sum(gl.debit - gl.credit), 0)
    INTO invalid_count, invalid_balance
    FROM changed_gl gl
    JOIN app_accounting_settings setting ON setting.account_id = gl.account_id
   WHERE (
       setting.setting_key = 'accounts_receivable'
       AND (
         COALESCE(gl.party_type, '') <> 'customer'
         OR COALESCE(NULLIF(BTRIM(gl.party_id), ''), '') = ''
       )
     )
     OR (
       setting.setting_key = 'accounts_payable'
       AND (
         COALESCE(gl.party_type, '') <> 'supplier'
         OR COALESCE(NULLIF(BTRIM(gl.party_id), ''), '') = ''
       )
     );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'control_account_party_required: % control-account row(s) with balance % lack the required party',
      invalid_count,
      invalid_balance
      USING ERRCODE = '23514',
        HINT = 'Accounts Receivable requires a customer; Accounts Payable requires a supplier.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wm_assert_control_account_party_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM app_accounting_settings setting
     WHERE setting.account_id = NEW.account_id
       AND (
         (
           setting.setting_key = 'accounts_receivable'
           AND (
             COALESCE(NEW.party_type, '') <> 'customer'
             OR COALESCE(NULLIF(BTRIM(NEW.party_id), ''), '') = ''
           )
         )
         OR (
           setting.setting_key = 'accounts_payable'
           AND (
             COALESCE(NEW.party_type, '') <> 'supplier'
             OR COALESCE(NULLIF(BTRIM(NEW.party_id), ''), '') = ''
           )
         )
       )
  ) THEN
    RAISE EXCEPTION
      'control_account_party_required: updated control-account row lacks the required party'
      USING ERRCODE = '23514',
        HINT = 'Accounts Receivable requires a customer; Accounts Payable requires a supplier.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_gl_control_party_insert ON app_gl_entries;
CREATE TRIGGER app_gl_control_party_insert
AFTER INSERT ON app_gl_entries
REFERENCING NEW TABLE AS changed_gl
FOR EACH STATEMENT
EXECUTE FUNCTION wm_assert_control_account_party_insert();

DROP TRIGGER IF EXISTS app_gl_control_party_update ON app_gl_entries;
CREATE TRIGGER app_gl_control_party_update
BEFORE UPDATE OF account_id, party_type, party_id ON app_gl_entries
FOR EACH ROW
EXECUTE FUNCTION wm_assert_control_account_party_update();

CREATE OR REPLACE VIEW wm_control_account_exceptions AS
SELECT
  account.id AS account_id,
  account.account_code,
  account.account_name,
  setting.setting_key,
  COALESCE(gl.party_type, '') AS party_type,
  COALESCE(gl.party_id, '') AS party_id,
  count(*)::bigint AS row_count,
  min(gl.posting_date) AS first_posting_date,
  max(gl.posting_date) AS last_posting_date,
  COALESCE(sum(gl.debit), 0) AS debit,
  COALESCE(sum(gl.credit), 0) AS credit,
  COALESCE(sum(gl.debit - gl.credit), 0) AS balance
FROM app_gl_entries gl
JOIN app_accounting_settings setting
  ON setting.account_id = gl.account_id
 AND setting.setting_key IN ('accounts_receivable', 'accounts_payable')
JOIN app_accounts account ON account.id = gl.account_id
WHERE
  (
    setting.setting_key = 'accounts_receivable'
    AND (
      COALESCE(gl.party_type, '') <> 'customer'
      OR COALESCE(NULLIF(BTRIM(gl.party_id), ''), '') = ''
    )
  )
  OR
  (
    setting.setting_key = 'accounts_payable'
    AND (
      COALESCE(gl.party_type, '') <> 'supplier'
      OR COALESCE(NULLIF(BTRIM(gl.party_id), ''), '') = ''
    )
  )
GROUP BY
  account.id,
  account.account_code,
  account.account_name,
  setting.setting_key,
  COALESCE(gl.party_type, ''),
  COALESCE(gl.party_id, '');

DO $$
DECLARE
  runtime_role text;
BEGIN
  FOR runtime_role IN
    SELECT rolname FROM pg_roles WHERE rolname LIKE 'wm_inventory_runtime_%'
  LOOP
    EXECUTE format('GRANT SELECT ON wm_control_account_exceptions TO %I', runtime_role);
  END LOOP;
END;
$$;
