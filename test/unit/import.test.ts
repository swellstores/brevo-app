import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PAGE_SIZE,
  emptyStats,
  addStats,
  fetchAccounts,
  partitionAccounts,
  importToList,
  upsertEach,
  importPage,
} from "../../functions/lib/import";
import ImportCustomers, { config } from "../../functions/import-customers";
import { makeAccount, makeSettings, mockFetch, callOf, rawSettings } from "../helpers/brevo-fixtures";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const optedIn = (id: string) => makeAccount({ id, email: `${id}@example.com`, email_optin: true, sms_optin: false });
const notOptedIn = (id: string) => makeAccount({ id, email: `${id}@example.com`, email_optin: false, sms_optin: false });

describe("emptyStats / addStats", () => {
  it("starts at zero and sums pages", () => {
    const total = addStats(emptyStats(), { imported: 2, upserted: 3, skipped: 1, failed: 0 });
    expect(addStats(total, { imported: 1, upserted: 0, skipped: 0, failed: 2 })).toEqual({
      imported: 3,
      upserted: 3,
      skipped: 1,
      failed: 2,
    });
  });
});

describe("fetchAccounts", () => {
  it("loads the first page sorted by id with only the needed fields", async () => {
    const get = vi.fn().mockResolvedValue({ results: [{ id: "a" }] });
    expect(await fetchAccounts({ get }, null)).toEqual([{ id: "a" }]);
    expect(get).toHaveBeenCalledWith("/accounts", {
      sort: "id asc",
      limit: PAGE_SIZE,
      fields: "id,email,first_name,last_name,phone,email_optin,sms_optin,shipping,billing",
    });
  });

  it("continues after the last id", async () => {
    const get = vi.fn().mockResolvedValue({ results: [] });
    await fetchAccounts({ get }, "abc", 10);
    expect(get.mock.calls[0][1]).toMatchObject({ limit: 10, where: { id: { $gt: "abc" } } });
  });

  it("returns an empty array for empty responses", async () => {
    expect(await fetchAccounts({ get: vi.fn().mockResolvedValue(null) }, null)).toEqual([]);
  });
});

describe("partitionAccounts", () => {
  const accounts = [optedIn("a"), notOptedIn("b"), makeAccount({ id: "c", email: undefined })];

  it("imports opted-in accounts to the list and upserts the rest", () => {
    const { toImport, toUpsert, skipped } = partitionAccounts(accounts, makeSettings(), false);
    expect(toImport.map((a) => a.id)).toEqual(["a"]);
    expect(toUpsert.map((a) => a.id)).toEqual(["b"]);
    expect(skipped).toBe(1);
  });

  it("skips accounts without opt-in when onlyOptin is set", () => {
    const { toImport, toUpsert, skipped } = partitionAccounts(accounts, makeSettings(), true);
    expect(toImport.map((a) => a.id)).toEqual(["a"]);
    expect(toUpsert).toEqual([]);
    expect(skipped).toBe(2);
  });

  it("upserts opted-in accounts when no list is set", () => {
    const { toImport, toUpsert } = partitionAccounts(accounts, makeSettings({ list_id: null }), false);
    expect(toImport).toEqual([]);
    expect(toUpsert.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("importToList", () => {
  it("queues one Brevo import job for the accounts", async () => {
    const fetchMock = mockFetch({ status: 202, body: { processId: 12 } });
    await importToList([optedIn("a"), optedIn("b")], makeSettings());

    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://api.brevo.com/v3/contacts/import");
    expect(call.body).toEqual({
      jsonBody: [
        { email: "a@example.com", attributes: { FIRSTNAME: "Jane", LASTNAME: "Doe" } },
        { email: "b@example.com", attributes: { FIRSTNAME: "Jane", LASTNAME: "Doe" } },
      ],
      listIds: [7],
      updateExistingContacts: true,
      emptyContactsAttributes: false,
      disableNotification: true,
    });
  });

  it("does nothing without accounts or list", async () => {
    const fetchMock = mockFetch();
    await importToList([], makeSettings());
    await importToList([optedIn("a")], makeSettings({ list_id: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("upsertEach", () => {
  it("upserts every account", async () => {
    const fetchMock = mockFetch({ status: 204 });
    const accounts = Array.from({ length: 7 }, (_, i) => notOptedIn(`u${i}`));
    expect(await upsertEach(accounts, makeSettings())).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("counts and logs non-retryable failures", async () => {
    mockFetch({ status: 400, body: { message: "Invalid email" } }, { status: 204 });
    expect(await upsertEach([notOptedIn("bad"), notOptedIn("ok")], makeSettings())).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith("Brevo: import of bad@example.com failed:", "Brevo 400: Invalid email");
  });

  it("throws retryable failures so the page is retried", async () => {
    mockFetch({ status: 429 });
    await expect(upsertEach([notOptedIn("a")], makeSettings())).rejects.toMatchObject({ status: 429 });
  });
});

describe("importPage", () => {
  it("imports, upserts and counts a page", async () => {
    const fetchMock = mockFetch({ status: 202, body: { processId: 1 } }, { status: 204 });
    const stats = await importPage(
      [optedIn("a"), notOptedIn("b"), makeAccount({ email: "" })],
      makeSettings(),
      false,
    );
    expect(stats).toEqual({ imported: 1, upserted: 1, skipped: 1, failed: 0 });
    expect(fetchMock.mock.calls.map((c) => callOf(c).url)).toEqual([
      "https://api.brevo.com/v3/contacts/import",
      "https://api.brevo.com/v3/contacts",
    ]);
  });

  it("subtracts failures from upserted", async () => {
    mockFetch({ status: 400, body: { message: "bad" } });
    expect(await importPage([notOptedIn("a")], makeSettings(), false)).toEqual({
      imported: 0,
      upserted: 0,
      skipped: 0,
      failed: 1,
    });
  });
});

describe("import-customers workflow", () => {
  // step.do runner that calls the callback directly and records step names
  function makeStep() {
    const names: string[] = [];
    const step = {
      do: vi.fn(async (name: string, ...args: any[]) => {
        names.push(name);
        const callback = args[args.length - 1];
        return callback();
      }),
      sleep: vi.fn(),
      sleepUntil: vi.fn(),
    };
    return { step: step as unknown as SwellWorkflowStep, names };
  }

  function makeReq(pages: any[][], settings: any = rawSettings, data: any = {}) {
    const get = vi.fn();
    pages.forEach((results) => get.mockResolvedValueOnce({ results }));
    get.mockResolvedValue({ results: [] });
    const req = {
      data,
      swell: { get, settings: vi.fn().mockResolvedValue({ brevo: settings }) },
    } as unknown as SwellWorkflowRequest;
    return { req, get };
  }

  it("is a workflow started by an action", () => {
    expect(config).toMatchObject({ kind: "workflow", action: true });
  });

  it("stops without an API key", async () => {
    const fetchMock = mockFetch();
    const { req, get } = makeReq([], {});
    const { step } = makeStep();

    expect(await new ImportCustomers().run(req, step)).toEqual({ error: "missing_api_key" });
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pages through all accounts and returns totals", async () => {
    mockFetch({ status: 202, body: { processId: 1 } });
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => optedIn(`a${String(i).padStart(3, "0")}`));
    const { req, get } = makeReq([full, [notOptedIn("z1")]]);
    const { step, names } = makeStep();

    const totals = await new ImportCustomers().run(req, step);

    expect(totals).toEqual({ imported: PAGE_SIZE, upserted: 1, skipped: 0, failed: 0 });
    expect(names).toEqual(["load settings", "page 1", "page 2"]);
    expect(get.mock.calls[1][1].where).toEqual({ id: { $gt: full[PAGE_SIZE - 1].id } });
  });

  it("stops on an empty store", async () => {
    const fetchMock = mockFetch();
    const { req } = makeReq([]);
    const { step, names } = makeStep();

    expect(await new ImportCustomers().run(req, step)).toEqual(emptyStats());
    expect(names).toEqual(["load settings", "page 1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes only_optin from the action modal", async () => {
    const fetchMock = mockFetch({ status: 202, body: { processId: 1 } });
    const { req } = makeReq([[optedIn("a"), notOptedIn("b")]], rawSettings, { only_optin: true });
    const { step } = makeStep();

    const totals = await new ImportCustomers().run(req, step);

    expect(totals).toEqual({ imported: 1, upserted: 0, skipped: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries pages with backoff", async () => {
    mockFetch();
    const { req } = makeReq([]);
    const { step } = makeStep();

    await new ImportCustomers().run(req, step);

    expect((step.do as any).mock.calls[1][1]).toEqual({
      retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
    });
  });
});
