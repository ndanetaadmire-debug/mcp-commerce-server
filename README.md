# mcp-commerce-server

[![CI](https://github.com/ndanetaadmire-debug/mcp-commerce-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ndanetaadmire-debug/mcp-commerce-server/actions/workflows/ci.yml)
![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-1.x-6f42c1)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

**A Model Context Protocol server that lets AI assistants (Claude, ChatGPT, Cursor, your own agents) work with an online store, without being able to do damage.**

MCP makes it easy to hand a model a set of tools. The hard part is deciding what happens when the model is confused, over-eager or being manipulated. This server is built around that question.

## Safety model

| Control | How |
|---|---|
| **Least-privilege keys** | Each API key maps to a principal with explicit scopes (`catalog:read`, `orders:read`, `customers:pii`, `inventory:write`, …). Keys are stored only as SHA-256 hashes and compared in constant time. |
| **PII minimisation** | `get_order` masks customer email and phone (`th**************om`) unless the key holds `customers:pii`. A support bot doesn't need the full address to say "it shipped". |
| **Preview-then-confirm writes** | `adjust_inventory` and `create_discount` never act on the first call. They return a preview and a `confirm_token`: an **HMAC over (principal, tool, exact arguments, expiry)**. Executing requires the same principal, the same arguments and an unexpired, unused token. |
| **Business limits in code** | Max stock change per call, max discount %, max validity. Bigger changes go to a human in the back office. |
| **Tool annotations** | `readOnlyHint`, `destructiveHint` and `idempotentHint` let MCP clients decide when to ask the user. |
| **Rate limits** | Per principal. |
| **Audit log** | Every call: principal, tool, outcome (ok / preview / denied / error) and a **hash** of the arguments, so the audit trail doesn't become a second copy of customer data. |

A confused or prompt-injected model therefore can't:
- skip the human (no token without a preview),
- show the user one change and execute another (the token is bound to the exact arguments),
- replay an old approval (tokens are single-use and expire after 5 minutes), or
- reach data its key isn't scoped for.

## Tools, resources, prompts

| Name | Kind | Scope |
|---|---|---|
| `search_products` | tool · read-only | `catalog:read` |
| `get_order` | tool · read-only (PII masked by default) | `orders:read` (+ `customers:pii`) |
| `list_low_stock` | tool · read-only | `inventory:read` |
| `adjust_inventory` | tool · destructive · preview/confirm | `inventory:write` |
| `create_discount` | tool · idempotent · preview/confirm | `discounts:write` |
| `commerce://products/{sku}` | resource | `catalog:read` |
| `commerce://policies/returns` | resource | — |
| `restock_review` | prompt | — |

Read tools return both human-readable text and `structuredContent` for programmatic clients.

## Run it

**Locally with Claude Desktop (stdio):**

```bash
npm ci && npm run build
node -e "console.log(require('crypto').createHash('sha256').update('sk_local_demo').digest('hex'))"
```

```json
{
  "mcpServers": {
    "commerce": {
      "command": "node",
      "args": ["/path/to/mcp-commerce-server/dist/stdio.js"],
      "env": {
        "MCP_KEYS": "desktop:<sha256-from-above>:catalog:read,orders:read,inventory:read,inventory:write",
        "MCP_API_KEY": "sk_local_demo"
      }
    }
  }
}
```

**Remotely (Streamable HTTP, stateless):** `MCP_KEYS=... npm run http`. Clients send `Authorization: Bearer <key>` to `POST /mcp`. Each request authenticates independently; the store, confirmation service and audit log are shared.

Audit records go to stderr in stdio mode, because stdout is the protocol channel.

## Tests

The tests connect a real MCP `Client` to the server over the SDK's in-memory transport, the same protocol path a production client uses. They cover discovery and annotations, structured output, PII masking per scope, scope denials (audited without raw arguments), schema rejection, rate limiting, and the full preview → tamper → confirm → replay cycle. They also caught a real bug: scope names contain `:`, which the key parser originally split on.

```bash
npm ci
npm run ci      # typecheck + tests + build
```

The store is an in-memory adapter behind a small interface. Point it at Shopify's Admin API (see [commerce-ops-agent](https://github.com/ndanetaadmire-debug/commerce-ops-agent)) or any backend.

---

Built by **[Admire T. Ndaneta](https://admire-portfolio.vercel.app)**. MIT licensed.
