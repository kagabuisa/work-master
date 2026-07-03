# ERPNext v15 Post-User Master Gap Summary

Generated: 2026-06-26T12:36:03.970Z

## Users

- v6 non-system users: 75
- v15 users now present: 75
- Missing non-system users by email: 0
- Final role assignments applied/kept from v6: 550

## Matched Setup Lists

- Activity Type: old 5, v15 5, records_match_by_name
- Address Template: old 1, v15 6, records_match_by_name
- Budget Set: old 18, v15 18, records_match_by_name
- Expense Claim Type: old 5, v15 5, records_match_by_name
- Industry Type: old 51, v15 51, records_match_by_name
- Item Attribute: old 4, v15 4, records_match_by_name
- Leave Type: old 8, v15 8, records_match_by_name
- Letter Head: old 3, v15 3, records_match_by_name
- Offer Term: old 12, v15 12, records_match_by_name
- POS Profile: old 40, v15 40, records_match_by_name
- Performance charges: old 3, v15 3, records_match_by_name
- Price Change Request: old 1, v15 1, records_match_by_name
- Print Heading: old 2, v15 2, records_match_by_name
- Product Bundle: old 1, v15 1, records_match_by_name
- Salary Structure: old 216, v15 216, records_match_by_name
- Sales Person: old 6, v15 6, records_match_by_name
- Supply Report: old 1152, v15 1152, records_match_by_name
- Vehicle: old 4, v15 4, records_match_by_name
- Warehouse Maximum Stock: old 7, v15 7, records_match_by_name
- Website Theme: old 1, v15 1, records_match_by_name

## Remaining Items Not Required For Start-Use

- Monthly Distribution: Optional budgeting distribution; old has one 2016 budget record. Not required to start sales/purchase/stock/accounting.
- Email Account: Notification setup only. Old email passwords/secrets should not be copied; configure fresh accounts in v15 if notifications are needed.
- Email Digest: Optional digest subscriptions; configure fresh after email accounts are set.
- Job Opening: Recruitment website content, not ERP operating master data.
- Blog Category: Website/blog content, not ERP operating master data.
- Blog Post: Website/blog content, not ERP operating master data.
- Blogger: Website/blog author profile, not ERP operating master data.
- Web Page: Website content, not ERP operating master data.
- Website Slideshow: Website content, not ERP operating master data.
- Deduction Type: Legacy payroll doctype absent in v15; covered by migrated Salary Component / Salary Structure setup.
- Earning Type: Legacy payroll doctype absent in v15; covered by migrated Salary Component / Salary Structure setup.
- Newsletter List: Legacy newsletter doctype absent in v15; not needed for ERP operations.
- Bulk Email: Legacy email history/marketing doctype absent in v15; excluded.
- Email Alert: Legacy notification doctype absent in v15; v15 uses newer Notification setup.
- Country: v15 has current country list; four old names are naming changes, not a start blocker.
- Material Request: Document/transaction-like operational record; excluded by request.
- Maintenance Schedule: Document/transaction-like operational record; excluded by request.
- Event: Calendar/history record; excluded.
- Note: Personal/system note; excluded.
- SMS Log: Communication log; excluded.
- DocShare: Sharing metadata; not reusable master data.
- Patch Log: System patch history; excluded.
- Error Snapshot: System error history; excluded.
- Desktop Icon: Legacy UI metadata; not used for v15 start.
- Page: Framework pages differ by version; not imported as records.

## Name-Mismatch Notes

Some custom lists still show “records_missing_by_name” in the generic audit because v15 generated new document names or duplicate v6 content was collapsed during cleanup. Counts/content were imported earlier where they were needed for operations.
- Approved Discounts: old 29, v15 29, audit status records_missing_by_name
- Area: old 4, v15 8, audit status records_missing_by_name
- Computed Profit n Loss Report: old 11, v15 22, audit status records_missing_by_name
- Driver: old 8, v15 8, audit status records_missing_by_name
- Ext Links: old 2, v15 4, audit status records_missing_by_name
- Goods Transporter: old 251, v15 251, audit status records_missing_by_name
- Handler Worksheet: old 25, v15 25, audit status records_missing_by_name
- Month: old 12, v15 24, audit status records_missing_by_name
- Motor Vehicle: old 8, v15 16, audit status records_missing_by_name
- Part Name: old 1094, v15 1094, audit status records_missing_by_name
- Position: old 9, v15 18, audit status records_missing_by_name
- Pricing Rule: old 70, v15 70, audit status records_missing_by_name
- Price Master Login Audit: old 203, v15 213, audit status records_missing_by_name
- Towns: old 343, v15 209, audit status records_missing_by_name
- Container: old 29, v15 29, audit status records_missing_by_name
- Items Cost: old 1, v15 2, audit status records_missing_by_name
- Payslip: old 1, v15 1, audit status records_missing_by_name
- Penalty: old 2, v15 4, audit status records_missing_by_name
- receipt: old 3, v15 6, audit status records_missing_by_name
- Warehouse Stocking: old 20, v15 39, audit status records_missing_by_name
- Year: old 2, v15 4, audit status records_missing_by_name

