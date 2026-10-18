# Work Master design guide

The shared styles live in `public/design-system.css`, loaded after the existing stylesheet. Reuse these components when changing screens; avoid adding another page-specific version of the same spacing or field rules. The existing stylesheet continues to support screens that have not adopted these layout components.

## Foundations

Use the existing `--surface`, `--line`, `--text`, `--muted`, and `--accent` colors. The shared spacing scale is 4, 8, 12, 16, and 20 pixels. Standard compact controls are 34 pixels high; surfaces use 16-pixel padding and 8-pixel corners. Keep visible keyboard focus and sufficient touch targets for icon actions. Fixed outline labels are supplied by `public/floating-fields.js`; preserve standard labels for checkboxes, switches, uploads, table editors, and multi-select controls. Long field labels retain their full accessible text and expose a helper icon when they do not fit.

## Page templates

Add `ui-page` to the main shell, with `ui-page-list`, `ui-page-form`, `ui-page-report`, or `ui-page-dashboard` describing the layout. These classes do not change permissions or data handling.

- **Dashboard/module directory:** compact brand and session header (`ui-dashboard-header`), flexible `ui-dashboard-grid`, and `ui-module-card.ejs` for each permitted module. Reference: `views/index.ejs`. Cards use 12-pixel padding, 14-pixel linked headings, helper icons for descriptions, and 12-pixel links in responsive columns. Cards expand to fill the final row and stack on mobile; touch devices retain 36-pixel link targets. Keep the existing permission-filtered module data and empty state.
- **List:** breadcrumb and page actions, `ui-toolbar` search/filter form, `ui-surface ui-results` table card, `ui-table-scroll` wrapper, `ui-table`, and existing pagination. Reference: `views/master-list.ejs`, including Employees. Sales and purchase lists, purchase orders, journals, stock entries/reconciliations, and accounts use this compact layout too. Tables scroll inside their card rather than widening the page.
- **Form/detail:** breadcrumb and module sub-tabs, `ui-surface` sections, `ui-form-section` fieldsets, `ui-form-grid` fields, and `ui-form-footer` actions. References: `views/hr-employee.ejs` and `views/hr-employee-details.ejs`. Attendance, Leave, Payroll, Employee Money, HR Settings, payroll runs, and payslips also reuse these form, surface, heading, and table components. Non-HR voucher and master editors, voucher details, general settings, users/roles, and Project Files also use shared surfaces, responsive field grids, and scrolling tables. Editable line tables preserve specialized spacing and controls; add `ui-table-scroll` around them without applying read-only `ui-table` density. Read-only controls retain their disabled state. Fields stack at the established responsive breakpoints.
- **Report:** breadcrumb and page actions, `ui-toolbar` filters, `ui-report-metrics` totals, and `ui-surface ui-results` result card. Reference: `views/daily-activity.ejs`. Report dates remain in the date filters; section metadata shows the result range. Accounting, stock, invoice, voucher, and debtor reports also use shared filters, metrics, surfaces, and tables. Do not repeat the breadcrumb's page title above the filters.

## Shared components

Stock entry previews follow the sales invoice document reference: one action group above the shared detail card, metadata cards, right-aligned quantities/rates, and a scrollable read-only item table. Full-page and drawer previews reuse `stock-entry-detail.ejs` and `stock-entry-actions.ejs`. Stock entry editors keep Save/Submit in the top action bar, with buttons associated to the form; retain the existing row, import, and cancellation controls.

Voucher master references show one identifier: codes/IDs for items, customers, and suppliers; names for employees, cost centers, and accounts. Keep foreign keys in hidden inputs or option values. Do not add a second visible name/ID field or combine the two in picker labels. Cost center name inputs must resolve to a permitted master ID before saving; unresolved edits must not silently clear an assignment.

Use `voucher-posting-fields.ejs` for voucher posting dates and times and payment dates. Keep its collapsed Edit/View control in the main details row; opening it overlays the inputs below the control without changing grid spans or moving other fields. On narrow screens the editor appears above the bottom edge of the viewport. Outside clicks and Escape dismiss it without clearing entered values. Preserve input names, IDs, saved values, and read-only behavior. New vouchers use the current Kampala date/time. `voucher-posting-fields.js` opens the control if a collapsed input fails validation. Due dates and report dates remain visible.

Use `ui-voucher-attributes` for a single row of voucher metadata such as price list, cost center, and linked purchase order. Each item has a muted label above its value and an equal share of the softly tinted, bordered panel, with subtle dividers. Keep values and permitted links complete; the row scrolls horizontally on narrow screens.

All search and filter bars use `ui-toolbar ui-filter-row`. Keep filter controls and actions in one horizontal row at every viewport width. Fields share the available width, retain readable minimum widths, and scroll horizontally within the bar when they do not fit; do not stack actions or wrap fields on mobile. This applies to report/list filters, master searches, HR register searches, role/user selectors, and statement date ranges. Group action buttons together and preserve their order. Keep switches and fixed outline-label exceptions intact. The shared `filter-row.js` places autocomplete results and report column-selection panels in the browser's popover layer so scrolling bars do not clip suggestions; keep result elements inside their existing field in the template.

Use `ui-inline-form` with `ui-form-grid` for short settings forms whose submit action belongs beside the fields. Its action stays in the current grid row rather than using the full-width form footer. HR Settings is the reference: account input and Save account share a row at all supported widths; longer forms stack fields on mobile.

Master directories use `ui-list-compact` on the page shell. Reuse this density modifier for compact lists: 4-pixel vertical cell padding, 12-pixel body text, smaller section headers, and 8-pixel toolbar/pagination padding. Keep complete cell values and horizontal scrolling; do not truncate employee details to save space. Touch devices retain 36-pixel row action targets. The employee status filter uses one inline switch label beside the search controls in the same row.

`ui-section-heading.ejs` receives a `heading` object with `title`, optional `eyebrow`, optional `meta`, optional `help`, and optional `href` to link the title. Output is escaped. Use it for section headings and counts, not a second page title.

`ui-helper.ejs` receives `helpLabel` and `helpText`, plus optional `helpClass`. It renders an accessible, keyboard-operable information disclosure. Put guidance beside the field or action it explains. The HR helper partial delegates to this component.

`ui-module-card.ejs` receives a `module` with `name`, `href`, `description`, `tone`, and `links` (`label`/`href`). It reuses the shared surface, section heading, and helper components. Supply only authorized links; the partial renders the supplied data without computing access rules.

Use one primary button per action group. Use `button-light` for secondary navigation and reset actions. Keep cancellation labels explicit. Table amounts align right with tabular numerals; badges convey status through text as well as color. Empty states explain that no records match the current view.

For a compact mini dashboard, add `ui-metrics-compact` to `ui-report-metrics`. Each label and figure share one row: label on the left, full figure on the right. Figures use responsive 10–12-pixel text; cards have a 240-pixel preferred minimum width and rearrange rather than squeezing their contents. Debtors is the reference. Keep values inside card boundaries without truncating them, and verify large and negative amounts at desktop and mobile widths.

## Verification

Check real rendered templates at desktop and mobile widths, including empty results, long labels, disabled controls, helper disclosure, and horizontal table scrolling. Confirm field names, action URLs, permissions, and pagination parameters remain correct. Run the relevant tests and rebuild the app as required by `AGENTS.md`.

Use `ui-download-menu.ejs` inside a report filter form for a single Download disclosure with CSV, Excel, and PDF submit options. It uses the shared filter panel styling and `filter-row.js` top-layer positioning so options remain visible above scrolling filter bars. The native disclosure supports keyboard opening; Escape and outside clicks close the floating panel.


Use `ui-party-balance-strip.ejs` with a `strip` object (`title`, `rows`, `partyLabel`, `positiveLabel`, `negativeLabel`, `help`) for matching customer/supplier positions. It reuses `ui-summary-line`, the shared section heading, and three evenly distributed labelled fields: party, Payment position, and Balance (UGX). The amount aligns right and payment position is centred. At 800px and below, the name moves above position and amount. Full values remain visible; zero balances show Settled.

General Ledger combines `ui-list-compact`, `ui-metrics-compact`, and `ui-results` for a dense report. Reusable accents are `ui-metric-focus` for the primary total, `ui-opening-row`, `ui-account-divider`, and `ui-total-row` for table hierarchy, and `ui-row-action` for compact accessible row links. Inline summaries use a subtle accent edge, a neutral status pill, and an emphasized amount; retain full names, natural wrapping, and horizontal table scrolling.

Controlled warehouse count and correction screens use the shared form/list surfaces, section headings, helpers and horizontally scrolling editable tables. Under active inventory controls, sales forms retain Posting Date/Time labels for accounting; purchase/stock forms label entered dates as document dates. Date and time inputs remain editable on editable vouchers. Show current stock previews and explain that server submission assigns the separate actual inventory timestamp. Count cut-offs are fixed metadata, never editable date controls. Reuse the scanned-sheet attachment partial with a count-scoped endpoint and count View/Save access for independent review.

Use `ui-panel-grid` for two adjacent document-tool surfaces (one column below 720px). `ui-upload-card` and `ui-upload-form` provide consistent file controls, compact spacing and aligned footer actions. Stock Reconciliation uses these shared components for supporting scans and Excel count sheets below its count table.

Use `ui-attributes-compact` with `ui-voucher-attributes` for dense voucher metadata: smaller padding and type with the same accessible horizontal scrolling. Keep workflow guidance in the shared helper beside the relevant action.

Document cards use shared `ui-upload-intro`, `ui-upload-summary`, `ui-upload-steps` and `ui-upload-field` components with `ui-upload-card`. Keep section headings, native accessible file pickers, quiet file-limit hints and bottom-aligned action rows; use a primary upload/import action and a secondary download action.

Use `ui-metrics-three` with compact report metrics for three columns of related effects. `ui-action-row` and `ui-action-form` align voucher workflow actions and their reason fields; `ui-action-form-secondary` separates the secondary action, and `ui-secondary-action` holds infrequent actions in a disclosure.

Stock entry preview metadata uses `ui-voucher-attributes ui-attributes-compact ui-attributes-inline` for one compact horizontal row in full and drawer previews. Use a direct `form.ui-attribute-control` child for an editable attribute with an adjacent save button; its controls stay inline and share the strip's dividers and padding. The inline modifier sizes text attributes to their contents so the row fits drawers; the strip scrolls horizontally on narrow screens without wrapping fields or controls. Fixed outline labels remain enabled for these form fields.

Use the shared `ui-access-panel`, `ui-access-invite`, and `ui-access-list` components for record sharing. Show one identity and one access selector per person, with a small labelled remove control. Keep timestamps secondary, reserve a quiet feedback line for save/error messages, and keep the invite action separate from existing people. Invite fields retain fixed outline labels; list selectors use explicit accessible names and `data-standard-labels`. On small screens, move row controls below the identity without truncating names. Changes save in place and restore focus; a visible Save button remains available without JavaScript.
