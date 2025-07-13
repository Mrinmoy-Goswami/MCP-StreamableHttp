import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";



const app = express();

const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "mcp-session-id",
    "X-Requested-With",
    "Accept",
    "Origin"
  ],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Type the transports object properly
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle preflight requests explicitly for /mcp endpoint
app.options("/mcp", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, X-Requested-With, Accept, Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

app.post('/mcp', async (req, res) => {
  try {
    // Add CORS headers explicitly
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else {
      transport = new StreamableHTTPServerTransport({
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          console.log(`Session initialized: ${sid}`);
          // Set session ID in response header
          res.header('mcp-session-id', sid);
        }
      });

      const server = new McpServer({
        name: "echo-server",
        version: "1.0.0"
      });

      // Register the Echo tool with proper handler
      server.registerTool(
        "echo",
        {
          title: "Echo Tool",
          description: "Echoes back whatever the user says",
          inputSchema: {
            message: z.string()
          }
        },
        async ({ message }) => ({
          content: [{ type: "text", text: message }]
        })
      );
      
      await server.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          console.log(`Session closed: ${transport.sessionId}`);
          delete transports[transport.sessionId];
        }
      };
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error in POST /mcp:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error'
      },
      id: null
    });
  }
});

app.get('/mcp', async (req, res) => {
  try {
    // Add CORS headers explicitly
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports[sessionId];
    
    if (!transport) {
      return res.status(400).json({ error: "Missing or invalid session" });
    }
    
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error in GET /mcp:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete('/mcp', async (req, res) => {
  try {
    // Add CORS headers explicitly
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports[sessionId];
    
    if (!transport) {
      return res.status(400).json({ error: "Missing or invalid session" });
    }
    
    await transport.handleRequest(req, res);
    
    // Clean up the session after DELETE
    delete transports[sessionId];
    console.log(`Session deleted: ${sessionId}`);
  } catch (error) {
    console.error('Error in DELETE /mcp:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeSessions: Object.keys(transports).length,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`MCP Echo Server running at http://localhost:${PORT}`);
  console.log('CORS enabled for development origins');
  console.log('Accepted origins:', corsOptions.origin);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  Object.values(transports).forEach(transport => {
    transport.close?.();
  });
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  Object.values(transports).forEach(transport => {
    transport.close?.();
  });
  process.exit(0);
});