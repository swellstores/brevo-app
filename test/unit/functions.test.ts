import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { rawSettings, makeAccount, makeRecord, mockFetch, callOf } from "../helpers/brevo-fixtures";
import contactSync, { config as contactConfig } from "../../functions/contact-sync";
import cartEvents, { config as cartConfig } from "../../functions/cart-events";
import orderEvents, { config as orderConfig } from "../../functions/order-events";
import testConnectionFn, { config as testConfig } from "../../functions/test-connection";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(data: Record<string, any>, record: any, settings: any = rawSettings) {
  const get = vi.fn().mockResolvedValue(record);
  const req = createMockRequest({
    data,
    swell: { get, settings: vi.fn().mockResolvedValue({ brevo: settings }) },
  });
  return { req, get };
}

describe("contact-sync", () => {
  it("subscribes to account events", () => {
    expect(contactConfig.model?.events).toEqual(["account.created", "account.updated"]);
  });

  it("loads the account and upserts the contact", async () => {
    const fetchMock = mockFetch({ status: 201, body: { id: 1 } });
    const { req, get } = request({ id: "acc_1", $event: { type: "account.created" } }, makeAccount());

    await contactSync(req);

    expect(get).toHaveBeenCalledWith("/accounts/{id}", { id: "acc_1" });
    expect(callOf(fetchMock.mock.calls[0]).body.email).toBe("jane@example.com");
  });

  it("does not load the account when contact sync is off", async () => {
    const fetchMock = mockFetch();
    const { req, get } = request({ id: "acc_1" }, makeAccount(), { ...rawSettings, sync_contacts: false });

    await contactSync(req);

    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the app is disabled", async () => {
    const fetchMock = mockFetch();
    const { req, get } = request({ id: "acc_1" }, makeAccount(), { ...rawSettings, enabled: false });

    await contactSync(req);

    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without an API key", async () => {
    const fetchMock = mockFetch();
    const { req, get } = request({ id: "acc_1" }, makeAccount(), {});

    await contactSync(req);

    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs when the account is not found", async () => {
    const fetchMock = mockFetch();
    const { req } = request({ id: "missing", $event: { type: "account.created" } }, null);

    await contactSync(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Brevo: account missing not found");
  });

  it("logs non-retryable Brevo errors", async () => {
    mockFetch({ status: 400, body: { message: "Invalid email" } });
    const { req } = request({ id: "acc_1", $event: { type: "account.created" } }, makeAccount());

    await expect(contactSync(req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws retryable Brevo errors so Swell retries", async () => {
    mockFetch({ status: 503 });
    const { req } = request({ id: "acc_1", $event: { type: "account.created" } }, makeAccount());

    await expect(contactSync(req)).rejects.toMatchObject({ status: 503 });
  });
});

const eventCases = [
  {
    name: "cart-events",
    handler: cartEvents,
    config: cartConfig,
    path: "/carts/{id}",
    events: ["cart.created", "cart.abandoned"],
    event: "cart.abandoned",
    brevoEvent: "cart_abandoned",
  },
  {
    name: "order-events",
    handler: orderEvents,
    config: orderConfig,
    path: "/orders/{id}",
    events: ["order.submitted", "order.delivered", "order.canceled"],
    event: "order.submitted",
    brevoEvent: "order_submitted",
  },
];

describe.each(eventCases)("$name", ({ handler, config, path, events, event, brevoEvent }) => {
  it("subscribes to the expected model events", () => {
    expect(config.model?.events).toEqual(events);
  });

  it("loads the record with expansions and sends the Brevo event", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const { req, get } = request({ id: "rec_1", $event: { type: event } }, makeRecord());

    await handler(req);

    expect(get).toHaveBeenCalledWith(path, {
      id: "rec_1",
      expand: ["account", "items.product", "items.variant"],
    });
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://api.brevo.com/v3/events");
    expect(call.body.event_name).toBe(brevoEvent);
  });

  it("does nothing when the app is disabled", async () => {
    const fetchMock = mockFetch();
    const { req, get } = request({ id: "rec_1", $event: { type: event } }, makeRecord(), {
      ...rawSettings,
      enabled: false,
    });

    await handler(req);

    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs when the record is not found", async () => {
    const fetchMock = mockFetch();
    const { req } = request({ id: "missing", $event: { type: event } }, null);

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs non-retryable Brevo errors", async () => {
    mockFetch({ status: 400, body: { message: "bad event" } });
    const { req } = request({ id: "rec_1", $event: { type: event } }, makeRecord());

    await expect(handler(req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws retryable Brevo errors so Swell retries", async () => {
    mockFetch({ status: 429 });
    const { req } = request({ id: "rec_1", $event: { type: event } }, makeRecord());

    await expect(handler(req)).rejects.toMatchObject({ status: 429 });
  });
});

describe("order-events order sync", () => {
  it("sends the event and syncs the order when order sync is on", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const { req } = request({ id: "rec_1", $event: { type: "order.canceled" } }, makeRecord({ status: "canceled" }), {
      ...rawSettings,
      sync_orders: true,
    });

    await orderEvents(req);

    const urls = fetchMock.mock.calls.map((call) => callOf(call).url);
    expect(urls).toEqual(["https://api.brevo.com/v3/events", "https://api.brevo.com/v3/orders/status"]);
    expect(callOf(fetchMock.mock.calls[1]).body.status).toBe("canceled");
  });

  it("still syncs the order when the event is turned off", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const { req } = request({ id: "rec_1", $event: { type: "order.canceled" } }, makeRecord(), {
      ...rawSettings,
      sync_orders: true,
      event_order_canceled: false,
    });

    await orderEvents(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callOf(fetchMock.mock.calls[0]).url).toBe("https://api.brevo.com/v3/orders/status");
  });

  it("syncs the order even when the event fails", async () => {
    const fetchMock = mockFetch({ status: 400, body: { message: "bad event" } }, { status: 204 });
    const { req } = request({ id: "rec_1", $event: { type: "order.submitted" } }, makeRecord(), {
      ...rawSettings,
      sync_orders: true,
    });

    await orderEvents(req);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("Brevo: order.submitted for order rec_1 failed:", expect.any(String));
  });
});

describe("test-connection", () => {
  it("is a settings action", () => {
    expect(testConfig.action).toBe(true);
  });

  function actionRequest(settings: any) {
    return createMockRequest({
      data: { $action: { id: "test_connection", source: "settings", settings: "brevo", user_id: "user_1" } },
      swell: { settings: vi.fn().mockResolvedValue({ brevo: settings }) },
    });
  }

  it("asks for the API key when missing", async () => {
    const fetchMock = mockFetch();
    const result = await testConnectionFn(actionRequest({}));
    expect(result).toEqual({ message: "Add your Brevo API key and save the settings first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the connection", async () => {
    mockFetch({ status: 200, body: { companyName: "Acme" } }, { status: 200, body: { name: "Newsletter" } });
    const result = await testConnectionFn(actionRequest(rawSettings));
    expect(result).toEqual({ message: "Connected to Brevo as Acme. Email list: Newsletter (#7)." });
  });

  it("explains a rejected API key", async () => {
    mockFetch({ status: 401, body: { code: "unauthorized", message: "Key not found" } });
    const result = await testConnectionFn(actionRequest(rawSettings));
    expect(result.message).toContain("Brevo rejected the API key");
  });

  it("reports other failures", async () => {
    mockFetch({ status: 500, body: { message: "Internal error" } });
    const result = await testConnectionFn(actionRequest(rawSettings));
    expect(result.message).toBe("Brevo request failed: Brevo 500: Internal error");
  });
});
