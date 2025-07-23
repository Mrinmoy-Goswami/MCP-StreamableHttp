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

// Global session counter for unique IDs
let sessionCounter = 0;

// POST /mcp — JSON-RPC entry point
app.post("/mcp", async (req, res) => {
  console.log('=== POST /mcp REQUEST ===');
  console.log('Method:', req.body?.method);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  try {
    // Set CORS headers
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle tool calls manually to bypass validation issues
    if (req.body?.method === "tools/call" && req.body?.params?.name === "echo") {
      console.log("🔧 Handling echo tool call manually");
      
      const message = req.body.params.arguments?.message || "No message provided";
      console.log("🔧 Extracted message:", message);
      
      const response = {
        jsonrpc: "2.0",
        id: req.body.id,
        result: {
          content: [{ type: "text", text: message }]
        }
      };
      
      console.log("🔧 Sending manual response:", JSON.stringify(response, null, 2));
      
      res.setHeader("Content-Type", "application/json");
      res.json(response);
      return;
    }

    const sessionId = req.get("mcp-session-id");
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      console.log('✅ Using existing session:', sessionId);
      transport = transports[sessionId];
    } else {
      console.log('🆕 Creating new session...');
      
      // Create new session ID
      const newSessionId = `session-${++sessionCounter}-${Date.now()}`;
      
      transport = new StreamableHTTPServerTransport({
        onsessioninitialized: (sid) => {
          console.log('🎯 Session initialized with ID:', sid);
        },
      });

      const server = new McpServer({
        name: "echo-server",
        version: "1.0.0",
      });

      // Don't register any tools to avoid validation issues
      // We'll handle tool calls manually above
      
      server.connect(transport);
      
      // Store transport with our session ID
      transports[newSessionId] = transport;
      res.setHeader("mcp-session-id", newSessionId);
      
      console.log(`✅ New session created: ${newSessionId}`);
    }

    // Let the transport handle non-tool requests (initialize, etc.)
    await transport.handleRequest(req, res, req.body);
    
  } catch (error) {
    console.error("❌ Error in POST /mcp:", error);
    console.error("❌ Error stack:", error instanceof Error ? error.stack : 'No stack');
    
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { 
          code: -32603, 
          message: "Internal server error",
          data: error instanceof Error ? error.message : String(error)
        },
        id: req.body?.id || null,
      });
    }
  }
});

// GET /mcp — SSE stream
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