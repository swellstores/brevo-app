import { describe, it, expect } from "vitest";
import { formatPhone } from "../../functions/lib/phone";

describe("formatPhone", () => {
  it("returns undefined for empty input", () => {
    expect(formatPhone(undefined)).toBeUndefined();
    expect(formatPhone(null)).toBeUndefined();
    expect(formatPhone("")).toBeUndefined();
  });

  it("formats national numbers with the country", () => {
    expect(formatPhone("07911 123456", "GB")).toBe("+447911123456");
    expect(formatPhone("(212) 736-5000", "us")).toBe("+12127365000");
  });

  it("keeps international numbers without a country", () => {
    expect(formatPhone("+33 6 12 34 56 78")).toBe("+33612345678");
  });

  it("returns undefined for invalid numbers", () => {
    expect(formatPhone("123", "US")).toBeUndefined();
    expect(formatPhone("not a phone", "US")).toBeUndefined();
    expect(formatPhone("2127365000")).toBeUndefined();
  });
});
