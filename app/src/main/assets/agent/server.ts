import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";

const PORT = Number(process.env.PORT) || 8765;
const WWW_DIR = join(process.cwd(), "www");
const DB_PATH = join(process.cwd(), "pidroid.sqlite");

// Initialize SQLite database
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS agent_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

console.log(`[pidroid] Agent runtime initialized. SQLite DB at: ${DB_PATH}`);

// Active WebSocket clients (for live agent events and UI hot-reloading)
const clients = new Set<any>();

function broadcast(event: string, payload: any) {
  const message = JSON.stringify({ event, payload, timestamp: Date.now() });
  for (const ws of clients) {
    try {
      ws.send(message);
    } catch {
      clients.delete(ws);
    }
  }
}

// Watch www directory for direct agent modifications
if (existsSync(WWW_DIR)) {
  try {
    const { watch } = await import("fs");
    watch(WWW_DIR, { recursive: true }, (eventType, filename) => {
      console.log(`[pidroid] Detected UI modification (${eventType}): ${filename}`);
      broadcast("ui_reload", { filename });
    });
  } catch (err) {
    console.warn("[pidroid] File watcher warning:", err);
  }
}

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for real-time agent updates and UI hot-reload
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API Routes
    if (url.pathname === "/api/status") {
      const messageCount = db.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      return Response.json({
        status: "online",
        runtime: "bun",
        version: Bun.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: DB_PATH,
        messageCount: messageCount?.count ?? 0,
      });
    }

    if (url.pathname === "/api/messages" && req.method === "GET") {
      const messages = db.query("SELECT * FROM messages ORDER BY id ASC").all();
      return Response.json({ messages });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return req.json().then(async (body: { message?: string }) => {
        const text = body.message?.trim();
        if (!text) {
          return Response.json({ error: "Message is required" }, { status: 400 });
        }

        // Store user message
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("user", text);
        broadcast("message", { role: "user", content: text });

        // Generate response (Autonomous loop / Durable agent hook)
        const replyText = `[Autonomous Agent Echo] Received: "${text}". Ready to modify UI or execute tools!`;
        db.query("INSERT INTO messages (role, content) VALUES (?, ?)").run("assistant", replyText);
        broadcast("message", { role: "assistant", content: replyText });

        return Response.json({ success: true, reply: replyText });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/write" && req.method === "POST") {
      return req.json().then((body: { path: string; content: string }) => {
        if (!body.path || body.content === undefined) {
          return Response.json({ error: "Path and content are required" }, { status: 400 });
        }
        const targetPath = join(process.cwd(), body.path);
        writeFileSync(targetPath, body.content, "utf-8");
        broadcast("file_modified", { path: body.path });
        return Response.json({ success: true, path: targetPath });
      }).catch(err => Response.json({ error: String(err) }, { status: 500 }));
    }

    if (url.pathname === "/api/files/list" && req.method === "GET") {
      const relPath = url.searchParams.get("dir") || "www";
      const targetDir = join(process.cwd(), relPath);
      if (!existsSync(targetDir)) return Response.json({ files: [] });

      const files = readdirSync(targetDir).map(file => {
        const st = statSync(join(targetDir, file));
        return { name: file, isDirectory: st.isDirectory(), size: st.size };
      });
      return Response.json({ dir: relPath, files });
    }

    // Static frontend files from www/
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(WWW_DIR, filePath);

    if (existsSync(fullPath)) {
      const file = Bun.file(fullPath);
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ event: "connected", payload: { version: Bun.version, port: PORT } }));
    },
    message(ws, message) {
      try {
        const data = JSON.parse(String(message));
        if (data.type === "ping") {
          ws.send(JSON.stringify({ event: "pong" }));
        }
      } catch {}
    },
    close(ws) {
      clients.delete(ws);
    }
  }
});

console.log(`[pidroid] HTTP & WebSocket Server running at http://127.0.0.1:${server.port}`);
