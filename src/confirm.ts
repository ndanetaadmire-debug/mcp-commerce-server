import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Preview-then-confirm for state-changing tools.
 *
 * The first call (no token) validates and returns a preview plus a short-lived token that is an HMAC
 * over (principal, tool, canonical args, expiry). Executing requires the same principal to send the
 * same args with that token. A model can't skip the preview, can't reuse a token for different args,
 * and an approval can't be replayed: tokens are single-use and expire.
 */
export class ConfirmationService {
  private readonly used = new Set<string>();

  constructor(private readonly secret: Buffer = randomBytes(32), private readonly ttlMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  issue(principalId: string, tool: string, args: Record<string, unknown>): { token: string; expiresAt: string } {
    const exp = this.now() + this.ttlMs;
    const sig = this.sign(principalId, tool, args, exp);
    return { token: `${exp}.${sig}`, expiresAt: new Date(exp).toISOString() };
  }

  verify(token: string, principalId: string, tool: string, args: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
    const [expStr, sig] = token.split(".");
    const exp = Number(expStr);
    if (!sig || !Number.isFinite(exp)) return { ok: false, reason: "malformed confirmation token" };
    if (this.now() > exp) return { ok: false, reason: "confirmation token expired; request a new preview" };
    const expected = Buffer.from(this.sign(principalId, tool, args, exp), "hex");
    const given = Buffer.from(sig, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "confirmation token does not match these arguments" };
    }
    if (this.used.has(token)) return { ok: false, reason: "confirmation token already used" };
    this.used.add(token);
    return { ok: true };
  }

  private sign(principalId: string, tool: string, args: Record<string, unknown>, exp: number): string {
    return createHmac("sha256", this.secret).update(`${principalId}\n${tool}\n${canonical(args)}\n${exp}`).digest("hex");
  }
}

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
