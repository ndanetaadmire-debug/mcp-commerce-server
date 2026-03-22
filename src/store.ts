export interface Product {
  sku: string;
  title: string;
  priceCents: number;
  stock: number;
  reorderPoint: number;
  category: string;
}

export interface Order {
  id: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  status: "processing" | "shipped" | "delivered" | "cancelled";
  totalCents: number;
  items: Array<{ sku: string; qty: number }>;
  placedAt: string;
}

export interface Discount {
  code: string;
  percent: number;
  expiresAt: string;
  createdBy: string;
}

export interface InventoryMovement {
  sku: string;
  delta: number;
  reason: string;
  by: string;
  at: string;
}

/** Port to the commerce backend (Shopify, WooCommerce, a custom DB). In-memory implementation for demos/tests. */
export class CommerceStore {
  readonly products = new Map<string, Product>();
  readonly orders = new Map<string, Order>();
  readonly discounts = new Map<string, Discount>();
  readonly movements: InventoryMovement[] = [];

  constructor(seed = true) {
    if (!seed) return;
    for (const p of SEED_PRODUCTS) this.products.set(p.sku, { ...p });
    for (const o of SEED_ORDERS) this.orders.set(o.id, { ...o });
  }

  search(query: string, limit: number, inStockOnly: boolean): Product[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.products.values()]
      .filter((p) => (!inStockOnly || p.stock > 0) && terms.every((t) => `${p.title} ${p.sku} ${p.category}`.toLowerCase().includes(t)))
      .slice(0, limit);
  }

  adjustStock(sku: string, delta: number, reason: string, by: string, at: Date): Product {
    const p = this.products.get(sku);
    if (!p) throw new Error(`Unknown SKU ${sku}`);
    if (p.stock + delta < 0) throw new Error(`Stock for ${sku} cannot go below zero`);
    p.stock += delta;
    this.movements.push({ sku, delta, reason, by, at: at.toISOString() });
    return p;
  }
}

const SEED_PRODUCTS: Product[] = [
  { sku: "LW-BOB-12", title: "Brazilian Bob Wig 12 inch", priceCents: 189_900, stock: 7, reorderPoint: 5, category: "wigs" },
  { sku: "LW-KNK-18", title: "Kinky Curly Wig 18 inch", priceCents: 249_900, stock: 2, reorderPoint: 4, category: "wigs" },
  { sku: "LW-BDW-22", title: "Body Wave Bundle 22 inch", priceCents: 129_900, stock: 0, reorderPoint: 6, category: "bundles" },
  { sku: "LW-FRT-13", title: "13x4 HD Lace Frontal", priceCents: 159_900, stock: 12, reorderPoint: 3, category: "frontals" },
];

const SEED_ORDERS: Order[] = [
  { id: "#1042", customerName: "Thandi Mokoena", customerEmail: "thandi@example.com", customerPhone: "+27821234567", status: "shipped", totalCents: 189_900, items: [{ sku: "LW-BOB-12", qty: 1 }], placedAt: "2026-11-10T09:12:00Z" },
];
