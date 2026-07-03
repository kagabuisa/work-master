# ERPNext v15 Transaction Smoke Test

Generated: 2026-06-26T11:38:16.705Z
Target: https://new.zenjji.com

## Result

- PASS: draft transaction creation and cleanup completed.

## Steps

| Step | Status | Document | Cleanup |
| --- | --- | --- | --- |
| Sales Invoice draft | ok | Sales Invoice SINV-00001 | deleted |
| Purchase Invoice draft | ok | Purchase Invoice ACC-PINV-2026-00003 | deleted |
| Stock Entry draft | ok | Stock Entry MAT-STE-2026-00001 | deleted |
| Payment Entry draft | ok | Payment Entry ACC-PAY-2026-00001 | deleted |

## Counts Before/After

| DocType | Before | After |
| --- | ---: | ---: |
| Sales Invoice | 4 | 4 |
| Purchase Invoice | 2 | 2 |
| Stock Entry | 0 | 0 |
| Payment Entry | 0 | 0 |

