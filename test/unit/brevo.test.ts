import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BrevoError,
  EVENTS,
  parseListId,
  getSettings,
  loadSettings,
  brevoRequest,
  handleError,
  isContactChange,
  getSmsPhone,
  buildContactAttributes,
  upsertContact,
  removeFromList,
  syncAccount,
  mapItems,
  buildEventPayload,
  trackEvent,
  formatDate,
  buildOrderPayload,
  syncOrder,
  testConnection,
} from "../../functions/lib/brevo";
import { makeAccount, makeRecord, makeSettings, mockFetch, callOf, rawSettings } from "../helpers/brevo-fixtures";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BrevoError", () => {
  it("formats the message with status and code", () => {
    const err = new BrevoError(400, "invalid_parameter", "bad email");
    expect(err.message).toBe("Brevo 400 invalid_parameter: bad email");
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_parameter");
  });

  it.each([
    [0, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
  ])("status %i retryable=%s", (status, retryable) => {
    expect(new BrevoError(status, undefined, "x").retryable).toBe(retryable);
  });
  it("recognizes a 401 from Authorized IPs", () => {
    expect(new BrevoError(401, "unauthorized", "We have detected you are using an unrecognised IP address 104.28.1.2. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips").ipBlocked).toBe(true);
    expect(new BrevoError(401, "unauthorized", "Key not found").ipBlocked).toBe(false);
    expect(new BrevoError(400, undefined, "invalid IP address").ipBlocked).toBe(false);
  });
});

describe("EVENTS", () => {
  it("maps every Swell event to a snake_case Brevo event and a setting", () => {
    expect(Object.keys(EVENTS)).toEqual([
      "cart.created",
      "cart.abandoned",
      "order.submitted",
      "order.delivered",
      "order.canceled",
    ]);
    for (const { name, setting } of Object.values(EVENTS)) {
      expect(name).toMatch(/^[a-z0-9_-]+$/);
      expect(makeSettings()[setting]).toBe(true);
    }
  });
});

describe("parseListId", () => {
  it.each([
    ["7", 7],
    [" 12 ", 12],
    ["#3", 3],
    [5, 5],
  ])("parses %j", (input, expected) => {
    expect(parseListId(input)).toBe(expected);
  });

  it.each([undefined, null, "", "abc", "0", "-1", "1.5"])("rejects %j", (input) => {
    expect(parseListId(input)).toBeNull();
  });
});

describe("getSettings", () => {
  it("applies defaults when nothing is saved", () => {
    expect(getSettings(undefined)).toEqual({
      api_key: "",
      enabled: true,
      sync_contacts: true,
      list_id: null,
      remove_on_optout: true,
      sync_sms: false,
      firstname_attribute: "FIRSTNAME",
      lastname_attribute: "LASTNAME",
      event_checkout_started: true,
      event_cart_abandoned: true,
      event_order_submitted: true,
      event_order_fulfilled: true,
      event_order_canceled: true,
      sync_orders: false,
    });
  });

  it("reads saved values from the brevo section", () => {
    const settings = getSettings({
      brevo: {
        api_key: " xkeysib-1 ",
        enabled: false,
        list_id: "9",
        sync_sms: true,
        firstname_attribute: "prenom",
        lastname_attribute: "",
        event_cart_abandoned: false,
        sync_orders: true,
      },
    });
    expect(settings.api_key).toBe("xkeysib-1");
    expect(settings.enabled).toBe(false);
    expect(settings.list_id).toBe(9);
    expect(settings.sync_sms).toBe(true);
    expect(settings.firstname_attribute).toBe("PRENOM");
    expect(settings.lastname_attribute).toBe("LASTNAME");
    expect(settings.event_cart_abandoned).toBe(false);
    expect(settings.sync_orders).toBe(true);
  });
});

describe("loadSettings", () => {
  it("returns settings when enabled with an API key", async () => {
    const settings = await loadSettings({ settings: vi.fn().mockResolvedValue({ brevo: rawSettings }) } as any);
    expect(settings?.api_key).toBe("xkeysib-test");
  });

  it("returns null when disabled", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({ brevo: { ...rawSettings, enabled: false } }) };
    expect(await loadSettings(swell as any)).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns null and logs when the API key is missing", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({}) };
    expect(await loadSettings(swell as any)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Brevo: missing API key in app settings");
  });
});

describe("brevoRequest", () => {
  it("sends the API key and JSON body and returns parsed JSON", async () => {
    const fetchMock = mockFetch({ status: 201, body: { id: 42 } });
    const result = await brevoRequest("key1", "POST", "/contacts", { email: "a@b.c" });

    expect(result).toEqual({ id: 42 });
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.brevo.com/v3/contacts");
    expect(call.headers["api-key"]).toBe("key1");
    expect(call.body).toEqual({ email: "a@b.c" });
  });

  it("returns null for empty responses", async () => {
    mockFetch({ status: 204 });
    expect(await brevoRequest("k", "POST", "/events", {})).toBeNull();
  });

  it("returns null for non-JSON success bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await brevoRequest("k", "GET", "/account")).toBeNull();
  });

  it("omits the body for GET", async () => {
    const fetchMock = mockFetch({ status: 200, body: {} });
    await brevoRequest("k", "GET", "/account");
    expect(callOf(fetchMock.mock.calls[0]).body).toBeUndefined();
  });

  it("throws BrevoError with Brevo's code and message", async () => {
    mockFetch({ status: 400, body: { code: "duplicate_parameter", message: "SMS already exists" } });
    const err = await brevoRequest("k", "POST", "/contacts", {}).catch((e) => e);
    expect(err).toBeInstanceOf(BrevoError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("duplicate_parameter");
    expect(err.message).toContain("SMS already exists");
  });

  it("uses the raw text when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    const err = await brevoRequest("k", "GET", "/account").catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad gateway");
  });

  it("wraps network failures as status 0", async () => {
    mockFetch(new Error("connection reset"));
    const err = await brevoRequest("k", "GET", "/account").catch((e) => e);
    expect(err).toBeInstanceOf(BrevoError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
  });
});

describe("handleError", () => {
  it("rethrows retryable Brevo errors", () => {
    const err = new BrevoError(503, undefined, "down");
    expect(() => handleError("x", err)).toThrow(err);
  });

  it("logs non-retryable Brevo errors", () => {
    handleError("contact sync", new BrevoError(400, "bad", "nope"));
    expect(errorSpy).toHaveBeenCalledWith("Brevo: contact sync failed:", "Brevo 400 bad: nope");
  });

  it("logs other errors", () => {
    handleError("x", "boom");
    expect(errorSpy).toHaveBeenCalledWith("Brevo: x failed:", "boom");
  });
});

describe("isContactChange", () => {
  it("is true for account.created", () => {
    expect(isContactChange("account.created", { id: "a" })).toBe(true);
  });

  it("is true when a contact field changed", () => {
    expect(isContactChange("account.updated", { id: "a", email_optin: false })).toBe(true);
    expect(isContactChange("account.updated", { id: "a", shipping: {} })).toBe(true);
  });

  it("is false when only unrelated fields changed", () => {
    expect(isContactChange("account.updated", { id: "a", balance: 10, order_count: 2 })).toBe(false);
  });
});

describe("getSmsPhone", () => {
  const sms = makeSettings({ sync_sms: true });

  it("returns E.164 phone when SMS sync is on and the customer opted in", () => {
    expect(getSmsPhone(makeAccount(), sms)).toBe("+447911123456");
  });

  it("falls back to shipping and billing phone and country", () => {
    const account = makeAccount({ phone: undefined, shipping: undefined, billing: { phone: "07911 123456", country: "GB" } });
    expect(getSmsPhone(account, sms)).toBe("+447911123456");
  });

  it("is undefined when SMS sync is off", () => {
    expect(getSmsPhone(makeAccount(), makeSettings())).toBeUndefined();
  });

  it("is undefined without SMS opt-in", () => {
    expect(getSmsPhone(makeAccount({ sms_optin: false }), sms)).toBeUndefined();
  });

  it("is undefined for invalid phones", () => {
    expect(getSmsPhone(makeAccount({ phone: "123" }), sms)).toBeUndefined();
  });
});

describe("buildContactAttributes", () => {
  it("maps names to the configured attributes", () => {
    const settings = makeSettings({ firstname_attribute: "PRENOM", lastname_attribute: "NOM" });
    expect(buildContactAttributes(makeAccount(), settings)).toEqual({ PRENOM: "Jane", NOM: "Doe" });
  });

  it("adds SMS when allowed", () => {
    expect(buildContactAttributes(makeAccount(), makeSettings({ sync_sms: true }))).toEqual({
      FIRSTNAME: "Jane",
      LASTNAME: "Doe",
      SMS: "+447911123456",
    });
  });

  it("skips empty names", () => {
    expect(buildContactAttributes(makeAccount({ first_name: "", last_name: null }), makeSettings())).toEqual({});
  });
});

describe("upsertContact", () => {
  it("creates or updates the contact and adds opted-in customers to the list", async () => {
    const fetchMock = mockFetch({ status: 201, body: { id: 1 } });
    await upsertContact(makeAccount(), makeSettings());

    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://api.brevo.com/v3/contacts");
    expect(call.body).toEqual({
      email: "jane@example.com",
      attributes: { FIRSTNAME: "Jane", LASTNAME: "Doe" },
      updateEnabled: true,
      listIds: [7],
    });
  });

  it("does not add customers without email opt-in to the list", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await upsertContact(makeAccount({ email_optin: false }), makeSettings());
    expect(callOf(fetchMock.mock.calls[0]).body.listIds).toBeUndefined();
  });

  it("does not add to a list when no list is set", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await upsertContact(makeAccount(), makeSettings({ list_id: null }));
    expect(callOf(fetchMock.mock.calls[0]).body.listIds).toBeUndefined();
  });

  it("retries without SMS when Brevo rejects the number", async () => {
    const fetchMock = mockFetch(
      { status: 400, body: { code: "duplicate_parameter", message: "SMS is already associated with another Contact" } },
      { status: 204 },
    );
    await upsertContact(makeAccount(), makeSettings({ sync_sms: true }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callOf(fetchMock.mock.calls[0]).body.attributes.SMS).toBe("+447911123456");
    expect(callOf(fetchMock.mock.calls[1]).body.attributes.SMS).toBeUndefined();
  });

  it("rethrows 400 errors when no SMS was sent", async () => {
    const fetchMock = mockFetch({ status: 400, body: { code: "invalid_parameter", message: "Invalid email" } });
    await expect(upsertContact(makeAccount(), makeSettings())).rejects.toThrow("Invalid email");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-400 errors without retry", async () => {
    const fetchMock = mockFetch({ status: 500, body: { message: "oops" } });
    await expect(upsertContact(makeAccount(), makeSettings({ sync_sms: true }))).rejects.toBeInstanceOf(BrevoError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("removeFromList", () => {
  it("unlinks the contact from the list by email", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await removeFromList("jane+x@example.com", makeSettings());

    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://api.brevo.com/v3/contacts/jane%2Bx%40example.com?identifierType=email_id");
    expect(call.body).toEqual({ unlinkListIds: [7] });
  });

  it("does nothing without a list", async () => {
    const fetchMock = mockFetch();
    await removeFromList("jane@example.com", makeSettings({ list_id: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 404])("ignores %i (not in list / unknown contact)", async (status) => {
    mockFetch({ status, body: { message: "Contact not in list" } });
    await expect(removeFromList("jane@example.com", makeSettings())).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    mockFetch({ status: 500 });
    await expect(removeFromList("jane@example.com", makeSettings())).rejects.toBeInstanceOf(BrevoError);
  });
});

describe("syncAccount", () => {
  it("upserts the contact on account.created", async () => {
    const fetchMock = mockFetch({ status: 201, body: { id: 1 } });
    await syncAccount("account.created", { id: "acc_1" }, makeAccount(), makeSettings());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when contact sync is off", async () => {
    const fetchMock = mockFetch();
    await syncAccount("account.created", {}, makeAccount(), makeSettings({ sync_contacts: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips accounts without email", async () => {
    const fetchMock = mockFetch();
    await syncAccount("account.created", {}, makeAccount({ email: undefined }), makeSettings());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips updates that do not touch contact fields", async () => {
    const fetchMock = mockFetch();
    await syncAccount("account.updated", { id: "acc_1", balance: 5 }, makeAccount(), makeSettings());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the contact from the list on opt-out", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const account = makeAccount({ email_optin: false });
    await syncAccount("account.updated", { id: "acc_1", email_optin: false }, account, makeSettings());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callOf(fetchMock.mock.calls[1]).body).toEqual({ unlinkListIds: [7] });
  });

  it("keeps the contact in the list when remove_on_optout is off", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const settings = makeSettings({ remove_on_optout: false });
    await syncAccount("account.updated", { email_optin: false }, makeAccount({ email_optin: false }), settings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not unlink when the account opted back in since the event", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await syncAccount("account.updated", { email_optin: false }, makeAccount({ email_optin: true }), makeSettings());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("mapItems", () => {
  it("returns an empty array without items", () => {
    expect(mapItems(undefined)).toEqual([]);
    expect(mapItems([])).toEqual([]);
  });

  it("prefers variant sku and image over product", () => {
    expect(mapItems(makeRecord().items)).toEqual([
      {
        id: "item_1",
        product_id: "prod_1",
        variant_id: "var_1",
        name: "Shirt",
        slug: "shirt",
        sku: "SKU-V",
        image_url: "https://cdn/v.jpg",
        quantity: 2,
        price: 10,
        price_total: 20,
        discount_total: 0,
      },
    ]);
  });

  it("falls back to product sku and image", () => {
    const items = makeRecord().items.map((item: any) => ({ ...item, variant: undefined }));
    const [item]: any[] = mapItems(items);
    expect(item.sku).toBe("SKU-P");
    expect(item.image_url).toBe("https://cdn/p.jpg");
  });
});

describe("buildEventPayload", () => {
  it("builds the event with identifiers, contact and event properties", () => {
    const payload: any = buildEventPayload("order_submitted", makeRecord(), makeSettings());

    expect(payload.event_name).toBe("order_submitted");
    expect(payload.identifiers).toEqual({ email_id: "jane@example.com" });
    expect(payload.contact_properties).toEqual({ FIRSTNAME: "Jane", LASTNAME: "Doe" });
    expect(payload.event_properties).toMatchObject({
      id: "rec_1",
      number: "100001",
      currency: "USD",
      grand_total: 25,
      coupon_code: "SAVE10",
      checkout_url: "https://shop.example.com/checkout/abc",
    });
    expect(payload.event_properties.items).toHaveLength(1);
  });

  it("omits empty values and contact properties", () => {
    const record = makeRecord({ coupon_code: null, number: undefined, account: { email: "a@b.c" } });
    const payload: any = buildEventPayload("cart_abandoned", record, makeSettings());
    expect(payload.contact_properties).toBeUndefined();
    expect("coupon_code" in payload.event_properties).toBe(false);
    expect("number" in payload.event_properties).toBe(false);
  });
});

describe("trackEvent", () => {
  it("posts the mapped event", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await trackEvent("order.delivered", makeRecord(), makeSettings());

    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://api.brevo.com/v3/events");
    expect(call.body.event_name).toBe("order_fulfilled");
  });

  it("ignores unsupported events", async () => {
    const fetchMock = mockFetch();
    await trackEvent("order.updated", makeRecord(), makeSettings());
    await trackEvent(undefined, makeRecord(), makeSettings());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips disabled events", async () => {
    const fetchMock = mockFetch();
    await trackEvent("cart.abandoned", makeRecord(), makeSettings({ event_cart_abandoned: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips records without customer email", async () => {
    const fetchMock = mockFetch();
    await trackEvent("cart.created", makeRecord({ account: undefined }), makeSettings());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Brevo: checkout_started skipped, rec_1 has no customer email");
  });

  it("propagates Brevo errors", async () => {
    mockFetch({ status: 400, body: { message: "bad" } });
    await expect(trackEvent("order.submitted", makeRecord(), makeSettings())).rejects.toBeInstanceOf(BrevoError);
  });
});

describe("formatDate", () => {
  it("drops milliseconds", () => {
    expect(formatDate("2026-10-01T12:30:45.123Z")).toBe("2026-10-01T12:30:45Z");
  });

  it("uses now for missing or invalid dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
    expect(formatDate(undefined)).toBe("2026-10-12T00:00:00Z");
    expect(formatDate("not a date")).toBe("2026-10-12T00:00:00Z");
    vi.useRealTimers();
  });
});

describe("buildOrderPayload", () => {
  it("maps the order to Brevo eCommerce format", () => {
    expect(buildOrderPayload(makeRecord())).toEqual({
      id: "100001",
      createdAt: "2026-10-01T12:30:45Z",
      updatedAt: "2026-10-02T08:00:00Z",
      status: "pending",
      amount: 25,
      identifiers: { email_id: "jane@example.com" },
      products: [{ productId: "prod_1", variantId: "var_1", price: 10, quantity: 2 }],
      coupons: ["SAVE10"],
    });
  });

  it("falls back to id and defaults for missing values", () => {
    const payload: any = buildOrderPayload(
      makeRecord({ number: undefined, grand_total: undefined, coupon_code: undefined, items: [{ product_id: "p" }] }),
    );
    expect(payload.id).toBe("rec_1");
    expect(payload.amount).toBe(0);
    expect(payload.coupons).toBeUndefined();
    expect(payload.products).toEqual([{ productId: "p", price: 0, quantity: 1 }]);
  });

  it("handles orders without items", () => {
    expect((buildOrderPayload(makeRecord({ items: undefined })) as any).products).toEqual([]);
  });
});

describe("syncOrder", () => {
  it("posts the order when order sync is on", async () => {
    const fetchMock = mockFetch({ status: 204 });
    await syncOrder(makeRecord(), makeSettings({ sync_orders: true }));
    expect(callOf(fetchMock.mock.calls[0]).url).toBe("https://api.brevo.com/v3/orders/status");
  });

  it("does nothing when order sync is off", async () => {
    const fetchMock = mockFetch();
    await syncOrder(makeRecord(), makeSettings());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips orders without customer email", async () => {
    const fetchMock = mockFetch();
    await syncOrder(makeRecord({ account: null }), makeSettings({ sync_orders: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("testConnection", () => {
  it("reports the account and list", async () => {
    mockFetch({ status: 200, body: { companyName: "Acme" } }, { status: 200, body: { name: "Newsletter" } });
    expect(await testConnection(makeSettings())).toBe("Connected to Brevo as Acme. Email list: Newsletter (#7).");
  });

  it("reports a missing list", async () => {
    mockFetch({ status: 200, body: { email: "me@acme.com" } }, { status: 404, body: { message: "List not found" } });
    expect(await testConnection(makeSettings())).toBe("Connected to Brevo as me@acme.com. Email list #7 was not found in Brevo.");
  });

  it("does not report a rate limit or network error as a missing list", async () => {
    mockFetch({ status: 200, body: { companyName: "Acme" } }, { status: 429, body: { message: "Too many requests" } });
    expect(await testConnection(makeSettings())).toBe(
      "Connected to Brevo as Acme. Email list #7 could not be checked, try again: Brevo 429: Too many requests",
    );

    vi.restoreAllMocks();
    mockFetch({ status: 200, body: { companyName: "Acme" } }, new Error("connection reset"));
    expect(await testConnection(makeSettings())).toBe(
      "Connected to Brevo as Acme. Email list #7 could not be checked, try again: Brevo 0 network_error: connection reset",
    );
  });

  it("notes when no list is set", async () => {
    mockFetch({ status: 200, body: {} });
    expect(await testConnection(makeSettings({ list_id: null }))).toBe(
      "Connected to Brevo as your account. No email list is set, so opted-in customers are not added to a list.",
    );
  });

  it("throws when the API key is rejected", async () => {
    mockFetch({ status: 401, body: { code: "unauthorized", message: "Key not found" } });
    await expect(testConnection(makeSettings())).rejects.toMatchObject({ status: 401 });
  });
});
