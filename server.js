import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());
app.use(express.static("."));

// In-memory pending store (replace with DB in production)
const pending = {}; // { reference: { name, email, phone, industry, createdAt } }

// Helper to generate short unique reference
function genRef() {
  return "REF-" + crypto.randomBytes(6).toString("hex");
}

// Daraja: get access token
async function getMpesaToken() {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET in env");
  }
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const url = process.env.MPESA_OAUTH_URL || "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Failed to get token: " + txt);
  }
  const data = await res.json();
  return data.access_token;
}

// Serve form (root index.html)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// POST /subscribe -> triggers STK push (Daraja)
app.post("/subscribe", async (req, res) => {
  try {
    const { name, email, phone, industry } = req.body;
    if (!name || !email || !phone || !industry) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Generate ref and store pending
    const accountRef = genRef();
    pending[accountRef] = { name, email, phone, industry, createdAt: Date.now() };

    // Daraja config
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    if (!shortcode || !passkey) {
      return res.status(500).json({ message: "MPESA_SHORTCODE or MPESA_PASSKEY not set in environment" });
    }

    // Get access token
    const token = await getMpesaToken();

    // Timestamp format YYYYMMDDHHmmss
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: 100,
      PartyA: phone,
      PartyB: '6976785',
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'Payment',
      TransactionDesc: 'Payment',
    };

    console.log("STK push payload:", { ...payload, Password: "[HIDDEN]" });

    const stkRes = await fetch(process.env.MPESA_STK_URL || "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const stkData = await stkRes.json().catch(() => null);
    console.log("STK response:", stkData);

    return res.json({
      status: "pending",
      message: "M-PESA payment prompt sent to your phone. Confirm to complete subscription.",
      reference: accountRef,
      stk: stkData || null,
    });
  } catch (err) {
    console.error("Error /subscribe:", err);
    return res.status(500).json({ message: "Failed to initiate payment", error: err.message });
  }
});

// POST /payment-confirmed -> M-PESA callback
app.post("/payment-confirmed", async (req, res) => {
  try {
    console.log("Payment callback received:", JSON.stringify(req.body).slice(0, 2000));
    const body = req.body;
    const stkCallback = body?.Body?.stkCallback;
    if (!stkCallback) {
      // Some providers may POST different payloads; acknowledge to avoid retries
      return res.status(200).json({ result: "no-stk-callback-present" });
    }

    const resultCode = stkCallback.ResultCode;
    const items = stkCallback?.CallbackMetadata?.Item || [];

    const accountRefItem = items.find((it) => it.Name === "AccountReference");
    const phoneItem = items.find((it) => it.Name === "PhoneNumber" || it.Name === "MSISDN");
    const amountItem = items.find((it) => it.Name === "Amount");
    const receiptItem = items.find((it) => it.Name === "MpesaReceiptNumber" || it.Name === "ReceiptNumber");

    const accountRef = accountRefItem?.Value || stkCallback?.CheckoutRequestID || null;
    const payerPhone = phoneItem?.Value || null;
    const amount = amountItem?.Value || null;
    const receipt = receiptItem?.Value || null;

    if (resultCode === 0 && accountRef && pending[accountRef]) {
      const entry = pending[accountRef];
      const { name, email, industry } = entry;

      const key = `MAILERLITE_GROUP_${industry.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      const groupId = process.env[key] || process.env.MAILERLITE_DEFAULT_GROUP;

      const mlPayload = {
        email: email,
        name: name,
        fields: { phone: payerPhone || "" },
      };
      if (groupId) mlPayload.groups = [groupId];

      try {
        const mlRes = await fetch("https://connect.mailerlite.com/api/subscribers", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
          },
          body: JSON.stringify(mlPayload),
        });
        const mlText = await mlRes.text();
        console.log("MailerLite result:", mlRes.status, mlText);
      } catch (e) {
        console.error("MailerLite API error:", e);
      }

      // Remove pending entry
      delete pending[accountRef];

      return res.status(200).json({ ResultCode: 0, ResultDesc: "Processed" });
    }

    console.warn("Callback not processed:", { resultCode, accountRef });
    return res.status(200).json({ ResultCode: 0, ResultDesc: "No action taken" });
  } catch (err) {
    console.error("Error in /payment-confirmed:", err);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Error handled" });
  }
});

// Debug endpoint
app.get("/_pending", (req, res) => {
  res.json(pending);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
