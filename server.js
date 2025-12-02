require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// 🔹 Simple temporary storage (replace with DB in production)
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

    // 🔹 Store subscriber details temporarily
    pendingPayments.set(phone, { name, email, industry });

    const accessToken = await getAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

    const password = Buffer.from(
      process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp
    ).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: 10,
      PartyA: phone,
      PartyB: '6976785',
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'Payment',
      TransactionDesc: 'Payment',
    };

    const stkRes = await axios.post(
      'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json(stkRes.data);

  } catch (err) {
    console.error("❌ STK Push Error:", err.response?.data || err.message);
    res.status(500).json({ error: 'STK Push failed' });
  }
});

// ===============================
// 3. MAILERLITE FUNCTION
// ===============================
const addUserToMailerLite = async (email, name, industry, phone) => {
  return axios.post(
    'https://connect.mailerlite.com/api/subscribers',
    {
      email: email,
      fields: {
        name: name,
        phone: phone,
        industry: industry
      },
      groups: [process.env.MAILERLITE_GROUP_ID]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
};

// ===============================
// 4. CALLBACK ROUTE
// ===============================
app.post('/callback', async (req, res) => {
  const callback = req.body.Body.stkCallback;

  console.log("📩 M-Pesa Callback:", JSON.stringify(callback, null, 2));

  const resultCode = callback.ResultCode;

  const phoneNumber = callback.CallbackMetadata?.Item?.find(i => i.Name === 'PhoneNumber')?.Value;

  if (!phoneNumber) {
    console.log("⚠️ No phone number in callback.");
    return res.status(200).send("OK");
  }

  // =======================================
  // 🔹 SUCCESSFUL PAYMENT
  // =======================================
  if (resultCode === 0) {
    console.log("✅ Payment success for:", phoneNumber);

    const user = pendingPayments.get(phoneNumber);

    if (user) {
      try {
        await addUserToMailerLite(user.email, user.name, user.industry, phoneNumber);
        console.log(`📧 Added to MailerLite: ${user.email}`);
      } catch (err) {
        console.log("❌ MailerLite Error:", err.response?.data || err.message);
      }

      pendingPayments.delete(phoneNumber); // cleanup
    }
  } 
  else {
    console.log("❌ Payment FAILED for:", phoneNumber);
  }

  res.status(200).send("OK");
});

// ===============================
// 5. SERVE FRONTEND
// ===============================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===============================
// 6. START SERVER
// ===============================
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
});
