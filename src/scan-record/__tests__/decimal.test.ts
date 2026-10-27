import { describe, expect, it } from "vitest";
import { abs, add, dec, format, mul } from "../decimal";

describe("decimal", () => {
  it("round-trips a Daml Decimal with 10 places", () => {
    expect(format(dec("112062.4048694990"))).toBe("112062.4048694990");
    expect(format(dec("39681534966.2458918175"))).toBe("39681534966.2458918175");
  });

  it("parses the scientific forms Scan sends", () => {
    expect(dec("0E-10")).toBe(BigInt(0));
    expect(format(dec("1.5E+3"), 0)).toBe("1500");
    expect(format(dec("-2.5e-1"), 2)).toBe("-0.25");
  });

  it("multiplies two 10-place decimals exactly", () => {
    const app = mul(dec("203513.6207535227"), dec("0.5506383526"));
    expect(format(app, 20)).toBe("112062.40486338091017470402");
    expect(format(app)).toBe("112062.4048633809");
  });

  it("rounds half away from zero and never prints -0", () => {
    expect(format(dec("0.00000000005"))).toBe("0.0000000001");
    expect(format(dec("-0.00000000005"))).toBe("-0.0000000001");
    expect(format(dec("-0.00000000004"))).toBe("0.0000000000");
    expect(format(dec("-1.5"), 0)).toBe("-2");
  });

  it("adds and takes absolute values", () => {
    expect(format(add(dec("1.1"), dec("2.2"), dec("-0.3")))).toBe("3.0000000000");
    expect(format(abs(dec("-7.25")))).toBe("7.2500000000");
    expect(add()).toBe(BigInt(0));
  });

  it("rejects anything that is not a plain decimal", () => {
    expect(() => dec("abc")).toThrow("not a decimal");
    expect(() => dec("1,5")).toThrow("not a decimal");
  });
});
