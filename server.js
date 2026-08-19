// Chai Lounge shop backend
// -------------------------------------------------------------
// 1. Frontend calls POST /api/create-order with { itemId, discordUserId }
// 2. Backend creates a Razorpay order and returns it to the frontend
// 3. Frontend opens Razorpay Checkout (supports UPI/QR/cards) with that order
// 4. Razorpay sends a signed webhook to POST /api/razorpay-webhook on payment
// 5. Backend verifies the signature, marks the order paid, and grants the
//    matching Discord role to the buyer automatically
// -------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const Database = require('better-sqlite3');
const { Client, GatewayIntentBits } = require('discord.js');

const PORT = process.env.PORT || 3000;

// ---------- shop catalogue (single source of truth, server-side) ----------
// Prices are in paise (₹1 = 100 paise) because Razorpay expects the smallest unit.
const SHOP_ITEMS = {
  custom_role_colour: { name: 'Custom Role Colour', amount: 4900, roleEnv: 'DISCORD_ROLE_CUSTOM_COLOUR' },
  regulars_badge:     { name: "Regular's Badge",     amount: 9900, roleEnv: 'DISCORD_ROLE_REGULAR_BADGE' },
  vip_voice_access:   { name: 'VIP Voice Access',     amount: 14900, roleEnv: 'DISCORD_ROLE_VIP_VOICE' },
};

// ---------- storage (a tiny local SQLite file, fine for a small shop) ----------
const db = new Database('orders.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    razorpay_order_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- Razorpay client ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------- Discord bot ----------
const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
discord.once('ready', () => console.log(`Discord bot logged in as ${discord.user.tag}`));
discord.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  console.error('Discord login failed — role granting will not work until this is fixed:', err.message);
});

async function grantRole(discordUserId, roleId) {
  const guild = await discord.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const member = await guild.members.fetch(discordUserId);
  await member.roles.add(roleId);
}

// ---------- app ----------
const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));

// IMPORTANT: the webhook route needs the raw request body to verify the
// signature, so it's registered with express.raw() BEFORE the global
// express.json() middleware touches it.
app.post(
  '/api/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // raw Buffer
      .digest('hex');

    if (signature !== expected) {
      console.warn('Webhook signature mismatch — ignoring request');
      return res.status(400).send('invalid signature');
    }

    const event = JSON.parse(req.body.toString('utf8'));

    if (event.event === 'payment.captured') {
      const orderId = event.payload.payment.entity.order_id;
      handlePaidOrder(orderId).catch((err) =>
        console.error(`Failed to fulfil order ${orderId}:`, err)
      );
    }

    // Acknowledge quickly — Razorpay retries if it doesn't get a 200
    res.status(200).send('ok');
  }
);

app.use(express.json());

// Create a Razorpay order for a shop item
app.post('/api/create-order', async (req, res) => {
  try {
    const { itemId, discordUserId } = req.body;
    const item = SHOP_ITEMS[itemId];

    if (!item) return res.status(400).json({ error: 'unknown item' });
    if (!discordUserId) return res.status(400).json({ error: 'discordUserId is required' });

    const order = await razorpay.orders.create({
      amount: item.amount,
      currency: 'INR',
      notes: { itemId, discordUserId },
    });

    db.prepare(
      `INSERT INTO orders (razorpay_order_id, item_id, discord_user_id, amount) VALUES (?, ?, ?, ?)`
    ).run(order.id, itemId, discordUserId, item.amount);

    res.json({
      orderId: order.id,
      amount: item.amount,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID, // safe to expose, it's the public key
      itemName: item.name,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not create order' });
  }
});

// Let the frontend poll for fulfilment status after checkout closes
app.get('/api/order-status/:orderId', (req, res) => {
  const row = db
    .prepare(`SELECT status FROM orders WHERE razorpay_order_id = ?`)
    .get(req.params.orderId);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ status: row.status });
});

async function handlePaidOrder(razorpayOrderId) {
  const order = db
    .prepare(`SELECT * FROM orders WHERE razorpay_order_id = ?`)
    .get(razorpayOrderId);

  if (!order) {
    console.warn(`No local order found for ${razorpayOrderId}`);
    return;
  }
  if (order.status === 'fulfilled') return; // already handled, webhook can retry

  const item = SHOP_ITEMS[order.item_id];
  const roleId = process.env[item.roleEnv];

  await grantRole(order.discord_user_id, roleId);

  db.prepare(`UPDATE orders SET status = 'fulfilled' WHERE razorpay_order_id = ?`).run(
    razorpayOrderId
  );

  console.log(`Granted "${item.name}" to Discord user ${order.discord_user_id}`);
}

app.listen(PORT, () => console.log(`Shop backend running on http://localhost:${PORT}`));
