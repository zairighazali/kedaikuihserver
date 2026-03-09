// backend/routes/payment.js
// ToyyibPay FPX integration

const router = require("express").Router();
const axios = require("axios");
const { query, transaction } = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

const TOYYIBPAY_BASE = process.env.TOYYIBPAY_BASE_URL || "https://toyyibpay.com";
const FRONTEND_URL   = process.env.FRONTEND_URL || "http://localhost:5173";

// POST /api/payment/create
router.post("/create", requireAuth, async (req, res) => {
  try {
    // BUG FIX 13: SECRET_KEY and CATEGORY_CODE were read at module load time
    // (top-level const), before dotenv has necessarily loaded the env file.
    // Moving them inside the handler ensures they are always read from the
    // already-loaded process.env at request time.
    const SECRET_KEY    = process.env.TOYYIBPAY_SECRET_KEY;
    const CATEGORY_CODE = process.env.TOYYIBPAY_CATEGORY_CODE;

    if (!SECRET_KEY || !CATEGORY_CODE) {
      return res.status(503).json({ error: "Payment gateway not configured. Set TOYYIBPAY_SECRET_KEY and TOYYIBPAY_CATEGORY_CODE in .env" });
    }

    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: "order_id is required" });

    const { rows } = await query(
      "SELECT * FROM orders WHERE id = $1 AND user_id = $2",
      [order_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    const order = rows[0];

    if (order.status !== "pending_payment") {
      return res.status(400).json({ error: "Order is not awaiting payment" });
    }

    const amountSen = Math.round(Number(order.total) * 100);

    const params = new URLSearchParams({
      userSecretKey:          SECRET_KEY,
      categoryCode:           CATEGORY_CODE,
      billName:               `Biskut Raya - ${order.order_number}`,
      billDescription:        `Pesanan ${order.order_number} - Biskut Raya Premium`,
      billPriceSetting:       1,
      billPayorInfo:          1,
      billAmount:             amountSen,
      billReturnUrl:          `${FRONTEND_URL}/payment/return?order_id=${order.id}`,
      billCallbackUrl:        `${process.env.BACKEND_URL || "http://localhost:4000"}/api/payment/callback`,
      billExternalReferenceNo: order.order_number,
      billTo:                 order.ship_name,
      billEmail:              req.user.email,
      billPhone:              order.ship_phone,
      billSplitPayment:       0,
      billSplitPaymentArgs:   "",
      billPaymentChannel:     0,
      billContentEmail:       `Terima kasih kerana membeli di Biskut Raya! Pesanan anda: ${order.order_number}`,
      billChargeToCustomer:   "",
    });

    const { data } = await axios.post(
      `${TOYYIBPAY_BASE}/index.php/api/createBill`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // BUG FIX 14: Original check was `data[0].BillCode === "0"` which is wrong —
    // ToyyibPay returns BillCode as a string of the actual code, not "0" on success.
    // A failed bill returns an error message array, not a BillCode at all.
    // Correct check: ensure data[0].BillCode exists and is not falsy/"0".
    if (!data || !Array.isArray(data) || !data[0]?.BillCode || data[0].BillCode === "0") {
      console.error("[ToyyibPay] Unexpected response:", data);
      throw new Error(`ToyyibPay error: ${JSON.stringify(data)}`);
    }

    const billCode    = data[0].BillCode;
    const paymentUrl  = `${TOYYIBPAY_BASE}/${billCode}`;

    await query(
      "UPDATE orders SET payment_ref = $1, payment_bill_url = $2 WHERE id = $3",
      [billCode, paymentUrl, order.id]
    );

    res.json({ bill_code: billCode, payment_url: paymentUrl });
  } catch (err) {
    console.error("[Payment Create]", err.message);
    res.status(500).json({ error: "Failed to create payment bill", detail: err.message });
  }
});

// POST /api/payment/callback — ToyyibPay webhook
router.post("/callback", async (req, res) => {
  try {
    const { billcode, order_id: refNo, status_id } = req.body;
    console.log("[Payment Callback]", req.body);

    if (status_id !== "1") {
      return res.send("0");
    }

    const { rows } = await query(
      "SELECT * FROM orders WHERE payment_ref = $1 OR order_number = $2",
      [billcode, refNo]
    );
    if (!rows.length) {
      console.error("[Callback] Order not found for bill:", billcode);
      return res.send("0");
    }
    const order = rows[0];

    if (order.status !== "pending_payment") {
      return res.send("1"); // already processed, ACK again
    }

    await transaction(async ({ query: q }) => {
      await q(
        `UPDATE orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [order.id]
      );

      if (order.affiliate_id) {
        const { rows: affRows } = await q(
          "SELECT * FROM affiliates WHERE id = $1",
          [order.affiliate_id]
        );
        if (affRows.length) {
          const aff = affRows[0];
          let commissionEarned = 0;
          if (aff.commission_type === "percent") {
            commissionEarned = Number(order.total) * (Number(aff.commission_value) / 100);
          } else {
            const { rows: itemRows } = await q(
              "SELECT SUM(quantity) AS total_qty FROM order_items WHERE order_id = $1",
              [order.id]
            );
            commissionEarned = Number(aff.commission_value) * Number(itemRows[0].total_qty);
          }

          await q(
            `INSERT INTO commissions
               (affiliate_id, order_id, order_total, commission_type, commission_value, commission_earned)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [aff.id, order.id, order.total, aff.commission_type, aff.commission_value, commissionEarned]
          );
          await q(
            `UPDATE affiliates SET total_orders = total_orders + 1, total_earned = total_earned + $1 WHERE id = $2`,
            [commissionEarned, aff.id]
          );
        }
      }
    });

    res.send("1");
  } catch (err) {
    console.error("[Payment Callback Error]", err.message);
    res.send("0");
  }
});

// GET /api/payment/status/:orderId
router.get("/status/:orderId", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, order_number, status, total, paid_at FROM orders WHERE id = $1",
      [req.params.orderId]
    );
    if (!rows.length) return res.status(404).json({ error: "Order not found" });
    res.json({ order: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;