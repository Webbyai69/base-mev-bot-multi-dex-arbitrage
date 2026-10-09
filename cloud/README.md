# Online dashboard on Cloudflare

The same dashboard you open at `http://localhost:8787`, reachable from your
phone or any computer at `https://base-arb-dashboard.<your-subdomain>.workers.dev`,
behind a Cloudflare Access login.

```
your PC (the bot, your keys) ── pushes every 4 s ──► Cloudflare Worker ◄── your browser (Access login)
```

- The bot keeps running on your PC. It **pushes** a copy of its dashboard data
  out to the Worker; nothing on Cloudflare can connect to your PC.
- What gets pushed is what the dashboard shows: opportunities, outcomes, rival
  trades, settings that aren't secret, and public addresses. Never
  `PRIVATE_KEY`, never RPC URLs, never `.env`.
- The online page has the same wallet panel; your wallet signs everything.
- The Worker's only control is **Stop sending** (live mode). The request waits
  on Cloudflare until the bot's next push picks it up, normally a few seconds.
  There is no remote resume: deleting the `STOP` file stays a step you take on your PC.
- The Worker refuses to show anything until Cloudflare Access is on and it can
  check your login (step 3), so a forgotten setting can't expose your bot.

It fits the Workers Free plan: the bot's pushes use about 22,000 requests a day
and an open dashboard about 1,200 an hour, against 100,000 a day.

## 1. Create the Worker from GitHub

In the Cloudflare dashboard: **Workers & Pages** › **Create** › **Import a
repository** (connect GitHub if asked, and give the Cloudflare app access to
`Webbyai69/base-mev-bot-multi-dex-arbitrage`). Then:

| setting | value |
|---|---|
| Project / Worker name | `base-arb-dashboard` (must match `name` in `cloud/wrangler.jsonc`) |
| Production branch | the branch the bot runs from, e.g. `upgrade/v3-multihop-flashblocks-liquidations` |
| Root directory | `cloud` |
| Build command | leave empty |
| Deploy command | `npx wrangler deploy` |

Deploy. Every push to that branch redeploys it. Opening the `workers.dev`
address now shows a setup page; that's expected until step 3.

## 2. Give it a secret for the bot's pushes

On your PC, make a random token:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Worker › **Settings** › **Variables and Secrets** › **Add**: type **Secret**,
name `INGEST_TOKEN`, value the token. Keep it for step 5.

## 3. Lock it with Cloudflare Access

1. Worker › **Settings** › **Domains & Routes** › `workers.dev` › **Enable
   Cloudflare Access**. Then **Manage Cloudflare Access** and make sure the
   policy allows only your email address.
2. Copy your **team domain** from **Zero Trust** › **Settings** (it ends in
   `.cloudflareaccess.com`).
3. In **Zero Trust** › **Access controls** › **Applications**, open the
   `base-arb-dashboard` application and copy its **Application Audience (AUD) Tag**.
4. Worker › **Settings** › **Variables and Secrets**: add `ACCESS_TEAM_DOMAIN`
   (the team domain) and `ACCESS_AUD` (the tag). These stay in place across
   deploys (`keep_vars` in `wrangler.jsonc`).

The Worker checks the signed Access token on every request (signature, issuer,
expiry and audience), so even if Access were switched off by mistake, the
dashboard would stay closed.

## 4. Let the bot through Access

Access now protects the whole address, including the bot's pushes, so the bot
needs a service token:

1. **Zero Trust** › **Access controls** › **Service credentials** › **Service
   Tokens** › **Create service token**, named `base-arb-bot`. Copy the
   **Client ID** and **Client Secret**; the secret is shown only once.
2. Open the `base-arb-dashboard` application › **Policies** › add a policy:
   action **Service Auth**, include **Service Token** = `base-arb-bot`.

## 5. Point the bot at it

Add to the bot's `.env` on your PC, then restart the bot:

```
CLOUD_URL=https://base-arb-dashboard.<your-subdomain>.workers.dev
CLOUD_TOKEN=<the INGEST_TOKEN from step 2>
CLOUD_ACCESS_CLIENT_ID=<Client ID from step 4>
CLOUD_ACCESS_CLIENT_SECRET=<Client Secret from step 4>
```

The bot's log shows `online dashboard: pushing to https://…`. Open the address
on your phone: Access emails you a one-time code, and the dashboard fills in
within a few seconds.

## Troubleshooting

| you see | meaning |
|---|---|
| the setup page | `ACCESS_TEAM_DOMAIN` isn't set on the Worker (step 3) |
| "Sign in through Cloudflare Access" | Access is off, or the token doesn't match `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` |
| "Waiting for your PC's first update" | the bot isn't pushing: look for `online dashboard: push failed` in its log |
| `push failed (… refused CLOUD_TOKEN …)` | `CLOUD_TOKEN` differs from the Worker's `INGEST_TOKEN` |
| `push failed (… login page …)` or `(… Access refused …)` | the service token or its Service Auth policy (step 4) |
| `push failed (HTTP 503 …)` | `INGEST_TOKEN` isn't set on the Worker (step 2) |
| "PC offline for …" | no push for 30 s: the bot stopped, or the PC is asleep or offline |
| build fails with a name mismatch | the Worker must be called `base-arb-dashboard` |

## Files

| file | what |
|---|---|
| `src/worker.js` | entry point; bundles `../ui/dashboard.html` so the online page always matches the local one |
| `src/app.js` | routes, the Access token check, and the `BotMirror` Durable Object that holds the latest data |
| `wrangler.jsonc` | Worker config: the Durable Object (SQLite, works on the Free plan), `workers.dev` only, no preview URLs |
| `../src/cloud.ts` | the bot's side: the pushes and the stop request |

Tests: `test/cloud.test.js` runs the Worker and the Durable Object under Node
(ingest token, Access token checks, live feed, stop round trip, balance reads,
and the bot → Worker → page path). `npm test` includes it.
