# ERPNext v6 to v15 Master Data and Settings Evaluation

Generated: 2026-06-25T19:07:10.481Z
Old source: MySQL database `1bd3e0294d`
New target: https://new.zenjji.com

## Objective

Check whether ERPNext v15 matches the ERPNext v6 setup for phase 1 master data and important singleton settings. This is read-only and compares live systems using the credentials in `.env`.

## Master Data Summary

| DocType | Old | v15 | Matched | Missing | Field Diffs |
| --- | --- | --- | --- | --- | --- |
| Company | 1 | 1 | 1 | 0 | 2 |
| Currency | 139 | 155 | 139 | 0 | 11 |
| Fiscal Year | 15 | 15 | 15 | 0 | 10 |
| UOM | 13 | 244 | 13 | 0 | 1 |
| Brand | 28 | 28 | 28 | 0 | 0 |
| Branch | 28 | 28 | 28 | 0 | 0 |
| Warehouse Type | 6 | 6 | 6 | 0 | 0 |
| Item Group | 15 | 15 | 15 | 0 | 9 |
| Price List | 59 | 69 | 59 | 0 | 12 |
| Cost Center | 38 | 39 | 38 | 0 | 1 |
| Warehouse | 51 | 63 | 51 | 0 | 12 |
| Account | 261 | 297 | 261 | 0 | 66 |

## Settings Summary

| Settings | Comparable Fields | Field Diffs | Missing/Unavailable |
| --- | --- | --- | --- |
| System Settings | 9 | 0 | 4 |
| Global Defaults | 6 | 1 | 1 |
| Accounts Settings | 1 | 0 | 4 |
| Stock Settings | 8 | 0 | 5 |
| Selling Settings | 8 | 0 | 3 |
| Buying Settings | 6 | 0 | 1 |
| HR Settings | 1 | 0 | 2 |
| Manufacturing Settings | 6 | 0 | 3 |
| Print Settings | 7 | 0 | 0 |
| Features Setup | 0 | 0 | GET /api/resource/Features%20Setup/Features%20Setup failed 500 (500) |
| Website Settings | 3 | 0 | 18 |

## Priority Gaps

- Company `SUPERTEX APA CO. LTD`: company_name old=`SUPERTEX APA CO. LTD`, v15=`SUPERTEX APA CO LTD`.
- Company `SUPERTEX APA CO. LTD`: domain old=`Retail`, v15=``.
- Currency `CNY`: fraction_units old=`0`, v15=`100`.
- Currency `CNY`: number_format old=`#,###.###`, v15=`#,###.##`.
- Currency `IRR`: symbol old=``, v15=`﷼`.
- Currency `KES`: symbol old=`KSh`, v15=`Sh`.
- Currency `KES`: enabled old=`1`, v15=`0`.
- Currency `NPR`: number_format old=`#,###.##`, v15=`#,##,###.##`.
- Currency `SGD`: fraction old=`Sen`, v15=`Cent`.
- Currency `TRY`: number_format old=`#,###.##`, v15=`#.###,##`.
- Currency `UGX`: symbol old=`Ugx`, v15=`Sh`.
- Currency `UGX`: fraction_units old=`0`, v15=`100`.
- Fiscal Year `2026`: year_start_date old=`2025-12-31`, v15=`2026-01-01`.
- Fiscal Year `2026`: year_end_date old=`2026-12-30`, v15=`2026-12-31`.
- Fiscal Year `2027`: year_start_date old=`2026-12-31`, v15=`2027-01-01`.
- Fiscal Year `2027`: year_end_date old=`2027-12-30`, v15=`2027-12-31`.
- Fiscal Year `2028`: year_start_date old=`2027-12-31`, v15=`2028-01-01`.
- Fiscal Year `2028`: year_end_date old=`2028-12-30`, v15=`2028-12-31`.
- Fiscal Year `2029`: year_start_date old=`2028-12-31`, v15=`2029-01-01`.
- Fiscal Year `2029`: year_end_date old=`2029-12-30`, v15=`2029-12-31`.
- Fiscal Year `2030`: year_start_date old=`2029-12-31`, v15=`2030-01-01`.
- Fiscal Year `2030`: year_end_date old=`2030-12-30`, v15=`2030-12-31`.
- UOM `Unit`: must_be_whole_number old=`0`, v15=`1`.
- Item Group `Products`: is_group old=`Yes`, v15=`0`.
- Item Group `Spark Plug`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `Spokes`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `CC Measuring Oil`: item_group_name old=`Measuring Oil`, v15=`CC Measuring Oil`.
- Item Group `CC Measuring Oil`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `Taff Butyl`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `Piston Taff`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `Wires`: parent_item_group old=`Products`, v15=`All Item Groups`.
- Item Group `Vehicles`: parent_item_group old=`Fixed Assets`, v15=`All Item Groups`.
- Price List `Import Price`: price_list_name old=`Import China`, v15=`Import Price`.
- Price List `PLST CARTON TAFF BUNIA`: price_list_name old=`PLST VIP TAFF BUNIA`, v15=`PLST CARTON TAFF BUNIA`.
- Price List `PLST Galaxy Autos ASP`: price_list_name old=`PLST Tambo ASP`, v15=`PLST Galaxy Autos ASP`.
- Price List `PLST Japa Q. Spares`: price_list_name old=`PLST Japa Q. Spares Retail`, v15=`PLST Japa Q. Spares`.
- Price List `PLST Kyenjojo Traders`: price_list_name old=`Kyenjojo Trdz CST`, v15=`PLST Kyenjojo Traders`.
- Price List `PLST Multiple Tradex WHSL`: price_list_name old=`PLST Mutliple Tradex WHSL`, v15=`PLST Multiple Tradex WHSL`.
- Price List `PLST TAFF BUNIA RTL`: price_list_name old=`PLST TAFF KUDIA RTL`, v15=`PLST TAFF BUNIA RTL`.
- Price List `PLST TAFF BUNIA WHSL`: price_list_name old=`PLST TAFF KUDIA WHSL`, v15=`PLST TAFF BUNIA WHSL`.
- Price List `PLST Taff Kampala`: price_list_name old=`Taff Kampala`, v15=`PLST Taff Kampala`.
- Price List `Retail Pricelist`: price_list_name old=`Price List Baiga AS`, v15=`Retail Pricelist`.
- Cost Center `SUPERTEX APA CO. LTD - SACL`: cost_center_name old=`SUPERTEX APA CO. LTD`, v15=`SUPERTEX APA CO LTD`.
- Warehouse `Container(1) W/Hse - SACL`: warehouse_name old=`Container`, v15=`Container(1) W/Hse`.
- Warehouse `CPU Stores WHse - SACL`: warehouse_name old=`Stores`, v15=`CPU Stores WHse`.
- Warehouse `DDR Request W/Hse - SACL`: warehouse_name old=`DDR Req`, v15=`DDR Request W/Hse`.
- Warehouse `Galaxy Enterprises W/Hse - SACL`: warehouse_name old=`Galaxy Enterprises`, v15=`Galaxy Enterprises W/Hse`.
- Warehouse `Kyenjojo Trdz W/Hse - SACL`: warehouse_name old=`Kyenjojo T W/Hse`, v15=`Kyenjojo Trdz W/Hse`.
- Warehouse `Masaba AG W/Hse - SACL`: warehouse_name old=`Masaba AS W/Hse`, v15=`Masaba AG W/Hse`.
- Warehouse `Okiror Vita W/Hse - SACL`: warehouse_name old=`Okiror Vita WHse`, v15=`Okiror Vita W/Hse`.
- Warehouse `Ordering Shop2Shop W/Hse - SACL`: warehouse_name old=`Ordering Shop2Shop WHse - SACL`, v15=`Ordering Shop2Shop W/Hse`.
- Warehouse `Superb Kse W/Hse - SACL`: warehouse_name old=`Super W/Hse`, v15=`Superb Kse W/Hse`.
- Warehouse `Taff Arua W/Hse Shp - SACL`: warehouse_name old=`Taff Arua W/Hse`, v15=`Taff Arua W/Hse Shp`.
- Account `Abiriga AS W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `Alpha AS W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `Baiga AS WHse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `BC Bundibugyo W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `BC Nebbi W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `BC Paidha W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `Container(1) W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `Container(2) W/Hse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `CPU Stores WHse - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Account `DDR Req W/Hs - SACL`: account_type old=`Warehouse`, v15=`Stock`.
- Global Defaults: default_company old=`SUPERTEX APA CO. LTD`, v15=`SUPERTEX APA CO LTD`.
- Features Setup: could not read v15 settings (GET /api/resource/Features%20Setup/Features%20Setup failed 500 (500)).

Full machine-readable details: `audits/v6-v15-master-data-settings-evaluation.json`
