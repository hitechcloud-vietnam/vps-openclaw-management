# Messaging Channels Connection

## Table of Contents

- [Overview](#overview)
- [1. Telegram Bot](#1-telegram-bot)
- [2. Discord Bot](#2-discord-bot)
- [3. Zalo OA](#3-zalo-oa)
- [4. Slack Bot](#4-slack-bot)
- [5. View Channel Status](#5-view-channel-status)
- [6. Remove a Channel](#6-remove-a-channel)

---

## Overview

OpenClaw supports integration with 4 messaging platforms:

| Channel   | Environment Variable     | Status           |
|-----------|-------------------------|------------------|
| Telegram  | `TELEGRAM_BOT_TOKEN`    | Built-in         |
| Discord   | `DISCORD_BOT_TOKEN`     | Via plugin       |
| Zalo OA   | `ZALO_BOT_TOKEN`        | Via plugin       |
| Slack     | `SLACK_BOT_TOKEN`       | Via plugin       |

After connecting, users can chat with AI directly on these platforms.

---

## 1. Telegram Bot

### Step 1: Create a Bot on Telegram

1. Open Telegram, search for **@BotFather**
2. Send the command `/newbot`
3. Name your bot (e.g., `My OpenClaw Bot`)
4. Set a username for your bot (e.g., `my_openclaw_bot`)
5. BotFather will return a **Bot Token** like: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`

### Step 2: Connect the Bot to OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"}' \
  http://$VPS_IP:9998/api/channels/telegram
```

### Step 3: Verify

Open Telegram, find your new bot, and send a message. The bot will reply with AI.

### Advanced Options

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
    "dmPolicy": "open",
    "allowFrom": ["*"]
  }' \
  http://$VPS_IP:9998/api/channels/telegram
```

| Parameter    | Description                          | Default  |
|--------------|--------------------------------------|----------|
| `dmPolicy`   | Direct message policy: `"open"` (anyone can message) | `"open"` |
| `allowFrom`  | List of allowed users/groups: `["*"]` = everyone     | `["*"]`  |

---

## 2. Discord Bot

### Step 1: Create a Bot in Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Click **"New Application"** → name it → **"Create"**
3. Go to the **"Bot"** tab → **"Add Bot"**
4. Click **"Reset Token"** to get a Bot Token
5. Enable **Privileged Gateway Intents**:
   - `MESSAGE CONTENT INTENT`
   - `SERVER MEMBERS INTENT`

### Step 2: Invite the Bot to Your Server

1. Go to the **"OAuth2"** tab → **"URL Generator"**
2. Select the `bot` scope
3. Select permissions: `Send Messages`, `Read Message History`, `Read Messages/View Channels`
4. Copy the URL and open it in your browser to invite the bot

### Step 3: Connect the Bot to OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "your-discord-bot-token"}' \
  http://$VPS_IP:9998/api/channels/discord
```

> The Discord plugin will be automatically enabled when connected.

---

## 3. Zalo OA

### Step 1: Create a Zalo OA

1. Go to https://oa.zalo.me
2. Create an Official Account (or use an existing OA)
3. In the **"Management"** section → **"API"** to get the token

### Step 2: Connect to OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "your-zalo-oa-token"}' \
  http://$VPS_IP:9998/api/channels/zalo
```

> The Zalo plugin will be automatically enabled when connected.

---

## 4. Slack Bot

### Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. Name it and select your workspace

### Step 2: Configure the Bot

1. In **"OAuth & Permissions"**, add Bot Token Scopes:
   - `chat:write`
   - `channels:read`
   - `channels:history`
   - `im:read`
   - `im:history`
   - `im:write`
2. Click **"Install to Workspace"** → copy the **Bot User OAuth Token** (`xoxb-...`)
3. In **"Socket Mode"**, enable Socket Mode → create an **App-Level Token** (`xapp-...`)

### Step 3: Connect to OpenClaw

```bash
curl -X PUT \
  -H "Authorization: Bearer $MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token"
  }' \
  http://$VPS_IP:9998/api/channels/slack
```

> **Note:** Slack requires both `token` (Bot Token) and `appToken` (App-Level Token).

---

## 5. View Channel Status

```bash
curl -H "Authorization: Bearer $MGMT_KEY" http://$VPS_IP:9998/api/channels
```

Sample result:

```json
{
  "ok": true,
  "channels": {
    "telegram": {
      "configured": true,
      "enabled": true,
      "token": "12345678...wxYZ"
    },
    "discord": {
      "configured": false,
      "enabled": false,
      "token": null
    },
    "slack": {
      "configured": false,
      "enabled": false,
      "token": null
    },
    "zalo": {
      "configured": false,
      "enabled": false,
      "token": null
    }
  }
}
```

- `configured: true` — Token set AND enabled
- `enabled: true` — Enabled in config
- `token` — Displays first 8 + last 4 chars (middle hidden)

---

## 6. Remove a Channel

```bash
curl -X DELETE \
  -H "Authorization: Bearer $MGMT_KEY" \
  http://$VPS_IP:9998/api/channels/telegram
```

Result:

```json
{
  "ok": true,
  "channel": "telegram",
  "removed": true
}
```

The API will automatically:
- Remove the token from `.env` and config
- Disable the plugin (if any)
- Restart OpenClaw