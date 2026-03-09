// backend/routes/auth.js
// User sync, role management, promo code validation

const router = require("express").Router();
const { query } = require("../lib/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { setCustomClaims } = require("../lib/firebase");

// ─── POST /api/auth/sync ────────────────────────────────────
// Called after Firebase login to ensure user exists in our DB
// Also returns the user's role so frontend knows permissions
router.post("/sync", requireAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;

    // Upsert user
    const { rows } = await query(
      `INSERT INTO users (firebase_uid, email, full_name, phone, role)
       VALUES ($1, $2, $3, $4, 'customer')
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = EXCLUDED.email,
         full_name = COALESCE($3, users.full_name),
         phone = COALESCE($4, users.phone)
       RETURNING *`,
      [req.firebaseUser.uid, req.firebaseUser.email, full_name || req.firebaseUser.name || "", phone || ""]
    );

    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/auth/me ───────────────────────────────────────
// Current user profile
router.get("/me", requireAuth, async (req, res) => {
  try {
    let affiliateData = null;
    if (req.user.role === "affiliate") {
      const { rows } = await query(
        "SELECT * FROM affiliates WHERE user_id = $1",
        [req.user.id]
      );
      affiliateData = rows[0] || null;
    }
    res.json({ user: req.user, affiliate: affiliateData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/auth/me ───────────────────────────────────────
// Update own profile
router.put("/me", requireAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    const { rows } = await query(
      "UPDATE users SET full_name = COALESCE($1, full_name), phone = COALESCE($2, phone) WHERE id = $3 RETURNING *",
      [full_name, phone, req.user.id]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/auth/set-admin ───────────────────────────────
// Promote a user to admin (only callable by existing admin or initial setup)
// Protect this endpoint carefully in production!
router.post("/set-admin", requireAdmin, async (req, res) => {
  try {
    const { firebase_uid } = req.body;
    if (!firebase_uid) return res.status(400).json({ error: "firebase_uid required" });

    await setCustomClaims(firebase_uid, { role: "admin" });
    const { rows } = await query(
      "UPDATE users SET role = 'admin' WHERE firebase_uid = $1 RETURNING *",
      [firebase_uid]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ user: rows[0], message: "Admin role granted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/promo/validate ───────────────────────────────
// Public: validate a promo code and return discount info
router.post("/promo/validate", async (req, res) => {
  try {
    const { promo_code } = req.body;
    if (!promo_code) return res.status(400).json({ error: "promo_code required" });

    const { rows } = await query(
      `SELECT a.promo_code, a.promo_discount_pct, a.affiliate_code,
              u.full_name AS affiliate_name
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE UPPER(a.promo_code) = UPPER($1) AND a.status = 'active'`,
      [promo_code]
    );

    if (!rows.length) return res.status(404).json({ valid: false, message: "Kod promo tidak sah" });

    res.json({
      valid: true,
      promo_code: rows[0].promo_code,
      discount_pct: rows[0].promo_discount_pct,
      affiliate_name: rows[0].affiliate_name,
      message: `Diskaun ${rows[0].promo_discount_pct}% diaktifkan!`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/settings/shipping ─────────────────────────────
// Public: get current shipping rates
router.get("/settings/shipping", async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM shipping_settings LIMIT 1");
    res.json({ shipping: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/settings/shipping ─────────────────────────────
// Admin: update shipping rates
router.put("/settings/shipping", requireAdmin, async (req, res) => {
  try {
    const { standard_rate, express_rate, free_shipping_threshold } = req.body;
    const { rows } = await query(
      `UPDATE shipping_settings SET
         standard_rate = COALESCE($1, standard_rate),
         express_rate = COALESCE($2, express_rate),
         free_shipping_threshold = COALESCE($3, free_shipping_threshold),
         updated_at = NOW()
       WHERE id = 1 RETURNING *`,
      [standard_rate, express_rate, free_shipping_threshold]
    );
    res.json({ shipping: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/settings/site ──────────────────────────────────
// Public: order deadline, site config
router.get("/settings/site", async (req, res) => {
  try {
    const { rows } = await query("SELECT key, value FROM site_settings");
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/settings/site ──────────────────────────────────
// Admin: update a site setting by key
router.put("/settings/site", requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "key required" });
    await query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
    res.json({ updated: true, key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;