import { describe, expect, it } from "vitest";
import { estimate, fixedMonthly, money } from "../src/cost.js";

describe("cost model", () => {
  it("default path has $0.40 fixed (one secret) and names every line", () => {
    const lines = estimate({ services: { api: { path: "." } }, database: { kind: "none" } });
    expect(fixedMonthly(lines)).toBeCloseTo(0.401, 2);
    expect(lines.map((l) => l.item)).toEqual(expect.arrayContaining(["Lambda Web Function (api)", "Built-in HTTPS endpoint", "S3 deploy bucket", "Secrets Manager (1 env)", "CloudWatch Logs"]));
    expect(lines.every((l) => l.note !== undefined)).toBe(true);
  });
  it("aurora adds the public IPv4 charge at idle; --private adds NAT", () => {
    const a = estimate({ services: { api: { path: "." } }, database: { kind: "aurora", network: "public" } });
    expect(fixedMonthly(a)).toBeGreaterThan(3.65);
    const p = estimate({ services: { api: { path: "." } }, database: { kind: "aurora", network: "private" } });
    expect(fixedMonthly(p) - fixedMonthly(a)).toBeGreaterThan(30);
  });
  it("formats money", () => { expect(money(0)).toBe("$0"); expect(money(0.001)).toBe("~$0"); expect(money(1.5)).toBe("$1.50"); });
});
