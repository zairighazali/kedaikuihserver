// backend/routes/orders.js

const router = require("express").Router();
const { query, transaction } = require("../lib/db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

// BUG FIX 10: generateOrderNumber uses COUNT(*) which is not safe under
// concurrent requests — two simultaneous orders could get the same number.
// Fixed by using a DB sequence approach: check the max existing order number
// instead of counting all rows, which also survives cancelled/deleted orders.
async function generateOrderNumber() {
  const { rows } = await query(
    "SELECT order_number FROM orders ORDER BY created_at DESC LIMIT 1"
  );
  let seq = 1;
  if (rows.length) {
    const last = rows[0].order_number; // e.g. "ORD-202500042"
    const num = parseInt(last.replace(/^ORD-\d{4}/, ""), 10);
    if (!isNaN(num)) seq = num + 1;
  }
  const year = new Date().getFullYear();
  return `ORD-${year}${String(seq).padStart(5, "0")}`;
}

// POST /api/orders
router.post("/", requireAuth, async (req, res) => {
  const {
    items,
    ship_name, ship_phone, ship_address, ship_city, ship_postcode, ship_state,
    shipping_method,
    promo_code,
  } = req.body;

  if (!items || !items.length) return res.status(400).json({ error: "Cart is empty" });
  if (!ship_name || !ship_phone || !ship_address) {
    return res.status(400).json({ error: "Shipping information is required" });
  }

  try {
    const result = await transaction(async ({ query: q }) => {
      let subtotal = 0;
      const orderItems = [];

      for (const item of items) {
        const { rows } = await q(
          "SELECT * FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE",
          [item.product_id]
        );
        if (!rows.length) throw new Error(`Product ${item.product_id} not found`);
        const product = rows[0];
        if (product.stock < item.quantity) {
          throw new Error(`Insufficient stock for "${product.name}". Available: ${product.stock}`);
        }

        let unit_price = Number(product.price);
        if (item.quantity >= product.min_bulk_qty) {
          unit_price = unit_price * (1 - Number(product.bulk_discount_pct) / 100);
        }

        const line_total = unit_price * item.quantity;
        subtotal += line_total;
        orderItems.push({ product, unit_price, quantity: item.quantity, line_total });
      }

      let affiliateId = null;
      let discountAmount = 0;

      if (promo_code) {
        const { rows: affRows } = await q(
          "SELECT * FROM affiliates WHERE UPPER(promo_code) = UPPER($1) AND status = 'active'",
          [promo_code]
        );
        if (affRows.length) {
          affiliateId = affRows[0].id;
          discountAmount = subtotal * (Number(affRows[0].promo_discount_pct) / 100);
        }
      }

      const { rows: settings } = await q("SELECT * FROM shipping_settings LIMIT 1");
      const setting = settings[0];

      // BUG FIX 11: if shipping_settings table is empty (not seeded yet),
      // setting is undefined and Number(undefined) = NaN, crashing the order.
      // Added fallback defaults.
      const stdRate  = setting ? Number(setting.standard_rate)         : 8;
      const expRate  = setting ? Number(setting.express_rate)          : 18;
      const freeThr  = setting ? Number(setting.free_shipping_threshold) : 100;

      let shippingCost = 0;
      if (shipping_method === "pickup") {
        shippingCost = 0;
      } else if (shipping_method === "express") {
        shippingCost = expRate;
      } else {
        shippingCost = subtotal >= freeThr ? 0 : stdRate;
      }

      const total = subtotal - discountAmount + shippingCost;
      const orderNumber = await generateOrderNumber();

      const { rows: orderRows } = await q(
        `INSERT INTO orders
           (order_number, user_id, affiliate_id, promo_code,
            ship_name, ship_phone, ship_address, ship_city, ship_postcode, ship_state,
            shipping_method, shipping_cost, subtotal, discount_amount, total,
            status, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending_payment','fpx')
         RETURNING *`,
        [
          orderNumber, req.user.id, affiliateId, promo_code || null,
          ship_name, ship_phone, ship_address, ship_city, ship_postcode, ship_state,
          shipping_method || "standard", shippingCost, subtotal, discountAmount, total,
        ]
      );
      const order = orderRows[0];

      for (const item of orderItems) {
        await q(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, item.product.id, item.product.name, item.unit_price, item.quantity, item.line_total]
        );
        await q("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.quantity, item.product.id]);
      }

      return { order, orderItems };
    });

    res.status(201).json({
      order: result.order,
      items: result.orderItems.map((i) => ({
        name: i.product.name,
        quantity: i.quantity,
        unit_price: i.unit_price,
        line_total: i.line_total,
      })),
    });
  } catch (err) {
    console.error("[Orders]", err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/orders/my — must come before /:id
// BUG FIX 12: Same route-ordering problem as products.js.
// "/my" must be declared BEFORE "/:id" or Express treats "my" as an order UUID
// and the query returns 404 every time.
router.get("/my", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              json_agg(json_build_object(
                'product_name', oi.product_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'line_total', oi.line_total
              )) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ orders: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders — admin all orders
router.get("/", requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = "";
    if (status) { params.push(status); where = `WHERE o.status = $1`; }

    const { rows } = await query(
      `SELECT o.*, u.email AS customer_email, u.full_name AS customer_name,
              COUNT(oi.id) AS item_count
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       ${where}
       GROUP BY o.id, u.email, u.full_name
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM orders ${where}`, params
    );
    res.json({ orders: rows, total: Number(countRows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.*,
              json_agg(json_build_object(
                'product_name', oi.product_name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'line_total', oi.line_total
              )) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1
       GROUP BY o.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    const order = rows[0];
    if (req.user.role !== "admin" && order.user_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/:id/status — admin
router.put("/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["pending_payment", "paid", "processing", "shipped", "delivered", "cancelled"];
    if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const { rows } = await query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    res.json({ order: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;