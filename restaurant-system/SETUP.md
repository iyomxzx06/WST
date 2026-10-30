# Havens Restaurant System

The modular restaurant system is the primary application. It does not import old sales or customer data. The one-time default catalog setup loads product names, prices, and bun/patty stock rules embedded in `hb.html`; it runs automatically when Inventory is opened if the catalog import has not been recorded.

## Database setup

### Existing Supabase project

1. In the Supabase SQL Editor, run `migrations/001_security_checkout_realtime.sql` once. It is additive and transactional; it does not drop tables or delete business data.
2. In the SQL Editor, run `migrations/002_import_hb_v11_catalog.sql` once. This adds the optional catalog importer and does not import or delete existing orders, products, or stock.
3. Run `migrations/003_label_hb_v11_burgers.sql` once. It renames only the eight exact default burger catalog names, adding B1 Classic, B2 Cheese, B3 Deluxe, and B4 Double labels. It does not change prices, recipes, stock, or historical order items. It also updates the one-time importer so future imports use the same labels.
4. Run `migrations/004_inventory_stock_rules.sql` once, after `003`. It adds missing inventory items with zero stock and sets the default burger/add-on quantities used by future checkouts. Existing stock balances, order history, and unrelated recipe entries are preserved. Review the stock list and enter your real opening amounts before taking orders.
5. Run `migrations/005_set_inventory_count.sql` once, after `004`, if it has not already been run. It enables setting a displayed ingredient count directly.
6. Run `migrations/006_batch_inventory_counts.sql` once, after `005`. It enables saving multiple displayed ingredient counts together; all changes and their stock-movement records succeed or roll back as one transaction.
7. Run `migrations/007_replace_default_burger_recipes.sql` once, after `004` (and after `006` if following the full sequence). It replaces recipe rows only for the eight exact default B1–B4 Single/B1T1 burger products so duplicate old recipe lines cannot cause extra deductions. It preserves recipes for all other products, stock balances, and order history. Any custom recipe edits on those eight default burger products will be replaced by the documented standard quantities.
8. Run `migrations/008_role_and_data_access_hardening.sql` once, after `007` and before deploying the matching frontend. It converts existing Inventory-role profiles to Manager, removes the retired role, restricts sensitive profile, recipe, supplier, purchase, and ingredient reads, and adds a role-aware stock-list RPC. Inventory-role accounts gain the Manager access specified for the system; verify that those accounts should have it before applying this migration. It does not delete accounts or business records.
9. Run `migrations/009_public_online_orders.sql` once, after `008`. It adds separate pending online-order tables and menu, submit, and tracking functions. Customers can submit without an account or email verification; they must provide a phone number and staff manually confirms every request. Online requests do not deduct stock or create POS sales until an authorized staff member accepts them. Acceptance atomically records the sale and stock movements; declining does not affect stock.
10. **Optional—email verification only:** If a verified sending domain/provider is configured and you later decide to require email OTP, run `migrations/010_verified_online_order_email.sql` once after `009`, before deploying the matching OTP-enabled frontend. It adds an email field (existing orders remain null) and switches submission to an authenticated-only RPC requiring a confirmed Auth email.
11. **Only if migration `010` was already applied and you are returning to no-OTP public checkout:** Run `migrations/011_restore_public_online_order_submission.sql` once after `010`, before deploying the no-OTP storefront. It restores the original anonymous-capable submit RPC and phone rate limit, while retaining the nullable email column. This makes order submission public again and does not provide email-based identity verification. Do not run `011` unless `010` has been applied.
12. Run `migrations/012_financial_payment_reporting.sql` once after `009` and after any optional `010`/`011` migration already selected for the project. It adds a role-protected RPC to record actual payment for an accepted online order, an append-only partial-refund ledger with a Manager/Owner-only RPC, and report aggregates that separate recorded orders, collected payments, refunds, and unpaid accepted online orders. It does not rewrite or delete existing orders/payments. Existing POS payment rows remain recorded as received; accepted online orders without a payment row remain unpaid. Apply this migration before deploying the matching staff app.
13. Run `migrations/013_operations_controls.sql` after `012`. It adds additive audit logs, cashier closing records, inventory wastage recording, and Manager/Owner order void controls. It does not delete or rewrite existing orders, payments, stock, or users.
14. Run `migrations/014_restore_readonly_inventory.sql` after `013`. It restores the read-only inventory RPC used by Cashier and Kitchen accounts and reloads the PostgREST schema cache. It does not change inventory balances or permissions for managers.
15. Only if the database has no staff profiles/business yet, add the intended initial Owner/Admin's lowercase email to the allowlist. If the business is already initialized, skip this step and sign in with the existing Owner/Admin account. Edit the example locally before running:

   ```sql
   insert into public.owner_setup_allowlist(email)
   values ('your-owner-email@example.com')
   on conflict (email) do nothing;
   ```

   The allowlist is not readable or writable through the browser. It authorizes only the one-time initial setup; staff accounts must be invited by an Owner/Admin.
15. In **Authentication → Users**, create the Owner/Admin Auth account if it does not already exist. For first-time setup, sign in with the allowlisted email. Customer sign-ups do not need to be enabled for the current no-OTP ordering flow.

If this is a brand-new Supabase project, first run `supabase-schema.sql`, then run migrations `001` through `009`, `012`, and `013` in order. Migration `010` is an optional future upgrade; migration `011` is only for reverting a database that has already applied `010` to no-OTP public checkout. If using either optional migration, apply it before `012`. The modular app and storefront must not be used until the required SQL files have completed successfully.

If migration execution fails, do not rerun partial statements individually. SQL Editor runs the migration in a transaction; review the error and resolve it before retrying. The recipe branch constraints intentionally validate existing rows and will stop the migration if it finds cross-branch recipe data.

### Supabase browser configuration

Set the project URL and **publishable** key in [`../supabase-config.js`](../supabase-config.js):

```js
window.HAVENS_SUPABASE_CONFIG = {
  url: "https://your-project.supabase.co",
  publishableKey: "sb_publishable_your_public_key"
};
```

The publishable key is browser-visible and relies on RLS. Never put a Supabase secret/service-role key in this file, HTML, or frontend JavaScript.

## Vercel deployment

1. Import the project into Vercel with the `WST` folder as its **Root Directory**.
2. The root URL and `/index.html` redirect to `/order/` so customers land on online ordering. The modular staff app remains at `/restaurant-system/`, and `/api/staff` remains the serverless staff-invitation endpoint.
3. Add these server-only Vercel Environment Variables for staff invitations:
   - `SUPABASE_URL`: the Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the legacy `service_role` JWT key (typically starts with `eyJ`); keep it only in Vercel's server-side environment. Do not use the browser publishable key or an `sb_secret_...` key here.
   - `APP_URL`: the deployed modular application URL, such as `https://your-site.vercel.app/restaurant-system/`.
4. In Supabase **Authentication → URL Configuration**, set the deployed site URL and allow the deployed modular application URL as a redirect URL for staff invitation emails.
5. Redeploy after changing Vercel environment variables.

The Owner/Admin account can invite Managers, Cashiers, and Kitchen staff from **Staff & access**. The Manager handles Inventory and Purchasing; there is no separate Inventory role for new invitations. Managers can edit stock, products, and purchasing. Cashiers and Kitchen staff can view current ingredient quantities but cannot edit them; the stock-list RPC omits reorder levels and cost values for those roles. RLS also restricts their direct access to staff profiles, recipes, suppliers, and purchase data. The server endpoint validates the caller's active Owner/Admin profile before sending an invitation and assigning a role.

Invitation links open the deployed application so the staff member can set a password. If a pending invitation expires, use **Resend invite** beside that staff account; do not submit the same email in the new-staff form. Accepted staff can request a password reset from the login screen using **Forgot password?**. Both links return to the password setup form.

Staff invitations cannot be sent from a `file://` local preview; use the deployed Vercel URL.

## Implemented modules

- Customer online ordering at `/order/` uses the live active-product catalog and database prices. Customers can request pickup or delivery (flat ₱30), provide their name and required phone number, select cash or GCash, and include a note. Email OTP is currently disabled because there is no verified sending domain/provider. Requests are public and remain unconfirmed until staff contacts the customer; delivery address and service area are manually confirmed. No payment gateway is used.
- To enable email OTP later, first configure a custom SMTP sender that can deliver to public customer addresses, configure Supabase's Email OTP template to include `{{ .Token }}` (the placeholder Supabase replaces with a six-digit code), then apply migration `010` and deploy the matching OTP storefront. Supabase's built-in SMTP is only suitable for development: messages are restricted to project team addresses and currently limited to 2 per hour. A custom SMTP provider such as Resend requires a verified sending domain.
- The order function allows up to five requests per normalized phone number per 15 minutes. This limits repeat submissions but is not identity verification or a substitute for CAPTCHA/edge-level abuse protection if the public storefront is targeted.
- Online order requests remain pending and do not reserve/deduct stock. Owner/Admin, Manager, and Cashier can accept or decline them in **Online orders**. Acceptance validates current menu/stock recipes, records the sale, deducts ingredients, and sends a kitchen ticket atomically; decline leaves inventory unchanged. The Kitchen role sees accepted tickets through Kitchen display, not customer addresses/phone numbers.
- Customers receive a private tracking link with an unguessable token. The database stores only its hash, and the status function returns order status/reference and totals without customer contact details or delivery address. Keep the link private. Payment choices are preferences only: collect cash or give GCash instructions manually after staff confirmation; the storefront does not process or record a payment.

- One-time `hb.html` catalog setup for 15 product variants/extras, their embedded prices, and bun/patty stock rules. Burgers are labeled B1–B4 and offered as Single/B1T1. It runs automatically when Inventory opens and the import has not been recorded, skips existing same-name products, and does not alter existing stock.
- Inventory has named rows for Buns, Patties, Cheese, Lettuce, Tomato, Onion, Sauce, and Bacon. Enter all counts you need beside the displayed ingredients and choose **Save all counts** once—there is no need to retype ingredient names or submit rows one by one. Migration `006` saves the batch and all corresponding stock movements atomically. New items start at zero; existing balances are not reset by migration `004`.
- Stock use per Single: B1 = 1 bun + 1 patty; B2 = 1 bun + 1 patty + 1 cheese; B3 = 1 bun + 1 patty + 1 lettuce + 1 tomato; B4 = 1 bun + 2 patties. B1T1 uses twice each listed quantity (B4 uses 2 buns + 4 patties).
- Each standalone add-on uses one matching stock item per sale; Beef Patty uses one Patties. The importer applies these rules to existing default catalog rows and to future imports.
- POS shows four B1–B4 burger cards. Selecting a card opens a Single/B1T1 picker with optional priced add-ons; add-ons are separate order lines and deduct one matching inventory unit each. The supplied B1–B4 photos are displayed on the cards.
- The Havens Burger Station singles-menu poster is shown on sign-in and in the POS as branded artwork. Its printed prices are not connected to the catalog; use the live prices on the POS cards and order picker for checkout.
- POS checkout with database-priced products, cash change calculation, payment records, transaction-safe stock deductions, and retry-safe idempotency keys.
- Inventory with ingredient setup, stock adjustments, reorder levels, and low-stock overview. Recipe management is intentionally not shown in the app; the database retains the stock rules so checkout can deduct ingredient quantities automatically.
- Suppliers, purchase orders, and delivery receipt into stock.
- Kitchen tickets with branch-filtered Realtime updates and a manual refresh control.
- Role access: Owner/Admin sees all modules; Manager sees every module except Staff & access; Cashier sees POS, Kitchen display, and read-only Inventory; Kitchen sees Kitchen display and read-only Inventory. Inventory and purchasing management is reserved for Owner/Admin and Manager.
- Expenses and date-range sales/expense reports.
- Dashboard, expense defaults/totals, and report date boundaries use the `Asia/Manila` calendar day.
- Migration `007` resets recipe lines only on the eight exact default burger products, then reapplies the standard stock rules: B1 = 1 bun + 1 patty; B2 adds 1 cheese; B3 adds 1 lettuce + 1 tomato; B4 = 1 bun + 2 patties. Each B1T1 uses twice its Single quantities.

## Verification and operational notes

- A checkout transaction writes the order, its line items, payment record, and all inventory movements/deductions atomically. Repeating the same checkout key returns the same order; reusing it with different order details is rejected.
- Ingredient rows are locked in a stable order during checkout to prevent concurrent orders from overselling stock.
- Realtime is enabled only for sales orders, ingredients, and inventory movements. The UI removes its subscription when the user signs out.
- A `payments` row represents an amount recorded as actually received. Cash POS checkout records the tendered amount; GCash/card POS checkout requires an explicit confirmation after the cashier verifies the external transfer/charge. The app does not process card or GCash through a gateway. Online-order Cash/GCash is only a customer preference until staff records the actual receipt. Accepted online orders without a `payments` row count as unpaid, not collected.
- Refunds are append-only in `payment_refunds`; Owner/Admin or Manager can record partial or full refunds with a reason from Recent orders. Refund entries do not void an order, change its kitchen status, or restore inventory. A voided order is excluded from recorded order value, while any payment on it remains visible as collected until a refund is recorded. Do not treat an unrefunded voided payment as cash returned.
- Reports use order creation dates for order counts/value, payment recorded dates for collections, refund recorded dates for refunds, and `spent_at` for expenses. Outstanding accepted online orders are a current all-date balance, independent of the selected range. Net collected is payments recorded in the range minus refunds recorded in the range; it is not net profit. Cost of goods sold is not included.
- The Expenses page shows the latest 100 expense entries, but its daily total and the report total are database aggregates over all matching expenses, not sums of the displayed page.
- `hb.html` stores operational values such as current inventory, sales history, restocks, meals, and audit events in browser `localStorage`; those values are not present in the file and are not imported. Migration `004` creates missing stock ingredients at zero and does not change existing balances. Enter verified opening stock manually after checking the old POS.
- The system is single-branch. Do not add branches until staff authorization and operational flows are extended and tested for multi-branch use.
- Live authentication, role, checkout, concurrency, and deployment checks require applying the migration and using authorized test accounts. Do not treat browser/static checks as proof of live database behavior.
- After applying migrations `009` and `012` and deploying, test the public menu and checkout, pending order visibility to staff, accept/decline permissions, stock deductions only on acceptance, kitchen visibility without delivery PII, tracking-link status updates, and financial cases below. Email verification is not part of the current checkout. If `010` is enabled later, separately test OTP delivery and that anonymous/unverified submissions are denied.
- After migration `008`, manually verify Owner/Admin, Manager, Cashier, and Kitchen access against the deployed database. In particular, check that migrated Inventory accounts have intended Manager access, Cashier/Kitchen receive only current stock fields, and direct table queries for restricted data are denied.
- Financial verification after migration `012` (use a non-production test branch or clearly labeled test transactions):
  1. Complete a cash POS order with cash received at least equal to the total; verify one `payments` row, `amount_tendered`, and `change_due`, and that the report adds it to Cash collected.
  2. Complete a GCash/card POS order only after confirming the transfer/charge in the external provider; verify the payment row and optional reference. The app does not independently verify external transactions.
  3. Accept an online request but do not collect payment; verify the order value increases, `payments` has no row for its sale, unpaid accepted-online count/value increases, and no collected method total changes.
  4. Collect an accepted online order through Online orders and record the actual method (not merely the preference); verify a single payment row appears, outstanding decreases, and the actual method total increases. Try recording it twice; the second call must be rejected.
  5. For a test payment, record a partial refund with a reason, then verify refunds/net receipts update. Verify Cashier cannot invoke the refund RPC, Manager/Owner can, and refunding beyond the remaining amount fails. If a sale has status `void`, verify its recorded order value is excluded; any unrefunded payment remains visible in the voided-payment warning until refunded.
  6. Create more than 100 test expenses for the same Manila date; verify the list still shows only 100, while the daily summary and report equal the sum of all matching records.
  7. Run reports for a single day, a multi-day range, and a range crossing Manila midnight; verify orders use creation time, collections/refunds use their own recorded times, and expenses use `spent_at`. Do not interpret order value minus expenses as profit.
