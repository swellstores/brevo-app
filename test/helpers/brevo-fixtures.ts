import { vi } from "vitest";
import { getSettings, type BrevoSettings } from "../../functions/lib/brevo";

// raw settings as returned by swell.settings()
export const rawSettings = {
  api_key: "xkeysib-test",
  list_id: "7",
};

export function makeSettings(overrides: Partial<BrevoSettings> = {}): BrevoSettings {
  return { ...getSettings({ brevo: rawSettings }), ...overrides };
}

export function makeAccount(overrides: Record<string, any> = {}) {
  return {
    id: "acc_1",
    email: "jane@example.com",
    first_name: "Jane",
    last_name: "Doe",
    phone: "07911 123456",
    email_optin: true,
    sms_optin: true,
    shipping: { country: "GB" },
    ...overrides,
  };
}

export function makeRecord(overrides: Record<string, any> = {}) {
  return {
    id: "rec_1",
    number: "100001",
    status: "pending",
    currency: "USD",
    grand_total: 25,
    sub_total: 20,
    discount_total: 0,
    tax_total: 1,
    shipment_total: 4,
    coupon_code: "SAVE10",
    checkout_url: "https://shop.example.com/checkout/abc",
    date_created: "2026-10-01T12:30:45.123Z",
    date_updated: "2026-10-02T08:00:00.000Z",
    items: [
      {
        id: "item_1",
        product_id: "prod_1",
        variant_id: "var_1",
        price: 10,
        price_total: 20,
        discount_total: 0,
        quantity: 2,
        product: {
          slug: "shirt",
          name: "Shirt",
          sku: "SKU-P",
          images: [{ file: { url: "https://cdn/p.jpg" } }],
        },
        variant: { sku: "SKU-V", images: [{ file: { url: "https://cdn/v.jpg" } }] },
      },
    ],
    account: makeAccount(),
    ...overrides,
  };
}

type Reply = { status: number; body?: any } | Error;

// Mocks global fetch; each call takes the next reply (the last one repeats)
export function mockFetch(...replies: Reply[]) {
  const queue = replies.length ? [...replies] : [{ status: 204 }];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (reply instanceof Error) {
      throw reply;
    }
    const text = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status });
  });
}

// [method, url, parsed body] of a fetch call
export function callOf(call: any[]) {
  const [url, init] = call;
  return {
    method: init?.method,
    url: String(url),
    headers: init?.headers,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}
