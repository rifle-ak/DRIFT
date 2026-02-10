# 🌊 DRIFT — Discord Relay Into Forum Threads

Migrate Discord text channels into forum posts, preserving **messages, attachments, author attribution, and timestamps**. Built for consolidating channel-per-user setups (like artist portfolios) into a single organized forum.

## How It Works

1. **Fetches** all messages from a text channel (oldest → newest)
2. **Creates** a forum post with a header showing migration metadata
3. **Replays** each message using a webhook — preserves the original author's name and avatar
4. **Downloads and re-uploads** attachments so they survive channel deletion
5. **Optionally locks** the source channel with a redirect notice

The source channel is **never deleted** — that's always a manual step after human verification.

## Commands

| Command | Description |
|---------|-------------|
| `/drift` | Migrate a single channel to a forum post |
| `/drift-category` | Migrate **all** channels in a category to individual forum posts |
| `/drift-preview` | Dry run — shows message counts, attachment sizes, estimated time |

### `/drift` Options

| Option | Required | Description |
|--------|----------|-------------|
| `channel` | ✅ | Source text channel |
| `forum` | ✅ | Target forum channel |
| `post-name` | ❌ | Custom forum post title (defaults to channel name, title-cased) |
| `tag` | ❌ | Forum tag to apply (must already exist) |
| `pins-only` | ❌ | Only migrate pinned messages |
| `archive-source` | ❌ | Lock the source channel after migration |

### `/drift-category` Options

| Option | Required | Description |
|--------|----------|-------------|
| `category` | ✅ | Source category containing channels |
| `forum` | ✅ | Target forum channel |
| `tag` | ❌ | Forum tag for all posts |
| `archive-source` | ❌ | Lock each channel after its migration |
| `preview` | ❌ | List channels without migrating |

## Setup

### 1. Create a Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application**, name it (e.g., "DRIFT")
3. Go to **Bot** → Click **Reset Token** → **Copy the token**
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** ✅
   - **Server Members Intent** ✅ (optional, improves display name resolution)
5. Go to **OAuth2** → Copy the **Client ID**

### 2. Invite the Bot

Use this URL pattern (replace `CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=536874064
```

Permission bits included: View Channels, Send Messages, Read Message History, Manage Webhooks, Create Public Threads, Attach Files, Use External Emojis.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-client-id
GUILD_ID=your-server-id    # for instant command registration during testing
```

### Staff Permissions

By default only users with **Manage Server** permission can use DRIFT commands. To allow additional staff members, add their role or user IDs to `.env`:

```
# Allow anyone with these roles to use DRIFT (comma-separated role IDs)
STAFF_ROLE_IDS=1234567890,9876543210

# Allow these specific users to use DRIFT (comma-separated user IDs)
STAFF_USER_IDS=1111111111
```

A user is authorised if **any** of these are true:
- They have the Manage Server permission, **or**
- They have a role listed in `STAFF_ROLE_IDS`, **or**
- Their user ID is listed in `STAFF_USER_IDS`

> **Tip:** Right-click a role or user in Discord and select **Copy ID** (requires Developer Mode enabled in Discord settings).

### 4. Install & Deploy Commands

```bash
npm install
node deploy-commands.js
```

### 5. Run

```bash
npm start
```

## Bot Permissions Required

The bot needs these permissions in both the source channel and target forum:

| Permission | Where | Why |
|------------|-------|-----|
| View Channel | Source + Forum | Read messages / post |
| Read Message History | Source | Fetch old messages |
| Send Messages | Source + Forum | Post redirect notice / header |
| Manage Webhooks | Forum | Create webhook for author attribution |
| Create Public Threads | Forum | Create forum posts |
| Attach Files | Forum | Re-upload attachments |

## What Gets Migrated

| Content | Status |
|---------|--------|
| Text messages | ✅ Preserved |
| Images / files | ✅ Downloaded and re-uploaded |
| Author name + avatar | ✅ Via webhook |
| Timestamps | ✅ Discord timestamp format (localized) |
| Rich embeds (from bots) | ✅ Preserved |
| Link previews | ✅ Auto-generated from URLs |
| Reply indicators | ⚠️ Noted as "replying to earlier message" (can't link to new msg IDs) |
| Stickers | ⚠️ Noted by name (can't re-send via webhook) |
| Reactions | ❌ Not preserved (API limitation) |
| System messages | ❌ Skipped (joins, pins, boosts) |
| Thread content | ❌ Sub-threads not migrated (main channel only) |

## Rate Limits & Timing

- Default delay between messages: **1.5 seconds** (configurable via `RATE_LIMIT_DELAY`)
- Default delay between channels in bulk mode: **30 seconds** (configurable via `BULK_CHANNEL_DELAY`)
- A channel with 500 messages takes approximately **12–15 minutes**
- Bulk migration of a category with 50 channels × 100 messages ≈ **2–3 hours**
- DRIFT handles Discord rate limits automatically with retry logic

## Bulk Migration Tips

When running `/drift-category`:

1. **Preview first** — use `preview: true` to see what you're about to migrate
2. **Create a "Migrated" tag** on your forum before starting — pass it as `tag: Migrated` so all migrated posts are easy to identify
3. **Run during off-peak hours** — less chance of rate limit issues
4. **DRIFT creates a log thread** in the channel where you run the command, showing real-time progress for each channel
5. **If it crashes mid-bulk** — already-migrated channels are done, just run again for the remaining ones
6. **Source channels are never deleted** — verify each forum post, then clean up old channels on your own schedule

## Architecture

```
drift/
├── bot.js                 # Bot entry point, command handlers
├── deploy-commands.js     # Slash command registration
├── lib/
│   └── migrator.js        # Core migration engine
├── package.json
├── .env.example
└── README.md
```

The migration engine (`lib/migrator.js`) is decoupled from the bot commands (`bot.js`) so it can be imported into an existing bot if needed.

## Troubleshooting

**"Bot lacks permissions"** — Double-check the bot's role has the permissions listed above in both the source channel and target forum. Channel-level permission overrides can block the bot even if the role has global permissions.

**"Tag not found"** — The tag must already exist on the forum channel. Create it manually in Discord first.

**Rate limit errors** — Increase `RATE_LIMIT_DELAY` in `.env` (try 2500 or 3000).

**Migration seems stuck** — Check the console. DRIFT logs every message. If you see `[RETRY FAILED]` messages, you're hitting rate limits hard. Increase the delay.

**Interaction expired (15 min)** — For very large channels, the progress updates in the slash command reply will stop working after 15 minutes, but the migration continues. Check the console or log thread for progress.

**Attachments show as "Could not download"** — The original attachment CDN URLs may have expired. This is rare for recent messages but can happen with very old channels.

## License

MIT — do whatever you want with it.
