import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuditLog } from "./audit.js";
import { AuthError, KeyRing } from "./auth.js";
import { ConfirmationService } from "./confirm.js";
import { buildServer } from "./server.js";
import { CommerceStore } from "./store.js";

// Remote use: stateless Streamable HTTP. Each request authenticates its Bearer key; the store,
// confirmation service and audit log are shared across requests.
const ring = new KeyRing(process.env.MCP_KEYS ?? "");
const store = new CommerceStore();
const confirmations = new ConfirmationService();
const audit = new AuditLog((r) => console.log(JSON.stringify(r)));

createServer(async (req, res) => {
  if (req.url !== "/mcp") return void res.writeHead(404).end();
  try {
    const principal = ring.authenticate(req.headers.authorization?.replace(/^Bearer\s+/i, ""));
    const server = buildServer({ store, principal, confirmations, audit });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close().then(() => server.close()));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    res.writeHead(err instanceof AuthError ? 401 : 500, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
}).listen(Number(process.env.PORT ?? 3333));
