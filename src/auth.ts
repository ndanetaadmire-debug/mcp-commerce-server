import { createHash, timingSafeEqual } from "node:crypto";

export type Scope = "catalog:read" | "orders:read" | "customers:pii" | "inventory:read" | "inventory:write" | "discounts:write";

export interface Principal {
  id: string;
  scopes: ReadonlySet<Scope>;
}

export class AuthError extends Error {}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * API keys are stored only as SHA-256 hashes and compared in constant time.
 * Each key maps to a principal with explicit scopes: least privilege per assistant/integration.
 * Format: MCP_KEYS="<id>:<sha256hex>:<scope,scope>;<id>:..."
 */
export class KeyRing {
  private readonly entries: Array<{ id: string; hash: Buffer; scopes: Set<Scope> }>;

  constructor(spec: string) {
    this.entries = spec
      .split(";")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => {
        // Scope names contain ":" (e.g. inventory:read), so only the first two colons are separators.
        const [id, hex, ...rest] = e.split(":");
        const scopes = rest.join(":");
        if (!id || !hex || hex.length !== 64) throw new Error(`Malformed key entry for "${id ?? "?"}"`);
        return { id, hash: Buffer.from(hex, "hex"), scopes: new Set((scopes ?? "").split(",").filter(Boolean) as Scope[]) };
      });
  }

  static hash(key: string): string {
    return sha256(key).toString("hex");
  }

  authenticate(key: string | undefined): Principal {
    if (!key) throw new AuthError("missing API key");
    const h = sha256(key);
    let found: Principal | undefined;
    for (const e of this.entries) if (timingSafeEqual(h, e.hash)) found = { id: e.id, scopes: e.scopes }; // no early exit
    if (!found) throw new AuthError("invalid API key");
    return found;
  }
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.has(scope)) throw new AuthError(`missing scope ${scope}`);
}
