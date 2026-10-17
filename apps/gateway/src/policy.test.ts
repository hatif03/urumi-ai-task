import { describe, expect, test } from "bun:test";
import { decide, type Grant } from "./policy.ts";

const member = { id: "u-member", role: "member" as const };
const admin = { id: "u-admin", role: "admin" as const };
const read = { serverSlug: "woocommerce", toolName: "list_orders", annotations: { readOnlyHint: true } };
const write = { serverSlug: "woocommerce", toolName: "create_product", annotations: { readOnlyHint: false } };
const unannotated = { serverSlug: "thirdparty", toolName: "echo", annotations: {} };
let n = 0;
const grant = (g: Partial<Grant>): Grant => ({ id: `g${++n}`, subjectType: "role", subject: "member", serverSlug: "*", toolName: "*", effect: "allow", ...g });

describe("tool permissions", () => {
  test("default: member reads, cannot write, admin can do both", () => {
    expect(decide(member, read, []).allowed).toBe(true);
    expect(decide(member, write, []).allowed).toBe(false);
    expect(decide(admin, write, []).allowed).toBe(true);
  });

  test("an unannotated tool counts as a write", () => {
    expect(decide(member, unannotated, []).allowed).toBe(false);
  });

  test("a server-wide allow opens writes for one server only", () => {
    const grants = [grant({ serverSlug: "woocommerce" })];
    expect(decide(member, write, grants).allowed).toBe(true);
    expect(decide(member, unannotated, grants).allowed).toBe(false);
  });

  test("a tool rule beats a server rule; deny beats allow at the same specificity", () => {
    const grants = [grant({ serverSlug: "woocommerce" }), grant({ serverSlug: "woocommerce", toolName: "create_product", effect: "deny" })];
    expect(decide(member, write, grants).allowed).toBe(false);
    expect(decide(member, read, grants).allowed).toBe(true);
    const tie = [grant({ serverSlug: "woocommerce", effect: "allow" }), grant({ serverSlug: "woocommerce", effect: "deny" })];
    expect(decide(member, read, tie).allowed).toBe(false);
  });

  test("a user rule beats a role rule, in either direction", () => {
    const allowOne = [grant({ subjectType: "user", subject: member.id, serverSlug: "woocommerce", toolName: "create_product" })];
    expect(decide(member, write, allowOne).allowed).toBe(true);
    expect(decide({ id: "other", role: "member" }, write, allowOne).allowed).toBe(false);
    const denyOne = [grant({ subjectType: "user", subject: member.id, effect: "deny" }), grant({ serverSlug: "woocommerce", toolName: "list_orders" })];
    expect(decide(member, read, denyOne).allowed).toBe(false);
  });

  test("a rule for a different server or user does not match", () => {
    expect(decide(member, write, [grant({ serverSlug: "utility" })]).allowed).toBe(false);
    expect(decide(member, write, [grant({ subjectType: "user", subject: "someone-else", serverSlug: "woocommerce" })]).allowed).toBe(false);
  });

  test("an exact tool name with a wildcard server never matches", () => {
    expect(decide(member, write, [grant({ serverSlug: "*", toolName: "create_product" })]).allowed).toBe(false);
  });

  test("an explicit deny can restrict an admin", () => {
    const grants = [grant({ subjectType: "user", subject: admin.id, serverSlug: "woocommerce", toolName: "update_order_status", effect: "deny" })];
    expect(decide(admin, { ...write, toolName: "update_order_status" }, grants).allowed).toBe(false);
    expect(decide(admin, write, grants).allowed).toBe(true);
  });
});
