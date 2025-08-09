import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { db, admin } from './firebaseAdmin.js';
import fetch from 'node-fetch'; // ✅ required for self-ping & push

const app = express();
app.use(cors());
app.use(express.json());

// Generate a 6-digit OTP
function generateOtp() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  console.log('Generated OTP:', otp);
  return otp;
}

// Mail transporter using Zoho SMTP
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.in',
  port: 465,
  secure: true,
  auth: {
    user: "contact@toshankanwar.website",
    pass: "hR5uCDzEee1p",
  },
});

// Build OTP email HTML (no $ symbols)
function getOtpEmailBody(orderId, otp) {
  return (
    '<div style="font-family: Arial, sans-serif; padding: 16px;">' +
      '<h2 style="color: #3b82f6;">🧁 Toshan Bakery - Order Verification</h2>' +
      '<p>Hello 👋,</p>' +
      '<p>Your OTP for order <strong>#' + orderId.slice(-8) + '</strong> is:</p>' +
      '<div style="font-size: 24px; font-weight: bold; margin: 12px 0; color: #10b981;">' + otp + '</div>' +
      '<p>This OTP is valid for 10 minutes.</p>' +
      '<p style="margin-top: 24px;">Thank you for ordering with Toshan Bakery!</p>' +
    '</div>'
  );
}

// Email on delivery
function getDeliveryEmail(order) {
  let itemHTML = 'N/A';
  if (order.items && order.items.length > 0) {
    itemHTML = order.items.map(function(item) {
      return (item.name || 'Item') + ' ×' + (item.quantity || 1);
    }).join('<br>');
  }

  return (
    '<div style="font-family: Arial, sans-serif; padding: 20px;">' +
      '<h2 style="color: #16a34a;">✅ Order Delivered - Thank you from Toshan Bakery!</h2>' +
      '<p>Hi <strong>' + (order.address?.name || 'Customer') + '</strong>,</p>' +
      '<p>Your order <strong>#' + order.id.slice(-8) + '</strong> has been successfully delivered!</p>' +
      '<p><strong>Items:</strong><br>' + itemHTML + '</p>' +
      '<p><strong>Total:</strong> ₹' +
        (typeof order.total === 'number' ? order.total.toFixed(2) : '0.00') +
        '<br><strong>Payment Status:</strong> Confirmed</p>' +
      '<p style="margin-top: 20px;">We appreciate your support! 🧁</p>' +
    '</div>'
  );
}

// 🔔 Send push notification via Expo
async function sendPushNotification(expoPushToken, title, body, data = {}) {
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: expoPushToken,
        sound: 'default',
        title,
        body,
        data,
      }),
    });
    console.log(`📲 Push notification sent to ${expoPushToken}`);
  } catch (err) {
    console.error('❌ Error sending push notification:', err.message);
  }
}

// 🔥 Health check route
app.get("/", function (req, res) {
  return res.send("✅ Toshan Bakery Delievery OTP Server is alive.");
});

// Send OTP
app.post('/send-otp', async function(req, res) {
  const orderId = req.body.orderId;
  const email = req.body.email;

  console.log('Incoming send-otp:', orderId, email);

  if (!orderId || !email) {
    return res.status(400).send({ success: false, message: 'Missing orderId or email.' });
  }

  const otp = generateOtp();
  const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60000)); // 10 mins

  try {
    await db.collection('otps').doc(orderId).set({ otp: otp, email: email, expiresAt: expiresAt });
    console.log('Saved OTP for order:', orderId);

    await transporter.sendMail({
      from: '"Toshan Bakery 🍞" <contact@toshankanwar.website>',
      to: email,
      subject: '🧾 Your OTP for Toshan Bakery Order',
      html: getOtpEmailBody(orderId, otp),
    });

    console.log('OTP sent to', email);
    return res.send({ success: true });

  } catch (err) {
    console.error('Error sending OTP:', err);
    return res.status(500).send({ success: false, message: 'Failed to send OTP' });
  }
});

// Verify OTP
app.post('/verify-otp', async function(req, res) {
  const orderId = req.body.orderId;
  const otp = req.body.otp;

  console.log('Incoming verify-otp:', orderId, otp);

  if (!orderId || !otp) {
    return res.status(400).send({ valid: false, error: 'orderId and otp are required.' });
  }

  try {
    const otpDoc = await db.collection('otps').doc(orderId).get();

    if (!otpDoc.exists) {
      console.warn('No OTP record for', orderId);
      return res.send({ valid: false });
    }

    const data = otpDoc.data();
    const now = new Date();
    const expiresAt = data.expiresAt.toDate();

    console.log('Stored OTP:', data.otp, '| Expires:', expiresAt.toISOString());

    if (data.otp === otp && expiresAt > now) {
      await otpDoc.ref.delete();

      const orderRef = db.collection('orders').doc(orderId);
      await orderRef.update({
        delivered: true,
        orderStatus: 'delivered',
        paymentStatus: 'confirmed',
      });

      const updatedOrder = await orderRef.get();
      const orderData = updatedOrder.data();
      const orderObj = { id: orderId, ...orderData };

      await transporter.sendMail({
        from: '"Toshan Bakery 🍰" <contact@toshankanwar.website>',
        to: data.email,
        subject: '✅ Your Toshan Bakery Order has been Delivered!',
        html: getDeliveryEmail(orderObj),
      });

      console.log('OTP verified and delivery email sent.');
      return res.send({ valid: true });
    } else {
      console.warn('OTP invalid or expired.');
      return res.send({ valid: false });
    }
  } catch (err) {
    console.error('Error in verify-otp:', err);
    return res.status(500).send({ valid: false, error: 'Internal server error' });
  }
});

/* ========== NEW ORDER NOTIFICATION LOGIC ========== */

// Track last checked time
let lastChecked = Date.now();

async function checkForNewConfirmedOrders() {
  try {
    const snapshot = await db.collection('orders')
      .where('timestamp', '>=', lastChecked)
      .get();

    const newOrders = [];
    snapshot.forEach(docSnap => {
      const order = docSnap.data();
      if (order.orderStatus && order.orderStatus.toLowerCase() === 'confirmed') {
        newOrders.push({ id: docSnap.id, ...order });
      }
    });

    if (newOrders.length > 0) {
      const tokenDocs = await db.collection('adminTokens').get();
      const tokens = tokenDocs.docs
        .map(d => d.data()?.expoPushToken)
        .filter(Boolean);

      for (const order of newOrders) {
        const customer = order.address?.name || order.userEmail || 'Customer';
        const amount = typeof order.total === 'number' ? order.total.toFixed(2) : '0.00';
        await Promise.all(tokens.map(token =>
          sendPushNotification(
            token,
            'New Order Confirmed 🧁',
            `${customer} — ₹${amount}`,
            { screen: 'OrdersScreen', orderId: order.id }
          )
        ));
        console.log(`🔔 Notified admins about new order ${order.id}`);
      }
    }

    lastChecked = Date.now();
  } catch (err) {
    console.error('Error checking for new orders:', err);
  }
}

// Poll every 30 seconds
setInterval(checkForNewConfirmedOrders, 30 * 1000);

// ✅ Self-ping every 5 minutes
const SELF_URL = "https://delivery-app-otp-verifier.onrender.com/"; // Replace with your actual Render app URL
setInterval(() => {
  fetch(SELF_URL)
    .then(res => res.text())
    .then(() => console.log("🔁 Self pinged server at /(root):", new Date().toLocaleTimeString()))
    .catch(err => console.error("🛑 Failed to self-ping:", err.message));
}, 5 * 60 * 1000); // every 5 minutes

// Start server
const PORT = 5000;
app.listen(PORT, function() {
  console.log('✅ OTP server running on port', PORT);
});
