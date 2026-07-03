# ERPNext v15 Readiness Verification

Generated: 2026-06-25T19:07:15.066Z
Target: https://new.zenjji.com

## Counts

| List | Old/Expected | V15 | Delta | Status |
| --- | --- | --- | --- | --- |
| Company | 1 | 1 | 0 | ok |
| Fiscal Year | 15 | 15 | 0 | ok |
| Currency | 139 | 155 | 16 | ok |
| Account | 261 | 297 | 36 | ok |
| Cost Center | 38 | 39 | 1 | ok |
| Warehouse Type | 6 | 6 | 0 | ok |
| Warehouse | 51 | 63 | 12 | ok |
| UOM | 13 | 244 | 231 | ok |
| Brand | 28 | 28 | 0 | ok |
| Item Group | 15 | 15 | 0 | ok |
| Price List | 59 | 69 | 10 | ok |
| Branch | 28 | 28 | 0 | ok |
| Mode of Payment | 39 | 39 | 0 | ok |
| Supplier | 534 | 534 | 0 | ok |
| Customer | 2808 | 2796 | -12 | ok |
| Employee | 178 | 181 | 3 | ok |
| Item Category | 27 | 28 | 1 | ok |
| Item | 2152 | 2152 | 0 | ok |
| Item Price | 69541 | 69541 | 0 | ok |
| Department | 14 | 15 | 1 | ok |
| Designation | 30 | 47 | 17 | ok |
| Employment Type | 9 | 9 | 0 | ok |
| Holiday List | 1 | 1 | 0 | ok |
| Territory | 17 | 19 | 2 | ok |
| Customer Group | 40 | 45 | 5 | ok |
| Supplier Group | 15 | 16 | 1 | ok |
| Terms and Conditions | 1 | 1 | 0 | ok |
| Purchase Taxes and Charges Template | 3 | 4 | 1 | ok |
| Contact | 2002 | 2358 | 356 | ok |
| Address | 60 | 38 | -22 | review |

## Blockers

- None found in this verification.

## Warnings / Review

- Address: v15 has 38, expected 60; review note applies.
- Address: 22 old address row(s) were skipped because no valid target link could be mapped.
- Features Setup: GET /api/resource/Features%20Setup/Features%20Setup failed 500 (500)

## Specific Checks

- Blank Item Category in v15 Items: 0
- Latest unique v6 Item Price rows expected in v15: 69541
- Historical duplicate v6 Item Price rows intentionally skipped: 746
- Address rows skipped because they had no valid Customer/Supplier/Company link: 22

