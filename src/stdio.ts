#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog } from "./audit.js";
import { KeyRing } from "./auth.js";
import { buildServer } from "./server.js";
import { CommerceStore } from "./store.js";

// Local use (e.g. Claude Desktop): the key in MCP_API_KEY identifies which principal and scopes this process runs as.
const ring = new KeyRing(process.env.MCP_KEYS ?? "");
const principal = ring.authenticate(process.env.MCP_API_KEY);
const server = buildServer({
  store: new CommerceStore(),
  principal,
  audit: new AuditLog((r) => process.stderr.write(`${JSON.stringify(r)}\n`)), // stdout is the protocol channel
});
await server.connect(new StdioServerTransport());
