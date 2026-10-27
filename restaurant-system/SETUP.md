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
8. Only if the database has no staff profiles/business yet, add the intended initial Owner/Admin's lowercase email to the allowlist. If the business is already initialized, skip this step and sign in with the existing Owner/Admin account. Edit the example locally before running:

   ```sql
   insert into public.owner_setup_allowlist(email)
   values ('your-owner-email@example.com')
   on conflict (email) do nothing;
   ```

   The allowlist is not readable or writable through the browser. It authorizes only the one-time initial setup; staff accounts must be invited by an Owner/Admin.
9. In **Authentication → Settings**, turn off public sign-ups. In **Authentication → Users**, create the Owner/Admin Auth account if it does not already exist. For first-time setup, sign in with the allowlisted email.

If this is a brand-new Supabase project, first run `supabase-schema.sql`, then run migrations `001` through `007` in order. The modular app must not be used until the SQL files have completed successfully.

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
2. The root URL and `/index.html` redirect to `/restaurant-system/`; the modular app is served there and `/api/staff` remains the serverless staff-invitation endpoint.
3. Add these server-only Vercel Environment Variables for staff invitations:
   - `SUPABASE_URL`: the Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the service-role key; keep it only in Vercel's server-side environment.
   - `APP_URL`: the deployed modular application URL, such as `https://your-site.vercel.app/restaurant-system/`.
4. In Supabase **Authentication → URL Configuration**, set the deployed site URL and allow the deployed modular application URL as a redirect URL for staff invitation emails.
5. Redeploy after changing Vercel environment variables.

The Owner/Admin account can invite staff from **Staff & access**. The server endpoint validates the caller's active Owner/Admin profile before sending an invitation and assigning a non-admin role.

Staff invitations cannot be sent from a `file://` local preview; use the deployed Vercel URL.

## Implemented modules

- One-time `hb.html` catalog setup for 15 product variants/extras, their embedded prices, and bun/patty stock rules. Burgers are labeled B1–B4 and offered as Single/B1T1. It runs automatically when Inventory opens and the import has not been recorded, skips existing same-name products, and does not alter existing stock.
- Inventory has named rows for Buns, Patties, Cheese, Lettuce, Tomato, Onion, Sauce, and Bacon. Enter all counts you need beside the displayed ingredients and choose **Save all counts** once—there is no need to retype ingredient names or submit rows one by one. Migration `006` saves the batch and all corresponding stock movements atomically. New items start at zero; existing balances are not reset by migration `004`.
- Stock use per Single: B1 = 1 bun + 1 patty; B2 = 1 bun + 1 patty + 1 cheese; B3 = 1 bun + 1 patty + 1 lettuce + 1 tomato; B4 = 1 bun + 2 patties. B1T1 uses twice each listed quantity (B4 uses 2 buns + 4 patties).
- Each standalone add-on uses one matching stock item per sale; Beef Patty uses one Patties. The importer applies these rules to existing default catalog rows and to future imports.
- POS shows four B1–B4 burger cards. Selecting a card opens a Single/B1T1 picker with optional priced add-ons; add-ons are separate order lines and deduct one matching inventory unit each. The supplied B1–B4 photos are displayed on the cards.
- POS checkout with database-priced products, cash change calculation, payment records, transaction-safe stock deductions, and retry-safe idempotency keys.
- Inventory with ingredient setup, stock adjustments, reorder levels, and low-stock overview. Recipe management is intentionally not shown in the app; the database retains the stock rules so checkout can deduct ingredient quantities automatically.
- Suppliers, purchase orders, and delivery receipt into stock.
- Kitchen tickets with branch-filtered Realtime updates and a manual refresh control.
- Owner/Admin staff invitations and role-filtered access.
- Expenses and date-range sales/expense reports.
- Dashboard, expense defaults/totals, and report date boundaries use the `Asia/Manila` calendar day.
- Migration `007` resets recipe lines only on the eight exact default burger products, then reapplies the standard stock rules: B1 = 1 bun + 1 patty; B2 adds 1 cheese; B3 adds 1 lettuce + 1 tomato; B4 = 1 bun + 2 patties. Each B1T1 uses twice its Single quantities.

## Verification and operational notes

- A checkout transaction writes the order, its line items, payment record, and all inventory movements/deductions atomically. Repeating the same checkout key returns the same order; reusing it with different order details is rejected.
- Ingredient rows are locked in a stable order during checkout to prevent concurrent orders from overselling stock.
- Realtime is enabled only for sales orders, ingredients, and inventory movements. The UI removes its subscription when the user signs out.
- Payment entries record the selected payment method and optional external reference; they do not process card or GCash payments through a payment gateway.
- `hb.html` stores operational values such as current inventory, sales history, restocks, meals, and audit events in browser `localStorage`; those values are not present in the file and are not imported. Migration `004` creates missing stock ingredients at zero and does not change existing balances. Enter verified opening stock manually after checking the old POS.
- The system is single-branch. Do not add branches until staff authorization and operational flows are extended and tested for multi-branch use.
- Live authentication, role, checkout, concurrency, and deployment checks require applying the migration and using authorized test accounts. Do not treat browser/static checks as proof of live database behavior.
