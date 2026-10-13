# Brevo integration

A Swell app that syncs customers to [Brevo](https://www.brevo.com/) contacts, imports existing customers, sends cart and order
events for Brevo automations, and optionally sends orders to Brevo eCommerce.

## Features

### Contact sync

`functions/contact-sync.ts` runs on `account.created` and `account.updated`, loads the full account and creates or updates the
Brevo contact by email ([Create a contact](https://developers.brevo.com/reference/createcontact) with `updateEnabled: true`).

| Swell account field                 | Brevo contact                                                    |
| ----------------------------------- | ---------------------------------------------------------------- |
| `email`                             | contact email (identifier)                                       |
| `first_name`                        | attribute set in **First name attribute** (default `FIRSTNAME`)  |
| `last_name`                         | attribute set in **Last name attribute** (default `LASTNAME`)    |
| `phone` (or shipping/billing phone) | `SMS` attribute in E.164, only with `sms_optin: true` and **Sync phone for SMS opt-ins** on |
| `email_optin: true`                 | added to **Email list ID**                                       |
| `email_optin` changed to `false`    | removed from **Email list ID** when **Remove from list on opt-out** is on |

- `account.updated` delivers only the changed fields. The contact is synced only when one of `email`, `first_name`, `last_name`,
  `phone`, `email_optin`, `sms_optin`, `shipping` or `billing` changed, so balance or order count updates make no Brevo calls.
- Phone numbers are normalized to E.164 with the shipping (or billing) country (`functions/lib/phone.ts`). Invalid numbers are not sent.
- If Brevo rejects the SMS number (invalid, or already used by another contact), the contact is saved again without it.
- Customers who did not opt in are synced as contacts but not added to the list. The app never blocklists contacts.

### Events

`functions/cart-events.ts` and `functions/order-events.ts` send events to the Brevo [Events API](https://developers.brevo.com/reference/create-event),
which you can use as automation triggers in Brevo.

| Swell event       | Brevo event        | Function          | Setting                  |
| ----------------- | ------------------ | ----------------- | ------------------------ |
| `cart.created`    | `checkout_started` | `cart-events.ts`  | `event_checkout_started` |
| `cart.abandoned`  | `cart_abandoned`   | `cart-events.ts`  | `event_cart_abandoned`   |
| `order.submitted` | `order_submitted`  | `order-events.ts` | `event_order_submitted`  |
| `order.delivered` | `order_fulfilled`  | `order-events.ts` | `event_order_fulfilled`  |
| `order.canceled`  | `order_canceled`   | `order-events.ts` | `event_order_canceled`   |

Each event is sent with:

- **Identifier** – the customer email (`identifiers.email_id`). Brevo creates the contact if it does not exist.
- **Contact properties** – first and last name, under the configured attribute names.
- **Event properties** – `id`, `number`, `status`, `currency`, `grand_total`, `sub_total`, `discount_total`, `tax_total`,
  `shipment_total`, `coupon_code`, `checkout_url` (carts) and `items`. Each item has `id`, `product_id`, `variant_id`, `name`,
  `slug`, `sku`, `image_url`, `quantity`, `price`, `price_total` and `discount_total`. Empty values are left out.

In Brevo templates use them as `{{ event.checkout_url }}`, `{{ event.grand_total }}` and so on.

### eCommerce orders

With **Sync orders to Brevo eCommerce** on, `order-events.ts` also sends the order to
[Brevo eCommerce](https://developers.brevo.com/reference/createorder) (`POST /v3/orders/status`) on `order.submitted`,
`order.delivered` and `order.canceled`:

| Brevo field     | Swell value                                    |
| --------------- | ---------------------------------------------- |
| `id`            | order `number` (falls back to `id`)            |
| `status`        | order `status` (e.g. `pending`, `delivered`, `canceled`) |
| `amount`        | `grand_total`                                  |
| `createdAt`     | `date_created`                                 |
| `updatedAt`     | `date_updated`                                 |
| `identifiers`   | `email_id`: customer email                     |
| `products`      | `productId`, `variantId`, `price`, `quantity` per item |
| `coupons`       | `[coupon_code]` when set                       |

Order sync runs even if the matching event toggle is off, and an event failure does not stop the order sync (or the other way round).

### Import existing customers

**Apps → Brevo → Actions → Import existing customers** starts the `functions/import-customers.ts` workflow, which syncs every
customer account that already exists in Swell. It runs in the background; the dashboard shows the run's status and when it ends.

- The import does not start when **Enabled** is off, and the setting is checked again before each page, so turning the
  app off stops a running import (the run returns `error: 'disabled'` with the totals sent so far).
- Accounts are read 100 at a time, oldest first (`id` cursor, `functions/lib/import.ts`). Each page is one durable workflow step,
  retried up to 5 times with exponential backoff (starting at 30 s) on network errors, HTTP 429 and 5xx.
- Accounts with `email_optin: true` are added to **Email list ID** with one [Brevo import job](https://developers.brevo.com/reference/import-contacts)
  per page (`updateExistingContacts: true`, `emptyContactsAttributes: false`, so existing Brevo values are not erased).
- Other accounts, and all accounts when no list is set, are created or updated one by one, 5 at a time, exactly like contact sync
  (no list for customers without opt-in).
- The modal option **Only customers who opted in to email** skips accounts without `email_optin: true`.
- Accounts without an email are skipped. Contacts Brevo rejects (e.g. invalid email) are logged and counted as failed; the import continues.
- When it finishes, the workflow logs and returns the totals: added to list, synced one by one, skipped and failed.
- The action is hidden while **Sync customer accounts** is off. Running it again is safe: contacts are updated, not duplicated.

### Test connection

**Apps → Brevo → Actions → Test connection** (`functions/test-connection.ts`) checks the API key (`GET /v3/account`) and the
email list (`GET /v3/contacts/lists/{id}`) and shows the account name and list name.

## Settings

All credentials and options are set by the merchant in the app settings (`settings/brevo.json`) and are never stored in code.
Functions read them with `getSettings` (`functions/lib/brevo.ts`), which applies the defaults below to values not yet saved.

| Setting                  | Type   | Required | Default     | Description                                                                 |
| ------------------------ | ------ | -------- | ----------- | --------------------------------------------------------------------------- |
| `api_key`                | secret | yes      |             | Brevo API key (`xkeysib-…`). Without it, functions log an error and send nothing. |
| `enabled`                | toggle | no       | on          | Turns off all syncing without uninstalling the app.                         |
| `sync_contacts`          | toggle | no       | on          | Create and update Brevo contacts from customer accounts.                    |
| `list_id`                | text   | no       |             | Numeric Brevo list ID (`7` or `#7`) for email opt-ins. Empty or invalid → contacts are not added to a list. |
| `remove_on_optout`       | toggle | no       | on          | Remove the contact from the list when `email_optin` changes to false.       |
| `sync_sms`               | toggle | no       | off         | Set the `SMS` attribute for customers with `sms_optin: true`.               |
| `firstname_attribute`    | text   | no       | `FIRSTNAME` | Brevo attribute for the first name (upper-cased). Use e.g. `PRENOM` for French accounts. |
| `lastname_attribute`     | text   | no       | `LASTNAME`  | Brevo attribute for the last name (upper-cased).                            |
| `event_checkout_started` | toggle | no       | on          | "Checkout started": send `checkout_started`.                                                    |
| `event_cart_abandoned`   | toggle | no       | on          | "Cart abandoned": send `cart_abandoned`.                                                      |
| `event_order_submitted`  | toggle | no       | on          | "Order placed": send `order_submitted`.                                                     |
| `event_order_fulfilled`  | toggle | no       | on          | "Order delivered": send `order_fulfilled`.                                                     |
| `event_order_canceled`   | toggle | no       | on          | "Order canceled": send `order_canceled`.                                                      |
| `sync_orders`            | toggle | no       | off         | Send orders to Brevo eCommerce.                                             |

Settings actions (`actions` in `settings/brevo.json`):

| Action                      | Function                       | Options                                              |
| --------------------------- | ------------------------------ | ---------------------------------------------------- |
| Test connection             | `test-connection.ts` (function) |                                                     |
| Import existing customers   | `import-customers.ts` (workflow) | `only_optin` checkbox: only customers who opted in to email |

## Setup

1. Install the Swell CLI and log in:

   ```bash
   npm install -g @swell/cli
   swell login
   ```

2. Install dependencies:

   ```bash
   cd /path/to/brevo
   npm install
   ```

3. Push the app to your store's test environment:

   ```bash
   swell app push
   ```

4. In Brevo:
   - create an API key in **Settings → SMTP & API → API Keys**;
   - create a list for newsletter subscribers in **Contacts → Lists** and note its ID;
   - check the name attributes in **Contacts → Settings → Contact attributes** (`FIRSTNAME`/`LASTNAME` in most accounts);
   - for order sync, activate **eCommerce** in Brevo.
5. In the Swell dashboard open **Apps → Brevo**, enter the API key and list ID, choose the options and save.
6. Run **Actions → Test connection**.
7. Run **Actions → Import existing customers** to sync customers created before the app was installed.
8. To install in the live environment, create a version and install it:

   ```bash
   swell app version minor
   swell app install
   ```

## Limits and known behavior

- **Email is the identifier.** When a customer changes their email, a new Brevo contact is created for the new address and the old one stays.
- **Import covers customers only.** Past carts and orders are not sent as events or eCommerce orders; only accounts are imported.
- **Import list jobs run asynchronously in Brevo.** The workflow queues them and does not wait for the result; rows Brevo rejects
  (e.g. a duplicate SMS number) appear only in Brevo's import report, not in the workflow totals.
- **Import of very large stores.** Each page of 100 accounts is one workflow step; stores with more than ~100,000 customers have not been tested
  and may reach the platform's step limit.
- **Workflows don't run under `swell app dev`.** The import always runs the pushed version.
- **Guest carts without email are skipped.** Brevo needs an identifier, so carts and orders with no linked account email send no event or order.
- **No event de-duplication.** Brevo events have no unique ID; if Swell redelivers an event (for example after a retry), Brevo records it again.
  eCommerce orders are keyed by order number, so resending an order updates it.
- **Retries.** Network errors, HTTP 429 and 5xx responses are rethrown so Swell retries the function. Other errors (invalid data, bad API key)
  are logged with `console.error` and dropped.
- **Checkout Started** fires on `cart.created`, when the cart record is first created, not on a later checkout step.
- **One list.** All email opt-ins go to one list; SMS opt-ins are synced as the `SMS` attribute, not to a separate list.
- **Opt-out removes from the list only.** The contact is not blocklisted in Brevo; Brevo's own unsubscribe handling is unchanged.
- **Event size.** Brevo limits event properties to 50 KB; carts and orders with hundreds of items may be rejected.
- **Function timeout.** Each function makes at most 2–3 Brevo calls within the 10 s limit.
- Brevo API base: `https://api.brevo.com/v3` (`functions/lib/brevo.ts`).

## Development

### Project layout

```
functions/
  contact-sync.ts     # account.created, account.updated → Brevo contact
  cart-events.ts      # cart.created, cart.abandoned → Brevo events
  order-events.ts     # order.submitted, order.delivered, order.canceled → Brevo events + eCommerce orders
  test-connection.ts  # settings action: checks API key and list
  import-customers.ts # settings action workflow: imports existing customers
  lib/brevo.ts        # settings, Brevo API client, mapping, sync logic
  lib/import.ts       # account paging and bulk import for the workflow
  lib/phone.ts        # E.164 phone formatting
settings/brevo.json   # merchant settings and the Test connection action
assets/icon.png       # app icon (placeholder)
assets/screenshots/   # listing screenshots (placeholders, referenced by `images` in swell.json)
test/unit/            # vitest unit tests (Brevo API mocked)
test/integration/     # vitest tests against the store using CLI auth
```

### Commands

```bash
npm run typecheck                 # TypeScript check for functions and tests
npm test                          # run all vitest tests
swell app dev                     # run functions locally, triggered by the test environment
swell app push                    # deploy to the test environment
swell inspect functions --app=.   # check deployed functions
swell logs --type function -s contact-sync   # function logs
swell inspect workflow-runs --workflow app.brevo.import-customers   # import runs
```

Tests run in the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers` and use your `swell login` session
(or `SWELL_STORE_ID` / `SWELL_SESSION_ID` in CI). Unit tests mock `fetch`, so no real Brevo calls are made.

To try the functions end to end, set an API key in the test environment, then create or update an account, cart or order with
`swell api post /accounts --body '{"email":"…"}'` and check the function logs and the contact in Brevo.

### Adding an event

1. Add the Swell event to `config.model.events` in the relevant function.
2. Map it to a Brevo event name and setting key in `EVENTS` (`functions/lib/brevo.ts`) and add the setting to `BrevoSettings` and `getSettings`.
3. Add a toggle for it in `settings/brevo.json`.
4. Add tests and update the tables in this README.

Logs are also available in the dashboard under **Developer → Console → Logs**.
