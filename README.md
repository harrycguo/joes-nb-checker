# Joe's New Balance Stock Checker

Node.js + Playwright checker for a Joe's New Balance product page. It only checks whether a target size appears available and sends notifications. It does not automate checkout, purchasing, carting, login, CAPTCHA bypassing, or any other aggressive behavior.

The default target size is `Womens 7`.

## Local Setup

1. Install Node.js 22.
2. Install dependencies:

```sh
npm install
```

3. Install the Playwright Chromium browser:

```sh
npm run install:browsers
```

4. Copy the example environment file and fill in your product URL:

```sh
cp .env.example .env
```

5. Run one check:

```sh
npm run check
```

Useful environment variables:

- `PRODUCT_URL`: required Joe's New Balance product page URL.
- `TARGET_SIZE`: optional, defaults to `Womens 7`.
- `PRODUCT_VARIATION_URL`: optional direct Product-Variation JSON endpoint. The checker derives this for Joe's product URLs when possible.
- `DISCORD_WEBHOOK_URL`: optional Discord webhook.
- `RESEND_API_KEY`, `EMAIL_TO`, `EMAIL_FROM`: optional Resend email settings.
- `DEBUG_STOCK_CHECKER=true`: optional verbose logging.

When running locally, the checker writes `.last-status.json` to reduce duplicate notifications while the same product and size remain available. GitHub Actions runs are stateless, so they may notify on every scheduled run while the size appears available.

## GitHub Actions Setup

The workflow in `.github/workflows/check-stock.yml` runs every 10 minutes and also supports manual runs with `workflow_dispatch`.

To configure it:

1. Push this repo to GitHub.
2. Open the repo on GitHub.
3. Go to `Settings` -> `Secrets and variables` -> `Actions`.
4. Add these repository secrets:

- `PRODUCT_URL`: required product page URL.
- `TARGET_SIZE`: optional, for example `Womens 7`.
- `DISCORD_WEBHOOK_URL`: optional.
- `RESEND_API_KEY`: optional.
- `EMAIL_TO`: optional.
- `EMAIL_FROM`: optional.

GitHub cron schedules are not exact to the second and can be delayed. Keep the interval reasonable; 10 minutes is a respectful default for this kind of availability check.

## Discord Webhook

1. In Discord, open the server settings for the server you control.
2. Go to `Integrations` -> `Webhooks`.
3. Create a webhook for the channel where alerts should appear.
4. Copy the webhook URL.
5. Add it as the GitHub secret `DISCORD_WEBHOOK_URL`, or put it in your local `.env`.

## Resend Email

1. Create or open a Resend account.
2. Verify the sending domain or use a sender address allowed by your Resend account.
3. Create an API key.
4. Set:

- `RESEND_API_KEY`: your Resend API key.
- `EMAIL_FROM`: verified sender address.
- `EMAIL_TO`: destination address.

If both Discord and Resend are configured, the checker sends both notifications.

## Manual Workflow Run

In GitHub:

1. Open the `Actions` tab.
2. Select `Check stock`.
3. Click `Run workflow`.

Locally:

```sh
npm run check
```

## How It Checks

The script first tries Joe's Product-Variation JSON endpoint and reads the `variationAttributes` size values. A size with `selectable: true` is treated as available. If that endpoint is unavailable, it falls back to opening `PRODUCT_URL` in Chromium, extracting likely size controls such as buttons, radio labels, ARIA options, and select options, then looking for labels similar to `Women's 7`, `Womens 7`, `W 7`, `Size 7`, or `7`.

It treats a matching size as unavailable when it sees signals such as `disabled`, `aria-disabled`, classes containing `disabled`, `unavailable`, `sold`, `out-of-stock`, or attributes like `data-disabled`, `data-available=false`, or `data-in-stock=false`.

Do not put browser session cookies, login tokens, cart cookies, or copied auth headers into GitHub secrets. The checker is intended for public availability signals only.

On failure, it saves `debug-page.png` for troubleshooting.
