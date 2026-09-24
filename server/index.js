/**
 * server/index.js — Express + WebSocket Server Entry Point
 * 
 * FIRST PRINCIPLES:
 * This is the "glue" between:
 *   1. React Dashboard (frontend, port 5173)
 *   2. LangGraph Pipeline (backend logic)
 *   3. Docker Sandbox (containers managed by pipeline)
 * 
 * It provides:
 *   - REST API on /api/* for CRUD operations
 *   - WebSocket on /ws for real-time streaming
 *   - CORS for frontend dev server
 * 
 * STARTUP SEQUENCE:
 *   1. Load env vars
 *   2. Initialize Gemini
 *   3. Start Express + attach WebSocket
 *   4. Ready for frontend connections
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

import { initGemini } from "../src/utils/gemini.js";
import projectRoutes from "./routes/projects.js";
import { initWebSocket } from "./ws/handler.js";

const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_ACCESS_PASSWORD = process.env.DEMO_ACCESS_PASSWORD || "";

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

import crypto from "crypto";

const sessionCookieValue = DEMO_ACCESS_PASSWORD
  ? crypto.createHmac("sha256", DEMO_ACCESS_PASSWORD).update("aidev-demo-session").digest("hex")
  : "";

function isDemoAuthenticated(req) {
  if (!DEMO_ACCESS_PASSWORD) return process.env.NODE_ENV !== "production";
  const cookieHeader = req.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("aidev_demo="));
  return !!cookie && safeEqual(decodeURIComponent(cookie.slice("aidev_demo=".length)), sessionCookieValue);
}

// ─── Express App ─────────────────────────────────────────────

const app = express();

// Middleware
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "10mb" }));

const loginAttempts = new Map();
app.post("/api/auth/login", (req, res) => {
  const now = Date.now();
  const key = req.ip;
  const attempts = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempts.resetAt <= now) {
    attempts.count = 0;
    attempts.resetAt = now + 15 * 60 * 1000;
  }
  if (attempts.count >= 10) return res.status(429).json({ error: "Too many attempts. Try again later." });
  attempts.count++;
  loginAttempts.set(key, attempts);

  if (!DEMO_ACCESS_PASSWORD) {
    if (process.env.NODE_ENV === "production") return res.status(503).json({ error: "Demo access is not configured." });
    return res.json({ authenticated: true });
  }
  if (typeof req.body?.password !== "string" || !safeEqual(req.body.password, DEMO_ACCESS_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect demo password." });
  }
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `aidev_demo=${sessionCookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
  res.json({ authenticated: true });
});

app.get("/api/auth/status", (req, res) => {
  res.json({ required: !!DEMO_ACCESS_PASSWORD && process.env.NODE_ENV === "production", authenticated: isDemoAuthenticated(req) });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "aidev_demo=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
  res.json({ authenticated: false });
});

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    console.log(`   ${req.method} ${req.path}`);
  }
  next();
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    gemini: !!process.env.GEMINI_API_KEY,
    timestamp: Date.now(),
  });
});

app.use("/api/projects", (req, res, next) => {
  if (!isDemoAuthenticated(req)) return res.status(401).json({ error: "Demo sign-in required." });
  next();
});

// Project routes
app.use("/api/projects", projectRoutes);

app.use(express.static(path.join(APP_ROOT, "dashboard", "dist")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/ws") return next();
  res.sendFile(path.join(APP_ROOT, "dashboard", "dist", "index.html"));
});

// ─── HTTP + WebSocket Server ─────────────────────────────────

const server = createServer(app);

// WebSocket server — shares the same HTTP server
const wss = new WebSocketServer({
  server,
  path: "/ws",
});

wss.on("connection", (ws, req) => {
  if (!isDemoAuthenticated(req)) {
    ws.close(1008, "Demo sign-in required");
  }
});

initWebSocket(wss);

// ─── Startup ─────────────────────────────────────────────────

async function start() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║                                                          ║");
  console.log("║   🤖  AI DEV TEAM — Mission Control Server              ║");
  console.log("║   Phase 7: Web Dashboard                                 ║");
  console.log("║                                                          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");

  // 1. Initialize Gemini
  try {
    initGemini(process.env.GEMINI_API_KEY);
    console.log(`   ✅ Gemini initialized (model: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"})`);
  } catch (error) {
    console.warn(`   ⚠️  Gemini not available: ${error.message}`);
    console.warn("      Set GEMINI_API_KEY in .env for full functionality");
  }

  // 2. Start server
  server.listen(PORT, () => {
    console.log(`   ✅ REST API:    http://localhost:${PORT}/api`);
    console.log(`   ✅ WebSocket:   ws://localhost:${PORT}/ws`);
    console.log(`   ✅ Frontend:    ${FRONTEND_URL}`);
    console.log("");
    console.log("   Waiting for dashboard connections...");
    console.log("");
  });
}

start().catch((error) => {
  console.error("   ❌ Server failed to start:", error);
  process.exit(1);
});
