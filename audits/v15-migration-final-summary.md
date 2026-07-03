# ERPNext v6 to v15 Customization Migration Summary

Generated: 2026-06-24T12:02:23.775Z

## Completed

| Area | Source | Migrated / Verified | Notes |
| --- | ---: | ---: | --- |
| Custom DocTypes | 65 | 65 | Workflow skipped by request. |
| Custom DocType fields | 695 | included in DocTypes | 13 fieldnames normalized for v15. |
| Custom fields | 179 | 179 | 2 already standard/DocType fields in v15. |
| Property setters | 310 | 95 | Obsolete v6 layout setters skipped. |
| Custom roles | 14 | 14 | Missing roles: 0. |
| Custom DocType permissions | 131 | 58 DocTypes checked | Child table permissions are parent-controlled in v15. |
| Client scripts | 33 | 32 | 2 Vehicle Log scripts merged into one. |
| Non-standard reports | 35 | 35 | Report Builder field warnings fixed: yes. |
| Custom print formats | 12 | 12 | Standard old formats skipped. |
| Default print format setters | 2 usable | 2 | Asset Register and Stock Entry. |

## Skipped Or Deferred

- Workflow: skipped by request; old workflow was inactive.
- Old standard print formats: skipped to avoid overwriting ERPNext 15 standard formats.
- Obsolete property setters: old `width` and `read_only_onload` values were skipped.
- Standard/existing v15 DocTypes named `Warehouse Type`, `Driver`, `Vehicle`, and `Vehicle Log` were not overwritten.

## Important Adjustments

- Some old standalone DocTypes had to become child tables because v15 requires Table field targets to be child DocTypes. This includes `Charges on Salary`, used by `Salary Slip.charges_to_recover`.
- Report cleanup renamed clear equivalents such as `Pending Payments.pending_amount` to `pending_payment`, `Salary Slip.month` to `month2`, and `Item.category` to `item_category`.
- Report cleanup dropped fields without safe v15 parent-field equivalents, such as `Sales Invoice.mode_of_payment` and `Item.default_warehouse`.

## Manual Test Checklist

1. Create/open `Salary Slip` and confirm `Charges to recover` rows work under the charges section.
2. Open and save `Sales Invoice`, `Stock Entry`, `Daily Activity Report`, `Journal Entry`, and `Salary Slip` to check migrated client scripts.
3. Print `Asset Register` and `Stock Entry` using their default print formats.
4. Run the 7 Query Reports and verify SQL results, because raw SQL can still break on ERPNext 15 schema changes.
5. Run the 28 Report Builder reports and confirm the dropped columns are acceptable to users.
6. Check role access with a non-Administrator test user for `Director`, `CPU Managers`, `Store Manager`, `Accountant`, and `Fields Sales`.

## Key Files

- audits/v15-client-script-import-log.json
- audits/v15-client-script-verification.json
- audits/v15-custom-doctype-field-renames.json
- audits/v15-custom-doctype-import-log.json
- audits/v15-custom-doctype-verification.json
- audits/v15-custom-field-import-log.json
- audits/v15-custom-field-verification.json
- audits/v15-default-print-format-setters-log.json
- audits/v15-print-format-import-log.json
- audits/v15-print-format-verification.json
- audits/v15-property-setter-import-log.json
- audits/v15-property-setter-verification.json
- audits/v15-report-field-fix-log.json
- audits/v15-report-import-log.json
- audits/v15-report-live-field-validation.json
- audits/v15-report-verification.json
- audits/v15-roles-permissions-import-log.json
- audits/v15-roles-permissions-verification.json
