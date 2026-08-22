# Chai Lounge Shop — Backend

Two things this backend does for chai-lounge.html:

1. **Real, verified checkout.** Buyer pays by UPI/card through Razorpay;
   their Discord role gets granted automatically the moment payment is
   captured — no manual screenshot-checking. Non-role items (like "Pin a
   Message") post a note in a Discord channel so you know to action it
   yourself.
2. **Live "who's online" list, grouped by role.** The Menu Board section
   on the site shows everyone currently online, grouped under their
   highest Discord role — Admins, Regulars, etc — sorted the same way
   your server's role list is ordered.

Both need this server running somewhere public, and both are already wired
up in `chai-lounge.html` — you just need to deploy this and point the site
at it.

## How checkout works

1. Visitor clicks "Buy" on the site → it calls `POST /api/create-order`.
2. Backend creates a Razorpay order, stores it in a local `orders.json`
   file (item, buyer's Discord user ID, status).
3. Razorpay Checkout opens in the browser (renders UPI/QR/cards itself —
   nothing to hardcode).
4. Razorpay charges the buyer, then calls `/api/razorpay-webhook` with a
   signed `payment.captured` event.
5. Backend verifies the signature is genuinely from Razorpay, looks up the
   order, then either grants the mapped Discord role or posts to your
   orders channel, depending on the item.

If `BACKEND_URL` in `chai-lounge.html` is still the placeholder, or this
server isn't reachable, the site automatically falls back to the old
manual "scan this QR, pay this UPI ID" modal — so the shop still works
while you're getting this set up.

## How the members list works

`GET /api/members` asks the bot for every currently-online member, finds
each one's highest **hoisted** role (the ones set to "Display role members
separately" in Discord), and groups them under that role's name — sorted
by the role's actual rank in your server. Anyone without a hoisted role
lands in a generic "Online" group at the end.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env — see below
npm start
```

### 1. Razorpay
- Sign up at razorpay.com, get **Key ID** and **Key Secret** from
  Settings → API Keys (start in Test Mode — this part is free, you're
  only charged a small % once a real payment goes through).
- Once deployed (step 4), go to Razorpay Dashboard → Settings → Webhooks
  and add:
  - URL: `https://your-deployed-url.com/api/razorpay-webhook`
  - Event: `payment.captured`
  - Set a secret there, and put that same value in `RAZORPAY_WEBHOOK_SECRET`.

### 2. Discord bot
- Create an application at discord.com/developers/applications, add a Bot,
  copy its token into `DISCORD_BOT_TOKEN`.
- On the same Bot tab, turn ON **Server Members Intent** and **Presence
  Intent** — required for the members list to see roles and status.
- Invite the bot to your server with the **Manage Roles** permission
  (OAuth2 → URL Generator → check "bot" scope + "Manage Roles" permission
  → open the generated link).
- In Server Settings → Roles, drag the bot's own role **above** every role
  it needs to grant — Discord blocks a bot from assigning a role ranked
  higher than itself.
- For roles you want their own header on the site (Admin, Regulars, etc),
  turn on **"Display role members separately"** for that role.
- Copy each target role's ID (enable Developer Mode in Discord → User
  Settings → Advanced, then right-click a role → Copy Role ID) into the
  matching `DISCORD_ROLE_*` line in `.env`.
- Copy your orders/notifications channel's ID (right-click the channel →
  Copy Channel ID) into `ORDERS_CHANNEL_ID`.

### 3. Deploy it somewhere public
Razorpay's webhook and your website both need a real, public URL to reach
this server — it can't stay on your own computer. Render's free tier
works well:
- Push these files to a GitHub repo (skip your real `.env` — only commit
  `.env.example`).
- On render.com: New → Web Service → connect the repo → build command
  `npm install`, start command `npm start`.
- Add every value from your real `.env` under Render's "Environment"
  settings, instead of committing the file.
- Deploy, then copy the live URL Render gives you (e.g.
  `https://chai-lounge-backend.onrender.com`).

### 4. Point the frontend at it
In `chai-lounge.html`, find:
```js
var BACKEND_URL = 'https://your-backend.example.com';
```
and replace it with your real deployed URL from step 3. That one line
switches on both the live members list and the real checkout flow.

## Notes

- `orders.json` is a plain JSON file on disk — fine for a small shop.
  Move to a real database if this grows a lot, since a JSON file isn't
  safe under heavy concurrent writes.
- Never expose `RAZORPAY_KEY_SECRET`, `DISCORD_BOT_TOKEN`, or
  `RAZORPAY_WEBHOOK_SECRET` to the frontend — only `RAZORPAY_KEY_ID`
  (returned as `keyId`) is safe to send to the browser.
- Test everything in Razorpay Test Mode before switching to live keys.
- Render's free tier sleeps after ~15 minutes idle — the first request
  after a quiet spell can take 30–50 seconds to wake up.
