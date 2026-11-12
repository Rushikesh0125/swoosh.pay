# swoosh.pay

Start a PayPal Sandbox commission payment by entering a Discord username on the web or selecting a user with `/pay` in a Discord DM.

## Run locally

Use Node.js 22.13 or later. Copy `.env.example` to `.env`, fill in the configuration below, then run `npm start` and open [swoosh.pay](http://localhost:8787). The server uses SQLite and writes to `data/handlepay.db`. Back the database with a persistent volume if hosting the server.

## Cloudflare Sandbox deployment

The [hosted app](https://handlepay-sandbox.jadhav-rushikesh-ggl.workers.dev) uses a dedicated D1 database. Deploy with `npx wrangler@4.156.0 d1 migrations apply DB --remote` and `npx wrangler@4.156.0 deploy`. Set provider credentials with Wrangler secrets. Adding a value to local `.env` does not set it on the deployed Worker.

- PayPal webhook URL is `https://handlepay-sandbox.jadhav-rushikesh-ggl.workers.dev/paypal/webhooks`. After creating it on the Sandbox Platform app, run `npx wrangler@4.156.0 secret put PAYPAL_WEBHOOK_ID` and enter its ID.
- Discord OAuth redirect URL is `https://handlepay-sandbox.jadhav-rushikesh-ggl.workers.dev/auth/discord/callback`.
- Discord interactions endpoint is `https://handlepay-sandbox.jadhav-rushikesh-ggl.workers.dev/discord/interactions`. Set the four Discord secrets on the Worker before Discord validates the endpoint.

### Discord

1. Create a Discord application with a bot and enable **User Install** with the `applications.commands` scope.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`. The bot token is also used to check current usernames before resolving handle-only requests.
3. Register `APP_ORIGIN/auth/discord/callback` as an OAuth2 redirect. Run `npm run discord:register`.
4. For commands and shareable invites, serve the app at a reachable HTTPS origin and set it as `APP_ORIGIN`. Set Discord's **Interactions Endpoint URL** to `APP_ORIGIN/discord/interactions`. The server listens on loopback by default. Use `HOST` to set a different bind address when the host requires it.
5. Install the app on the sender's Discord account, then run `/pay recipient:@pixelnova amount:60` in a DM. The response opens a sender-only review page.

[Discord application commands](https://docs.discord.com/developers/docs/interactions/application-commands) · [Interaction signature verification](https://docs.discord.com/developers/interactions/receiving-and-responding)

### PayPal Sandbox

Use a PayPal Platforms-enabled Sandbox application with permission to use Partner Referrals and multiparty checkout. Configure `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PARTNER_MERCHANT_ID`, and `PAYPAL_PARTNER_BN_CODE`. The buyer and recipient use separate Sandbox accounts.

For automatic reconciliation, register `APP_ORIGIN/paypal/webhooks` under **Sandbox Webhooks** on the same Platform app. Subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, and `PAYMENT.CAPTURE.REFUNDED`. Set `PAYPAL_WEBHOOK_ID` to the ID of that endpoint. PayPal needs a reachable HTTPS URL. The payment review page can check the order directly during local development.

`BUYLIST_ENV_FILE` optionally reads the local Buylist PayPal client ID and secret without copying them into this checkout. The Buylist Sandbox client authenticated, but the partner seller lookup returned `403 NOT_AUTHORIZED` during setup. Its direct Checkout configuration does not establish multiparty access.

[PayPal Platforms setup](https://developer.paypal.com/platforms/get-started) · [PayPal immediate capture](https://developer.paypal.com/platforms/checkout/immediate-capture) · [PayPal webhook setup](https://developer.paypal.com/api/rest/webhooks/rest/)

## Payment flow

- Both entry points persist the same kind of USD payment request. Discord passes a stable account ID. The web route looks up a linked username and verifies it through Discord before binding it.
- For an unlinked recipient, the sender copies a seven-day setup invite into the DM. The recipient signs in with Discord and connects PayPal. Handle-only invites require a current username match and bind to the authenticated account ID on acceptance. Discord-selected invites require the selected account ID.
- When `/pay` targets a recipient who already connected PayPal, the sender-only reply has a **Pay with PayPal** button that goes straight to PayPal approval through `/checkout/:id`. PayPal returns to `/paypal/return/:id`, which captures the approved order immediately and edits the original Discord reply with the receipt. The interaction token is stored for 14 minutes for that edit. Apply `migrations/0003_discord_fast_pay.sql` before deploying.
- Otherwise the sender reviews the bound account and amount, then opens PayPal. The server creates an order for the verified seller. On return, the sender completes capture. Status refresh retrieves the order from PayPal. Verified, deduplicated capture webhooks reconcile asynchronous changes. PayPal APIs use Sandbox endpoints throughout.
- The current scope is the web app and Discord. Telegram is future scope. This build has no AI feature and does not yet meet the hackathon's AI requirement.

## Verify

Run `npm test` for HTTP integration tests with simulated Discord and PayPal responses. For Sandbox acceptance, use two Discord accounts and two PayPal Sandbox accounts. Create a DM request for an unlinked recipient, verify that a different Discord account cannot claim it, onboard the intended recipient, and check the final capture and receiving merchant in PayPal. Repeat from the web form against the now-linked username.
