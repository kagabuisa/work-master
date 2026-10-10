# Invoice UI and UX review

- **Reviewed:** 27 September 2026
- **Scope:** invoice list, new and draft edit form, invoice detail drawer, payment section, print view, and their client-side behavior.
- **Method:** review of the current EJS, JavaScript, and CSS, followed by Chromium screenshots at 1440 × 900 and 390 × 844 and an A4 PDF check. The browser used representative demo data, not a live customer invoice. This review does not include user testing.

## Follow-up changes (7 October 2026)

Code updates add arrow-key navigation and result announcements for customer and item suggestions, give item quantity and Add controls contextual names, and render unavailable pagination actions as non-focusable disabled text. The invoice button remains **Save**, with a note explaining that saving keeps a draft and submission posts stock and accounting entries. These updates have not received a fresh browser or screen-reader review. The original findings below describe the September review.

## Overall assessment

The core workflow is coherent: invoices have a distinct draft state, submission is a separate action, the list distinguishes document status from payment status, and the form preserves entered data after a server error. The recent price-list behavior keeps invoice lines and recalculates totals. The largest remaining UX gaps are in how the app identifies line items, explains price sources, and supports keyboard and touch input.

### Visual check

- The [desktop draft](invoice-review-assets/draft-desktop.png) is compact and the border labels remain readable. In the browser check, changing the price list updated all three sample line rates and the total.
- The [phone invoice list](invoice-review-assets/list-phone.png) shows invoice number, date, and part of customer name; total, paid amount, and both statuses are off-screen inside the table. There is no visible cue that the table scrolls sideways. The document itself has no horizontal overflow, so the hidden columns are easy to miss.
- The [phone draft](invoice-review-assets/draft-phone.png) is 2,041 px tall with only three items. Each line becomes a tall card, and Save remains at the top after scrolling to totals.
- The [phone detail](invoice-review-assets/detail-phone.png) also hides line totals and payment statuses inside horizontally scrolling tables. The payment entry form itself fits the width.
- The [phone print view](invoice-review-assets/print-phone.png) wraps money values and table headings awkwardly. The [A4 output](invoice-review-assets/invoice-a4.png) is legible and now labels payment entries as “Received” or “Cancelled.”

**Resolved after the initial review:** the printed payment table now includes a Status column, so a cancelled entry cannot be mistaken for a received payment. See [invoice-print.ejs](../views/invoice-print.ejs#L92) and the updated [A4 preview](invoice-review-assets/invoice-a4.png).

## Findings and recommendations

| Priority | Finding | Evidence and user effect | Recommended change |
| --- | --- | --- | --- |
| **High** | **The “Item Name” column shows an item code in the editor and detail view.** | The editor renders `item.item_code` under “Item Name” in [invoice.js](../public/invoice.js#L620); the detail view does the same in [invoice-detail.ejs](../views/invoice-detail.ejs#L31). The print view displays `item.item_name`, so the same invoice has different item identification across screens. Users must decode codes to verify the right product. | Show the item name as the primary text and the code as smaller secondary text in the editor, detail, drawer, and print view. Keep both visible for reconciliation. |
| **High** | **Invoice item controls lack row-specific names and are small on desktop.** | Every line uses “Quantity”, “Unit price”, and “Remove” without the item name in [invoice.js](../public/invoice.js#L622). Several table buttons have a 24 px minimum height in [styles.css](../public/styles.css#L1959); only the mobile editor overrides this to 40 px. This makes keyboard or screen-reader navigation ambiguous and increases mis-taps in payment tables. | Name controls with their item context, for example “Unit price for 12N6 battery”, and use at least a 40–44 px touch target for interactive table actions. Add a visible or accessible confirmation for removing a line if accidental removal is common. |
| **Medium** | **Price-list changes need clearer per-line feedback.** | The form can replace rates and shows a short status below the top fields, but [invoice.js](../public/invoice.js#L424) only reports a summary and up to three codes with no price on the selected list. Users cannot see which rate came from the price list versus the item default, or the old and new values. This is especially confusing for lists such as Taff Kampala with incomplete item coverage. | After repricing, mark each affected row with its price source and briefly show old → new rate. Keep a persistent warning on rows using default rates until the user saves or changes lists. Put “Refresh Prices” beside the Price List field, or describe when it is needed. |
| **Medium** | **Customer and item lookups have limited keyboard and assistive-technology cues.** | [new-invoice.ejs](../views/new-invoice.ejs#L50) has search inputs followed by untyped result containers. [invoice.js](../public/invoice.js#L261) displays suggestions but does not expose `aria-expanded`, `aria-controls`, active suggestion, or a live result count. Enter selects the first match, but arrow-key selection is absent. | Use a combobox/listbox pattern or native autocomplete behavior. Announce loading, result count, and “no matches”; support Up/Down, Enter, and Escape; keep visible focus on the active result. Preserve the current mouse flow. |
| **Medium** | **The draft workflow hides the next step until after saving.** | The form’s primary action says “Save” in [new-invoice.ejs](../views/new-invoice.ejs#L17), while “Submit Invoice” and “Submit Cash Sale” appear only on the saved draft’s detail page in [invoice-actions.ejs](../views/invoice-actions.ejs#L1). Users cannot tell from the editor that Save creates or updates a draft. | Label the action “Save Draft”; show a brief “Next: review and submit” note near it. On the saved draft, make the main submission action prominent and explain the stock and payment consequences in plain language. |
| **High** | **The phone invoice list hides the most useful financial information.** | In the [390 px screenshot](invoice-review-assets/list-phone.png), total, paid amount, and both statuses are off-screen inside the eight-column table in [invoices.ejs](../views/invoices.ejs#L46). At widths under 820 px, [styles.css](../public/styles.css#L2480) makes tables horizontally scrollable, but the viewport gives no scroll cue. | Use compact mobile rows with invoice number, customer, date, total, balance, and statuses visible. Put secondary columns in the drawer. Add a “Clear filters” action when filters produce an empty result. |
| **Medium** | **A few line items make the phone draft long and difficult to review.** | Three line cards push the [390 px draft](invoice-review-assets/draft-phone.png) to 2,041 px. The top Save action is far from the totals at the bottom. The layout in [styles.css](../public/styles.css#L3031) expands each table row into a two-column card with a full-width remove action. | Reduce repeated labels and empty space in each line card; keep name/code, quantity, unit price, and line total together. Add a sticky bottom summary with Total and Save Draft for long invoices, without covering editable fields. |
| **Medium** | **The phone print page is hard to read before printing.** | In the [390 px browser view](invoice-review-assets/print-phone.png), column headings and amounts wrap across multiple lines; the [A4 PDF](invoice-review-assets/invoice-a4.png) reads well. | Provide a mobile-friendly preview or a “Download PDF” action so phone users can inspect the A4 layout before printing or sharing it. |
| **Low** | **Pagination looks disabled but remains a focusable `#` link.** | [pagination.ejs](../views/pagination.ejs#L13) adds a `disabled` class but leaves Prev/Next as anchors with `href="#"`. Keyboard users can focus an action that cannot move. | Render a non-link disabled control with `aria-disabled="true"`, or omit the anchor at the page boundary. |

## Suggested delivery order

1. **Correct information:** align item names across editor, detail, and print.
2. **Make pricing understandable:** show a line-level rate source and changed values, then test a draft with list prices and with default-rate fallbacks.
3. **Improve interaction:** give lookup results keyboard semantics, contextual control names, and larger table action targets.
4. **Refine mobile navigation:** simplify the narrow-screen list and line cards; keep Total and Save Draft available on long invoices.
5. **Polish the remaining flow:** clarify draft submission, filtered empty states, and mobile print preview.

## Validation for a follow-up implementation

Test at desktop and phone widths with a long invoice, a draft with a changed price list, an item missing from that list, a cancelled payment, and a filtered empty list. Complete the same flows by keyboard and screen reader, then print an invoice with payment history to confirm its wording matches the on-screen balance. The current browser check covered price changes and representative layouts; it did not cover those keyboard and screen-reader tasks.
