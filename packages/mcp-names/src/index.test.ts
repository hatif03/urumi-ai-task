import { describe, expect, test } from "bun:test";
import { joinToolName, splitToolName } from "./index.ts";

describe("mcp names", () => {
  test("joins and splits a public tool name", () => {
    expect(joinToolName("woocommerce", "list_orders")).toBe("woocommerce__list_orders");
    expect(splitToolName("woocommerce__list_orders")).toEqual({
      slug: "woocommerce",
      tool: "list_orders",
    });
  });

  test("rejects an upstream name that already contains the separator", () => {
    expect(() => joinToolName("utility", "get__time")).toThrow();
    expect(splitToolName("utility__get__time")).toBeNull();
  });

  test("rejects a disabled-looking or empty slug", () => {
    expect(splitToolName("__list_orders")).toBeNull();
    expect(splitToolName("list_orders")).toBeNull();
    expect(() => joinToolName("Bad", "echo")).toThrow();
  });
});
