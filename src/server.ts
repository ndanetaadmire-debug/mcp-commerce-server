import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuditLog, RateLimiter } from "./audit.js";
import { AuthError, type Principal, requireScope, type Scope } from "./auth.js";
import { ConfirmationService } from "./confirm.js";
import type { CommerceStore, Order } from "./store.js";

export interface ServerDeps {
  store: CommerceStore;
  principal: Principal;
  confirmations?: ConfirmationService;
  audit?: AuditLog;
  limiter?: RateLimiter;
  now?: () => Date;
  limits?: { maxStockDelta: number; maxDiscountPercent: number; maxDiscountDays: number };
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (data: Record<string, unknown>, summary: string): ToolResult => ({ content: [{ type: "text", text: summary }], structuredContent: data });
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });
const rands = (cents: number) => `R${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`;

/** Personal data is minimised unless the caller holds `customers:pii`. */
export function presentOrder(o: Order, p: Principal) {
  const pii = p.scopes.has("customers:pii");
  const mask = (s: string) => (s.length <= 4 ? "****" : `${s.slice(0, 2)}${"*".repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`);
  return {
    id: o.id, status: o.status, totalCents: o.totalCents, items: o.items, placedAt: o.placedAt,
    customer: pii ? { name: o.customerName, email: o.customerEmail, phone: o.customerPhone }
                  : { name: o.customerName.split(" ")[0] ?? "", email: mask(o.customerEmail), phone: mask(o.customerPhone) },
  };
}

export function buildServer(d: ServerDeps): McpServer {
  const confirmations = d.confirmations ?? new ConfirmationService();
  const audit = d.audit ?? new AuditLog();
  const limiter = d.limiter ?? new RateLimiter(60, 60_000);
  const now = d.now ?? (() => new Date());
  const limits = d.limits ?? { maxStockDelta: 100, maxDiscountPercent: 30, maxDiscountDays: 30 };
  const P = d.principal;

  const server = new McpServer(
    { name: "commerce", version: "1.0.0" },
    { instructions: "Read tools are safe. Write tools (adjust_inventory, create_discount) return a preview and a confirm_token first; show the preview to the user and only call again with the token after they approve." },
  );

  /** Every tool goes through one wrapper: rate limit → scope → handler → audit. */
  function guarded<A extends Record<string, unknown>>(tool: string, scope: Scope, handler: (args: A) => ToolResult | Promise<ToolResult>) {
    return async (args: A): Promise<ToolResult> => {
      if (!limiter.take(P.id)) {
        audit.record({ principal: P.id, tool, args, outcome: "denied", detail: "rate_limited" });
        return fail("Rate limit exceeded. Try again in a minute.");
      }
      try {
        requireScope(P, scope);
        const res = await handler(args);
        audit.record({ principal: P.id, tool, args, outcome: res.isError ? "error" : res.structuredContent?.["preview"] ? "preview" : "ok" });
        return res;
      } catch (err) {
        const denied = err instanceof AuthError;
        audit.record({ principal: P.id, tool, args, outcome: denied ? "denied" : "error", detail: (err as Error).message });
        return fail(denied ? `Not permitted: ${(err as Error).message}` : `Failed: ${(err as Error).message}`);
      }
    };
  }

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Search the catalogue by keywords (title, SKU, category).",
      inputSchema: { query: z.string().min(1).max(100), limit: z.number().int().min(1).max(25).default(10), in_stock_only: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded("search_products", "catalog:read", ({ query, limit, in_stock_only }: { query: string; limit: number; in_stock_only: boolean }) => {
      const items = d.store.search(query, limit, in_stock_only);
      return ok({ items }, items.length ? items.map((p) => `${p.sku} · ${p.title} · ${rands(p.priceCents)} · ${p.stock} in stock`).join("\n") : "No products found.");
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Order status and items. Customer contact details are masked unless the key has customers:pii.",
      inputSchema: { order_id: z.string().regex(/^#\d{3,10}$/, "Order IDs look like #1042") },
      annotations: { readOnlyHint: true },
    },
    guarded("get_order", "orders:read", ({ order_id }: { order_id: string }) => {
      const o = d.store.orders.get(order_id);
      if (!o) return fail(`Order ${order_id} not found.`);
      const view = presentOrder(o, P);
      return ok(view, `${o.id}: ${o.status}, ${rands(o.totalCents)}, customer ${view.customer.name} (${view.customer.email})`);
    }),
  );

  server.registerTool(
    "list_low_stock",
    {
      title: "List low stock",
      description: "Products at or below their reorder point, most urgent first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guarded("list_low_stock", "inventory:read", () => {
      const items = [...d.store.products.values()].filter((p) => p.stock <= p.reorderPoint).sort((a, b) => a.stock - a.reorderPoint - (b.stock - b.reorderPoint));
      return ok({ items: items.map((p) => ({ sku: p.sku, title: p.title, stock: p.stock, reorderPoint: p.reorderPoint })) },
        items.map((p) => `${p.sku}: ${p.stock} left (reorder at ${p.reorderPoint})`).join("\n") || "Nothing is low on stock.");
    }),
  );

  server.registerTool(
    "adjust_inventory",
    {
      title: "Adjust inventory",
      description: "Change stock for a SKU (positive = received, negative = written off). Call once without confirm_token to get a preview, then again with the token after the user approves.",
      inputSchema: { sku: z.string().min(1), delta: z.number().int().refine((n) => n !== 0, "delta cannot be 0"), reason: z.string().min(5).max(200), confirm_token: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guarded("adjust_inventory", "inventory:write", ({ confirm_token, ...args }: { sku: string; delta: number; reason: string; confirm_token?: string }) => {
      const p = d.store.products.get(args.sku);
      if (!p) return fail(`Unknown SKU ${args.sku}`);
      if (Math.abs(args.delta) > limits.maxStockDelta) return fail(`Adjustments larger than ${limits.maxStockDelta} units must be done in the back office.`);
      if (p.stock + args.delta < 0) return fail(`Only ${p.stock} in stock; cannot remove ${-args.delta}.`);
      if (!confirm_token) {
        const { token, expiresAt } = confirmations.issue(P.id, "adjust_inventory", args);
        return ok({ preview: true, sku: p.sku, from: p.stock, to: p.stock + args.delta, reason: args.reason, confirm_token: token, expires_at: expiresAt },
          `PREVIEW: ${p.sku} stock ${p.stock} → ${p.stock + args.delta} (${args.reason}). Ask the user to approve, then call again with confirm_token.`);
      }
      const v = confirmations.verify(confirm_token, P.id, "adjust_inventory", args);
      if (!v.ok) return fail(v.reason);
      const updated = d.store.adjustStock(args.sku, args.delta, args.reason, P.id, now());
      return ok({ preview: false, sku: updated.sku, stock: updated.stock }, `Done: ${updated.sku} now has ${updated.stock} in stock.`);
    }),
  );

  server.registerTool(
    "create_discount",
    {
      title: "Create discount code",
      description: `Create a percentage discount code (max ${limits.maxDiscountPercent}%, max ${limits.maxDiscountDays} days). Preview first, then confirm with the token.`,
      inputSchema: {
        code: z.string().regex(/^[A-Z0-9]{4,20}$/, "Use 4–20 uppercase letters/digits"),
        percent: z.number().int().min(1),
        days_valid: z.number().int().min(1),
        confirm_token: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guarded("create_discount", "discounts:write", ({ confirm_token, ...args }: { code: string; percent: number; days_valid: number; confirm_token?: string }) => {
      if (args.percent > limits.maxDiscountPercent) return fail(`Discounts above ${limits.maxDiscountPercent}% need a manager in the back office.`);
      if (args.days_valid > limits.maxDiscountDays) return fail(`Codes can be valid for at most ${limits.maxDiscountDays} days.`);
      const existing = d.store.discounts.get(args.code);
      if (existing) {
        return existing.percent === args.percent ? ok({ preview: false, ...existing }, `Code ${args.code} already exists.`) : fail(`Code ${args.code} already exists with ${existing.percent}%.`);
      }
      const expiresAt = new Date(now().getTime() + args.days_valid * 86_400_000).toISOString();
      if (!confirm_token) {
        const { token, expiresAt: tokenExp } = confirmations.issue(P.id, "create_discount", args);
        return ok({ preview: true, ...args, expires_at: expiresAt, confirm_token: token, token_expires_at: tokenExp },
          `PREVIEW: ${args.code} = ${args.percent}% off until ${expiresAt.slice(0, 10)}. Confirm with the user, then call again with confirm_token.`);
      }
      const v = confirmations.verify(confirm_token, P.id, "create_discount", args);
      if (!v.ok) return fail(v.reason);
      const disc = { code: args.code, percent: args.percent, expiresAt, createdBy: P.id };
      d.store.discounts.set(args.code, disc);
      return ok({ preview: false, ...disc }, `Created ${args.code}: ${args.percent}% off until ${expiresAt.slice(0, 10)}.`);
    }),
  );

  server.registerResource(
    "product",
    new ResourceTemplate("commerce://products/{sku}", { list: undefined }),
    { title: "Product", description: "A product as JSON", mimeType: "application/json" },
    async (uri, { sku }) => {
      requireScope(P, "catalog:read");
      const p = d.store.products.get(String(sku));
      if (!p) throw new Error(`Unknown SKU ${String(sku)}`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(p) }] };
    },
  );

  server.registerResource(
    "returns-policy",
    "commerce://policies/returns",
    { title: "Returns policy", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "Unused items can be returned within 30 days. Worn wigs cannot be returned for hygiene reasons." }] }),
  );

  server.registerPrompt(
    "restock_review",
    { title: "Weekly restock review", description: "Review low stock and propose purchase quantities", argsSchema: { weeks_of_cover: z.string().default("4") } },
    ({ weeks_of_cover }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Call list_low_stock, then propose order quantities for ${weeks_of_cover} weeks of cover. Do not adjust inventory; this is a proposal for a human buyer.` } }],
    }),
  );

  return server;
}
