# Brevo

Sync customers to Brevo contacts and send cart and order events to trigger Brevo email and SMS automations.

## How it works

1. **Syncs customers.** When a customer account is created or its name, email, phone or marketing opt-ins change, the app creates or updates the Brevo contact:
   - email opt-in → added to your email list;
   - email opt-out → removed from the list (optional);
   - SMS opt-in → phone saved to the contact's SMS attribute (optional).

2. **Sends events.** Cart and order events become Brevo events you can use as automation triggers:

   | Store event       | Brevo event        |
   | ----------------- | ------------------ |
   | `cart.created`    | `checkout_started` |
   | `cart.abandoned`  | `cart_abandoned`   |
   | `order.submitted` | `order_submitted`  |
   | `order.delivered` | `order_fulfilled`  |
   | `order.canceled`  | `order_canceled`   |

   Each event includes the order totals, currency, coupon, checkout link and items with name, SKU, image, price and quantity. Each event can be turned on or off.

3. **Syncs orders (optional).** Orders are sent to Brevo eCommerce for revenue reporting and segmentation.

4. **Imports existing customers.** Run **Import existing customers** once to bring in customers created before the app was installed.

## Setup

Enter your Brevo API key and email list ID in the app settings, then run **Test connection**. To sync orders, activate eCommerce in Brevo and turn on order sync.
