import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Temporary storage
const pendingPayments = new Map();

// ===============================
// 1. Generate Access Token
// ===============================
const getAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await axios.get(
    'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  return res.data.access_token;
};

// ===============================
// 2. STK PUSH ROUTE
// ===============================
app.post('/stkpush', async (req, res) => {
  try {
    const { name, email, phone, industry } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }

    // Store user until payment callback
    pendingPayments.set(phone, { name, email, industry });

    const accessToken = await getAccessToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: 100,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE, // or your till/paybill
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'Payment',
      TransactionDesc: 'Payment',
    };

    const stkRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({ message: "STK push sent", data: stkRes.data });
  } catch (err) {
    console.error("STK Push Error:", err.response?.data || err.message);
    res.status(500).json({ error: 'STK Push failed' });
  }
});

// ===============================
// 3. MAILERLITE SUBSCRIBE
// ===============================
const addUserToMailerLite = async (email, name, industry, phone) => {
  return axios.post(
    'https://connect.mailerlite.com/api/subscribers',
    {
      email,
      fields: { name, phone, industry },
      groups: [process.env.MAILERLITE_GROUP_ID],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
};

// ===============================
// 4. CALLBACK ROUTE
// ===============================
app.post('/callback', async (req, res) => {
  console.log("Callback Received:", JSON.stringify(req.body, null, 2));

  const callback = req.body?.Body?.stkCallback;

  if (!callback) {
    console.log("Invalid callback format");
    return res.status(200).send("OK");
  }

  const resultCode = callback.ResultCode;

  const phoneNumber =
    callback.CallbackMetadata?.Item?.find(i => i.Name === 'PhoneNumber')?.Value;

  if (!phoneNumber) {
    console.log("Callback missing phone number");
    return res.status(200).send("OK");
  }

  if (resultCode === 0) {
    console.log("Payment success:", phoneNumber);

    const user = pendingPayments.get(phoneNumber);
    if (user) {
      try {
        await addUserToMailerLite(
          user.email,
          user.name,
          user.industry,
          phoneNumber
        );
        console.log("Added to MailerLite:", user.email);
      } catch (err) {
        console.log("MailerLite Error:", err.response?.data || err.message);
      }

      pendingPayments.delete(phoneNumber);
    }
  } else {
    console.log("Payment failed:", phoneNumber);
  }

  res.status(200).send("OK");
});

// ===============================
// 5. Serve frontend
// ===============================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===============================
// 6. Start Server
// ===============================
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
