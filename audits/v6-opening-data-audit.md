# ERPNext v6 Opening Data Audit

Generated: 2026-06-25T19:12:17.274Z
Old database: `1bd3e0294d`
V15 target: https://new.zenjji.com

## Cutoff Signals

| Area | Rows | Min Date | Max Date |
| --- | --- | --- | --- |
| GL Entry | 1892987 | Wed Jun 01 2016 00:00:00 GMT+0300 (East Africa Time) | Wed Dec 30 2026 00:00:00 GMT+0300 (East Africa Time) |
| Stock Ledger Entry | 2814236 | Wed Jun 01 2016 00:00:00 GMT+0300 (East Africa Time) | Wed Dec 30 2026 00:00:00 GMT+0300 (East Africa Time) |

## V15 Transaction Counts

| DocType | Count |
| --- | --- |
| GL Entry | 6 |
| Stock Ledger Entry | 5 |
| Sales Invoice | 4 |
| Purchase Invoice | 2 |
| Journal Entry | 1 |
| Stock Entry | 0 |
| Stock Reconciliation | 0 |
| Payment Entry | 0 |

## Accounting Opening

- Non-zero account balances: 183
- Total debit balance: 92683389948.11
- Total credit balance: 92752330948.11
- Net balance check: -68941000
- Non-zero party balances: 103

Top account balances by absolute value:

| Account | Balance |
| --- | --- |
| Sales - SACL | -69882945389.19 |
| Cost of Goods Sold - SACL | 65176566226.99 |
| Creditors - SACL | -13686074077 |
| Stanbic Bank(KAGABU ISA) USD 930014867111 - SACL | 12607895357 |
| Stock Received But Not Billed - SACL | -7228539247.3 |
| Clearing and Forwarding MBSA/KLA - SACL | 4445456050 |
| Opening Balance Equity - SACL | -1749552112.62 |
| CPU Stores WHse - SACL | 1564738535.35 |
| Rent - SACL | 1175926325 |
| Salary - SACL | 1158842764 |
| Kagabu Isa - SACL | 577388481 |
| Freight Expenses - SACL | 525564831 |
| Imports Handling Expenses - SACL | 414231852 |
| Motor Vehicle Fuel - SACL | 336400092 |
| Staff Meals and Refreshments - SACL | 271454500 |
| Travel Expenses - SACL | 271168003 |
| Stock Adjustment - SACL | 228121039.26 |
| VAT Payments - SACL | 219611454 |
| Other Income - SACL | -189030734 |
| Vehicles - SACL | 164370630 |

## Stock Opening

- Non-zero item/warehouse bins: 4945
- Total stock value from Bin: 2371158062
- Negative quantity bins: 5
- Negative value bins: 2

Top stock bins by absolute value:

| Item | Warehouse | Qty | Value |
| --- | --- | --- | --- |
| TAFF BUTYL 3.00-17-TUBES | CPU Stores WHse - SACL | 10251 | 75176593 |
| BULB HEADLAMP S25 12V35/35W | CPU Stores WHse - SACL | 106419 | 71504820 |
| SPARK PLUG D8TC(RED) TAFF | CPU Stores WHse - SACL | 64440 | 68662000 |
| CABLE ACCELERATOR TAFF-BM100 | CPU Stores WHse - SACL | 25440 | 58512000 |
| BATTERY TAFF YB6.5 12V6.5AH WET CG125 | CPU Stores WHse - SACL | 1671 | 55782326 |
| SHOCK ABSORBER RR TAFF-BM100 | CPU Stores WHse - SACL | 2262 | 50885587 |
| FRONT FENDER N/M-BM100 | CPU Stores WHse - SACL | 1655 | 32830000 |
| MOTORCYCLE UMBRELLA | CPU Stores WHse - SACL | 773 | 30920000 |
| BEARING 6004 | CPU Stores WHse - SACL | 22250 | 29405033 |
| TITAN FORTRESS 3.00-17 GJIE-TYRE | CPU Stores WHse - SACL | 445 | 28925000 |
| BEARING 6300 | CPU Stores WHse - SACL | 19420 | 26290688 |
| BEARING 628 | CPU Stores WHse - SACL | 29870 | 25389500 |
| BULB HEADLAMP SPORT XENON-HID | CPU Stores WHse - SACL | 21000 | 25200000 |
| BEARING 6301 | CPU Stores WHse - SACL | 19420 | 24440000 |
| FUEL TANK COVER-BM100 | CPU Stores WHse - SACL | 5050 | 22725000 |
| HUB FR-BM100 | CPU Stores WHse - SACL | 988 | 22724000 |
| RADIO & MP3 PLAYER BIG | CPU Stores WHse - SACL | 740 | 22200000 |
| PISTON KIT STD++ TAFF-BM100 | CPU Stores WHse - SACL | 2610 | 22161257 |
| SPARK PLUG A7TC(WHITE) TAFF | CPU Stores WHse - SACL | 21090 | 20035500 |
| CARBURETOR ASSY-BM100 | CPU Stores WHse - SACL | 995 | 19900000 |

## Outstanding Invoices

| Type | Count | Total Outstanding |
| --- | --- | --- |
| Sales Invoice | 64 | 41670881 |
| Purchase Invoice | 54 | 15482909152 |

## Recommended Next Step

- Confirm the opening cutoff date to use for v15. The latest v6 GL and stock dates are shown above.
- After the cutoff is confirmed, prepare opening Journal Entry lines from the account balances and Stock Reconciliation rows from the non-zero bins.
- Importing open Sales/Purchase Invoices separately is better than only using party balances if invoice-level aging and allocation history must continue in v15.

