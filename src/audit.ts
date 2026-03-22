import { createHash } from "node:crypto";
import { canonical } from "./confirm.js";

export interface AuditRecord {
  at: string;
  principal: string;
  tool: string;
  argsHash: string; // hash, not raw args: the audit log must not become a PII store
  outcome: "ok" | "denied" | "error" | "preview";
  detail?: string;
}

export class AuditLog {
  readonly records: AuditRecord[] = [];
  constructor(private readonly sink: (r: AuditRecord) => void = () => {}) {}

  record(r: Omit<AuditRecord, "at" | "argsHash"> & { args: unknown }): void {
    const { args, ...rest } = r;
    const rec: AuditRecord = { at: new Date().toISOString(), argsHash: createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16), ...rest };
    this.records.push(rec);
    this.sink(rec);
  }
}

/** Fixed-window per-principal limiter (swap for Redis in multi-instance deployments). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    return ++w.count <= this.limit;
  }
}
