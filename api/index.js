import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// Initialize Firebase Admin SDK
const firebaseConfig = {
  apiKey: "AIzaSyD6CoiozFrzftUyBn5UaQU2fwzPFRE9NyU",
  authDomain: "mskweb-1db5c.firebaseapp.com",
  projectId: "mskweb-1db5c",
  storageBucket: "mskweb-1db5c.firebasestorage.app",
  messagingSenderId: "953778688896",
  appId: "1:953778688896:web:8c6b1df9b10fcc0a632765",
  measurementId: "G-MG37FPPD16",
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...firebaseConfig,
  });
}
const db = admin.firestore();

const app = express();

// Middleware - CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:5173",
      "http://localhost:8080",
      "https://shop-go-main-1.vercel.app",
    ];

    // Check if origin matches allowed patterns
    const isAllowed =
      allowedOrigins.includes(origin) ||
      origin.includes(".vercel.app") ||
      origin.includes(".netlify.app");

    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn("CORS blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options("*", cors(corsOptions));
app.use(express.json());

// Yoco Configuration
const YOCO_SECRET_KEY = process.env.YOCO_SECRET_KEY;
const YOCO_API_BASE = "https://payments.yoco.com/api";

if (!YOCO_SECRET_KEY) {
  console.warn("⚠️  WARNING: YOCO_SECRET_KEY not set!");
}

/**
 * Yoco Webhook Handler
 * POST /api/webhooks/yoco
 */
app.post(
  "/api/webhooks/yoco",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      console.log("🔔 Webhook received from Yoco");
      console.log("Headers:", req.headers);

      const event = JSON.parse(req.body.toString());
      console.log("📦 Webhook event:", JSON.stringify(event, null, 2));

      // Acknowledge receipt immediately
      res.status(200).json({ received: true });

      // Process the webhook event
      if (
        event.type === "checkout.succeeded" ||
        event.type === "payment.succeeded"
      ) {
        console.log("✅ Payment succeeded webhook received");
        console.log("Checkout ID:", event.payload?.id);
        console.log("Payment ID:", event.payload?.paymentId);
        console.log("Metadata:", event.payload?.metadata);

        // Save order to Firebase
        const orderId = event.payload?.metadata?.orderId;
        if (orderId) {
          try {
            const orderData = JSON.parse(
              event.payload.metadata.orderData || "{}",
            );
            orderData.payment = {
              paymentId: event.payload.paymentId || event.payload.id,
              status: "completed",
              method: "yoco",
              amountPaid: event.payload.amount / 100,
            };
            orderData.status = "confirmed";

            await db
              .collection("orders")
              .doc(orderId.replace("#", ""))
              .set(orderData);
            console.log("✅ Order saved to Firebase:", orderId);
          } catch (err) {
            console.error("Failed to save order from webhook:", err);
          }
        }
      } else if (event.type === "checkout.cancelled") {
        console.log("❌ Payment cancelled webhook received");
      } else if (event.type === "checkout.failed") {
        console.log("❌ Payment failed webhook received");
      } else {
        console.log("ℹ️ Unknown webhook event type:", event.type);
      }
    } catch (error) {
      console.error("💥 Webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  },
);

/**
 * Root endpoint
 */
app.get("/", (req, res) => {
  res.json({
    service: "Payment Server",
    status: "running",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    endpoints: {
      health: "/health",
      checkout: "POST /api/payments/checkout",
      webhook: "POST /api/webhooks/yoco",
      refund: "POST /api/payments/refund",
    },
  });
});

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    yocoConfigured: !!YOCO_SECRET_KEY,
  });
});

/**
 * Create a checkout session
 * POST /api/payments/checkout
 */
app.post("/api/payments/checkout", async (req, res) => {
  try {
    const { amount, currency, metadata, successUrl, cancelUrl, failureUrl } =
      req.body;

    console.log("📝 Checkout request received:", {
      amount,
      currency,
      metadata,
      successUrl,
      cancelUrl,
    });

    if (!amount) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: amount (in cents)",
      });
    }

    if (!YOCO_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server configuration error: YOCO_SECRET_KEY not set",
      });
    }

    const yocoPayload = {
      amount: amount,
      currency: currency || "ZAR",
      metadata: metadata || {},
    };

    if (successUrl) yocoPayload.successUrl = successUrl;
    if (cancelUrl) yocoPayload.cancelUrl = cancelUrl;
    if (failureUrl) yocoPayload.failureUrl = failureUrl;

    console.log(
      "📤 Sending to Yoco API:",
      JSON.stringify(yocoPayload, null, 2),
    );

    const yocoResponse = await fetch(`${YOCO_API_BASE}/checkouts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(yocoPayload),
    });

    const data = await yocoResponse.json();

    if (!yocoResponse.ok) {
      console.error("❌ Yoco API error:", data);
      return res.status(yocoResponse.status).json({
        success: false,
        error: data.errorMessage || data.message || "Checkout creation failed",
        details: data,
      });
    }

    console.log("✅ Checkout created:", data.id);

    res.json({
      success: true,
      id: data.id,
      status: data.status,
      redirectUrl: data.redirectUrl,
      amount: data.amount,
      currency: data.currency,
      createdDate: data.createdDate,
    });
  } catch (error) {
    console.error("💥 Checkout error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * Get checkout status
 * GET /api/payments/checkout/:checkoutId
 */
app.get("/api/payments/checkout/:checkoutId", async (req, res) => {
  try {
    const { checkoutId } = req.params;

    if (!YOCO_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server configuration error",
      });
    }

    const response = await fetch(`${YOCO_API_BASE}/checkouts/${checkoutId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: "Failed to get checkout status",
        details: data,
      });
    }

    res.json({
      success: true,
      id: data.id,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      createdDate: data.createdDate,
      metadata: data.metadata,
    });
  } catch (error) {
    console.error("Checkout status error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * Create payment charge (backwards compatibility)
 * POST /api/payments/charge
 */
app.post("/api/payments/charge", async (req, res) => {
  try {
    const { amount, token, metadata } = req.body;

    if (!amount || !token) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: amount, token",
      });
    }

    if (!YOCO_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server configuration error",
      });
    }

    console.log("💳 Charge request received:", { amount, metadata });
    console.log("Token (masked):", token.substring(0, 10) + "...");

    const yocoPayload = {
      amount: amount,
      token: token,
      currency: "ZAR",
      metadata: metadata || {},
    };

    const yocoResponse = await fetch(`${YOCO_API_BASE}/charges`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(yocoPayload),
    });

    const data = await yocoResponse.json();

    if (!yocoResponse.ok) {
      console.error("❌ Yoco charge error:", data);
      return res.status(yocoResponse.status).json({
        success: false,
        error: data.errorMessage || data.message || "Charge failed",
        details: data,
      });
    }

    console.log("✅ Charge successful:", data.id);

    res.json({
      success: true,
      id: data.id,
      status: data.status,
      amount: data.amount,
      metadata: data.metadata,
    });
  } catch (error) {
    console.error("💥 Charge error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * Refund endpoint
 * POST /api/payments/refund
 */
app.post("/api/payments/refund", async (req, res) => {
  try {
    const { chargeId, amount } = req.body;

    if (!chargeId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: chargeId",
      });
    }

    if (!YOCO_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server configuration error",
      });
    }

    console.log("🔄 Refund request received:", { chargeId, amount });

    const yocoPayload = {
      ...(amount && { amount }),
    };

    const yocoResponse = await fetch(
      `${YOCO_API_BASE}/charges/${chargeId}/refunds`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${YOCO_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(yocoPayload),
      },
    );

    const data = await yocoResponse.json();

    if (!yocoResponse.ok) {
      console.error("❌ Refund error:", data);
      return res.status(yocoResponse.status).json({
        success: false,
        error: data.errorMessage || data.message || "Refund failed",
        details: data,
      });
    }

    console.log("✅ Refund successful:", data.id);

    res.json({
      success: true,
      id: data.id,
      status: data.status,
      amount: data.amount,
    });
  } catch (error) {
    console.error("💥 Refund error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message,
    });
  }
});

export default app;
