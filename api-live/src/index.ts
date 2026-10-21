import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { Server } from "socket.io";
import { createServer } from "http";

import { handleAssistantLiveConnection } from "@features/assistant/assistant-live.service";
import { handleScannerLiveConnection } from "@features/medication-scanner/scanner-live.service";
import { socketAuthMiddleware } from "@middlewares/socket-auth.middleware";
import { globalErrorHandler, notFoundHandler } from "@middlewares/error-handler.middleware";
import medicalAlertRoutes from "@features/medical-alert/medical-alert.routes";
import prescriptionRoutes from "@features/assistant/prescription.routes";
import { logger } from "@/lib/logger";

dotenv.config();

const app = express();
const server = createServer(app);

// ── Express global middleware ─────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

// ── Socket.IO setup ──────────────────────────
const io = new Server(server);

// Real-time voice medical assistant (Gemini Live — native audio + tools)
io.of("/assistant-live").use(socketAuthMiddleware);
io.of("/assistant-live").on("connection", handleAssistantLiveConnection);

// Real-time medication-label scanner (Gemini Live — video in, guidance out)
io.of("/scanner-live").use(socketAuthMiddleware);
io.of("/scanner-live").on("connection", handleScannerLiveConnection);

// ── Express routes ────────────────────────────
// Medical alert is a plain REST/SMS feature — unchanged from the base API.
app.use("/api/medical-alert", medicalAlertRoutes);

// Prescription management REST API (backs the caregiver portal).
app.use("/api/prescriptions", prescriptionRoutes);

// Caregiver demo portal — static single-page app living at <project>/portal.
// Resolved from the working directory (same convention as firebase.ts), which
// is the project root in both `npm run dev` and `npm start`.
const PORTAL_DIR = path.resolve(process.cwd(), "portal");
app.use("/portal", express.static(PORTAL_DIR));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "live" });
});

// ── Express error handlers (must be AFTER all routes) ──
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ── Process-level error handlers ─────────────

process.on("uncaughtException", (err: Error) => {
  logger.fatal("UNCAUGHT EXCEPTION! Shutting down...", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal("UNHANDLED REJECTION! Shutting down...", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => logger.info(`Live server running on ${PORT}`));
