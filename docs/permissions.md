# Permissions and voucher visibility

## How access is decided

1. Each user has one role. Roles grant actions on voucher types, master lists, payments, accounts, and reports. The built-in roles are Standard, Privileged, Admin, Retail, Wholesale, Finance, Logistics, and Management. Retail, Wholesale, Finance, Logistics, and Management start with the same permission set as Standard; an admin can edit role permissions in **Settings → Roles**.
2. An admin can adjust a user's effective permissions in **Settings → Users**. User grants add to the role permissions, and user denials remove them. A denial wins when a permission appears in both places. Admin has full access.
3. A user's permitted records narrow which named records they can use or view. **Settings → Users** provides Warehouse, Cost Center, Employee name, Retail Price list, and Wholesale Price list assignments. Assigned values are stored in `app_users.record_access`; the related named Read permissions are added to the user. Customer group, supplier type, price list, warehouse, and account scopes can narrow access further.
4. The application checks both the action permission and the record scope on each request. A menu link or a report permission alone does not grant access to a voucher outside the user's scope.

The Roles and User Permissions pages offer every active, submitted price list as a permission type, including buying lists such as Standard Buying. The Read action allows use of the list where its buying or selling direction, currency, and the voucher workflow permit it. Listing a price list as a permission type does not make an inactive or incompatible list usable in a voucher.

Role permissions are defined in [`src/auth.js`](../src/auth.js). User record assignments are defined in [`src/user-record-access.js`](../src/user-record-access.js). Request checks are in [`src/authorize.js`](../src/authorize.js), and named record scopes are in [`src/access.js`](../src/access.js).

## Standard role voucher rule

Standard users can see a voucher when its `created_by_user_id` matches their login. For a **sales invoice**, they can also see it when `invoicer_id` matches the employee assigned to their user. These are alternative ways to qualify: a Standard user can see an invoice they created or one assigned to their permitted employee. Purchases, purchase orders, stock entries, stock reconciliations, and journals use the creator login because they have no employee assignee field.

The rule applies to voucher lists, voucher reports and CSV exports, direct detail/edit/action URLs, linked payment pages, stock entry cancellation lookups, stock ledger and movement details, gross profit, and journal reference suggestions. Other roles keep their existing role permissions and record scopes.

The Journals list, report, detail, and drawer require Account Read access to every line account, including for the journal creator. Standard users must also own the journal. A denied detail or drawer request explains whether Journal Read, ownership, or line account access is missing. The creator can see the restricted account codes in that error.

Voucher ownership comes from the record audit fields, which stamp `created_by_user_id` when the voucher is created. A historical voucher with no creator user ID is not treated as owned by a Standard user. A historical sales invoice can still be visible if its `invoicer_id` matches the user's assigned employee. Editing a voucher does not change its creator. The rule is implemented in [`src/voucher-ownership.js`](../src/voucher-ownership.js).

Daily Activity and Debtors reports remain unavailable to Standard users because those views do not reliably map every displayed voucher to an owner. A Standard user with General Ledger Read can open General Ledger, but sees entries only from their own vouchers (or sales invoices assigned to their employee) and permitted accounts. Payment entries follow the ownership of their parent invoice or purchase. Historical entries without a verifiable owner are excluded. If customer or supplier categories are selected for the user, the ledger also filters sales and purchase entries to those categories and omits journal and stock entries. The scoped sales, purchase, purchase order, journal, stock ledger, stock movement, and gross profit reports remain available when the user's action permissions allow them.

## Example

If Isa Kagabu is the permitted employee for a Standard user, that user can open a sales invoice they created, or an invoice whose invoicer is Isa Kagabu's employee ID. They cannot open a purchase order created by another login, even if they have the Purchase Order Read permission.

Assigning an employee also prefills that employee as the invoicer on a new sales invoice. The user can select another valid invoicer where their other permissions permit it, but that does not make the resulting invoice visible to a different Standard user unless the other user created it or is assigned as its invoicer.
