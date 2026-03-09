// backend/routes/affiliates.js

const router = require("express").Router();
const { query } = require("../lib/db");
const { requireAuth, requireAdmin, requireAffiliate } = require("../middleware/auth");
const { setCustomClaims } = require("../lib/firebase");

// POST /api/affiliates/register
router.post("/register", requireAuth, async (req, res) => {
  try {
    const { promo_code, desired_code } = req.body;
    if (!promo_code) return res.status(400).json({ error: "promo_code is required" });

    const { rows: exist } = await query(
      "SELECT id FROM affiliates WHERE UPPER(promo_code) = UPPER($1)",
      [promo_code]
    );
    if (exist.length) return res.status(400).json({ error: "Promo code already taken" });

    const { rows: settings } = await query(
      "SELECT value FROM site_settings WHERE key = 'default_commission_pct'"
    );
    const defaultCommission = settings[0]?.value || "10";

    // BUG FIX 15: COUNT(*)-based sequence has the same race condition as orders.
    // Also, if desired_code is provided, we should check it's not already taken.
    if (desired_code) {
      const { rows: codeExist } = await query(
        "SELECT id FROM affiliates WHERE affiliate_code = $1",
        [desired_code]
      );
      if (codeExist.length) return res.status(400).json({ error: "Affiliate code already taken" });
    }

    const { rows: countRows } = await query("SELECT COUNT(*) FROM affiliates");
    const seq = String(Number(countRows[0].count) + 1).padStart(3, "0");
    const affiliateCode = desired_code || `AFF${seq}`;

    const { rows } = await query(
      `INSERT INTO affiliates
         (user_id, affiliate_code, promo_code, commission_type, commission_value, status)
       VALUES ($1,$2,$3,'percent',$4,'pending')
       RETURNING *`,
      [req.user.id, affiliateCode, promo_code.toUpperCase(), defaultCommission]
    );

    res.status(201).json({ affiliate: rows[0], message: "Application submitted. Pending admin approval." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/affiliates/track
// BUG FIX 16: Route comment said "GET /api/affiliates/track" but it was
// correctly defined as POST. Comment fixed to avoid confusion.
// Also: this must be declared before /:id routes to avoid "track" being
// matched as an affiliate ID.
router.post("/track", async (req, res) => {
  try {
    const { affiliate_code } = req.body;
    if (!affiliate_code) return res.status(400).json({ error: "affiliate_code required" });

    const { rows } = await query(
      "SELECT id FROM affiliates WHERE affiliate_code = $1 AND status = 'active'",
      [affiliate_code]
    );
    if (!rows.length) return res.status(404).json({ error: "Affiliate not found" });

    const affiliateId = rows[0].id;
    await query(
      "INSERT INTO affiliate_clicks (affiliate_id, ip_address, user_agent) VALUES ($1,$2,$3)",
      [affiliateId, req.ip, req.headers["user-agent"] || ""]
    );
    await query(
      "UPDATE affiliates SET total_clicks = total_clicks + 1 WHERE id = $1",
      [affiliateId]
    );

    res.json({ tracked: true, affiliate_id: affiliateId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/affiliates/me — must be before /:id
// BUG FIX 17: Same route-ordering issue. "/me" and "/leaderboard" must be
// declared before "/:id" or Express will try to look them up as UUIDs.
router.get("/me", requireAffiliate, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.*,
              u.email, u.full_name, u.phone,
              (a.total_earned - a.total_paid) AS pending_payout
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Affiliate record not found" });

    const aff = rows[0];

    const { rows: commissions } = await query(
      `SELECT c.*, o.order_number, o.created_at AS order_date
       FROM commissions c
       JOIN orders o ON o.id = c.order_id
       WHERE c.affiliate_id = $1
       ORDER BY c.created_at DESC LIMIT 10`,
      [aff.id]
    );

    const { rows: clicks } = await query(
      `SELECT DATE(clicked_at) AS date, COUNT(*) AS clicks
       FROM affiliate_clicks
       WHERE affiliate_id = $1 AND clicked_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(clicked_at)
       ORDER BY date`,
      [aff.id]
    );

    res.json({ affiliate: aff, commissions, click_trend: clicks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/affiliates/leaderboard — must be before /:id
router.get("/leaderboard", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.affiliate_code, a.promo_code, u.full_name,
              a.total_orders, a.total_clicks, a.total_earned
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.status = 'active'
       ORDER BY a.total_earned DESC
       LIMIT 10`
    );
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/affiliates — admin all
router.get("/", requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.*, u.email, u.full_name, u.phone,
              (a.total_earned - a.total_paid) AS pending_payout
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC`
    );
    res.json({ affiliates: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/affiliates/:id/approve — admin
router.put("/:id/approve", requireAdmin, async (req, res) => {
  try {
    const { commission_type, commission_value, promo_discount_pct } = req.body;
    const { rows } = await query(
      `UPDATE affiliates SET
         status = 'active',
         commission_type = COALESCE($1, commission_type),
         commission_value = COALESCE($2, commission_value),
         promo_discount_pct = COALESCE($3, promo_discount_pct)
       WHERE id = $4
       RETURNING *, (SELECT firebase_uid FROM users WHERE id = affiliates.user_id) AS firebase_uid`,
      [commission_type, commission_value, promo_discount_pct, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Affiliate not found" });

    if (rows[0].firebase_uid) {
      await setCustomClaims(rows[0].firebase_uid, { role: "affiliate" });
      await query("UPDATE users SET role = 'affiliate' WHERE firebase_uid = $1", [rows[0].firebase_uid]);
    }

    res.json({ affiliate: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/affiliates/:id/commission — admin
router.put("/:id/commission", requireAdmin, async (req, res) => {
  try {
    const { commission_type, commission_value, promo_discount_pct } = req.body;
    const { rows } = await query(
      `UPDATE affiliates SET
         commission_type = COALESCE($1, commission_type),
         commission_value = COALESCE($2, commission_value),
         promo_discount_pct = COALESCE($3, promo_discount_pct)
       WHERE id = $4 RETURNING *`,
      [commission_type, commission_value, promo_discount_pct, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Affiliate not found" });
    res.json({ affiliate: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/affiliates/:id/payout — admin
router.post("/:id/payout", requireAdmin, async (req, res) => {
  try {
    const { rows: affRows } = await query("SELECT * FROM affiliates WHERE id = $1", [req.params.id]);
    if (!affRows.length) return res.status(404).json({ error: "Affiliate not found" });

    const pendingAmount = Number(affRows[0].total_earned) - Number(affRows[0].total_paid);
    if (pendingAmount <= 0) return res.status(400).json({ error: "No pending commissions" });

    await query(
      `UPDATE commissions SET status = 'paid', paid_at = NOW()
       WHERE affiliate_id = $1 AND status IN ('pending','approved')`,
      [req.params.id]
    );

    const { rows } = await query(
      `UPDATE affiliates SET total_paid = total_earned WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ affiliate: rows[0], amount_paid: pendingAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;