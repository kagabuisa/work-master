# Old ERPNext v6 Customization Audit

Generated: 2026-06-24T10:56:58.922Z
Database: 1bd3e0294d
MariaDB: 10.0.25-MariaDB-1~trusty

## Summary

| Area | Count |
| --- | --- |
| Custom DocTypes | 65 |
| Non-core DocTypes | 30 |
| Custom Fields | 179 |
| Property Setters | 310 |
| Custom Scripts | 33 |
| Workflows | 1 |
| Print Formats | 18 |
| Reports | 117 |
| Roles | 50 |
| DocPerm rows | 717 |
| Modules | 23 |

## Installed Applications

| app | version |
| --- | --- |
| (not found in tabSingles) |  |

## Custom Fields By DocType

| DocType | Count |
| --- | --- |
| Item | 30 |
| Stock Entry | 22 |
| Item Price | 20 |
| Salary Slip | 18 |
| Lead | 14 |
| Journal Entry | 10 |
| Daily Activity Report | 8 |
| Purchase Order Item | 7 |
| Customer | 6 |
| Sales Invoice | 6 |
| Purchase Order | 5 |
| Warehouse | 5 |
| Attendance | 4 |
| Purchase Receipt | 4 |
| Area | 2 |
| Container | 2 |
| Account | 1 |
| Address | 1 |
| Approved Discounts | 1 |
| Cost Center | 1 |
| Employee | 1 |
| Ext Links | 1 |
| Journal Entry Account | 1 |
| Leave Application | 1 |
| Print Settings | 1 |
| Purchase Invoice | 1 |
| Sales Invoice Item | 1 |
| Sales Order | 1 |
| Stock Entry Detail | 1 |
| Stock Reconciliation | 1 |
| Supplier | 1 |
| Top3AVGSales | 1 |

## Property Setters By DocType

| DocType | Count |
| --- | --- |
| Item | 31 |
| Sales Invoice | 27 |
| Item Price | 18 |
| Journal Entry | 18 |
| Salary Slip | 15 |
| Stock Entry | 15 |
| Daily Activity Report | 14 |
| Sales Invoice Item | 12 |
| Purchase Receipt | 10 |
| Journal Entry Account | 9 |
| Lead | 8 |
| Purchase Order | 7 |
| Stock Ledger Entry | 7 |
| Stock Reconciliation | 7 |
| Customer | 6 |
| Delivery Note | 6 |
| Employee | 6 |
| Quotation | 6 |
| Sales Order | 6 |
| Delivery Details | 5 |
| Ext Links | 5 |
| Salary Slip Earning | 4 |
| Vehicle Log Details | 4 |
| Warehouse | 4 |
| Audit Report | 3 |
| Gate  Pass | 3 |
| Purchase Invoice | 3 |
| Stock Entry Detail | 3 |
| Stock Reconciliation Item | 3 |
| Supplier | 3 |
| Account | 2 |
| Approved Discounts | 2 |
| Asset Register | 2 |
| Bin | 2 |
| Charges on Salary | 2 |
| Cost Center | 2 |
| Leave Application | 2 |
| Order Report | 2 |
| Price List | 2 |
| Pricing Rule | 2 |
| Salary Structure | 2 |
| Sales report | 2 |
| Shop Visit Details | 2 |
| Supplier Quotation | 2 |
| Top3AVGSales | 2 |
| Area | 1 |
| Attendance | 1 |
| Container | 1 |
| CPU Daily Delivery Report | 1 |
| Deduction Type | 1 |
| File | 1 |
| Lead Followup | 1 |
| maximum stock | 1 |
| POS Profile | 1 |
| Purchase Order Item | 1 |
| Purchase Receipt Item | 1 |
| Sales Team | 1 |

## Custom Scripts

| name | dt | script_type | preview |
| --- | --- | --- | --- |
| Approved Discounts-Client | Approved Discounts | Client | frappe.listview_settings['Approved Discounts'] = { add_fields: ["item_name", "min_qty", "discount_rate"] }; |
| Area-Client | Area | Client | function compute(doc, cdt, cdn){ if (doc.width && doc.height && doc.length){ //it's check if the fields contains a value doc.plane = doc.height - (doc.width * d |
| Asset Register-Client | Asset Register | Client | frappe.ui.form.on("Asset Register", { validate: function(frm) { frm.trigger("calculate_depreciation") }, cost: function(frm) { frm.trigger("calculate_depreciati |
| Audit Report-Client | Audit Report | Client | cur_frm.add_fetch('shop_manager','employee_name','manager') cur_frm.add_fetch('auditor','employee_name','auditor_name') frappe.ui.form.on("Audit Report", { vali |
| CPU D Report-Client | CPU Daily Delivery Report | Client | cur_frm.add_fetch('manager','employee_name','manager_name') cur_frm.add_fetch('employee','employee_name','employee_name') |
| Customer-Client | Customer | Client | cur_frm.add_fetch('customer','contact_person','contact'); cur_frm.add_fetch('lead_employee','employee_name','lead_employee_name') |
| Daily Activity Report-Client | Daily Activity Report | Client | frappe.ui.form.on("Daily Activity Report", { validate: function(frm) { frm.trigger("calculate_balance") }, sales: function(frm) { frm.trigger("calculate_balance |
| Gate  Pass-Client | Gate  Pass | Client | cur_frm.add_fetch("lead_employee_id","employee_name","lead_employee_name"); cur_frm.add_fetch("team_member_2_id","employee_name","team_member_2_name"); cur_frm. |
| Handler Worksheet-Client | Handler Worksheet | Client | cur_frm.add_fetch('store_manager','employee_name','store_manager_name') cur_frm.add_fetch('handler','employee_name','handler_name') |
| Item Price-Client | Item Price | Client | cur_frm.add_fetch('item_code','cost','unit_cost') |
| Items Cost-Client | Items Cost | Client | cur_frm.add_fetch('item','description','code') cur_frm.add_fetch('item','item_category','category') |
| Journal Entry-Client | Journal Entry | Client | //Backdating script // Validation to ensure a Journal entry cant be back dated more than 2 days frappe.ui.form.on("Journal Entry", "validate", function(frm) { v |
| Lead-Client | Lead | Client | cur_frm.add_fetch('town_visited','town_name','town'); cur_frm.add_fetch('sales_person','employee_name','sales_person_name') |
| Lead Followup-Client | Lead Followup | Client | cur_frm.add_fetch('lead_followup','employee','employee_name') |
| Payment Voucher-Client | Payment Voucher | Client | cur_frm.add_fetch('approved_by','employee_name','approver') cur_frm.add_fetch('paid_to','employee_name','payee') |
| Employee-Client | Payslip | Client | cur_frm.add_fetch('employee','employee_name','employee_name') cur_frm.add_fetch('employee','assigned_to','shop') cur_frm.add_fetch('employee','designation','pos |
| Pending Payments-Client | Pending Payments | Client | function compute(doc, cdt, cdn){ if (doc.invoice_amount && doc.total_amount_paid){ //it checks if the fields contains a value doc.pending_payment = doc.invoice_ |
| Performance charges-Client | Performance charges | Client | cur_frm.add_fetch('employee','employee_name','employee_name') |
| Purchase Receipt-Client | Purchase Receipt | Client | cur_frm.add_fetch('buyer','employee_name','buyer_name') |
| receipt-Client | receipt | Client | cur_frm.cscript.custom_amount = function(doc) { amount_calc = doc.custom_qty * doc.custom_price; doc.custom_amount = amount_calc; refresh_field("custom_amount") |
| Salary Slip-Client | Salary Slip | Client | frappe.ui.form.on("Salary Slip", { validate: function(frm) { frm.trigger("calculate_commission2") }, sales: function(frm) { frm.trigger("calculate_commission2") |
| Sales Invoice-Client | Sales Invoice | Client | cur_frm.add_fetch('invoice_by', 'employee_name', 'invoicer_name'); cur_frm.add_fetch('item_code', 'item_category', 'category'); function fetch_approved_discount |
| Sales Invoice Item-Client | Sales Invoice Item | Client | cur_frm.add_fetch('item_code','item_category','category') |
| Sales invoiced-Client | Sales invoiced | Client | cur_frm.add_fetch('document_id','grand_total','grand_total') |
| Sales report-Client | Sales report | Client | frappe.ui.form.on("Salesrptdetails", { sales: function(frm, cdt, cdn) { var d = locals[cdt][cdn]; var total = 0; console.log(d) frm.doc.table_3.forEach(function |
| Shop visit-Client | Shop visit | Client | cur_frm.add_fetch('visitor','employee_name','manager_name') cur_frm.add_fetch('manager','employee_name','managerz_name') |
| shop visit details-Client | Shop Visit Details | Client | cur_frm.add_fetch('manager','employee_name','managerz_name') |
| Stock Entry-Client | Stock Entry | Client | cur_frm.add_fetch('received_by','employee_name','employee') cur_frm.add_fetch('packed_by','employee_name','packer') // additional validation on dates frappe.ui. |
| Towns-Client | Towns | Client | cur_frm.add_fetch('dweller','employee_name','employee_name') |
| Vehicle Log Details-Client | Vehicle Log | Client | function compute(doc, cdt, cdn){ if (doc.km_arrival && doc.km_departure){ //it checks if the fields contains a value doc.test = doc.km_arrival - doc.km_departur |
| Vehicle Log-Client | Vehicle Log | Client | cur_frm.add_fetch('employee','employee_name','employee_name') |
| Vehicle Log Book-Client | Vehicle Log Book | Client | cur_frm.add_fetch('driver','employee_name','driver_name'); cur_frm.add_fetch('from','town_name','town_from'); cur_frm.add_fetch('to','town_name','town_to'); cur |
| maximum stock-Client | Warehouse Maximum Stock | Client | cur_frm.add_fetch('item_name','description','code') cur_frm.add_fetch('item_name','item_category','category') |

## Workflows

| name | workflow_name | document_type | is_active | workflow_state_field |
| --- | --- | --- | --- | --- |
| Leave Application workflow | Leave Application workflow | Leave Application | 0 | workflow_state |

## Print Formats

| name | doc_type | module | standard | disabled | print_format_type |
| --- | --- | --- | --- | --- | --- |
| Asset Register print | Asset Register |  | No | 0 | Server |
| Custom Audit report | Audit Report |  | No | 0 | Server |
| Cheque Printing Format | Journal Entry |  | Yes | 0 | Server |
| Credit Note | Journal Entry |  | Yes | 0 | Server |
| Payment Receipt Voucher | Journal Entry |  | Yes | 0 | Server |
| Offer Letter | Offer Letter |  | Yes | 0 | Server |
| Drop Shipping Format | Purchase Order |  | Yes | 0 | Server |
| Purchase Order | Purchase Order |  | No | 0 | Server |
| metaTest | Sales Invoice |  | No | 0 | Server |
| New Format 20-12-2025 | Sales Invoice |  | No | 0 | Server |
| POS Invoice | Sales Invoice |  | Yes | 0 | Server |
| PrintTemp | Sales Invoice |  | No | 0 | Server |
| sales invoice print | Sales Invoice |  | No | 0 | Server |
| Delivery note | Stock Entry |  | No | 0 | Server |
| DLN Mobile | Stock Entry |  | No | 0 | Server |
| STOCK ENTRY | Stock Entry |  | No | 0 | Server |
| Stock Entry - Invoice | Stock Entry |  | No | 0 | Server |
| test | Stock Entry |  | No | 0 | Server |

## Reports

| name | ref_doctype | module | report_type | is_standard | disabled |
| --- | --- | --- | --- | --- | --- |
| Budget Variance Report | Cost Center | Accounts | Script Report | Yes | 0 |
| Daily Activity Report | Daily Activity Report | Accounts | Report Builder | No | 0 |
| DAR- Daily Sales Report Full | Daily Activity Report | Accounts | Query Report | No | 0 |
| DAR-Daily Sales report | Daily Activity Report | Accounts | Query Report | No | 0 |
| SalesExpensesBankings | Daily Activity Report | Accounts | Report Builder | No | 0 |
| Balance Sheet | GL Entry | Accounts | Script Report | Yes | 0 |
| Cash Flow | GL Entry | Accounts | Script Report | Yes | 0 |
| General Ledger | GL Entry | Accounts | Script Report | Yes | 0 |
| Profit and Loss Statement | GL Entry | Accounts | Script Report | Yes | 0 |
| Trial Balance | GL Entry | Accounts | Script Report | Yes | 0 |
| Trial Balance for Party | GL Entry | Accounts | Script Report | Yes | 0 |
| Bank Clearance Summary | Journal Entry | Accounts | Script Report | Yes | 0 |
| Bank Reconciliation Statement | Journal Entry | Accounts | Script Report | Yes | 0 |
| CPU Cost Center Expenses 18-06-2022 | Journal Entry | Accounts | Report Builder | No | 0 |
| Journal Entries Report | Journal Entry | Accounts | Report Builder | No | 0 |
| Payment Period Based On Invoice Date | Journal Entry | Accounts | Script Report | Yes | 0 |
| Pending Payments | Pending Payments | Accounts | Report Builder | No | 0 |
| Price-Rules | Pricing Rule | Accounts | Report Builder | No | 0 |
| Accounts Payable | Purchase Invoice | Accounts | Script Report | Yes | 0 |
| Accounts Payable Summary | Purchase Invoice | Accounts | Script Report | Yes | 0 |
| Item-wise Purchase Register | Purchase Invoice | Accounts | Script Report | Yes | 0 |
| Purchase Invoice Trends | Purchase Invoice | Accounts | Script Report | Yes | 0 |
| Purchase Order Items To Be Billed | Purchase Invoice | Accounts | Query Report | Yes | 0 |
| Purchase Register | Purchase Invoice | Accounts | Script Report | Yes | 0 |
| Received Items To Be Billed | Purchase Invoice | Accounts | Query Report | Yes | 0 |
| Accounts Receivable | Sales Invoice | Accounts | Script Report | Yes | 0 |
| Accounts Receivable Summary | Sales Invoice | Accounts | Script Report | Yes | 0 |
| Daily Sales | Sales Invoice | Accounts | Query Report | No | 0 |
| Delivered Items To Be Billed | Sales Invoice | Accounts | Query Report | Yes | 0 |
| Gross Profit | Sales Invoice | Accounts | Script Report | Yes | 0 |
| Item-wise Sales Register | Sales Invoice | Accounts | Script Report | Yes | 0 |
| Ordered Items To Be Billed | Sales Invoice | Accounts | Query Report | Yes | 0 |
| Price Review Report | Sales Invoice | Accounts | Report Builder | No | 0 |
| Sales Invoice 29012020 | Sales Invoice | Accounts | Report Builder | No | 0 |
| Sales Invoice Month range | Sales Invoice | Accounts | Report Builder | No | 0 |
| Sales invoice report | Sales Invoice | Accounts | Report Builder | No | 0 |
| Sales Invoice Summary 28-04-2023 | Sales Invoice | Accounts | Report Builder | No | 0 |
| Sales Invoice Trends | Sales Invoice | Accounts | Script Report | Yes | 0 |
| Sales Partners Commission | Sales Invoice | Accounts | Query Report | Yes | 0 |
| Sales Register | Sales Invoice | Accounts | Script Report | Yes | 0 |
| SALES SUMMARY BY PERIOD AND SELLING UNIT | Sales Invoice | Accounts | Report Builder | No | 0 |
| Shop visit | Shop visit | Accounts | Report Builder | No | 0 |
| Item-wise Purchase History | Purchase Order | Buying | Query Report | Yes | 0 |
| Purchase Order Trends | Purchase Order | Buying | Script Report | Yes | 0 |
| Requested Items To Be Ordered | Purchase Order | Buying | Query Report | Yes | 0 |
| Supplier Addresses and Contacts | Supplier | Buying | Query Report | Yes | 0 |
| Document Share Report | DocShare | Core | Report Builder | Yes | 0 |
| DocType - Admin - followup | DocType | Core | Report Builder | No | 0 |
| SCANNED DOCUMETS | File | Core | Report Builder | No | 0 |
| ToDo | ToDo | Core | Script Report | Yes | 0 |
| Permitted Documents For User | User | Core | Script Report | Yes | 0 |
| To do reports | ToDo | Desk | Report Builder | No | 0 |
| Employee Holiday Attendance | Attendance | HR | Script Report | Yes | 0 |
| Monthly Attendance Sheet | Attendance | HR | Script Report | Yes | 0 |
| Employee Birthday | Employee | HR | Script Report | Yes | 0 |
| Employee Information | Employee | HR | Report Builder | Yes | 0 |
| Employee Leave Balance | Employee | HR | Script Report | Yes | 0 |
| Monthly payslip report(MPR) | Salary Slip | HR | Report Builder | No | 0 |
| Monthly Salary Register | Salary Slip | HR | Script Report | Yes | 0 |
| Completed Production Orders | Production Order | Manufacturing | Query Report | Yes | 0 |
| Issued Items Against Production Order | Production Order | Manufacturing | Query Report | Yes | 0 |
| Open Production Orders | Production Order | Manufacturing | Query Report | Yes | 0 |
| Production Orders in Progress | Production Order | Manufacturing | Query Report | Yes | 0 |
| Project wise Stock Tracking | Project | Projects | Report Builder | Yes | 0 |
| Daily Time Log Summary | Time Log | Projects | Script Report | Yes | 0 |
| Customer Acquisition and Loyalty | Customer | Selling | Script Report | Yes | 0 |
| Customer Addresses And Contacts | Customer | Selling | Query Report | Yes | 0 |
| Customer Credit Balance | Customer | Selling | Script Report | Yes | 0 |
| Lead Details | Lead | Selling | Query Report | Yes | 0 |
| Available Stock for Packing Items | Product Bundle | Selling | Script Report | Yes | 0 |
| Quotation Trends | Quotation | Selling | Script Report | Yes | 0 |
| Inactive Customers | Sales Order | Selling | Script Report | Yes | 0 |
| Item-wise Sales History | Sales Order | Selling | Query Report | Yes | 0 |
| Pending SO Items For Purchase Request | Sales Order | Selling | Query Report | Yes | 0 |
| Sales Order Trends | Sales Order | Selling | Script Report | Yes | 0 |
| Sales Person Target Variance Item Group-Wise | Sales Order | Selling | Script Report | Yes | 0 |
| Sales Person-wise Transaction Summary | Sales Order | Selling | Script Report | Yes | 0 |
| Territory Target Variance Item Group-Wise | Sales Order | Selling | Script Report | Yes | 0 |
| Sales Reconciliation DAR Vs Sales Invoice | Daily Activity Report | Setup | Query Report | No | 0 |
| Report-Daily Sales(Sales Invoices) | Sales Invoice | Setup | Query Report | Yes | 0 |
| Item Shortage Report | Bin | Stock | Report Builder | Yes | 0 |
| BOM Search | BOM | Stock | Script Report | Yes | 0 |
| STOCK DIFFERENCE REPORT SUMMARY | Delivery Difference Report | Stock | Report Builder | No | 0 |
| Delivery Note Trends | Delivery Note | Stock | Script Report | Yes | 0 |
| Ordered Items To Be Delivered | Delivery Note | Stock | Query Report | Yes | 0 |
| Group Item List | Item | Stock | Report Builder | No | 0 |
| Itemlist Import | Item | Stock | Report Builder | No | 0 |
| ItemList-Item Code | Item | Stock | Report Builder | No | 0 |
| Items | Item | Stock | Query Report | No | 0 |
| Items To Be Requested | Item | Stock | Query Report | Yes | 0 |
| Itemwise Recommended Reorder Level | Item | Stock | Script Report | Yes | 0 |
| Stock Ageing | Item | Stock | Script Report | Yes | 0 |
| Stock Projected Qty | Item | Stock | Script Report | Yes | 0 |
| ITEM LOOKUP 06-05-2021 | Item Price | Stock | Report Builder | No | 0 |
| Item Price Shops Dev 05-11-2025 | Item Price | Stock | Report Builder | No | 0 |
| Item-wise Price List Rate | Item Price | Stock | Report Builder | Yes | 0 |
| Price List | Item Price | Stock | Query Report | No | 0 |
| Material Requests for which Supplier Quotations are not created | Material Request | Stock | Query Report | Yes | 0 |
| Purchase Order Items To Be Received | Purchase Receipt | Stock | Query Report | Yes | 0 |
| Purchase Receipt Trends | Purchase Receipt | Stock | Script Report | Yes | 0 |
| Serial No Service Contract Expiry | Serial No | Stock | Report Builder | Yes | 0 |
| Serial No Status | Serial No | Stock | Report Builder | Yes | 0 |
| Serial No Warranty Expiry | Serial No | Stock | Report Builder | Yes | 0 |
| Requested Items To Be Transferred | Stock Entry | Stock | Query Report | Yes | 0 |
| Batch-Wise Balance History | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Item Prices | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Mix-Max Stock Balance Report | Stock Ledger Entry | Stock | Report Builder | No | 0 |
| Stock Balance | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Stock Balance New | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Stock Ledger | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Supplier-Wise Sales Analytics | Stock Ledger Entry | Stock | Script Report | Yes | 0 |
| Ordering Kit | Top3AVGSales | Stock | Query Report | No | 0 |
| Supplementary Order | Top3AVGSales | Stock | Report Builder | No | 0 |
| Max-Reorder Qty-APL | Warehouse Maximum Stock | Stock | Report Builder | No | 0 |
| Product-Line Report | Warehouse Maximum Stock | Stock | Report Builder | No | 0 |
| Warehousing Stocking Report | Warehouse Stocking | Stock | Report Builder | No | 0 |
| Maintenance Schedules | Maintenance Schedule | Support | Query Report | Yes | 0 |

## Custom Field Details

| dt | fieldname | label | fieldtype | options | insert_after | reqd | hidden | read_only |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Account | cost_center | Cost Center | Link | Cost Center | account_currency | 0 | 0 | 0 |
| Address | shopify_address_id | Shopify Address Id | Data |  | fax | 0 | 0 | 1 |
| Approved Discounts | status | Status | Select | Approved<br>Disapproved | naming_series | 0 | 0 | 0 |
| Area | invoices | Invoices | Section Break |  | plane | 0 | 0 | 0 |
| Area | sales_invoiced | Sales invoiced | Table | Sales invoiced | invoices | 0 | 0 | 0 |
| Attendance | late_arrival | Late Arrival | Select | <br>Yes<br>OnLeave | amended_from | 0 | 0 | 0 |
| Attendance | la_time | LA Time | Time |  | late_arrival | 0 | 0 | 0 |
| Attendance | early_departure | Early Departure | Select | <br>Yes<br>OnLeave | la_time | 0 | 0 | 0 |
| Attendance | ed_time | ED Time | Time |  | early_departure | 0 | 0 | 0 |
| Container | reference | Reference | Data |  | section_break_7 | 1 | 0 | 0 |
| Container | column |  | Column Break |  | shipping_line | 0 | 0 | 0 |
| Cost Center | cost_center_type | Cost Center Type | Select | <br>Retail<br>Selling<br>Administrative<br>Logistics<br>Marketing<br>Operations | parent_cost_center | 0 | 0 | 0 |
| Customer | shopify_customer_id | Shopify Customer Id | Data |  | naming_series | 0 | 0 | 1 |
| Customer | contact_person | Contact Person | Data |  | customer_name | 0 | 0 | 0 |
| Customer | lead_employee | Sales Person | Link | Employee | language | 0 | 0 | 0 |
| Customer | lead_employee_name | Sales Person's Name | Data |  | lead_employee | 0 | 0 | 1 |
| Customer | customer_followup_section | Customer Followup Section | Section Break |  | contact_html | 0 | 0 | 0 |
| Customer | customer_followup | Customer followup | Table | Lead Followup | customer_followup_section | 0 | 0 | 0 |
| Daily Activity Report | warehouse | Warehouse | Link | Warehouse | cost center | 1 | 0 | 0 |
| Daily Activity Report | review_report | Daily Shop Review Report | Section Break |  | expense details | 0 | 0 | 0 |
| Daily Activity Report | sales_invoiced | Sales Invoiced | Float |  | review_report | 0 | 0 | 0 |
| Daily Activity Report | expenses_posted | Expenses Posted | Float |  | sales_invoiced | 0 | 0 | 0 |
| Daily Activity Report | divider |  | Column Break |  | expenses_posted | 0 | 0 | 0 |
| Daily Activity Report | banked_on | Banked On | Date |  | cash_banked | 0 | 0 | 0 |
| Daily Activity Report | cash_banked | Cash Banked | Float |  | divider | 0 | 0 | 0 |
| Daily Activity Report | bank_used | Bank Used | Link | Account | banked_on | 0 | 0 | 0 |
| Employee | assigned_to | Assigned to | Link | Cost Center | holiday_list | 1 | 0 | 0 |
| Ext Links | shops_sales_and_commission | Shops Sales and Commission | HTML | <p></p><p><a href="https://bi.zenjji.com/public/question/ad95a963-abe3-40f5-98e9-d42621ca779a" rel="noopener noreferrer" target="_blank">Shop Sales &amp; Commission Report 07-03-2022 Click here...</a><br></p> | accountant | 0 | 0 | 0 |
| Item | suppliers | Suppliers | Data |  | stock_uom | 0 | 0 | 0 |
| Item | product_line_item | Product Line Item | Select | <br>CPU<br>Yes<br>No | suppliers | 0 | 0 | 0 |
| Item | item_category | Item Category | Link | Item Category | product_line_item | 1 | 0 | 0 |
| Item | system_category | System Category | Select | Accessories<br>Body<br>Electrics<br>Engine<br>Lubricants<br>Others<br>Supplies<br>Tools<br>Transmission<br>Tubes<br>Tyres<br>Wheel<br><br> | item_category | 0 | 0 | 0 |
| Item | source | Source | Select | Import<br>Local | system_category | 0 | 0 | 0 |
| Item | cost | Cost | Float |  | source | 1 | 0 | 0 |
| Item | old_cost | Old Cost | Float |  | cost | 0 | 0 | 0 |
| Item | rrp | Recomended Retail Price(RRP) | Float |  | old_cost | 1 | 0 | 0 |
| Item | rwp | Recomended Wholesale Price(RWP) | Float |  | rrp | 0 | 0 | 0 |
| Item | freight | Freight | Float |  | rwp | 0 | 0 | 0 |
| Item | handling_costs | Handling Costs | Float |  | freight | 0 | 0 | 0 |
| Item | package_type | Package Type | Data |  | handling_costs | 0 | 0 | 0 |
| Item | lead_item | Lead Item | Link | Item | image_view | 0 | 0 | 0 |
| Item | abc_analysis | ABC Analysis | Select | <br>A<br>B<br>C<br>D<br>E<br>O<br>XA<br>DA | lead_item | 0 | 0 | 0 |
| Item | minimum_order_qty | Minimum Order Qty(MOQ) | Float |  | abc_analysis | 0 | 0 | 0 |
| Item | group_abc | Group ABC | Select | <br>A<br>B<br>C<br>D<br>E<br>O<br>XA<br>DA | minimum_order_qty | 0 | 0 | 0 |
| Item | supply_vs_demand | Supply vs Demand | Select | <br>Regular Out of Stock<br>Generally Available<br> | group_abc | 0 | 0 | 0 |
| Item | part_name | Part Name | Data |  | supply_vs_demand | 0 | 0 | 0 |
| Item | photocount_id | PhotoCount id | Data |  | part_name | 0 | 0 | 0 |
| Item | maximum_stock | Maximum Stock | Float |  | photocount_id | 0 | 0 | 0 |
| Item | import_max_qty | Import Max Qty | Float |  | maximum_stock | 0 | 0 | 0 |
| Item | length | Length | Float |  | is_asset_item | 0 | 0 | 0 |
| Item | width | Width | Float |  | length | 0 | 0 | 0 |
| Item | height | Height | Float |  | width | 0 | 0 | 0 |
| Item | gross_weight | Gross Weight | Float |  | warranty_period | 0 | 0 | 0 |
| Item | qty_per_carton | QTY per Carton | Float |  | net_weight | 0 | 0 | 0 |
| Item | cbm_per_carton | CBM per Carton | Float |  | qty_per_carton | 0 | 0 | 0 |
| Item | order_min_qty | Order Min Qty | Float |  | cbm_per_carton | 0 | 0 | 0 |
| Item | fob | FOB | Float |  | order_min_qty | 0 | 0 | 0 |
| Item | import_supplier | Import Supplier | Link | Supplier | supplier_items | 0 | 0 | 0 |
| Item Price | price_type | Price type | Select | <br>Retail price<br>Wholesale price | price_list | 0 | 0 | 0 |
| Item Price | price_update | Price Update | Select | <br>New<br>Old<br>Remove | price_type | 0 | 0 | 0 |
| Item Price | price_update_on | Price Update On | Date |  | price_update | 0 | 0 | 0 |
| Item Price | cost_center | Cost Center | Link | Cost Center | selling | 0 | 0 | 0 |
| Item Price | carton_price | Carton Price | Currency |  | price_list_rate | 0 | 0 | 0 |
| Item Price | dealer_price | Dealer Price | Currency |  | carton_price | 0 | 0 | 0 |
| Item Price | new_price | New Price/Rate | Currency |  | dealer_price | 0 | 0 | 0 |
| Item Price | stock_balance | Stock Balance | Float |  | new_price | 0 | 0 | 0 |
| Item Price | unit_cost | Unit Cost | Currency |  | currency | 0 | 0 | 0 |
| Item Price | promo_start_date | Promo Start Date | Date |  | item_description | 0 | 0 | 0 |
| Item Price | promo_expiry_date | Promo Expiry Date | Date |  | promo_start_date | 0 | 0 | 0 |
| Item Price | promo_warehouse | Promo Warehouse | Link | Warehouse | promo_expiry_date | 0 | 0 | 0 |
| Item Price | promo_customer | Promo Customer | Link | Customer | promo_warehouse | 0 | 0 | 0 |
| Item Price | warehouse_type | Warehouse Type | Link | Warehouse Type | promo_customer | 0 | 0 | 0 |
| Item Price | promo_rate | Promo Rate | Float |  | warehouse_type | 0 | 0 | 0 |
| Item Price | promo_qty | Promo Qty | Float |  | promo_rate | 0 | 0 | 0 |
| Item Price | incarton | QTY/CTN | Float |  | bulk_import_help | 0 | 0 | 0 |
| Item Price | old_price | Old Price/Rate | Currency |  | incarton | 0 | 0 | 1 |
| Item Price | item_category | Item Category | Link | Item Category | old_price | 0 | 0 | 0 |
| Item Price | margin | Margin | Percent |  | item_category | 0 | 0 | 0 |
| Journal Entry | entry_category | Entry Category | Select | <br>Expense<br>Banking<br>Purchase<br>Transfer<br>Others | naming_series | 1 | 0 | 0 |
| Journal Entry | requisition_status | Requisition Status | Select | <br>Approved<br>Rejected | entry_category | 0 | 0 | 0 |
| Journal Entry | request_approved | Request is Approved | Select | Yes | requisition_status | 0 | 0 | 0 |
| Journal Entry | sales_date | Date of Sales Banked | Date |  | request_approved | 0 | 0 | 0 |
| Journal Entry | employee | Receiver/User/Member | Link | Employee | sales_date | 1 | 0 | 0 |
| Journal Entry | employee_name | Employee Name | Data |  | employee | 0 | 0 | 1 |
| Journal Entry | cost_center | Cost Center | Link | Cost Center | column_break1 | 1 | 0 | 0 |
| Journal Entry | allow | Allow | Select | <br>Backdate | company | 0 | 0 | 0 |
| Journal Entry | invoice_number | Invoice Number | Link | Sales Invoice | allow | 0 | 0 | 0 |
| Journal Entry | workflow_state | Workflow State | Link | Workflow State | amended_from | 0 | 1 | 0 |
| Journal Entry Account | packages_received | Packages Received | Float |  | account | 0 | 0 | 0 |
| Lead | town_visited | Town of Operation | Link | Towns | naming_series | 1 | 0 | 0 |
| Lead | town | Town Name | Data |  | town_visited | 1 | 0 | 1 |
| Lead | owner_tel | Owner Tel(WhatsApp) | Data |  | lead_name | 1 | 0 | 0 |
| Lead | shop_size | Shop Classification | Select | <br>Large<br>Medium<br>Small | email_id | 1 | 0 | 0 |
| Lead | town_classification | Town Classification | Select | <br>Busy<br>Not busy | shop_size | 1 | 0 | 0 |
| Lead | owner_met | Owner met? | Select | <br>Yes<br>No | source | 0 | 0 | 0 |
| Lead | shop_manager | Shop Manager | Data |  | owner_met | 0 | 0 | 0 |
| Lead | manager_tel_whatsapp | Manager's Tel(WhatsApp) | Data |  | shop_manager | 0 | 0 | 0 |
| Lead | remarks | Remarks | Text |  | campaign_name | 0 | 0 | 0 |
| Lead | bad_data | Bad Data | Select | <br>Phone<br>Name<br>Town | remarks | 0 | 0 | 0 |
| Lead | sales_person | Sales Person | Link | Employee | lead_owner | 1 | 0 | 0 |
| Lead | sales_person_name | Sales Person Name | Data |  | sales_person | 0 | 0 | 1 |
| Lead | lead_follow_up | Lead Follow Up | Section Break |  | contact_date | 0 | 0 | 0 |
| Lead | lead_followup | Lead followup | Table | Lead Followup | lead_follow_up | 0 | 0 | 0 |
| Leave Application | workflow_state | Workflow State | Link | Workflow State | amended_from | 0 | 1 | 0 |
| Print Settings | compact_item_print | Compact Item Print | Check |  | with_letterhead | 0 | 0 | 0 |
| Purchase Invoice | test | Test | Data |  | supplier_name | 0 | 0 | 0 |
| Purchase Order | approval_status | Approval Status | Select | <br>Approved<br>Wait<br>Rejected | supplier | 0 | 0 | 0 |
| Purchase Order | container_status | Container Status | Select | In-Process<br>In-Transit<br>Received<br>Verified | is_subcontracted | 0 | 0 | 0 |
| Purchase Order | delivery_to | Delivery to | Link | Cost Center | transaction_date | 0 | 0 | 0 |
| Purchase Order | reference | Reference | Data |  | delivery_to | 0 | 0 | 0 |
| Purchase Order | container_number | Container Number/Bill No/Loading Date | Data |  | reference | 0 | 0 | 0 |
| Purchase Order Item | import_details | Import details | Section Break |  | base_net_amount | 0 | 1 | 0 |
| Purchase Order Item | import_supplier | Supplier | Link | Supplier | import_details | 0 | 0 | 0 |
| Purchase Order Item | import_rate | IR | Float |  | import_supplier | 0 | 0 | 0 |
| Purchase Order Item | qty_per_carton | Qty per Carton | Float |  | import_rate | 0 | 0 | 0 |
| Purchase Order Item | cb2 |  | Column Break |  | qty_per_carton | 0 | 0 | 0 |
| Purchase Order Item | item_weight | Item Weight/CTN | Float |  | cb2 | 0 | 0 | 0 |
| Purchase Order Item | carton_cbm | Carton CBM | Float |  | item_weight | 0 | 0 | 0 |
| Purchase Receipt | business_unit_or_cost_center | Business Unit or Cost Center | Link | Cost Center | supplier | 0 | 0 | 0 |
| Purchase Receipt | buyer | Buyer | Link | Employee | business_unit_or_cost_center | 0 | 0 | 0 |
| Purchase Receipt | buyer_name | Buyer Name | Data |  | buyer | 0 | 0 | 1 |
| Purchase Receipt | receipt_no | Receipt No | Data |  | is_return | 0 | 0 | 0 |
| Salary Slip | date | Date(Last day of Month we are paying) | Date |  | column_break0 | 1 | 0 | 0 |
| Salary Slip | column_break_27 |  | Column Break |  | branch | 0 | 0 | 0 |
| Salary Slip | sales | Sales | Currency |  | letter_head | 0 | 0 | 0 |
| Salary Slip | margin | Margin | Float |  | sales | 0 | 0 | 0 |
| Salary Slip | commission2 | Commission | Currency |  | margin | 0 | 0 | 1 |
| Salary Slip | approved | Approved | Select | <br>No<br>Yes | commission2 | 0 | 0 | 0 |
| Salary Slip | details_of_charges | Charges on Salary arising this month | Section Break |  | total_in_words | 0 | 0 | 0 |
| Salary Slip | charges_to_recover | Charges to recover | Table | Charges on Salary | details_of_charges | 0 | 0 | 0 |
| Salary Slip | deduction_and_balance | Deduction and Balance | Section Break |  | charges_to_recover | 0 | 0 | 0 |
| Salary Slip | salary_slip | Previous Months' Salary slip | Link | Salary Slip | deduction_and_balance | 0 | 0 | 0 |
| Salary Slip | employee2 | Employee's Name | Data |  | salary_slip | 0 | 0 | 1 |
| Salary Slip | month2 | Previous Month | Data |  | employee2 | 0 | 0 | 1 |
| Salary Slip | balance_bf | Previous months balance | Currency |  | month2 | 0 | 0 | 1 |
| Salary Slip | clbrk_28 |  | Column Break |  | balance_bf | 0 | 0 | 0 |
| Salary Slip | grand_total | Total Charges from this month | Currency |  | clbrk_28 | 0 | 0 | 0 |
| Salary Slip | deducted | To be deducted | Currency |  | grand_total | 0 | 0 | 0 |
| Salary Slip | balance_cf | Balance(4 nxt Month) | Currency |  | deducted | 0 | 0 | 1 |
| Salary Slip | kagabu | kagabu | Data |  | balance_cf | 0 | 1 | 0 |
| Sales Invoice | contact | Person to Contact | Data |  | customer | 0 | 0 | 1 |
| Sales Invoice | approved | Approved | Select | <br>Yes<br>No | is_return | 0 | 0 | 0 |
| Sales Invoice | warehoused | Warehoused | Link | Warehouse | approved | 1 | 0 | 0 |
| Sales Invoice | invoice_number | Invoice Number | Data |  | warehoused | 0 | 0 | 0 |
| Sales Invoice | invoice_by | Invoiced by | Link | Employee | mode_of_payment | 1 | 0 | 0 |
| Sales Invoice | invoicer_name | Invoicers name | Data |  | invoice_by | 0 | 0 | 1 |
| Sales Invoice Item | category | Category | Data |  | item_name | 0 | 0 | 0 |
| Sales Order | shopify_order_id | Shopify Order Id | Data |  | title | 0 | 0 | 1 |
| Stock Entry | transfer_type | Transfer Type | Select | <br>Order<br>Taff Kla Order<br>Warehouse transfer<br>DDR - Shortage<br>DDR - Excess | purpose | 1 | 0 | 0 |
| Stock Entry | target_warehouse_for_shop_to_shop_transfer | Target Warehouse for Shop to Shop Transfer | Link | Warehouse | transfer_type | 0 | 0 | 0 |
| Stock Entry | order_status | Order Status | Select | <br>Approved<br>Pending approval<br> | target_warehouse_for_shop_to_shop_transfer | 0 | 0 | 0 |
| Stock Entry | approval_status | Order is Approved | Select | Yes | order_status | 0 | 0 | 0 |
| Stock Entry | delivery_status | Delivery Status | Select | <br>In-Process<br>Picked & Packed<br>Delivered<br>In-Transit<br>All Received<br>Received + DDR | approval_status | 0 | 0 | 0 |
| Stock Entry | total_packages | Total Packages | Float |  | delivery_status | 0 | 0 | 0 |
| Stock Entry | delivery_details | Delivery Details | Long Text |  | total_packages | 0 | 0 | 0 |
| Stock Entry | cost_center | Unit | Link | Cost Center | col2 | 1 | 0 | 0 |
| Stock Entry | allow | Allow | Select | <br>BackDate | posting_time | 0 | 0 | 0 |
| Stock Entry | customer_names | Customer Names | Link | Customer | allow | 0 | 0 | 0 |
| Stock Entry | document_type | Document type | Link | DocType | customer_names | 0 | 1 | 1 |
| Stock Entry | document_id | Stock Entry Number | Dynamic Link | document_type | document_type | 0 | 0 | 0 |
| Stock Entry | stock_entry_posting_date | Stock Entry Posting Date | Date |  | document_id | 0 | 0 | 0 |
| Stock Entry | delivery_date | Delivery Date | Date |  | stock_entry_posting_date | 0 | 0 | 0 |
| Stock Entry | transporter | Transporter | Data |  | delivery_date | 0 | 0 | 0 |
| Stock Entry | packed_by | Packed By | Link | Employee | transporter | 0 | 0 | 0 |
| Stock Entry | packer | Packer's Name | Data |  | packed_by | 0 | 0 | 1 |
| Stock Entry | receive_date | Receive Date | Date |  | packer | 0 | 0 | 0 |
| Stock Entry | packages_received | Packages Received | Int |  | receive_date | 0 | 0 | 0 |
| Stock Entry | received_by | Received & Confirmed By | Link | Employee | packages_received | 0 | 0 | 0 |
| Stock Entry | employee | Name | Data |  | received_by | 0 | 0 | 1 |
| Stock Entry | singature | Singature: | Data |  | employee | 0 | 1 | 1 |
| Stock Entry Detail | picked | Picked | Float |  | col_break3 | 0 | 1 | 0 |
| Stock Reconciliation | warehouse | Warehouse | Link | Warehouse | company | 1 | 0 | 0 |
| Supplier | holding_company | Holding Company | Link | Supplier | naming_series | 0 | 0 | 0 |
| Top3AVGSales | remark | Remark | Text |  | top3mavgs | 0 | 0 | 0 |
| Warehouse | warehouse_abbreviation | Warehouse Abbreviation | Data |  | warehouse_name | 1 | 0 | 0 |
| Warehouse | branch | Branch | Link | Branch | disabled | 0 | 0 | 0 |
| Warehouse | warehouse_type | Warehouse Type | Select | <br>Shop<br>Wholesale<br>Distribution Center<br>Others<br>Transit | mobile_no | 1 | 0 | 0 |
| Warehouse | cost_center | Cost Center | Link | Cost Center | warehouse_type | 1 | 0 | 0 |
| Warehouse | code | Code | Data |  | cost_center | 0 | 0 | 0 |

## Property Setter Details

| doc_type | doctype_or_field | field_name | property | property_type | value |
| --- | --- | --- | --- | --- | --- |
| Account | DocType |  | read_only_onload | Check |  |
| Account | DocType |  | sort_order | Data | ASC |
| Approved Discounts | DocType |  | read_only_onload | Check |  |
| Approved Discounts | DocField | item_name | width |  | 293 |
| Area | DocType |  | read_only_onload | Check |  |
| Asset Register | DocType |  | default_print_format | Data | Asset Register print |
| Asset Register | DocField | asset_description | width |  | 150 |
| Attendance | DocType |  | read_only_onload | Check |  |
| Audit Report | DocType |  | read_only_onload | Check |  |
| Audit Report | DocField | label | hidden | Check | 0 |
| Audit Report | DocField | rating | width |  | 54 |
| Bin | DocField | item_code | width |  | 180 |
| Bin | DocField | warehouse | width |  | 236 |
| Charges on Salary | DocType |  | read_only_onload | Check |  |
| Charges on Salary | DocField | charge_name | options | Text | <br>Stock shrink<br>Under pricing<br>Cash recovery<br>Missing reports<br>Fixed asset recovery<br>Training fees recovery<br>Operational loss recovery<br>Other Charges |
| Container | DocType |  | read_only_onload | Check |  |
| Cost Center | DocType |  | read_only_onload | Check |  |
| Cost Center | DocType |  | sort_order | Data | ASC |
| CPU Daily Delivery Report | DocField | manager_name | width |  | 107 |
| Customer | DocType |  | read_only_onload | Check |  |
| Customer | DocType |  | sort_field | Data | modified |
| Customer | DocField | customer_name | width |  | 230 |
| Customer | DocField | default_price_list | width |  | 251 |
| Customer | DocField | naming_series | hidden | Check | 1 |
| Customer | DocField | naming_series | reqd | Check | 0 |
| Daily Activity Report | DocType |  | read_only_onload | Check |  |
| Daily Activity Report | DocField | banked | width |  | 135 |
| Daily Activity Report | DocField | cost center | width |  | 61 |
| Daily Activity Report | DocField | date | width |  | 71 |
| Daily Activity Report | DocField | do_you_have_any_delivery_differences | width |  | 248 |
| Daily Activity Report | DocField | expense | width |  | 73 |
| Daily Activity Report | DocField | expense details | width |  | 723 |
| Daily Activity Report | DocField | item_not_received_or_excess_items_received | width |  | 53 |
| Daily Activity Report | DocField | naming_series | default | Text |  |
| Daily Activity Report | DocField | naming_series | options | Text | DAR-.###### |
| Daily Activity Report | DocField | packages_received | width |  | 55 |
| Daily Activity Report | DocField | sales | width |  | 174 |
| Daily Activity Report | DocField | stock_entry_number | width |  | 57 |
| Daily Activity Report | DocField | unit_type | reqd | Check | 1 |
| Deduction Type | DocField | description | width |  | 794 |
| Delivery Details | DocField | packages | width |  | 69 |
| Delivery Details | DocField | remarks | width |  | 380 |
| Delivery Details | DocField | shop | width |  | 208 |
| Delivery Details | DocField | status | width |  | 72 |
| Delivery Details | DocField | transporter | width |  | 130 |
| Delivery Note | DocField | base_rounded_total | hidden | Check | 1 |
| Delivery Note | DocField | base_rounded_total | print_hide | Check | 1 |
| Delivery Note | DocField | in_words | hidden | Check | 0 |
| Delivery Note | DocField | in_words | print_hide | Check | 0 |
| Delivery Note | DocField | rounded_total | hidden | Check | 1 |
| Delivery Note | DocField | rounded_total | print_hide | Check | 1 |
| Employee | DocType |  | read_only_onload | Check |  |
| Employee | DocField | designation | width |  | 190 |
| Employee | DocField | employee_number | hidden | Check | 1 |
| Employee | DocField | employee_number | reqd | Check | 0 |
| Employee | DocField | naming_series | hidden | Check | 0 |
| Employee | DocField | naming_series | reqd | Check | 1 |
| Ext Links | DocType |  | read_only_onload | Check |  |
| Ext Links | DocField | accountant | permlevel | Int | 2 |
| Ext Links | DocField | links_cpu | depends_on | Data |  |
| Ext Links | DocField | links_cpu | options | Text | <p></p><p><a href="http://3.70.155.255/ZenjjiMetabaseStart" rel="noopener noreferrer" target="_blank"> Start zenjji.com and bi.zenjji.com</a><br><br><br></p><p></p><p><a href="http://3.70.155.255/ZenjjiMetabaseStop" rel="noopener noreferrer" target="_blank"> Stop zenjji.com and bi.zenjji.com</a><br><br><br></p><p></p><p><a href="https://bi.zenjji.com/public/question/aed3757d-fa96-41a9-96dd-d28bf8fb61c9" rel="noopener noreferrer" target="_blank">NEW ORDER PREPARATION META 16-08-2021 Click here...</a><br><br><br></p><p></p><p><a href="https://bi.zenjji###.com/public/question/4bbb89a7-b597-4d4e-9c1a-0bcfa4429850" rel="noopener noreferrer" target="_blank">MARKET PURCHASE LIST Click here...</a><br><br><br></p><p></p><p><a href="https://bi.zenjji.com/public/question/7dd79cb1-1eaa-496b-a132-b3d3d7db1d17" rel="noopener noreferrer" target="_blank">STOCK ENTRY Click here...</a><br><br><br></p><p><a href="https://bi.zenjji.com/public/question/021ae59c-9903-4d78-8e71-a01942d05a5a" rel="noopener noreferrer" target="_blank">Excess items on shop orders. Click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/9522ec96-eb5d-4565-b3f5-5062ddf000c7">Items missing from Shop Orders. click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/593ea916-7a6a-4f14-8c5b-a088f1e293e2?EntryNo=%25%25" rel="noopener noreferrer" target="_blank">Shop order sequence. click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/9a7ea6c9-4702-46c4-a26a-9a6de05e6748?item_code=%25%25" rel="noopener noreferrer" target="_blank">CPU Stock Balance check. click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/bc41a01c-7885-4b32-aaeb-70832d9ec036?UnderStock=1000000" rel="noopener noreferrer" target="_blank">Warehouse stock balance check. click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/68d84187-53f4-4b90-8c03-549fd7958c84" rel="noopener noreferrer" target="_blank">Taff Kampala Stock check. click here...</a><br><br></p><br><a href="https://bi.zenjji.com/public/question/f1534c54-72c1-462b-bc77-60898a08c0e8" rel="noopener noreferrer" target="_blank">CPU Bulk Order List. click here...</a><br><br><p></p><br><a href="https://bi.zenjji.com/public/question/314971d5-8ee5-4da4-8008-bb81fd90e62e" rel="noopener noreferrer" target="_blank">Submitted Order Summary for Level of Service Computation. click here...</a><br><br><p></p><br><p></p><br><a href="https://bi.zenjji.com/public/question/3be28891-754c-41d1-809c-a63116534907" rel="noopener noreferrer" target="_blank">Stock balances for Audit Review purposes. Click here...</a><br><br><p></p><br><a href="http://www.gpstrackerxy.com/Login.aspx?Server=2" rel="noopener noreferrer" target="_blank">Motor Vehicle tracking. Click here...</a><br><br><p></p><br><br><a href="https://bi.zenjji.com/public/question/3fb9937e-86ba-4de7-b45f-542ac2b9c074" rel="noopener noreferrer" target="_blank">To Check Items weight for a given stock entry to determine if the truck is not overloaded . Click here...</a><br><br><p></p><br><br><a href="https://bi.zenjji.com/public/question/8b83903a-84de-42ea-92df-3ac9db093967" rel="noopener noreferrer" target="_blank">To Check Total quantity of Items in stock across all warehouse. Click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/3be28891-754c-41d1-809c-a63116534907?warehouse=%25%20%25" rel="noopener noreferrer" target="_blank">Photo Count. Click here...</a><br><br><br><a href="https://bi.zenjji.com/public/question/ff792de5-f903-468c-ada1-80fbf7946bfe" rel="noopener noreferrer" target="_blank">Cash Balance. Click here...</a><br><br><p></p><br> |
| Ext Links | DocField | user | permlevel | Int | 1 |
| File | DocField | file_name | width |  | 204 |
| Gate  Pass | DocType |  | read_only_onload | Check |  |
| Gate  Pass | DocField | activity | options | Text | <br>Delivery<br>Sales and Marketing<br>Service<br>Repairs<br>Fueling<br>Other |
| Gate  Pass | DocField | vehicle | options | Text | <br>UBH-740P<br>UBE-089Y<br>UBJ-443Z<br>UBM-936C<br>UEM-234Y<br>UEG-161Q<br>UBF-268L<br>UFL-809F |
| Item | DocType |  | read_only_onload | Check |  |
| Item | DocField | abc_analysis | width |  | 120 |
| Item | DocField | attributes | hidden | Check | 0 |
| Item | DocField | brand | width |  | 56 |
| Item | DocField | cbm_per_carton | width |  | 120 |
| Item | DocField | cost | width |  | 120 |
| Item | DocField | default_supplier | width |  | 176 |
| Item | DocField | default_warehouse | width |  | 120 |
| Item | DocField | description | width |  | 95 |
| Item | DocField | fob | width |  | 64 |
| Item | DocField | import_supplier | width |  | 120 |
| Item | DocField | is_sales_item | width |  | 61 |
| Item | DocField | item_category | width |  | 120 |
| Item | DocField | item_code | hidden | Check | 0 |
| Item | DocField | item_code | label | Data | Item Code(Item Name) |
| Item | DocField | item_code | reqd | Check | 1 |
| Item | DocField | item_code | width |  | 228 |
| Item | DocField | item_group | width |  | 76 |
| Item | DocField | item_name | width |  | 223 |
| Item | DocField | lead_item | width |  | 206 |
| Item | DocField | naming_series | hidden | Check | 1 |
| Item | DocField | naming_series | reqd | Check | 0 |
| Item | DocField | net_weight | width |  | 120 |
| Item | DocField | part_name | width |  | 177 |
| Item | DocField | photocount_id | width |  | 139 |
| Item | DocField | product_line_item | width |  | 120 |
| Item | DocField | qty_per_carton | width |  | 115 |
| Item | DocField | rrp | width |  | 120 |
| Item | DocField | rwp | width |  | 120 |
| Item | DocField | source | width |  | 59 |
| Item | DocField | system_category | width |  | 120 |
| Item Price | DocType |  | read_only_onload | Check |  |
| Item Price | DocType |  | sort_field | Data | modified |
| Item Price | DocType |  | sort_order | Data | ASC |
| Item Price | DocField | cost_center | width |  | 110 |
| Item Price | DocField | currency | width |  | 184 |
| Item Price | DocField | item_category | width |  | 76 |
| Item Price | DocField | item_code | width |  | 318 |
| Item Price | DocField | item_description | width |  | 55 |
| Item Price | DocField | margin | width |  | 64 |
| Item Price | DocField | new_price | width |  | 30 |
| Item Price | DocField | old_price | width |  | 30 |
| Item Price | DocField | price_list | width |  | 280 |
| Item Price | DocField | price_list_rate | width |  | 95 |
| Item Price | DocField | price_type | width |  | 99 |
| Item Price | DocField | price_update | width |  | 103 |
| Item Price | DocField | price_update_on | width |  | 122 |
| Item Price | DocField | stock_balance | width |  | 104 |
| Item Price | DocField | unit_cost | width |  | 77 |
| Journal Entry | DocType |  | default_print_format | Data |  |
| Journal Entry | DocType |  | read_only_onload | Check |  |
| Journal Entry | DocType |  | title_field | Data | cost_center |
| Journal Entry | DocField | cheque_no | in_list_view | Check | 0 |
| Journal Entry | DocField | cheque_no | width |  | 96 |
| Journal Entry | DocField | clearance_date | width |  | 53 |
| Journal Entry | DocField | company | width |  | 96 |
| Journal Entry | DocField | cost_center | width |  | 102 |
| Journal Entry | DocField | entry_category | width |  | 106 |
| Journal Entry | DocField | is_opening | width |  | 120 |
| Journal Entry | DocField | posting_date | width |  | 95 |
| Journal Entry | DocField | sales_date | width |  | 177 |
| Journal Entry | DocField | total_credit | precision | Select | 2 |
| Journal Entry | DocField | total_debit | precision | Select | 2 |
| Journal Entry | DocField | total_debit | width |  | 184 |
| Journal Entry | DocField | user_remark | width |  | 434 |
| Journal Entry | DocField | voucher_type | options | Text | Journal Entry<br>Expense Entry<br>Purchase Entry<br>Bank Entry<br>Cash Entry<br>Credit Card Entry<br>Debit Note<br>Credit Note<br>Contra Entry<br>Excise Entry<br>Write Off Entry<br>Opening Entry<br>Fixed Asset Entry |
| Journal Entry | DocField | voucher_type | width |  | 60 |
| Journal Entry Account | DocType |  | read_only_onload | Check |  |
| Journal Entry Account | DocType |  | sort_field | Data | modified |
| Journal Entry Account | DocType |  | sort_order | Data | DESC |
| Journal Entry Account | DocField | account | width |  | 243 |
| Journal Entry Account | DocField | credit_in_account_currency | precision | Select | 2 |
| Journal Entry Account | DocField | credit_in_account_currency | width |  | 180 |
| Journal Entry Account | DocField | debit_in_account_currency | precision | Select | 2 |
| Journal Entry Account | DocField | debit_in_account_currency | width |  | 141 |
| Journal Entry Account | DocField | party | width |  | 85 |
| Lead | DocType |  | read_only_onload | Check |  |
| Lead | DocField | col_break123 | label | Data |  |
| Lead | DocField | company_name | label | Data | Company Name |
| Lead | DocField | lead_name | label | Data | Owner's Name(John Egalu-0701324234-KUMI) |
| Lead | DocField | lead_name | width |  | 288 |
| Lead | DocField | lead_owner | width |  | 176 |
| Lead | DocField | source | options | Text | <br>Shop Visit<br>Advertisement<br>Blog Post<br>Campaign<br>Call<br>Customer<br>Exhibition<br>Supplier<br>Website<br>Email |
| Lead | DocField | source | reqd | Check | 1 |
| Lead Followup | DocType |  | read_only_onload | Check |  |
| Leave Application | DocType |  | read_only_onload | Check |  |
| Leave Application | DocField | status | options | Text | Open<br>Approved<br>Approved by SUP<br>Rejected |
| maximum stock | DocField | item_name | width |  | 182 |
| Order Report | DocField | packages_sent | width |  | 87 |
| Order Report | DocField | shop | width |  | 216 |
| POS Profile | DocField | user | width |  | 175 |
| Price List | DocType |  | read_only_onload | Check |  |
| Price List | DocType |  | sort_order | Data | ASC |
| Pricing Rule | DocType |  | read_only_onload | Check |  |
| Pricing Rule | DocField | apply_on | options | Text | <br>Item Code<br>Item Group<br>Item Category<br>Brand |
| Purchase Invoice | DocType |  | read_only_onload | Check |  |
| Purchase Invoice | DocField | in_words | hidden | Check | 0 |
| Purchase Invoice | DocField | in_words | print_hide | Check | 0 |
| Purchase Order | DocType |  | read_only_onload | Check |  |
| Purchase Order | DocField | contact_person | width |  | 293 |
| Purchase Order | DocField | in_words | hidden | Check | 0 |
| Purchase Order | DocField | in_words | print_hide | Check | 0 |
| Purchase Order | DocField | reference | width |  | 233 |
| Purchase Order | DocField | supplier_address | width |  | 66 |
| Purchase Order | DocField | transaction_date | width |  | 86 |
| Purchase Order Item | DocType |  | read_only_onload | Check |  |
| Purchase Receipt | DocType |  | read_only_onload | Check |  |
| Purchase Receipt | DocField | company | width |  | 142 |
| Purchase Receipt | DocField | contact_person | width |  | 30 |
| Purchase Receipt | DocField | grand_total | width |  | 120 |
| Purchase Receipt | DocField | in_words | hidden | Check | 0 |
| Purchase Receipt | DocField | in_words | print_hide | Check | 0 |
| Purchase Receipt | DocField | posting_date | width |  | 102 |
| Purchase Receipt | DocField | receipt_no | width |  | 219 |
| Purchase Receipt | DocField | supplier | width |  | 209 |
| Purchase Receipt | DocField | supplier_address | width |  | 30 |
| Purchase Receipt Item | DocField | item_code | width |  | 210 |
| Quotation | DocField | base_rounded_total | hidden | Check | 1 |
| Quotation | DocField | base_rounded_total | print_hide | Check | 1 |
| Quotation | DocField | in_words | hidden | Check | 0 |
| Quotation | DocField | in_words | print_hide | Check | 0 |
| Quotation | DocField | rounded_total | hidden | Check | 1 |
| Quotation | DocField | rounded_total | print_hide | Check | 1 |
| Salary Slip | DocType |  | read_only_onload | Check |  |
| Salary Slip | DocField | arrear_amount | hidden | Check | 1 |
| Salary Slip | DocField | branch | width |  | 230 |
| Salary Slip | DocField | column_break_25 | hidden | Check | 1 |
| Salary Slip | DocField | column_break_26 | hidden | Check | 1 |
| Salary Slip | DocField | company | width |  | 48 |
| Salary Slip | DocField | department | width |  | 60 |
| Salary Slip | DocField | designation | width |  | 68 |
| Salary Slip | DocField | employee | width |  | 72 |
| Salary Slip | DocField | employee_name | width |  | 97 |
| Salary Slip | DocField | fiscal_year | width |  | 30 |
| Salary Slip | DocField | leave_encashment_amount | hidden | Check | 1 |
| Salary Slip | DocField | leave_without_pay | width |  | 30 |
| Salary Slip | DocField | margin | width |  | 64 |
| Salary Slip | DocField | month | width |  | 52 |
| Salary Slip Earning | DocType |  | read_only_onload | Check |  |
| Salary Slip Earning | DocType |  | sort_field | Data | modified |
| Salary Slip Earning | DocType |  | sort_order | Data | DESC |
| Salary Slip Earning | DocField | e_modified_amount | reqd | Check | 1 |
| Salary Structure | DocType |  | read_only_onload | Check |  |
| Salary Structure | DocField | branch | in_list_view | Check | 1 |
| Sales Invoice | DocType |  | read_only_onload | Check |  |
| Sales Invoice | DocField | apply_discount_on | width |  | 157 |
| Sales Invoice | DocField | base_grand_total | width |  | 93 |
| Sales Invoice | DocField | base_rounded_total | hidden | Check | 1 |
| Sales Invoice | DocField | base_rounded_total | print_hide | Check | 1 |
| Sales Invoice | DocField | company | width |  | 121 |
| Sales Invoice | DocField | contact_display | width |  | 274 |
| Sales Invoice | DocField | customer | width |  | 251 |
| Sales Invoice | DocField | customer_group | width |  | 111 |
| Sales Invoice | DocField | debit_to | width |  | 120 |
| Sales Invoice | DocField | due_date | width |  | 142 |
| Sales Invoice | DocField | grand_total | width |  | 124 |
| Sales Invoice | DocField | in_words | hidden | Check | 0 |
| Sales Invoice | DocField | in_words | print_hide | Check | 0 |
| Sales Invoice | DocField | is_pos | default | Text | 1 |
| Sales Invoice | DocField | mode_of_payment | width |  | 115 |
| Sales Invoice | DocField | naming_series | options | Text | SINV-<br>SINV-RET- |
| Sales Invoice | DocField | naming_series | width |  | 120 |
| Sales Invoice | DocField | posting_date | width |  | 84 |
| Sales Invoice | DocField | project | width |  | 86 |
| Sales Invoice | DocField | rounded_total | hidden | Check | 1 |
| Sales Invoice | DocField | rounded_total | print_hide | Check | 1 |
| Sales Invoice | DocField | selling_price_list | width |  | 30 |
| Sales Invoice | DocField | shipping_address_name | width |  | 129 |
| Sales Invoice | DocField | territory | width |  | 74 |
| Sales Invoice | DocField | update_stock | default | Text | 1 |
| Sales Invoice | DocField | update_stock | reqd | Check | 1 |
| Sales Invoice Item | DocType |  | read_only_onload | Check |  |
| Sales Invoice Item | DocField | amount | width |  | 138 |
| Sales Invoice Item | DocField | cost_center | width |  | 113 |
| Sales Invoice Item | DocField | description | width |  | 30 |
| Sales Invoice Item | DocField | discount_percentage | width |  | 85 |
| Sales Invoice Item | DocField | item_code | width |  | 30 |
| Sales Invoice Item | DocField | item_name | width |  | 64 |
| Sales Invoice Item | DocField | price_list_rate | width |  | 72 |
| Sales Invoice Item | DocField | qty | width |  | 64 |
| Sales Invoice Item | DocField | rate | precision | Select | 5 |
| Sales Invoice Item | DocField | rate | width |  | 70 |
| Sales Invoice Item | DocField | warehouse | width |  | 141 |
| Sales Order | DocField | base_rounded_total | hidden | Check | 1 |
| Sales Order | DocField | base_rounded_total | print_hide | Check | 1 |
| Sales Order | DocField | in_words | hidden | Check | 0 |
| Sales Order | DocField | in_words | print_hide | Check | 0 |
| Sales Order | DocField | rounded_total | hidden | Check | 1 |
| Sales Order | DocField | rounded_total | print_hide | Check | 1 |
| Sales report | DocType |  | read_only_onload | Check |  |
| Sales report | DocField | table_3 | label | Data | Shop Sales Report |
| Sales Team | DocField | sales_person | width |  | 123 |
| Shop Visit Details | DocField | issue | width |  | 266 |
| Shop Visit Details | DocField | issue_type | width |  | 323 |
| Stock Entry | DocType |  | default_print_format | Data | STOCK ENTRY |
| Stock Entry | DocType |  | read_only_onload | Check |  |
| Stock Entry | DocType |  | title_field | Data | cost_center |
| Stock Entry | DocField | cost_center | width |  | 223 |
| Stock Entry | DocField | customer | depends_on | Data | eval:doc.purpose=="Sales Return"\|\| parent.transfer_type==="Taff Kla Order" |
| Stock Entry | DocField | from_warehouse | width |  | 174 |
| Stock Entry | DocField | production_order | width |  | 43 |
| Stock Entry | DocField | project | width |  | 58 |
| Stock Entry | DocField | purpose | default | Text | Material Transfer |
| Stock Entry | DocField | purpose | in_list_view | Check | 0 |
| Stock Entry | DocField | purpose | options | Text | <br>Material Transfer<br>Material Issue<br>Material Receipt<br>Material Transfer for Manufacture<br>Manufacture<br>Repack<br>Subcontract |
| Stock Entry | DocField | purpose | read_only | Check | 1 |
| Stock Entry | DocField | purpose | width |  | 150 |
| Stock Entry | DocField | section_break_12 | label | Data |  |
| Stock Entry | DocField | to_warehouse | width |  | 201 |
| Stock Entry Detail | DocType |  | read_only_onload | Check |  |
| Stock Entry Detail | DocType |  | sort_order | Data | ASC |
| Stock Entry Detail | DocField | item_code | width |  | 237 |
| Stock Ledger Entry | DocField | batch_no | width |  | 30 |
| Stock Ledger Entry | DocField | company | width |  | 69 |
| Stock Ledger Entry | DocField | item_code | width |  | 191 |
| Stock Ledger Entry | DocField | posting_date | width |  | 88 |
| Stock Ledger Entry | DocField | serial_no | width |  | 30 |
| Stock Ledger Entry | DocField | voucher_no | width |  | 30 |
| Stock Ledger Entry | DocField | voucher_type | width |  | 30 |
| Stock Reconciliation | DocType |  | read_only_onload | Check |  |
| Stock Reconciliation | DocType |  | title_field | Data | warehouse |
| Stock Reconciliation | DocField | difference_amount | in_list_view | Check | 1 |
| Stock Reconciliation | DocField | difference_amount | width |  | 201 |
| Stock Reconciliation | DocField | posting_date | in_list_view | Check | 0 |
| Stock Reconciliation | DocField | posting_time | in_list_view | Check | 0 |
| Stock Reconciliation | DocField | warehouse | width |  | 238 |
| Stock Reconciliation Item | DocField | current_qty | width |  | 75 |
| Stock Reconciliation Item | DocField | qty | width |  | 77 |
| Stock Reconciliation Item | DocField | warehouse | width |  | 149 |
| Supplier | DocType |  | read_only_onload | Check |  |
| Supplier | DocField | naming_series | hidden | Check | 1 |
| Supplier | DocField | naming_series | reqd | Check | 0 |
| Supplier Quotation | DocField | in_words | hidden | Check | 0 |
| Supplier Quotation | DocField | in_words | print_hide | Check | 0 |
| Top3AVGSales | DocType |  | read_only_onload | Check |  |
| Top3AVGSales | DocField | item | width |  | 234 |
| Vehicle Log Details | DocField | arrival_time | width |  | 82 |
| Vehicle Log Details | DocField | depart_from | width |  | 172 |
| Vehicle Log Details | DocField | departure_time | width |  | 86 |
| Vehicle Log Details | DocField | km_departure | width |  | 75 |
| Warehouse | DocType |  | read_only_onload | Check |  |
| Warehouse | DocType |  | sort_field | Data | modified |
| Warehouse | DocType |  | sort_order | Data | ASC |
| Warehouse | DocField | column_break0 | label | Data |  |

## Migration Notes

- Custom fields and property setters can usually be recreated in ERPNext 15, but each target DocType and field name must be verified because many standard DocTypes changed between v6 and v15.
- Custom Script records are legacy client scripts. Their JavaScript should be reviewed and rewritten for current Frappe form APIs where needed.
- Print formats from v6 may depend on old Jinja/context fields and need rendering tests in v15.
- Reports need classification before migration: Report Builder/Query/Script reports have different migration paths, and script reports may require filesystem app code.
- This database audit cannot detect custom Python apps, scheduler code, edited core files, or files stored outside the database.
