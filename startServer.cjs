#!/usr/bin/env node
/**
 * Backend server entry point
 * This file uses CommonJS (require/module.exports) for the Express backend
 * even though the frontend package.json specifies "type": "module"
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Security & middleware ────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:5173",
    "http://localhost:4000",
    // Add your deployed frontend URL here
  ],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // for ToyyibPay callbacks

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use("/api/", limiter);
app.use("/api/payment/", strictLimiter);

// ─── Routes ──────────────────────────────────────────────────
const authRoutes     = require("./server/routes/auth");
const productRoutes  = require("./server/routes/products");
const orderRoutes    = require("./server/routes/orders");
const paymentRoutes  = require("./server/routes/payment");
const affiliateRoutes = require("./server/routes/affiliates");

app.use("/api/auth",       authRoutes);
app.use("/api/products",   productRoutes);
app.use("/api/orders",     orderRoutes);
app.use("/api/payment",    paymentRoutes);
app.use("/api/affiliates", affiliateRoutes);

// Promo validation & settings also in auth.js but mounted at /api
app.use("/api",            authRoutes);

// ─── Health check ─────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));

// ─── 404 handler ──────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Route not found" }));

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n🌙 Biskut Raya API running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   DB: ${process.env.DATABASE_URL ? "✅ Neon configured" : "❌ DATABASE_URL missing"}`);
  console.log(`   Firebase: ${process.env.FIREBASE_PROJECT_ID ? "✅ Configured" : "❌ FIREBASE_PROJECT_ID missing"}`);
  console.log(`   ToyyibPay: ${process.env.TOYYIBPAY_SECRET_KEY ? "✅ Configured" : "⚠️  Not configured (payment disabled)"}\n`);
});

module.exports = app;
