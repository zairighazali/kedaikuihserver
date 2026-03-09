// backend/middleware/auth.js
// Express middleware to verify Firebase ID tokens and enforce roles

const { verifyToken } = require("../lib/firebase");
const { query } = require("../lib/db");

/**
 * requireAuth — Verifies Firebase token, attaches decoded user to req.user
 * Also loads the user's DB record (role, affiliate ID, etc.)
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }

    const token = header.slice(7);
    const decoded = await verifyToken(token);

    // Load user from our DB (for role + extra data)
    const { rows } = await query(
      "SELECT id, firebase_uid, email, full_name, role FROM users WHERE firebase_uid = $1",
      [decoded.uid]
    );

    if (!rows.length) {
      // Auto-create user record if first time (customer role)
      const insert = await query(
        `INSERT INTO users (firebase_uid, email, full_name, role)
         VALUES ($1, $2, $3, 'customer') RETURNING *`,
        [decoded.uid, decoded.email, decoded.name || ""]
      );
      req.user = insert.rows[0];
    } else {
      req.user = rows[0];
    }

    req.firebaseUser = decoded;
    next();
  } catch (err) {
    console.error("[Auth]", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * requireRole(...roles) — Ensures the authenticated user has one of the given roles
 * Must be used AFTER requireAuth
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(" or ")}` });
    }
    next();
  };
}

// Convenience shorthands
const requireAdmin = [requireAuth, requireRole("admin")];
const requireAffiliate = [requireAuth, requireRole("affiliate", "admin")];
const requireCustomer = [requireAuth]; // any authenticated user

module.exports = { requireAuth, requireRole, requireAdmin, requireAffiliate, requireCustomer };