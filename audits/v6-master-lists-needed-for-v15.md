# ERPNext v6.24 Lists Needed For v15

Generated: 2026-06-25T06:30:46.063Z
Source database: 1bd3e0294d

## Core company/accounting structure

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Company | must_have | 1 | has data | SUPERTEX APA CO. LTD |
| Fiscal Year | must_have | 15 | has data | 2026, 2025, 2030 |
| Currency | must_have | 139 | has data | UGX, CONGOLESE FRANC, CNY |
| Account | must_have | 261 | has data | NSP2026 - SACL, P2021 - SACL, Accomodation Expense - SACL |
| Cost Center | must_have | 38 | has data | Mobile Five CTC - SACL, SUPERTEX APA CO. LTD - SACL, Mobile Three CTC - SACL |
| Mode of Payment | must_have | 39 | has data | Taff Mobile Five MOP, Taff Mobile Four MOP, Mobile Three MOP |
| Mode of Payment Account | child | 35 | has data | b1decd0bfa, e2dc1267bf, 0826f902a4 |
| Bank Account | useful_if_present |  | missing table |  |

## Stock/catalog setup

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Warehouse Type | must_have | 6 | has data | Others, Transit, Distribution Center |
| Warehouse | must_have | 51 | has data | Ordering Shop2Shop W/Hse - SACL, Mobile Five W/Hse - SACL, SKY Traders W/Hse - SACL |
| UOM | must_have | 13 | has data | 57, Oz, Lb |
| Brand | must_have | 28 | has data | TITAN, Exella, TRDA |
| Item Group | must_have | 15 | has data | Wires, All Item Groups, Products |
| Item | must_have | 2152 | has data | CC PETROL SAE50 API SF 5X6, CC DIESEL SAE50 API SF 5X6, CC 2T SAE30 API SF 5X6 |
| Item Price | must_have | 70287 | has data | ITEM-PRICE-61840, ITEM-PRICE-60558, ITEM-PRICE-63234 |
| Item Default | child_v15 |  | missing table |  |
| UOM Conversion Detail | child | 2152 | has data | 076441cf0f, 0883bd2a78, 50f97e7915 |
| Item Reorder | child | 0 | empty |  |
| Item Supplier | child | 1 | has data | a79dd35bd1 |

## Customers/sales setup

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Customer Group | must_have | 40 | has data | Taff Mobile Five CSTG, All Customer Groups, Taff Mobile Two CTSG |
| Territory | must_have | 17 | has data | Central, Mbale, Eastern |
| Customer | must_have | 2808 | has data | HALIMA-0757306767-KIBUYE, GIDEON SPARES -0756500375-HOIMA, CALTON 148R- 0777352024- KAMPALA |
| Sales Person | should_have | 6 | has data | Mambasa Japhale, Sales Team, Mugabi Junior |
| Sales Partner | useful_if_present | 0 | empty |  |
| Lead | optional_history | 3405 | has data | LEAD-03410, LEAD-03409, LEAD-03408 |
| Contact | should_have_if_present | 2002 | has data | HALIMA-0757306767-KIBUYE-HALIMA-0757306767-KIBUYE, GIDEON SPARES -0756500375-HOIMA-GIDEON SPARES -0756500375-HOIMA, CALTON 148R- 0777352024- KAMPALA-CALTON 148R- 0777352024- KAMPALA |
| Address | should_have_if_present | 60 | has data | SNB SPARE PARTS P.O BOX 605 KAMPALA, TEL 0772417661,0774276376,0702473484,0701045484.-Billing, ORYX OIL (U) LTD Phone 25641257066, 25631262120. FAX 25631262121.-Billing, VIVO ENERGY-Billing |
| Price List | must_have | 59 | has data | PLST MOBILE UNITS, PLST Taff Mbale WHSL, PLST Taff Kampala HQ |

## Suppliers/purchasing setup

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Supplier Type | v6_to_supplier_group | 15 | has data | Importer, Indigenous Holding Company, Employees |
| Supplier Group | v15_required |  | missing table |  |
| Supplier | must_have | 534 | has data | QINGDAO HUADA IND PCL, GUANGZHOU JONASSON IMPEX, LR LUCKY AUTO SPARE PARTS CENTER - 0701100567 |
| Manufacturer | useful_if_present | 0 | empty |  |

## HR setup

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Employee | should_have | 178 | has data | EMP/0172, EMP/0179, EMP/0178 |
| Department | should_have | 14 | has data | Stores, Legal, Research & Development |
| Designation | should_have | 30 | has data | Support Logistics Officer, Trading Officer, Logistic Manager |
| Employment Type | useful_if_present | 9 | has data | Company Driver, Apprentice, Intern |
| Branch | should_have | 28 | has data | Taff Bunia Branch, OK Extra Traders Branch, Taff Arua Branch |
| Holiday List | should_have | 1 | has data | Holidays |

## Taxes/terms/templates

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| Sales Taxes and Charges Template | must_have_if_taxed | 0 | empty |  |
| Sales Taxes and Charges | child | 0 | empty |  |
| Purchase Taxes and Charges Template | must_have_if_taxed | 3 | has data | VAT18 - SACL, WITHOLDING TAX6 - SACL, INCOME TAX30 - SACL |
| Purchase Taxes and Charges | child | 3 | has data | 7a8304f8c2, f50ddf759e, f95246806d |
| Terms and Conditions | should_have | 1 | has data | Terms on sale |
| Letter Head | should_have | 3 | has data | Standard., st, Standard |
| Print Format | already_customizations | 18 | has data | metaTest, New Format 20-12-2025, PrintTemp |

## Settings/singles

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| System Settings | settings | 23 | has data |  |
| Global Defaults | settings | 17 | has data |  |
| Accounts Settings | settings | 15 | has data |  |
| Stock Settings | settings | 23 | has data |  |
| Selling Settings | settings | 21 | has data |  |
| Buying Settings | settings | 17 | has data |  |
| Print Settings | settings | 17 | has data |  |
| HR Settings | settings | 13 | has data |  |

## Users/security

| List | Priority | Count/Fields | Status | Sample |
| --- | --- | ---: | --- | --- |
| User | manual_review | 77 | has data | danielomoding@gmail.com, cpustores@gmail.com, bouhani2004@yahoo.fr |
| Role | already_customizations | 50 | has data | Emergency, Fields Sales, Shop Manager |
| UserRole | manual_review | 601 | has data | 3a46fdea2e, 0f38f0a178, 5132478fa6 |
| User Permission | should_have_if_used |  | missing table |  |
| DocPerm | already_customizations | 717 | has data | 4a384e27c4, ade7348299, 7ce69964b7 |

## All Singleton Settings Present

| Setting DocType | Fields |
| --- | ---: |
| About Us Settings | 14 |
| Accounts Settings | 15 |
| Authorization Control | 10 |
| Bank Reconciliation | 16 |
| Blog Settings | 13 |
| BOM Replace Tool | 12 |
| Buying Settings | 17 |
| Contact Us Settings | 21 |
| Dropbox Backup | 16 |
| Employee Attendance Tool | 14 |
| Features Setup | 31 |
| Global Defaults | 17 |
| HR Settings | 13 |
| Hub Settings | 21 |
| Leave Control Panel | 19 |
| Manufacturing Settings | 19 |
| Naming Series | 15 |
| Notification Control | 27 |
| Payment Reconciliation | 19 |
| Payment Tool | 23 |
| Print Settings | 17 |
| Process Payroll | 17 |
| Production Planning Tool | 20 |
| Purchase Common | 10 |
| Rename Tool | 12 |
| Selling Settings | 21 |
| Shopify Settings | 32 |
| Shopping Cart Settings | 18 |
| SMS Center | 20 |
| SMS Settings | 14 |
| Social Login Keys | 16 |
| Stock Settings | 23 |
| System Settings | 23 |
| Test Gate Pass | 17 |
| Upload Attendance | 12 |
| Website Script | 11 |
| Website Settings | 31 |
