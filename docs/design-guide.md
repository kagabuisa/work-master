# Work Master design guide

The shared styles live in `public/design-system.css`, loaded after the existing stylesheet. Reuse these components when changing screens; avoid adding another page-specific version of the same spacing or field rules. The existing stylesheet continues to support screens that have not adopted these layout components.

## Foundations

Use the existing `--surface`, `--line`, `--text`, `--muted`, and `--accent` colors. The shared spacing scale is 4, 8, 12, 16, and 20 pixels. Standard compact controls are 34 pixels high; surfaces use 16-pixel padding and 8-pixel corners. Keep visible keyboard focus and sufficient touch targets for icon actions. Fixed outline labels are supplied by `public/floating-fields.js`; preserve standard labels for checkboxes, switches, uploads, table editors, and multi-select controls. Long field labels retain their full accessible text and expose a helper icon when they do not fit.

## Page templates

Add `ui-page` to the main shell, with `ui-page-list`, `ui-page-form`, or `ui-page-report` describing the layout. These classes do not change permissions or data handling.

- **List:** breadcrumb and page actions, `ui-toolbar` search/filter form, `ui-surface ui-results` table card, `ui-table-scroll` wrapper, `ui-table`, and existing pagination. Reference: `views/master-list.ejs`, including Employees. Tables scroll inside their card rather than widening the page.
- **Form/detail:** breadcrumb and module sub-tabs, `ui-surface` sections, `ui-form-section` fieldsets, `ui-form-grid` fields, and `ui-form-footer` actions. References: `views/hr-employee.ejs` and `views/hr-employee-details.ejs`. Attendance, Leave, Payroll, Employee Money, HR Settings, payroll runs, and payslips also reuse these form, surface, heading, and table components. Read-only controls retain their disabled state. Fields stack at the established responsive breakpoints.
- **Report:** breadcrumb and page actions, `ui-toolbar` filters, `ui-report-metrics` totals, and `ui-surface ui-results` result card. Reference: `views/daily-activity.ejs`. Report dates remain in the date filters; section metadata shows the result range. Do not repeat the breadcrumb's page title above the filters.

## Shared components

Use `ui-inline-form` with `ui-form-grid` for short settings forms whose submit action belongs beside the fields. Its action stays in the current grid row rather than using the full-width form footer. HR Settings is the reference: account input and Save account share a row at all supported widths; longer forms stack fields on mobile.

Master directories use `ui-list-compact` on the page shell. Reuse this density modifier for compact lists: 4-pixel vertical cell padding, 12-pixel body text, smaller section headers, and 8-pixel toolbar/pagination padding. Keep complete cell values and horizontal scrolling; do not truncate employee details to save space. Touch devices retain 36-pixel row action targets. The employee status filter uses one inline switch label beside the search controls, stacking below them on narrow screens.

`ui-section-heading.ejs` receives a `heading` object with `title`, optional `eyebrow`, optional `meta`, and optional `help`. Output is escaped. Use it for section headings and counts, not a second page title.

`ui-helper.ejs` receives `helpLabel` and `helpText`, plus optional `helpClass`. It renders an accessible, keyboard-operable information disclosure. Put guidance beside the field or action it explains. The HR helper partial delegates to this component.

Use one primary button per action group. Use `button-light` for secondary navigation and reset actions. Keep cancellation labels explicit. Table amounts align right with tabular numerals; badges convey status through text as well as color. Empty states explain that no records match the current view.

## Verification

Check real rendered templates at desktop and mobile widths, including empty results, long labels, disabled controls, helper disclosure, and horizontal table scrolling. Confirm field names, action URLs, permissions, and pagination parameters remain correct. Run the relevant tests and rebuild the app as required by `AGENTS.md`.
