import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AuditLog, RateLimiter } from "../src/audit.js";
import { AuthError, KeyRing, type Principal, type Scope } from "../src/auth.js";
import { ConfirmationService, canonical } from "../src/confirm.js";
import { buildServer } from "../src/server.js";
import { CommerceStore } from "../src/store.js";

const ALL: Scope[] = ["catalog:read", "orders:read", "customers:pii", "inventory:read", "inventory:write", "discounts:write"];
const principal = (scopes: Scope[], id = "assistant"): Principal => ({ id, scopes: new Set(scopes) });

async function connect(p: Principal, opts: { limiter?: RateLimiter; confirmations?: ConfirmationService } = {}) {
  const store = new CommerceStore();
  const audit = new AuditLog();
  const server = buildServer({ store, principal: p, audit, now: () => new Date("2026-11-14T08:00:00Z"), ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
  return { client, call, store, audit };
}

describe("discovery", () => {
  it("advertises tools with schemas and safety annotations, plus resources and prompts", async () => {
    const { client } = await connect(principal(ALL));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["adjust_inventory", "create_discount", "get_order", "list_low_stock", "search_products"]);
    expect(tools.find((t) => t.name === "search_products")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "adjust_inventory")?.annotations?.destructiveHint).toBe(true);
    expect((await client.listPrompts()).prompts[0]?.name).toBe("restock_review");
    const res = await client.readResource({ uri: "commerce://products/LW-BOB-12" });
    expect(JSON.parse((res.contents[0] as { text: string }).text)).toMatchObject({ stock: 7 });
  });

  it("declares all four behaviour hints on every tool", async () => {
    const { client } = await connect(principal(ALL));
    for (const tool of (await client.listTools()).tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });
});

describe("read tools", () => {
  it("search returns structured content and text", async () => {
    const { call } = await connect(principal(["catalog:read"]));
    const r = await call("search_products", { query: "wig", in_stock_only: true });
    expect(r.structuredContent.items.map((p: { sku: string }) => p.sku)).toEqual(["LW-BOB-12", "LW-KNK-18"]);
    expect(r.content[0]!.text).toContain("R1 899,00".replace(" ", " ").slice(0, 1));
  });

  it("masks customer PII unless the key holds customers:pii", async () => {
    const masked = await (await connect(principal(["orders:read"]))).call("get_order", { order_id: "#1042" });
    expect(masked.structuredContent.customer).toEqual({ name: "Thandi", email: "th**************om", phone: "+2********67" });
    const full = await (await connect(principal(["orders:read", "customers:pii"]))).call("get_order", { order_id: "#1042" });
    expect(full.structuredContent.customer.email).toBe("thandi@example.com");
  });

  it("lists low stock most urgent first", async () => {
    const r = await (await connect(principal(["inventory:read"]))).call("list_low_stock");
    expect(r.structuredContent.items.map((i: { sku: string }) => i.sku)).toEqual(["LW-BDW-22", "LW-KNK-18"]);
  });
});

describe("scopes and audit", () => {
  it("denies tools outside the key's scopes and audits the denial without raw args", async () => {
    const { call, audit } = await connect(principal(["catalog:read"]));
    const r = await call("get_order", { order_id: "#1042" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/missing scope orders:read/);
    expect(audit.records.at(-1)).toMatchObject({ tool: "get_order", outcome: "denied" });
    expect(JSON.stringify(audit.records)).not.toContain("#1042");
  });

  it("rejects schema-invalid input before the handler runs", async () => {
    const { call } = await connect(principal(ALL));
    expect((await call("get_order", { order_id: "1042; DROP TABLE" })).isError).toBe(true);
  });

  it("rate-limits per principal", async () => {
    const { call } = await connect(principal(["catalog:read"]), { limiter: new RateLimiter(2, 60_000) });
    await call("search_products", { query: "wig" });
    await call("search_products", { query: "wig" });
    expect((await call("search_products", { query: "wig" })).content[0]!.text).toMatch(/Rate limit/);
  });
});

describe("preview-then-confirm writes", () => {
  it("never changes stock on the first call; executes only with a matching token", async () => {
    const { call, store } = await connect(principal(["inventory:write"]));
    const args = { sku: "LW-KNK-18", delta: 10, reason: "Received PO-778 from supplier" };
    const preview = await call("adjust_inventory", args);
    expect(preview.structuredContent).toMatchObject({ preview: true, from: 2, to: 12 });
    expect(store.products.get("LW-KNK-18")!.stock).toBe(2);

    const token = preview.structuredContent.confirm_token as string;
    const tampered = await call("adjust_inventory", { ...args, delta: 100, confirm_token: token });
    expect(tampered.content[0]!.text).toMatch(/does not match/);

    const done = await call("adjust_inventory", { ...args, confirm_token: token });
    expect(done.structuredContent).toEqual({ preview: false, sku: "LW-KNK-18", stock: 12 });
    expect(store.movements).toHaveLength(1);

    const replay = await call("adjust_inventory", { ...args, confirm_token: token });
    expect(replay.content[0]!.text).toMatch(/already used/);
    expect(store.products.get("LW-KNK-18")!.stock).toBe(12);
  });

  it("enforces business limits before issuing a preview", async () => {
    const { call } = await connect(principal(["inventory:write", "discounts:write"]));
    expect((await call("adjust_inventory", { sku: "LW-BOB-12", delta: -50, reason: "write-off damaged" })).content[0]!.text).toMatch(/Only 7/);
    expect((await call("adjust_inventory", { sku: "LW-BOB-12", delta: 500, reason: "big delivery" })).content[0]!.text).toMatch(/back office/);
    expect((await call("create_discount", { code: "HALFOFF", percent: 50, days_valid: 7 })).content[0]!.text).toMatch(/manager/);
    expect((await call("create_discount", { code: "FOREVER", percent: 10, days_valid: 365 })).content[0]!.text).toMatch(/at most 30 days/);
  });

  it("tokens are bound to the principal and expire", async () => {
    let t = 0;
    const conf = new ConfirmationService(Buffer.alloc(32, 1), 1000, () => t);
    const args = { code: "WELCOME10", percent: 10, days_valid: 14 };
    const { token } = conf.issue("alice", "create_discount", args);
    expect(conf.verify(token, "mallory", "create_discount", args)).toMatchObject({ ok: false });
    t = 5000;
    expect(conf.verify(token, "alice", "create_discount", args)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
  });

  it("discount creation is idempotent per code", async () => {
    const { call, store } = await connect(principal(["discounts:write"]));
    const args = { code: "WELCOME10", percent: 10, days_valid: 14 };
    const { structuredContent } = await call("create_discount", args);
    await call("create_discount", { ...args, confirm_token: structuredContent.confirm_token });
    expect(store.discounts.get("WELCOME10")).toMatchObject({ percent: 10, createdBy: "assistant", expiresAt: "2026-11-28T08:00:00.000Z" });
    expect((await call("create_discount", args)).content[0]!.text).toMatch(/already exists/);
    expect((await call("create_discount", { ...args, percent: 20 })).isError).toBe(true);
  });
});

describe("KeyRing", () => {
  it("stores only hashes and resolves scopes", () => {
    const ring = new KeyRing(`buyer:${KeyRing.hash("sk_live_abc")}:inventory:read,inventory:write`);
    expect([...ring.authenticate("sk_live_abc").scopes]).toEqual(["inventory:read", "inventory:write"]);
    expect(() => ring.authenticate("sk_live_wrong")).toThrow(AuthError);
    expect(() => ring.authenticate(undefined)).toThrow(AuthError);
    expect(() => new KeyRing("bad:entry")).toThrow(/Malformed/);
  });
});
