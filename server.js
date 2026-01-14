import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

app.use(cors());
app.use(bodyParser.json());

// In-memory database (for MVP - replace with real DB later)
let stores = [];
let products = [];
let orders = [];
let verifications = [];

// Load data from JSON files
function loadData() {
  try {
    const storesData = fs.readFileSync(
      path.join(__dirname, "data", "stores.json"),
      "utf8"
    );
    stores = JSON.parse(storesData);

    const productsData = fs.readFileSync(
      path.join(__dirname, "data", "products.json"),
      "utf8"
    );
    products = JSON.parse(productsData);

    console.log(
      `✅ Loaded ${stores.length} stores and ${products.length} products`
    );
  } catch (error) {
    console.error("Error loading data:", error.message);
  }
}

loadData();

// ==================== STORE APIs ====================

app.get("/api/stores", (req, res) => {
  res.json({ success: true, stores });
});

app.get("/api/stores/:storeId", (req, res) => {
  const store = stores.find((s) => s.storeId === req.params.storeId);
  if (!store) {
    return res.status(404).json({ success: false, message: "Store not found" });
  }
  res.json({ success: true, store });
});

// ==================== PRODUCT APIs ====================

app.get("/api/products", (req, res) => {
  const { storeId, category } = req.query;
  let filteredProducts = products;

  if (category) {
    filteredProducts = filteredProducts.filter((p) => p.category === category);
  }

  res.json({
    success: true,
    products: filteredProducts,
    count: filteredProducts.length,
  });
});

app.get("/api/products/barcode/:barcode", (req, res) => {
  const product = products.find((p) => p.barcode === req.params.barcode);

  if (!product) {
    return res.status(404).json({
      success: false,
      message: "Product not found",
      barcode: req.params.barcode,
    });
  }

  res.json({ success: true, product });
});

app.get("/api/products/search", (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res
      .status(400)
      .json({ success: false, message: "Search query required" });
  }

  const searchResults = products.filter(
    (p) =>
      p.name.toLowerCase().includes(q.toLowerCase()) ||
      p.brand.toLowerCase().includes(q.toLowerCase()) ||
      p.category.toLowerCase().includes(q.toLowerCase())
  );

  res.json({
    success: true,
    products: searchResults,
    count: searchResults.length,
  });
});

// ==================== ORDER APIs ====================

app.post("/api/orders/create", (req, res) => {
  try {
    const { storeId, items, customerPhone } = req.body;

    if (!storeId || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Store ID and items required",
      });
    }

    // Calculate totals
    let subtotal = 0;
    const orderItems = items.map((item) => {
      const product = products.find((p) => p.productId === item.productId);
      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }
      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;
      return {
        ...product,
        quantity: item.quantity,
        itemTotal,
      };
    });

    const tax = Math.round(subtotal * 0.05); // 5% GST
    const total = subtotal + tax;

    const order = {
      orderId: `ORD${Date.now()}`,
      storeId,
      customerPhone: customerPhone || "anonymous",
      items: orderItems,
      subtotal,
      tax,
      total,
      status: "pending_payment",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes
    };

    orders.push(order);

    // Get store UPI details
    const store = stores.find((s) => s.storeId === storeId);

    res.json({
      success: true,
      order,
      upiDetails: store
        ? {
            upiId: store.upiId,
            upiQrCode: `${store.upiQrCode}&am=${total}&tn=${order.orderId}`,
          }
        : null,
    });
  } catch (error) {
    console.error("Create order error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/api/orders/:orderId", (req, res) => {
  const order = orders.find((o) => o.orderId === req.params.orderId);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  res.json({ success: true, order });
});

app.post("/api/orders/:orderId/claim-payment", (req, res) => {
  try {
    const { orderId } = req.params;
    const { utrLast4, paidAmount } = req.body;

    const order = orders.find((o) => o.orderId === orderId);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (order.status !== "pending_payment") {
      return res.status(400).json({
        success: false,
        message: "Order already processed",
      });
    }

    // Update order status
    order.status = "payment_claimed";
    order.paymentClaimedAt = new Date().toISOString();
    order.utrLast4 = utrLast4;
    order.paidAmount = paidAmount;

    res.json({
      success: true,
      message: "Payment claimed. Awaiting verification.",
      order,
    });
  } catch (error) {
    console.error("Claim payment error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== CASHIER/VERIFICATION APIs ====================

app.get("/api/cashier/pending-orders", (req, res) => {
  const { storeId } = req.query;

  let pendingOrders = orders.filter(
    (o) => o.status === "payment_claimed" || o.status === "pending_payment"
  );

  if (storeId) {
    pendingOrders = pendingOrders.filter((o) => o.storeId === storeId);
  }

  // Sort by most recent first
  pendingOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    success: true,
    orders: pendingOrders,
    count: pendingOrders.length,
  });
});

app.post("/api/cashier/verify-order", (req, res) => {
  try {
    const { orderId, cashierId, verified, notes } = req.body;

    const order = orders.find((o) => o.orderId === orderId);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (verified) {
      order.status = "verified";
      order.verifiedAt = new Date().toISOString();
      order.verifiedBy = cashierId || "cashier";
      order.verificationNotes = notes;
    } else {
      order.status = "rejected";
      order.rejectedAt = new Date().toISOString();
      order.rejectedBy = cashierId || "cashier";
      order.rejectionReason = notes;
    }

    // Log verification
    verifications.push({
      verificationId: uuidv4(),
      orderId,
      cashierId: cashierId || "cashier",
      verified,
      notes,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: verified ? "Order verified successfully" : "Order rejected",
      order,
    });
  } catch (error) {
    console.error("Verify order error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post("/api/cashier/scan-exit-qr", (req, res) => {
  try {
    const { orderId } = req.body;

    const order = orders.find((o) => o.orderId === orderId);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (order.status === "verified") {
      order.status = "completed";
      order.completedAt = new Date().toISOString();

      return res.json({
        success: true,
        message: "Customer can exit",
        allowExit: true,
        order,
      });
    }

    if (order.status === "payment_claimed") {
      return res.json({
        success: false,
        message: "Payment not verified yet",
        allowExit: false,
        order,
      });
    }

    if (order.status === "pending_payment") {
      return res.json({
        success: false,
        message: "Payment not completed",
        allowExit: false,
        order,
      });
    }

    res.json({
      success: false,
      message: "Invalid order status",
      allowExit: false,
      order,
    });
  } catch (error) {
    console.error("Scan exit QR error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== ANALYTICS APIs ====================

app.get("/api/analytics/dashboard", (req, res) => {
  const { storeId } = req.query;

  let storeOrders = orders;
  if (storeId) {
    storeOrders = orders.filter((o) => o.storeId === storeId);
  }

  const today = new Date().toISOString().split("T")[0];
  const todayOrders = storeOrders.filter((o) => o.createdAt.startsWith(today));

  const completedOrders = storeOrders.filter((o) => o.status === "completed");
  const pendingOrders = storeOrders.filter(
    (o) => o.status === "pending_payment" || o.status === "payment_claimed"
  );

  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.total, 0);
  const todayRevenue = todayOrders
    .filter((o) => o.status === "completed")
    .reduce((sum, o) => sum + o.total, 0);

  res.json({
    success: true,
    analytics: {
      totalOrders: storeOrders.length,
      todayOrders: todayOrders.length,
      completedOrders: completedOrders.length,
      pendingOrders: pendingOrders.length,
      totalRevenue,
      todayRevenue,
      averageOrderValue:
        completedOrders.length > 0
          ? Math.round(totalRevenue / completedOrders.length)
          : 0,
    },
  });
});

// ==================== HEALTH CHECK ====================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Scan & Go SaaS Backend Running",
    version: "1.0.0",
    endpoints: {
      stores: "/api/stores",
      products: "/api/products",
      orders: "/api/orders/create",
      cashier: "/api/cashier/pending-orders",
      analytics: "/api/analytics/dashboard",
    },
    stats: {
      stores: stores.length,
      products: products.length,
      orders: orders.length,
    },
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 Scan & Go SaaS Backend Server Running           ║
║   📍 Port: ${PORT}                                      ║
║   🏪 Stores: ${stores.length}                                         ║
║   📦 Products: ${products.length}                                       ║
║   ✅ Ready for testing!                               ║
╚═══════════════════════════════════════════════════════╝
  `);
});
