// Chai Lounge shop backend
// -------------------------------------------------------------
// SHOP / PAYMENTS
// 1. Frontend calls POST /api/create-order with { itemId, discordUserId }
// 2. Backend creates a Razorpay order and returns it to the frontend
// 3. Frontend opens Razorpay Checkout (supports UPI/QR/cards) with that order
// 4. Razorpay sends a signed webhook to POST /api/razorpay-webhook on payment
// 5. Backend verifies the signature, marks the order paid, and grants the
//    matching Discord role to the buyer automatically
//
// MEMBERS LIST
// GET /api/members returns everyone currently online, grouped under their
// highest "hoisted" Discord role (Admins, Regulars, etc — same grouping
// Discord itself uses in its member sidebar). This needs the bot, because
// role and presence data isn't available from a browser directly.
// -------------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { Client, GatewayIntentBits } = require('discord.js');

const PORT = process.env.PORT || 3000;
const DB_FILE = 'orders.json';

// ---------- shop catalogue (single source of truth, server-side) ----------
// Prices are in paise (₹1 = 100 paise) because Razorpay expects the smallest unit.
const SHOP_ITEMS = {
  custom_role_colour: { name: 'Custom Role Colour', amount: 4900, type: 'role', roleEnv: 'DISCORD_ROLE_CUSTOM_COLOUR' },
  regulars_badge:     { name: "Regular's Badge",     amount: 9900, type: 'role', roleEnv: 'DISCORD_ROLE_REGULAR_BADGE' },
  vip_voice_access:   { name: 'VIP Voice Access',     amount: 14900, type: 'role', roleEnv: 'DISCORD_ROLE_VIP_VOICE' },
  pin_message:        { name: 'Pin a Message — 24hrs', amount: 2900, type: 'notify' },
};

// ---------- storage (plain JSON file — no native build required, unlike
// better-sqlite3, which fails to install on some Windows setups) ----------
function loadOrders() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

// ---------- Razorpay client ----------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------- Discord bot ----------
// GuildPresences + GuildMembers are "privileged intents" — you must also
// turn them ON in the Discord Developer Portal → your app → Bot tab
// ("Server Members Intent" and "Presence Intent"), or login will fail.
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});
discord.once('ready', () => console.log(`Discord bot logged in as ${discord.user.tag}`));
discord.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  console.error('Discord login failed — role granting/member list will not work until this is fixed:', err.message);
});

async function grantRole(discordUserId, roleId) {
  const guild = await discord.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const member = await guild.members.fetch(discordUserId);
  await member.roles.add(roleId);
}

// For items that aren't a role (like a one-off "pin my message"), post a
// note in your orders channel so you know to go do it manually.
async function notifyOrdersChannel(text) {
  const channelId = process.env.ORDERS_CHANNEL_ID;
  if (!channelId) {
    console.log('ORDERS_CHANNEL_ID not set — order notification skipped:', text);
    return;
  }
  const channel = await discord.channels.fetch(channelId);
  await channel.send(text);
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

    const orders = loadOrders();
    orders[order.id] = {
      itemId,
      discordUserId,
      amount: item.amount,
      status: 'created',
      createdAt: new Date().toISOString(),
    };
    saveOrders(orders);

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
  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json({ status: order.status });
});

async function handlePaidOrder(razorpayOrderId) {
  const orders = loadOrders();
  const order = orders[razorpayOrderId];

  if (!order) {
    console.warn(`No local order found for ${razorpayOrderId}`);
    return;
  }
  if (order.status === 'fulfilled') return; // already handled, webhook can retry

  const item = SHOP_ITEMS[order.itemId];

  if (item.type === 'role') {
    const roleId = process.env[item.roleEnv];
    await grantRole(order.discordUserId, roleId);
    console.log(`Granted "${item.name}" to Discord user ${order.discordUserId}`);
  } else if (item.type === 'notify') {
    await notifyOrdersChannel(
      `🧾 New order: **${item.name}** paid for by <@${order.discordUserId}> — needs manual action.`
    );
    console.log(`Notified orders channel for "${item.name}" from Discord user ${order.discordUserId}`);
  }

  order.status = 'fulfilled';
  orders[razorpayOrderId] = order;
  saveOrders(orders);
}

// ---------- live members, grouped by their highest hoisted role ----------
// "Hoisted" = the role has "Display role members separately" turned on in
// Discord (Server Settings → Roles) — that's what makes a role show up as
// its own header in Discord's own member list, and we mirror that here.
app.get('/api/members', async (req, res) => {
  try {
    const guild = await discord.guilds.fetch(process.env.DISCORD_GUILD_ID);
    await guild.members.fetch(); // populates the member cache, including presences
    const roles = await guild.roles.fetch();

    const hoistedRoles = [...roles.values()]
      .filter((r) => r.hoist && r.name !== '@everyone')
      .sort((a, b) => b.position - a.position); // highest role first

    const groups = hoistedRoles.map((r) => ({
      roleId: r.id,
      roleName: r.name,
      color: r.hexColor === '#000000' ? '#d8a63d' : r.hexColor,
      members: [],
    }));
    const fallback = { roleId: null, roleName: 'Online', color: '#d8a63d', members: [] };

    let onlineCount = 0;

    guild.members.cache.forEach((member) => {
      const status = member.presence?.status;
      if (!status || status === 'offline') return; // only show online members
      onlineCount++;

      const memberEntry = {
        username: member.displayName,
        avatar: member.user.displayAvatarURL({ extension: 'png', size: 64 }),
        status, // 'online' | 'idle' | 'dnd'
      };

      const topHoisted = hoistedRoles.find((r) => member.roles.cache.has(r.id));
      const bucket = topHoisted
        ? groups.find((g) => g.roleId === topHoisted.id)
        : fallback;
      bucket.members.push(memberEntry);
    });

    const result = [...groups, fallback].filter((g) => g.members.length > 0);
    res.json({ groups: result, onlineCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not fetch members' });
  }
});

app.listen(PORT, () => console.log(`Shop backend running on http://localhost:${PORT}`));
