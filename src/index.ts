import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();

const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "mcp-session-id",
    "X-Requested-With",
    "Accept",
    "Origin",
  ],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeSessions: Object.keys(transports).length,
    timestamp: new Date().toISOString(),
  });
});

// Preflight for /mcp
app.options("/mcp", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, X-Requested-With, Accept, Origin"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

// POST /mcp — JSON-RPC entry point
app.post("/mcp", async (req, res) => {
  console.log('=== POST /mcp REQUEST ===');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Set CORS headers
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");

    const sessionId = req.get("mcp-session-id");
    console.log('Session ID from request:', sessionId);

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      console.log('Using existing transport for session:', sessionId);
      transport = transports[sessionId];
    } else {
      console.log('Creating new transport...');
      transport = createMcpSession((newSessionId) => {
        console.log('New session created:', newSessionId);
        transports[newSessionId] = transport;
        res.setHeader("mcp-session-id", newSessionId);
      });
    }

    console.log('Calling transport.handleRequest...');
    
    // Let the transport handle the request completely
    await transport.handleRequest(req, res, req.body);
    
    console.log('Transport handled request successfully');
    
  } catch (error) {
    console.error("❌ Error in POST /mcp:", error);
    
    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { 
          code: -32603, 
          message: "Internal server error",
          data: error instanceof Error ? error.message : String(error)
        },
        id: null,
      });
    }
  }
});

// GET /mcp — open SSE stream
app.get("/mcp", async (req, res) => {
  try {
    const sessionId = req.get("mcp-session-id");
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).json({ error: "Missing or invalid session" });
    }

    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    await transports[sessionId].handleRequest(req, res);
  } catch (error) {
    console.error("❌ Error in GET /mcp:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /mcp — end session
app.delete("/mcp", async (req, res) => {
  try {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");

    const sessionId = req.get("mcp-session-id");
    const transport = sessionId && transports[sessionId];

    if (!transport) {
      return res.status(400).json({ error: "Missing or invalid session" });
    }

    await transport.handleRequest(req, res);

    transport.close?.();
    delete transports[sessionId];
    console.log(`🗑️ Session deleted: ${sessionId}`);
  } catch (error) {
    console.error("❌ Error in DELETE /mcp:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// MCP Session Factory
function createMcpSession(onSessionInit: (sid: string) => void): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    onsessioninitialized: onSessionInit,
  });

  const server = new McpServer({
    name: "echo-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo Tool",
      description: "Echoes back the message sent",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to echo back"
          }
        },
        required: ["message"]
      }
    },
    async (args) => {
      console.log("📨 Echo tool received args:", args);
      const message = args.message || "No message provided";
      console.log("📨 Echo tool message:", message);
      
      return {
        content: [{ type: "text", text: message }],
      };
    }
  );

  server.connect(transport);

  transport.onclose = () => {
    if (transport.sessionId) {
      console.log(`🔴 Session closed: ${transport.sessionId}`);
      delete transports[transport.sessionId];
    }
  };

  return transport;
}

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 MCP Echo Server running at http://localhost:${PORT}`);
  console.log("🎯 CORS origins allowed:", corsOptions.origin);
});

// Graceful shutdown
["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, () => {
    console.log(`⚠️ Shutting down... (${signal})`);
    Object.values(transports).forEach((t) => t.close?.());
    process.exit(0);
  });
});