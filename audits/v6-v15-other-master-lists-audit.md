# ERPNext v6 Other Master/Setup Lists Audit

Generated: 2026-06-26T12:35:10.258Z
Old database: `1bd3e0294d`
V15 target: https://new.zenjji.com

Scope: reusable master/setup lists only. Transaction/opening data is intentionally excluded from recommendations.

## Start-Use Review Items

| DocType | Priority | Old | V15 DocType | V15 Records | Status | Sample Missing/Old Records |
| --- | --- | --- | --- | --- | --- | --- |
| Sales Team | should_import_child_if_parent_transactions_later | 418 | yes |  | v15_count_error | 6a34102a55, 8e4cd6bd9f, 201a3d9ad7, 750e8d5a78, 2521fc071e |
| Salary Structure | should_import_if_payroll_used | 216 | yes | 216 | records_match_by_name | EMP/0172/SST/00002, EMP/0172/SST/00001, EMP/0179/SST/00001, EMP/0178/SST/00001, EMP/0177/SST/00001 |
| Leave Type | should_import_if_hr_used | 8 | yes | 8 | records_match_by_name | graduation leave, Privilege Leave, Leave with Pay, Sick Leave, Maternity Leave |
| Sales Person | should_import | 6 | yes | 6 | records_match_by_name | Mambasa Japhale, Sales Team, Mugabi Junior, Ijosia Toha, Okello Patrick |
| Letter Head | should_import | 3 | yes | 3 | records_match_by_name | Standard., st, Standard |
| Pricing Rule | review_if_discount_rules_used | 70 | yes | 70 | records_missing_by_name | 5 or More Cartons Price - Total Quartz Mwesigwa Mbarara, Accel Oilibya, AFRO Carton Price - Mwesigwa Mbarara, AXCL GTX Discounted, Brake Pedal Carton Price |
| POS Profile | review_if_pos_used | 40 | yes | 40 | records_match_by_name | 92dd482496, 7211eefd71, dc2a27d678, a9f7556180, de5b57686f |
| Approved Discounts | review_if_sales_discount_control_used | 29 | yes | 29 | records_missing_by_name | DISC-00031, DISC-00032, DISC-00034, DISC-00035, DISC-00036 |
| Top3AVGSales | review_custom_master | 7121 | yes |  | v15_count_error | T3AVGS-0018243, T3AVGS-0018240, T3AVGS-0018241, T3AVGS-0018239, T3AVGS-0018242 |
| Lead Followup | review_custom_master | 3226 | yes |  | v15_count_error | 62497d62ed, d5c77dcb7a, fc13638b66, afda401082, abb9ea2cf8 |
| maximum stock | review_custom_master | 2429 | yes |  | v15_count_error | 031096870d, 02676a1ec2, 0698f6925f, MAXSTK000121, 0116053367 |
| Difference report Details | review_custom_master | 1357 | yes |  | v15_count_error | 3bf4aaaefa, 3693a09864, 418b3dd9a3, 258d56e865, 8f92d033a1 |
| Supply Report | review_custom_master | 1152 | yes | 1152 | records_match_by_name | SUPRPT-0001152, SUPRPT-0001151, SUPRPT-0001150, SUPRPT-0001149, SUPRPT-0001148 |
| Part Name | review_custom_master | 1094 | yes | 1094 | records_missing_by_name | 007618005e, 00d2dceec0, 00e4dc979e, 00edaaf3b0, 010f450ab6 |
| Budget details | review_custom_master | 720 | yes |  | v15_count_error | 044eaef308, 160b6273d8, 2f7a9981a7, 034b0a0bc7, 0267536215 |
| Charges on Salary | review_custom_master | 642 | yes |  | v15_count_error | c0994c5939, 812d11431c, 6b8d9fb16e, 09af1dc8ce, 7d79765d54 |
| Vehicle Log Details | review_custom_master | 464 | yes |  | v15_count_error | 091a99b745, 28cc516d00, ef65791116, 4939a04111, a92148ad5c |
| Towns | review_custom_master | 343 | yes | 209 | records_missing_by_name | Abuko, AGAGO, AGWOK, AKABA, AKWORO |
| Goods Transporter | review_custom_master | 251 | yes | 251 | records_missing_by_name | 0701311708, 07066810398, 0706810398, 0773740086, 0782590761 |
| Price Master Login Audit | review_custom_master | 203 | yes | 213 | records_missing_by_name | 00e7729700, 01a1d81bde, 02831d42a4, 0293212057, 02c9597e92 |
| Container | review_custom_master | 29 | yes | 29 | records_missing_by_name | 114b73d879, CTR-0019, CXDU2121091, DFSU6379847, e921918399 |
| Handler Worksheet | review_custom_master | 25 | yes | 25 | records_missing_by_name | HWS-00026, HWS-00027 |
| Warehouse Stocking | review_custom_master | 20 | yes | 39 | records_missing_by_name | WASTK-0000040, WASTK-0000041, WASTK-0000042 |
| Budget Set | review_custom_master | 18 | yes | 18 | records_match_by_name | BGT-000001, BGT-000006, BGT-000012, BGT-000004, BGT-000013 |
| Payment Details | review_custom_master | 14 | yes |  | v15_count_error | 6b9049b933, 7f8261738a, 1846eba40d, dfe4a509b8, bb3d4c8ef4 |
| Month | review_custom_master | 12 | yes | 24 | records_missing_by_name | April, August, December, February, January |
| Computed Profit n Loss Report | review_custom_master | 11 | yes | 22 | records_missing_by_name | 0312f6120f, 31-08-2017, 36f32f8b70, 468402f524, 63dd5c1ade |
| PoorQuality | review_custom_master | 11 | yes |  | v15_count_error | fd833c2f0d, 072cc1d959, 0a92a21ea4, 0db7b401c0, 10b618a023 |
| Position | review_custom_master | 9 | yes | 18 | records_missing_by_name | Administrator, Assesment Trainee, Handler, In-Charge CPU, Internal Auditor |
| Warehouse Maximum Stock | review_custom_master | 7 | yes | 7 | records_match_by_name | WMS0007, WMS0001, WMS0004, WMS0005, WMS0006 |
| receipt | review_custom_master | 3 | yes | 6 | records_missing_by_name | 1a688024bc, 68cab85e4d, e266f8f353 |
| Penalty | review_custom_master | 2 | yes | 4 | records_missing_by_name | 2ac8a20c52, e494c097b9 |
| Year | review_custom_master | 2 | yes | 4 | records_missing_by_name | 2016, 2017 |
| Items Cost | review_custom_master | 1 | yes | 2 | records_missing_by_name | MAIN SHAFT - BXR |
| Payslip | review_custom_master | 1 | yes | 1 | records_missing_by_name | 039f9bb992 |
| Price Change Request | review_custom_master | 1 | yes | 1 | records_match_by_name | PCR-000001 |
| Daily Activity Report | optional_history | 59980 | yes | 1 | v15_has_records_unmapped | DAR-060572, DAR-060571, DAR-060570, DAR-060569, DAR-060568 |
| Delivery Details | optional_history | 11182 | yes |  | v15_count_error | 2554f50e3d, 2eb73d25c3, 2ff9eb59fa, 18d34ddd6a, 3b42f9b1e3 |
| CPU Daily Delivery Report | optional_history | 2323 | yes | 0 | v15_empty | 2026-06-23, 2026-06-20, 2026-06-19, 2026-06-18, 2026-06-17 |
| Gate  Pass | optional_history | 1460 | yes | 0 | records_missing_by_name | ebd28d8812, GPS-0000001, GPS-0000002, GPS-0000003, GPS-0000004 |
| Audit Report | optional_history | 1110 | yes | 0 | records_missing_by_name | AUR-0000002, AUR-0000003, AUR-0000004, AUR-0000005, AUR-0000006 |
| Vehicle Log Book | optional_history | 471 | yes | 0 | records_missing_by_name | TRIP-0000001, TRIP-0000002, TRIP-0000003, TRIP-0000004, TRIP-0000005 |
| Delivery Difference Report | optional_history | 431 | yes | 0 | records_missing_by_name | 1f841d45a3, 2424a3f6ef, 3bae6fcc3f, 720f079f37, 80b317b902 |
| Order Report | optional_history | 254 | yes | 0 | records_missing_by_name | ORPT-00002, ORPT-00003, ORPT-00004, ORPT-00005, ORPT-00006 |
| Shop Visit Details | optional_history | 240 | yes | 0 | records_missing_by_name | 001189e9a2, 00a8ff3493, 03d1a59321, 04551b1c4f, 051c0eb94d |
| Trip Plan-Report | optional_history | 123 | yes | 0 | records_missing_by_name | TPR-00003, TPR-00004, TPR-00005, TPR-00006, TPR-00007 |
| Vehicle Log | optional_history | 94 | yes | 0 | records_missing_by_name | TRIP00003, TRIP00004, TRIP00006, TRIP00011, TRIP00012 |
| Shop visit | optional_history | 33 | yes | 0 | records_missing_by_name | SVR-00001, SVR-00002, SVR-00003, SVR-00004, SVR-00005 |
| Pending Payments | optional_history | 25 | yes | 0 | records_missing_by_name | PeP-00001, PeP-00002, PeP-00003, PeP-00004, PeP-00005 |
| Sales report | optional_history | 12 | yes | 0 | records_missing_by_name | [SRP000001, 08e68cdae2, 47f44e9fac, 5880617296, 5fe0cc3dc0 |
| Net Asset Value - Balance Sheet | optional_history | 11 | yes | 0 | records_missing_by_name | 19789d2ec5, 2017-10-31, 2017-11-30, 2017-12-31, 2018-01-31 |
| Driver | optional_custom_operations | 8 | yes | 8 | records_missing_by_name | 2a0a4f6ee3, Akello Judith, Bagenda William, d087a2cc51, James Rwatoro |
| Motor Vehicle | optional_custom_operations | 8 | yes | 16 | records_missing_by_name | 034d4d3d02, 12fb0d7ca6, 25111afb87, 288fcbf53a, 90ea72d4a9 |
| Email Account | optional_notifications | 6 | yes | 2 | records_missing_by_name | Kagabu Isa, Notifications, Replies, Sales, Support |
| Payment Voucher | optional_history | 5 | yes | 0 | records_missing_by_name | d76148dc52, Pay_ID-000001, Pay_ID-000002, Pay_ID-000003, Pay_ID-000004 |
| Area | optional_custom_operations | 4 | yes | 8 | records_missing_by_name | 42c552ed46, 836591b281, 95951f8ecf, 9c33a7f28e |
| Vehicle | optional_custom_operations | 4 | yes | 4 | records_match_by_name | UFL 809F, UBE-089Y, UAT-939Y, UAU-615A |
| Asset Register | optional_history | 3 | yes | 0 | records_missing_by_name | Asset_ID-000001, Asset_ID-000002, Asset_ID-000003 |
| Performance charges | optional_custom_operations | 3 | yes | 3 | records_match_by_name | PCH-00003, PCH-00002, PCH-00001 |
| Email Digest | optional_notifications | 2 | yes | 0 | records_missing_by_name | Default Weekly Digest - SUPERTEX APA CO. LTD, Scheduler Errors |
| Ext Links | optional_custom_operations | 2 | yes | 4 | records_missing_by_name | cf330dd1a6, Vmoennsply7 |
| Monthly Distribution | optional_budgeting | 1 | yes | 0 | records_missing_by_name | Budget 2016 |
| Sales Invoice Item | child_table_review_only | 2194193 | yes |  | v15_count_error | dfa5d00456, b45a39a5b0, d94a694c7c, 8f6ac5e882, 3ab4f7c77e |
| Journal Entry Account | child_table_review_only | 416296 | yes |  | v15_count_error | 3183a5e4d1, a3440c4866, 2f850d9c7d, af9acb7a68, 518b089114 |
| Stock Entry Detail | child_table_review_only | 249936 | yes |  | v15_count_error | 3278f15166, 386858093d, 5ee67b58d1, 11ce8dff9a, 4b6dee3c9b |
| Stock Reconciliation Item | child_table_review_only | 113922 | yes |  | v15_count_error | e6b96ee1f6, 6ac8b9566b, c1aaf512fd, e93960a9e5, edcb6a3a8e |
| Purchase Receipt Item | child_table_review_only | 64969 | yes |  | v15_count_error | 5f7524e039, a63d2dd1f4, 6b4728b1aa, fa005b9edc, 6dd23b99ef |
| Purchase Invoice Item | child_table_review_only | 61024 | yes |  | v15_count_error | 2702f0ce8e, 85ea498b90, 0acfec7dc4, cba4ca3d7e, 8377cce9c6 |
| Purchase Order Item | child_table_review_only | 14749 | yes |  | v15_count_error | dcb326af07, 161c5f4c40, 137da02fcc, 14a3322bad, 14a2292791 |
| DocShare | review_standard_setup | 8810 | yes | 75 | v15_has_records_unmapped | ba65dbc301, 16041eef24, 31d5c599f8, 289bb745b7, fd1fff4d0f |
| Salary Slip Earning | child_table_review_only | 7063 | no |  | doctype_missing_in_v15 | 719e0ff773, 76647b212e, af68cc2dca, 97887650b6, 41db9cc29f |
| Salary Slip Deduction | child_table_review_only | 5598 | no |  | doctype_missing_in_v15 | 588808e506, 0ba13a5526, 9298e5f67a, 9940813b2f, 97c29b5ad9 |
| DefaultValue | child_table_review_only | 5347 | yes |  | v15_count_error | 0e27003285, 7c2b7e8d5f, 813fde55ab, b462a86355, 2a51653a38 |
| UOM Conversion Detail | child_table_review_only | 2152 | yes |  | v15_count_error | 076441cf0f, 0883bd2a78, 50f97e7915, f97cb0748d, d2e94e7dfd |
| Bulk Email | review_standard_setup | 1014 | no |  | doctype_missing_in_v15 | 0a1635651a, 814fca7981, f1601ba7e2, dff5060be1, 5c20083e1c |
| Desktop Icon | review_standard_setup | 668 | yes | 0 | records_missing_by_name | 00dcbce54e, 0280b45589, 0308de7583, 033d788394, 03766c35e4 |
| Salary Structure Deduction | child_table_review_only | 479 | no |  | doctype_missing_in_v15 | 85dbfe3828, 968bff2ee1, 0b905dffb0, c5d9824ba7, 28b2926ddb |
| Patch Log | review_standard_setup | 378 | yes | 718 | records_missing_by_name | PATCHLOG00001, PATCHLOG00002, PATCHLOG00003, PATCHLOG00004, PATCHLOG00005 |
| Salary Structure Earning | child_table_review_only | 313 | no |  | doctype_missing_in_v15 | 0e934db362, bb3ee2187f, 5941f72bac, 07e02818cb, 192aecd503 |
| Country | review_standard_setup | 249 | yes | 250 | records_missing_by_name | Iran, Islamic Republic of, Macedonia, Republic of, Syrian Arab Republic, Tanzania, United Republic of |
| Material Request Item | child_table_review_only | 244 | yes |  | v15_count_error | ffa0c5ada8, 013af665e3, 02a85ca654, 030ae6fd5a, 033e14bc33 |
| Event | review_standard_setup | 231 | yes | 0 | records_missing_by_name | EV00001, EV00003, EV00004, EV00005, EV00006 |
| Block Module | child_table_review_only | 206 | yes |  | v15_count_error | 33b55a8290, 52c1a9e1c3, 661d9005f6, 10cc06b1da, 2c1b1f8443 |
| Employee Education | child_table_review_only | 171 | yes |  | v15_count_error | f51080a08e, 22abc41ea7, dfce0bb27f, 8778458893, c32c93d45b |
| Handler Worksheet Details | child_table_review_only | 131 | yes |  | v15_count_error | eb89431e89, 31c315ab61, e3bdbda259, 59fc1df8ad, 3758692130 |
| Employee External Work History | child_table_review_only | 85 | yes |  | v15_count_error | 5ef4fc7a08, ebb03aa1a6, 1b517ce61d, 14856ce7a0, d2152220a2 |
| User | review_standard_setup | 77 | yes | 75 | records_missing_by_name | 3RDCPUAUDITOR@gmail.com, Administrator, Churchillocaya@gmail.com, Guest |
| Industry Type | review_standard_setup | 51 | yes | 51 | records_match_by_name | Venture Capital, Transportation, Television, Telecommunications, Technology |
| Mode of Payment Account | child_table_review_only | 35 | yes |  | v15_count_error | b1decd0bfa, e2dc1267bf, 0826f902a4, c576326831, e53a08d5e6 |
| Page Role | child_table_review_only | 33 | no |  | doctype_missing_in_v15 | 7e95c8fbeb, 2ac5d212b4, 1f1f33f4e2, e606f5dc1e, 5d2590bd21 |
| Sales Order Item | child_table_review_only | 33 | yes |  | v15_count_error | 00fb65c819, 0f3d93f08d, 3cf67f7861, 151f72e768, 478c034603 |
| Salesrptdetails | child_table_review_only | 30 | yes |  | v15_count_error | d6b4ef8246, 555d2882f1, e9958b519e, 034276acd8, 8132cd3669 |
| Employee Leave Approver | child_table_review_only | 29 | no |  | doctype_missing_in_v15 | de8fb220b2, cf852643b6, fd397d6a4f, d598d1f7b9, 64de0201bd |
| Page | review_standard_setup | 24 | yes | 18 | records_missing_by_name | Accounts Browser, activity, applications, bom-browser, data-import-tool |
| Budget Detail | child_table_review_only | 22 | no |  | doctype_missing_in_v15 | f8aa47fe00, 48562d6342, 55bba8a30f, 5867b68b41, 593d1c9923 |
| Web Form Field | child_table_review_only | 22 | yes |  | v15_count_error | 0be44fe1e1, ee3d84d943, dcf1b10375, c83cab85d8, 7c832ba8d9 |
| Deduction Type | review_standard_setup | 21 | no |  | doctype_missing_in_v15 | Missing Reports, Employee Loan, surcharge, Missing banking report, Debt recovery. |
| Item Attribute Value | child_table_review_only | 19 | yes |  | v15_count_error | f488c1e5ce, 59ec350a77, 32772c3736, 3f4845a74f, 81b3ccf9ee |
| Landed Cost Taxes and Charges | child_table_review_only | 16 | yes |  | v15_count_error | 0bc54c5f4e, 863f733dd3, 39d3bed9a2, 6008cab259, 787ce5ac0e |
| Price List Country | child_table_review_only | 15 | yes |  | v15_count_error | 9fbe91e9cf, 798367cdb3, 0fd3c0484d, 681e9661a9, 5dfe71d1de |
| Fiscal Year Company | child_table_review_only | 13 | yes |  | v15_count_error | 3bb44b9879, 2dcfaa57c7, 2db690de50, da7be010c9, 437aed86c2 |
| Monthly Distribution Percentage | child_table_review_only | 12 | yes |  | v15_count_error | f2e31ca70f, 0c21383446, 4253f51a21, 57a9f868a0, 69b7d8890c |
| Offer Term | review_standard_setup | 12 | yes | 12 | records_match_by_name | Incentives, Notice Period, Leaves per Year, Responsibilities, Job Description |
| Quotation Item | child_table_review_only | 11 | yes |  | v15_count_error | QUOD/00011, QUOD/00009, QUOD/00010, QUOD/00008, QUOD/00007 |
| Blog Post | review_standard_setup | 10 | yes | 0 | records_missing_by_name | audit-review, cpu-bulk-order, edited-analysed-shop-orders, excess-items-on-order, inventory-management |
| Earning Type | review_standard_setup | 10 | no |  | doctype_missing_in_v15 | Wage Pay, Other Allowances, Debts Collected, Basic Salary, Commission on performance |
| Sales invoiced | child_table_review_only | 7 | yes |  | v15_count_error | 967ad652d8, b0126fcf4c, dc07c77641, 52190333b0, ba3811e0d0 |
| SMS Log | review_standard_setup | 7 | yes | 0 | records_missing_by_name | SMSLOG/00000001, SMSLOG/00000002, SMSLOG/00000003, SMSLOG/00000004, SMSLOG/00000005 |
| Blog Category | review_standard_setup | 6 | yes | 0 | records_missing_by_name | Audit & Internal Review, Finance, general, Inventory Management, Order Management |
| Activity Type | review_standard_setup | 5 | yes | 5 | records_match_by_name | Communication, Execution, Proposal Writing, Research, Planning |
| Expense Claim Type | review_standard_setup | 5 | yes | 5 | records_match_by_name | Travel, Others, Medical, Food, Calls |
| Note | review_standard_setup | 5 | yes | 0 | records_missing_by_name | Discussion Junior Kabale Giant AS 04-03-2019, Incorrect number of General Ledger Entries found. You might have selected a wrong Account in the transaction., Metabase, Mulitple Tradrex, Password |
| Error Snapshot | review_standard_setup | 4 | no |  | doctype_missing_in_v15 | 7f0417d9cf, 917d5722c2, 4ffd2f7c39, 6301d4b0da |
| Item Attribute | review_standard_setup | 4 | yes | 4 | records_match_by_name | Category, Brand, Colour, Size |
| Party Account | child_table_review_only | 4 | yes |  | v15_count_error | b59377a399, c184f2803a, d8be84f1b5, d5582141d6 |
| Currency Exchange | review_standard_setup | 3 | yes | 3 | records_missing_by_name | CNY-UGX, USD-CNY, USD-UGX |
| Maintenance Schedule Detail | child_table_review_only | 3 | yes |  | v15_count_error | 24f71b5c76, 6005d193dc, f9f2320335 |
| Purchase Taxes and Charges | child_table_review_only | 3 | yes |  | v15_count_error | 7a8304f8c2, f50ddf759e, f95246806d |
| SMS Parameter | child_table_review_only | 3 | yes |  | v15_count_error | 086dbb1d25, 4b8a6d444b, e80e125fd7 |
| Target Detail | child_table_review_only | 3 | yes |  | v15_count_error | d6353a881c, 4925eef061, 262f0c93f2 |
| Web Form | review_standard_setup | 3 | yes | 7 | records_missing_by_name | job_application |
| Workflow Document State | child_table_review_only | 3 | yes |  | v15_count_error | 3ab6dd0e74, 6f1cea0cf2, ef6c59e343 |
| Item Website Specification | child_table_review_only | 2 | yes |  | v15_count_error | 30d6aea30d, e24b938d3c |
| Job Opening | review_standard_setup | 2 | yes | 0 | records_missing_by_name | Jobs, management-trainee |
| Print Heading | review_standard_setup | 2 | yes | 2 | records_match_by_name | Debit Note, Credit Note |
| Purchase Invoice Advance | child_table_review_only | 2 | yes |  | v15_count_error | 01bccd0ee9, 172bd9fa8a |
| Web Page | review_standard_setup | 2 | yes | 0 | records_missing_by_name | supertex-apa-co-ltd, zenjji_bi |
| Address Template | review_standard_setup | 1 | yes | 6 | records_match_by_name | Uganda |
| Blogger | review_standard_setup | 1 | yes | 0 | records_missing_by_name | isa |
| Email Alert | review_standard_setup | 1 | no |  | doctype_missing_in_v15 | 6455d6a062 |
| Email Alert Recipient | child_table_review_only | 1 | no |  | doctype_missing_in_v15 | e2e298a43d |
| Employee Internal Work History | child_table_review_only | 1 | yes |  | v15_count_error | fdc36662ea |
| Event Role | child_table_review_only | 1 | no |  | doctype_missing_in_v15 | fd0c74ca73 |
| Item Supplier | child_table_review_only | 1 | yes |  | v15_count_error | a79dd35bd1 |
| Maintenance Schedule | review_standard_setup | 1 | yes | 0 | records_missing_by_name | MS00001 |
| Maintenance Schedule Item | child_table_review_only | 1 | yes |  | v15_count_error | c1c35d25c2 |
| Material Request | review_standard_setup | 1 | yes | 0 | records_missing_by_name | MREQ-00001 |
| Newsletter List | review_standard_setup | 1 | no |  | doctype_missing_in_v15 | Supertex |
| Product Bundle | review_standard_setup | 1 | yes | 1 | records_match_by_name | Shell HX3 Carton |
| Product Bundle Item | child_table_review_only | 1 | yes |  | v15_count_error | ac8c8e9b79 |
| Top Bar Item | child_table_review_only | 1 | yes |  | v15_count_error | fa11842828 |
| Website Slideshow | review_standard_setup | 1 | yes | 0 | records_missing_by_name | Parts |
| Website Theme | review_standard_setup | 1 | yes | 1 | records_match_by_name | Standard |

## Recommended Actions

- Sales Team: No immediate action for starting v15.
- Salary Structure: No immediate action for starting v15.
- Leave Type: No immediate action for starting v15.
- Sales Person: No immediate action for starting v15.
- Letter Head: No immediate action for starting v15.
- Pricing Rule: Review fields and import if this setup is used in daily operations.
- Approved Discounts: Review fields and import if this setup is used in daily operations.
- Top3AVGSales: No immediate action for starting v15.
- Lead Followup: No immediate action for starting v15.
- maximum stock: No immediate action for starting v15.
- Difference report Details: No immediate action for starting v15.
- Part Name: Review fields and import if this setup is used in daily operations.
- Budget details: No immediate action for starting v15.
- Charges on Salary: No immediate action for starting v15.
- Vehicle Log Details: No immediate action for starting v15.
- Towns: Review fields and import if this setup is used in daily operations.
- Goods Transporter: Review fields and import if this setup is used in daily operations.
- Price Master Login Audit: Review fields and import if this setup is used in daily operations.
- Container: Review fields and import if this setup is used in daily operations.
- Handler Worksheet: Review fields and import if this setup is used in daily operations.
- Warehouse Stocking: Review fields and import if this setup is used in daily operations.
- Payment Details: No immediate action for starting v15.
- Month: Review fields and import if this setup is used in daily operations.
- Computed Profit n Loss Report: Review fields and import if this setup is used in daily operations.
- PoorQuality: No immediate action for starting v15.
- Position: Review fields and import if this setup is used in daily operations.
- receipt: Review fields and import if this setup is used in daily operations.
- Penalty: Review fields and import if this setup is used in daily operations.
- Year: Review fields and import if this setup is used in daily operations.
- Items Cost: Review fields and import if this setup is used in daily operations.
- Payslip: Review fields and import if this setup is used in daily operations.
- Delivery Details: No immediate action for starting v15.
- CPU Daily Delivery Report: Optional; import only if the workflow is still used.
- Gate  Pass: Optional; import only if the workflow is still used.
- Audit Report: Optional; import only if the workflow is still used.
- Vehicle Log Book: Optional; import only if the workflow is still used.
- Delivery Difference Report: Optional; import only if the workflow is still used.
- Order Report: Optional; import only if the workflow is still used.
- Shop Visit Details: Optional; import only if the workflow is still used.
- Trip Plan-Report: Optional; import only if the workflow is still used.

## Covered Earlier

| DocType | Old | V15 Records | Status |
| --- | --- | --- | --- |
| Account | 261 | 297 | records_missing_by_name |
| Cost Center | 38 | 39 | records_missing_by_name |
| Fiscal Year | 15 | 15 | records_match_by_name |
| Mode of Payment | 39 | 39 | records_missing_by_name |
| Purchase Taxes and Charges Template | 3 | 4 | records_missing_by_name |
| Supplier | 534 | 534 | records_match_by_name |
| Currency | 139 | 155 | records_match_by_name |
| Branch | 28 | 28 | records_missing_by_name |
| Department | 14 | 15 | records_missing_by_name |
| Designation | 30 | 47 | records_missing_by_name |
| Employee | 178 | 181 | records_missing_by_name |
| Employment Type | 9 | 9 | records_match_by_name |
| Holiday List | 1 | 1 | records_match_by_name |
| Customer | 2809 | 2796 | v15_has_records_unmapped |
| Brand | 28 | 28 | records_match_by_name |
| Company | 1 | 1 | records_missing_by_name |
| Customer Group | 40 | 45 | records_missing_by_name |
| Item Group | 15 | 15 | records_match_by_name |
| Supplier Type | 15 |  | doctype_missing_in_v15 |
| Terms and Conditions | 1 | 1 | records_match_by_name |
| Territory | 17 | 19 | records_match_by_name |
| UOM | 13 | 244 | records_match_by_name |
| Item | 2152 | 2153 | v15_has_records_unmapped |
| Item Category | 27 | 28 | records_missing_by_name |
| Item Price | 70287 | 69542 | v15_has_records_unmapped |
| Price List | 59 | 69 | records_match_by_name |
| Warehouse | 51 | 63 | records_match_by_name |
| Warehouse Type | 6 | 6 | records_match_by_name |
| Address | 60 | 38 | records_missing_by_name |
| Contact | 2003 | 2423 | v15_has_records_unmapped |

## Transaction/History Excluded

| DocType | Old Records | Reason |
| --- | --- | --- |
| Stock Ledger Entry | 2814298 | Transaction/history data excluded by request. |
| GL Entry | 1893069 | Transaction/history data excluded by request. |
| Communication | 1700365 | Transaction/history data excluded by request. |
| Sales Invoice | 234194 | Transaction/history data excluded by request. |
| Journal Entry | 202490 | Transaction/history data excluded by request. |
| File | 64842 | Transaction/history data excluded by request. |
| Bin | 31753 | Transaction/history data excluded by request. |
| Stock Entry | 24544 | Transaction/history data excluded by request. |
| Attendance | 24166 | Transaction/history data excluded by request. |
| Purchase Receipt | 16232 | Transaction/history data excluded by request. |
| Purchase Invoice | 15767 | Transaction/history data excluded by request. |
| Salary Slip | 4675 | Transaction/history data excluded by request. |
| Stock Reconciliation | 4070 | Transaction/history data excluded by request. |
| Lead | 3406 | Transaction/history data excluded by request. |
| Purchase Order | 2797 | Transaction/history data excluded by request. |
| Leave Allocation | 410 | Transaction/history data excluded by request. |
| ToDo | 379 | Transaction/history data excluded by request. |
| Version | 181 | Transaction/history data excluded by request. |
| Leave Application | 120 | Transaction/history data excluded by request. |
| Quotation | 7 | Transaction/history data excluded by request. |
| Sales Order | 7 | Transaction/history data excluded by request. |
| Period Closing Voucher | 3 | Transaction/history data excluded by request. |

## Machine-Readable Details

Full JSON: `audits/v6-v15-other-master-lists-audit.json`

