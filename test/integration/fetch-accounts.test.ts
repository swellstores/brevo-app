import { describe, it, expect } from "vitest";
import { createSwellClient } from "../helpers/swell-client";
import { fetchAccounts } from "../../functions/lib/import";

describe("fetchAccounts (read-only, real store)", () => {
  it("pages through accounts by id without overlap", async () => {
    const swell = createSwellClient();

    const first = await fetchAccounts(swell, null, 2);
    if (first.length < 2) {
      return; // store has too few accounts to page
    }
    const next = await fetchAccounts(swell, first[1].id, 2);

    expect(first[0].id < first[1].id).toBe(true);
    for (const account of next) {
      expect(account.id > first[1].id).toBe(true);
    }
    expect(Object.keys(first[0])).toContain("email");
  });
});
