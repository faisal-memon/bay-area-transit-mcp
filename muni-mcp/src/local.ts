import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js";

const port = Number(process.env.PORT || 8787);
const apiKey = process.env.API_511_KEY;
if (!apiKey) throw new Error("API_511_KEY is required in local mode");

const httpServer = createHttpServer(async (req, res) => {
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "muni-mcp-server", mode: "local", mcp_endpoint: "/mcp" }));
    return;
  }
  try {
    const body = await new Promise<string>((resolve, reject) => {
      let value = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { value += chunk; });
      req.on("end", () => resolve(value));
      req.on("error", reject);
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await createServer(apiKey).connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Muni MCP local server listening on ${port}`);
});
