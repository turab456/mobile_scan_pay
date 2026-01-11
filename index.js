import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();

app.use(cors());
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Scan & Go Backend Running");
});

app.post("/api/create-order", async (req, res) => {
  try {
    const { amount, phone } = req.body;

    if (!amount || !phone) {
      return res.status(400).json({ message: "Amount & phone required" });
    }

    const orderId = `ORDER_${Date.now()}`;

    const response = await axios.post(
      `${process.env.CASHFREE_BASE_URL}/pg/orders`,
      {
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: phone,
          customer_phone: phone.replace("+91", ""),
        },
        order_meta: {
          return_url:
            "http://localhost:5173/payment-result?order_id={order_id}",
        },
        order_config: {
          payment_methods: {
            upi: true,
            card: false,
            netbanking: false,
            wallet: false,
          },
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-client-id": process.env.CASHFREE_CLIENT_ID,
          "x-client-secret": process.env.CASHFREE_CLIENT_SECRET,
          "x-api-version": "2023-08-01",
        },
      }
    );

    res.json({
      orderId,
      paymentSessionId: response.data.payment_session_id,
    });
  } catch (err) {
    console.error("Create order error:", err.response?.data || err.message);
    res.status(500).json({ message: "Cashfree order creation failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
