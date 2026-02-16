# Heimdall
![Heimdall banner](./site/heimdall.png)

The all-seeing GitHub PR guardian that filters AI slop and low-effort contributions. Install it on any org or repo — no workflow files needed in target repositories.

## What It Does

- Listens to `pull_request` webhooks and triages on every PR open, edit, sync, or reopen.
- Applies/removes managed labels:
  - `triage:low-effort`
  - `triage:ai-slop`
- Posts one explainable triage comment showing the score breakdown, and updates it on each run.
- Supports a maintainer override label (`reviewed-by-human`) to skip triage for a specific PR.
- Bypasses trusted authors (e.g. `dependabot[bot]`) and trusted title patterns (e.g. `^docs:`).

---

## Setup

### Prerequisites

- Node.js >= 20
- A GitHub account
- [smee.io](https://smee.io) channel (for local development only)

### Step 1: Create a GitHub App

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
   - Direct link: `https://github.com/settings/apps/new`

2. Fill in the basics:
   - **GitHub App name**: Choose any name (e.g. `heimdall`)
   - **Homepage URL**: Any URL (can be the repo URL)
   - **Webhook URL**:
     - For local dev: Your Smee channel URL (e.g. `https://smee.io/your-channel-id`)
     - For production: `https://<your-server>/api/github/webhooks`
   - **Webhook secret**: Generate a random string (e.g. `openssl rand -hex 20`) — save this for later

3. Set **Repository permissions**:
   - **Issues**: Read and write
   - **Pull requests**: Read and write
   - **Metadata**: Read-only (auto-selected)

4. Subscribe to events:
   - Check **Pull request**

5. Click **Create GitHub App**

6. After creation, note the **App ID** shown at the top of the app settings page.

7. Scroll down and click **Generate a private key**. A `.pem` file will download — keep this safe.

### Step 2: Install the App

1. Go to your app's page: `https://github.com/settings/apps/<your-app-name>`
2. Click **Install App** in the sidebar
3. Choose the account/org and select either **All repositories** or **Only select repositories**
4. Click **Install**

---

## Running Locally

### 1. Set up Smee webhook forwarding

[Smee](https://smee.io) forwards GitHub webhooks to your local machine.

```bash
# Create a channel at https://smee.io — copy the URL

# Install the Smee client
npm install -g smee-client

# Start forwarding (keep this running in a separate terminal)
smee --url https://smee.io/<your-channel-id> --target http://localhost:3000/api/github/webhooks
```

Make sure the **Webhook URL** in your GitHub App settings is set to your Smee channel URL.

### 2. Configure environment variables

Create a `.env` file in the project root:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...<paste your PEM content here with newlines escaped as \n>...-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret
PORT=3000
```

To convert your `.pem` file into a single-line value:

```bash
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' path/to/your-private-key.pem
```

Copy the output and paste it as the value for `GITHUB_APP_PRIVATE_KEY` (wrapped in double quotes).

### 3. Start the server

```bash
npm install
npm test          # verify tests pass
npm run build     # syntax check

# Load .env and start
set -a; source .env; set +a; npm start
```

You should see:

```
GitHub App webhook server listening on port 3000.
```

### 4. Test it

Open, edit, or reopen a pull request in a repo where the app is installed. The server will log the triage result with a full score breakdown:

```
Triage completed for owner/repo#1
  low-effort: 53/100 (threshold 40, flagged=true)
    findings: minimal-description (+28), generic-title (+10), trivial-change (+15)
  ai-slop:    8/100 (threshold 45, flagged=false)
    findings: generic-title-ai-signal (+8)
  labels: triage:low-effort
```

---

## Deploying to a Remote Server

The app is a plain Node.js HTTP server. Deploy it anywhere that runs Node.js 20+.

### Option A: Railway / Render / Fly.io

These platforms auto-detect Node.js projects and run `npm start`.

1. Push your code to a GitHub repo (make sure `.env` is in `.gitignore`)
2. Connect the repo to your platform
3. Set the three required environment variables in the platform dashboard:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_WEBHOOK_SECRET`
4. Deploy — the platform gives you a public URL (e.g. `https://your-app.up.railway.app`)
5. Update your GitHub App's **Webhook URL** to: `https://your-app.up.railway.app/api/github/webhooks`

### Option B: VPS / Docker

```bash
# Clone and install
git clone <your-repo-url>
cd prtool
npm install --production

# Set env vars (or use a .env file)
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
export GITHUB_WEBHOOK_SECRET=your-secret
export PORT=3000

# Run with a process manager
npx pm2 start src/server.js --name pr-triage
```

If using Docker, create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t pr-triage .
docker run -d -p 3000:3000 \
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..." \
  -e GITHUB_WEBHOOK_SECRET=your-secret \
  pr-triage
```

### After deploying

1. Update GitHub App **Webhook URL** to `https://<your-domain>/api/github/webhooks`
2. Ensure the Webhook secret matches `GITHUB_WEBHOOK_SECRET`
3. Test by opening or reopening a PR

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | App ID from your GitHub App settings page |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key (escaped `\n` supported) |
| `GITHUB_WEBHOOK_SECRET` | Must match the secret in your GitHub App webhook config |

### Optional (triage tuning)

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIAGE_AI_SLOP_THRESHOLD` | `45` | Score threshold (0-100) to flag AI-slop |
| `TRIAGE_LOW_EFFORT_THRESHOLD` | `40` | Score threshold (0-100) to flag low-effort |
| `TRIAGE_AI_SLOP_LABEL` | `triage:ai-slop` | Label name applied for AI-slop |
| `TRIAGE_LOW_EFFORT_LABEL` | `triage:low-effort` | Label name applied for low-effort |
| `TRIAGE_HUMAN_REVIEWED_LABEL` | `reviewed-by-human` | Label that disables triage for a PR |
| `TRIAGE_TRUSTED_AUTHORS` | `dependabot[bot],renovate[bot]` | CSV of authors to skip |
| `TRIAGE_TRUSTED_TITLE_REGEX` | `^docs:,^chore\(deps\):,^build\(deps\):` | CSV of title regex patterns to skip |
| `TRIAGE_MIN_FINDINGS` | `2` | Minimum number of findings required to apply a label |
| `PORT` | `3000` | Server listen port |

---

## How Scoring Works

Each PR is scored on two independent axes. A label is applied only when **both** conditions are met: `score >= threshold` AND `findings >= TRIAGE_MIN_FINDINGS`.

### Low-Effort Signals (max 100)

| Signal | Condition | Points |
|--------|-----------|--------|
| Minimal description | Body < 40 chars | +28 |
| Short description | Body < 120 chars | +15 |
| Generic title | Title matches common generic words or < 12 chars | +10 |
| No tests, large change | Source files, no tests, >= 300 lines | +24 |
| No tests, medium change | Source files, no tests, >= 6 files | +12 |
| Very wide PR | >= 25 files | +12 |
| Wide PR | >= 15 files | +7 |
| Very large PR | >= 1200 lines | +12 |
| Large PR | >= 500 lines | +7 |
| Trivial change | <= 10 lines, <= 2 files, body < 120 chars | +15 |

### AI-Slop Signals (max 100)

| Signal | Condition | Points |
|--------|-----------|--------|
| Generic title | Same as above | +8 |
| No tests, large change | Source files, no tests, >= 300 lines | +16 |
| All generic commits | >= 2 commits, 100% match generic pattern | +30 |
| Mostly generic commits | >= 2 commits, >= 60% match | +16 |
| Repetitive commits | >= 4 commits, < 60% unique | +10 |
| High churn/file | >= 8 files, >= 200 lines/file avg | +18 |
| Moderate churn/file | >= 5 files, >= 120 lines/file avg | +10 |
| Explicit AI disclosure | Body mentions AI generation | +20 |
| Generic metadata combo | >= 60% generic commits + body < 120 chars | +10 |

---

## Notes

- This service only reads PR metadata, changed file names, and commit messages via GitHub APIs.
- It never checks out or runs code from pull requests.
- The `reviewed-by-human` label removes all triage labels and deletes the triage comment.
