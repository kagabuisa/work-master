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
