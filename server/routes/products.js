// backend/routes/products.js

const router = require("express").Router();
const { query } = require("../lib/db");
const { requireAdmin } = require("../middleware/auth");

// GET /api/products — public
router.get("/", async (req, res) => {
  try {
    const { category, search } = req.query;
    let sql = `
      SELECT id, name, description, price, stock, category,
             image_url, image_emoji, min_bulk_qty, bulk_discount_pct,
             is_active, created_at
      FROM products
      WHERE is_active = TRUE
    `;
    const params = [];

    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      // BUG FIX 7: The search clause used the same $N placeholder twice in one
      // expression — e.g. "name ILIKE $2 OR description ILIKE $2". PostgreSQL
      // requires you to push the value once per placeholder index ($2, $3 etc.)
      // OR use the same $N safely only in separate clauses. The safest fix is to
      // push the value twice and use two distinct parameter indices.
      const idx = params.length;
      params.push(`%${search}%`); // push again for the second ILIKE
      sql += ` AND (name ILIKE $${idx} OR description ILIKE $${idx + 1})`;
    }
    sql += " ORDER BY created_at DESC";

    const { rows } = await query(sql, params);
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/categories — public
// BUG FIX 8: This route MUST be declared before /:id, otherwise Express
// matches "categories" as the :id param and returns 404 or wrong result.
router.get("/categories", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT DISTINCT category FROM products WHERE is_active = TRUE AND category IS NOT NULL ORDER BY category"
    );
    res.json({ categories: rows.map((r) => r.category) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/admin/all — admin only
// BUG FIX 9: Same route-ordering issue. "/admin/all" must come before "/:id"
// or Express captures "admin" as the :id parameter.
router.get("/admin/all", requireAdmin, async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM products ORDER BY created_at DESC");
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id — public
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT * FROM products WHERE id = $1 AND is_active = TRUE",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json({ product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/products — admin only
router.post("/", requireAdmin, async (req, res) => {
  try {
    const {
      name, description, price, stock, category,
      image_url, image_emoji, min_bulk_qty, bulk_discount_pct,
    } = req.body;

    if (!name || price === undefined || stock === undefined) {
      return res.status(400).json({ error: "name, price and stock are required" });
    }

    const { rows } = await query(
      `INSERT INTO products
         (name, description, price, stock, category, image_url, image_emoji, min_bulk_qty, bulk_discount_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [name, description, price, stock, category, image_url, image_emoji || "🍪", min_bulk_qty || 20, bulk_discount_pct || 10]
    );
    res.status(201).json({ product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/products/:id — admin only
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const {
      name, description, price, stock, category,
      image_url, image_emoji, min_bulk_qty, bulk_discount_pct, is_active,
    } = req.body;

    const { rows } = await query(
      `UPDATE products SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         stock = COALESCE($4, stock),
         category = COALESCE($5, category),
         image_url = COALESCE($6, image_url),
         image_emoji = COALESCE($7, image_emoji),
         min_bulk_qty = COALESCE($8, min_bulk_qty),
         bulk_discount_pct = COALESCE($9, bulk_discount_pct),
         is_active = COALESCE($10, is_active)
       WHERE id = $11
       RETURNING *`,
      [name, description, price, stock, category, image_url, image_emoji, min_bulk_qty, bulk_discount_pct, is_active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json({ product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id — admin only (soft delete)
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      "UPDATE products SET is_active = FALSE WHERE id = $1 RETURNING id, name",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json({ message: "Product deleted", product: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;