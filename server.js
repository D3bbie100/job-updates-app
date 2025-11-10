import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.post("/subscribe", async (req, res) => {
  const { name, email, phone, industry } = req.body;

  if (!name || !email || !phone || !industry)
    return res.status(400).json({ message: "Missing fields" });

  try {
    const stkResponse = await fetch(process.env.MPESA_STK_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone,
        amount: 200,
        callback_url: `${process.env.MPESA_CALLBACK_BASE}/payment-confirmed`,
        reference: email,
      }),
    });

    const stkData = await stkResponse.json();
    console.log("STK Push Sent:", stkData);

    res.json({
      message:
        "Payment request sent to your phone. Please complete payment to finish subscribing for job updates.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error initiating payment" });
  }
});

app.post("/payment-confirmed", async (req, res) => {
  console.log("Callback received:", req.body);

  const { Body } = req.body;
  if (!Body || !Body.stkCallback) return res.sendStatus(200);

  const resultCode = Body.stkCallback.ResultCode;
  const metadata = Body.stkCallback.CallbackMetadata?.Item || [];

  if (resultCode === 0) {
    const phone = metadata.find((i) => i.Name === "PhoneNumber")?.Value;
    const email = Body.stkCallback.CheckoutRequestID;

    const groupId =
      process.env[`MAILERLITE_GROUP_${industry.toUpperCase()}`] ||
      process.env.MAILERLITE_DEFAULT_GROUP;

    await fetch(`https://connect.mailerlite.com/api/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({
        email,
        fields: {
          name: metadata.find((i) => i.Name === "AccountReference")?.Value,
          phone,
          industry,
        },
        groups: [groupId],
      }),
    });

    console.log("Added subscriber:", email);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Job Updates app running on port ${PORT}`));
