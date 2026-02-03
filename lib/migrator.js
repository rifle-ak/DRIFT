// ─────────────────────────────────────────────────────────────────────────────
//  DRIFT — Discord Relay Into Forum Threads
//  lib/migrator.js — Core channel → forum post migration engine
// ─────────────────────────────────────────────────────────────────────────────
import { AttachmentBuilder, ChannelType } from 'discord.js';

const RATE_LIMIT_DELAY = parseInt(process.env.RATE_LIMIT_DELAY, 10) || 1500;
const PROGRESS_INTERVAL = 15;            // update progress every N messages
const MAX_FILE_SIZE    = 25 * 1024 * 1024; // 25 MB — standard bot upload cap
const MAX_CONTENT_LEN  = 2000;            // Discord message character limit

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Migrate a single text channel into a forum post.
 *
 * @param {Object} opts
 * @param {TextChannel}        opts.sourceChannel  - channel to migrate
 * @param {ForumChannel}       opts.forumChannel   - target forum
 * @param {string|null}        opts.postName       - custom post title (optional)
 * @param {string|null}        opts.tagName        - forum tag name to apply (optional)
 * @param {boolean}            opts.pinsOnly       - only migrate pinned messages
 * @param {boolean}            opts.archiveSource  - lock source channel afterwards
 * @param {ChatInputCommandInteraction} opts.interaction - for progress updates
 * @param {Guild}              opts.guild
 * @returns {Promise<MigrationResult>}
 */
export async function migrateChannel(opts) {
  const {
    sourceChannel, forumChannel, postName, tagName,
    pinsOnly, archiveSource, interaction, guild,
  } = opts;

  const startTime = Date.now();

  // ── Validate inputs ─────────────────────────────────────────────────
  if (sourceChannel.type !== ChannelType.GuildText) {
    throw new Error(`Source must be a text channel (got type ${sourceChannel.type})`);
  }
  if (forumChannel.type !== ChannelType.GuildForum) {
    throw new Error(`Target must be a forum channel (got type ${forumChannel.type})`);
  }

  // ── Permission checks ──────────────────────────────────────────────
  const me = guild.members.me;
  const srcPerms = sourceChannel.permissionsFor(me);
  const frmPerms = forumChannel.permissionsFor(me);

  const missing = [];
  if (!srcPerms.has('ViewChannel'))        missing.push('View Channel (source)');
  if (!srcPerms.has('ReadMessageHistory')) missing.push('Read Message History (source)');
  if (!frmPerms.has('SendMessages'))       missing.push('Send Messages (forum)');
  if (!frmPerms.has('ManageWebhooks'))     missing.push('Manage Webhooks (forum)');
  if (!frmPerms.has('CreatePublicThreads')) missing.push('Create Posts (forum)');
  if (missing.length > 0) {
    throw new Error(`Bot is missing permissions:\n• ${missing.join('\n• ')}`);
  }

  // ── Fetch messages ─────────────────────────────────────────────────
  await updateProgress(interaction, '📥 Fetching messages from source channel...');

  let messages;
  if (pinsOnly) {
    const pins = await sourceChannel.messages.fetchPinned();
    messages = [...pins.values()].reverse(); // oldest first
  } else {
    messages = await fetchAllMessages(sourceChannel, interaction);
  }

  if (messages.length === 0) {
    throw new Error('No messages found in the source channel.');
  }

  const totalAttachments = messages.reduce((n, m) => n + m.attachments.size, 0);
  await updateProgress(interaction,
    `📥 Found **${messages.length}** messages with **${totalAttachments}** attachments. Creating forum post...`);

  // ── Resolve forum tag ──────────────────────────────────────────────
  const appliedTags = [];
  if (tagName) {
    const tag = forumChannel.availableTags.find(t =>
      t.name.toLowerCase() === tagName.toLowerCase());
    if (tag) {
      appliedTags.push(tag.id);
    } else {
      const available = forumChannel.availableTags.map(t => t.name).join(', ') || '(none)';
      throw new Error(`Tag "${tagName}" not found on the forum. Available tags: ${available}`);
    }
  }

  // If the forum requires a tag and none was provided, try "Migrated" or use the first available
  if (forumChannel.availableTags.length > 0 && appliedTags.length === 0) {
    const migrated = forumChannel.availableTags.find(t =>
      t.name.toLowerCase() === 'migrated');
    if (migrated) appliedTags.push(migrated.id);
    // If no "Migrated" tag exists and tags are optional, that's fine. If required,
    // Discord will return an error and we'll catch it below.
  }

  // ── Determine post title ───────────────────────────────────────────
  const title = postName
    || sourceChannel.name
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

  // ── Build the OP (first message / header) ──────────────────────────
  const channelTopic = sourceChannel.topic ? `\n> 📝 ${sourceChannel.topic}` : '';
  const headerContent = [
    `# ${title}`,
    '',
    `> 📁 Migrated from <#${sourceChannel.id}>`,
    channelTopic,
    `> 📅 Channel created: <t:${Math.floor(sourceChannel.createdTimestamp / 1000)}:D>`,
    `> 🔄 Migrated: <t:${Math.floor(Date.now() / 1000)}:F>`,
    `> 💬 Messages: **${messages.length}**  ·  📎 Attachments: **${totalAttachments}**`,
    pinsOnly ? '> 📌 *Only pinned messages were migrated*' : '',
    '',
    '*This portfolio was automatically migrated by DRIFT (Discord Relay Into Forum Threads). All messages below are preserved with their original authors and timestamps.*',
  ].filter(Boolean).join('\n');

  // ── Create forum post ──────────────────────────────────────────────
  let thread;
  try {
    thread = await forumChannel.threads.create({
      name: title.substring(0, 100), // forum post title limit
      appliedTags,
      message: { content: headerContent },
    });
  } catch (err) {
    if (err.code === 50001) {
      throw new Error('Bot lacks access to create posts in the forum channel.');
    }
    throw new Error(`Failed to create forum post: ${err.message}`);
  }

  // ── Create webhook for author attribution ──────────────────────────
  let webhook;
  try {
    webhook = await forumChannel.createWebhook({
      name: 'DRIFT Migrator',
      reason: `DRIFT: migrating #${sourceChannel.name} → forum post "${title}"`,
    });
  } catch (err) {
    throw new Error(`Failed to create webhook: ${err.message}. Bot needs Manage Webhooks permission.`);
  }

  // ── Replay messages ────────────────────────────────────────────────
  let messageCount   = 0;
  let attachmentCount = 0;
  let skippedCount    = 0;
  let errorCount      = 0;

  try {
    for (const message of messages) {
      // Skip system messages (user joins, pins, boosts, etc.)
      if (message.system) {
        skippedCount++;
        messageCount++;
        continue;
      }

      // Skip completely empty messages (no content, no attachments, no embeds, no stickers)
      if (!message.content
          && message.attachments.size === 0
          && message.embeds.length === 0
          && message.stickers.size === 0) {
        skippedCount++;
        messageCount++;
        continue;
      }

      try {
        await sendMigratedMessage(webhook, thread.id, message);
        attachmentCount += message.attachments.size;
      } catch (err) {
        // Rate limited — back off and retry once
        if (err.status === 429 || err.code === 429) {
          const retryAfter = (err.retryAfter || 5) * 1000;
          console.warn(`Rate limited. Waiting ${retryAfter}ms before retry...`);
          await sleep(retryAfter + 500);

          try {
            await sendMigratedMessage(webhook, thread.id, message);
            attachmentCount += message.attachments.size;
          } catch (retryErr) {
            errorCount++;
            console.error(`[RETRY FAILED] msg ${message.id}: ${retryErr.message}`);
          }
        } else {
          errorCount++;
          console.error(`[SKIP] msg ${message.id}: ${err.message}`);
        }
      }

      messageCount++;

      // Progress update
      if (messageCount % PROGRESS_INTERVAL === 0) {
        const pct = Math.round((messageCount / messages.length) * 100);
        await updateProgress(interaction,
          `⏳ Migrating... **${messageCount}/${messages.length}** (${pct}%)` +
          ` · 📎 ${attachmentCount} attachments` +
          (errorCount > 0 ? ` · ⚠️ ${errorCount} errors` : ''));
      }

      await sleep(RATE_LIMIT_DELAY);
    }
  } finally {
    // Always clean up the webhook, even if we crash mid-migration
    try { await webhook.delete('Migration complete'); } catch { /* best effort */ }
  }

  // ── Post-migration: notify in source channel ───────────────────────
  try {
    await sourceChannel.send({
      content: [
        '## 📋 This channel has been migrated',
        '',
        `Your portfolio has been moved to the new forum: **${thread.url}**`,
        '',
        'Please head over there to continue posting your art!',
        pinsOnly ? '*Note: Only pinned messages were migrated.*' : '',
      ].filter(Boolean).join('\n'),
    });
  } catch { /* channel might be read-only, that's fine */ }

  // ── Archive source channel if requested ────────────────────────────
  if (archiveSource) {
    try {
      await sourceChannel.edit({
        permissionOverwrites: [{
          id: guild.id, // @everyone
          deny: ['SendMessages', 'AddReactions', 'CreatePublicThreads'],
        }],
        topic: `[MIGRATED] → ${thread.url}`,
      });
    } catch (err) {
      console.warn(`Could not archive source channel: ${err.message}`);
    }
  }

  // ── Return summary ─────────────────────────────────────────────────
  return {
    threadUrl:       thread.url,
    threadId:        thread.id,
    postTitle:       title,
    messageCount,
    attachmentCount,
    skippedCount,
    errorCount,
    duration:        formatDuration(Date.now() - startTime),
  };
}


/**
 * Preview migration stats without making any changes.
 */
export async function previewChannel(sourceChannel, interaction) {
  await updateProgress(interaction, '🔍 Scanning channel...');

  const messages = await fetchAllMessages(sourceChannel, interaction);
  const pins     = await sourceChannel.messages.fetchPinned();

  let textOnly   = 0;
  let withImages = 0;
  let withFiles  = 0;
  let botMsgs    = 0;
  let systemMsgs = 0;
  const authors  = new Set();
  let totalSize  = 0;

  for (const msg of messages) {
    if (msg.system) { systemMsgs++; continue; }
    if (msg.author.bot) botMsgs++;
    authors.add(msg.author.id);

    const hasImage = [...msg.attachments.values()].some(a =>
      a.contentType?.startsWith('image/'));

    if (msg.attachments.size === 0) textOnly++;
    else if (hasImage) withImages++;
    else withFiles++;

    for (const [, att] of msg.attachments) totalSize += att.size;
  }

  return {
    channelName:     sourceChannel.name,
    channelTopic:    sourceChannel.topic || '(none)',
    totalMessages:   messages.length,
    pinnedMessages:  pins.size,
    textOnly,
    withImages,
    withFiles,
    botMessages:     botMsgs,
    systemMessages:  systemMsgs,
    uniqueAuthors:   authors.size,
    totalAttachSize: formatSize(totalSize),
    createdAt:       sourceChannel.createdAt.toISOString(),
  };
}


// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Fetch every message in a channel, oldest-first.
 */
async function fetchAllMessages(channel, interaction) {
  const all   = [];
  let lastId  = null;
  let batches = 0;

  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;

    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;

    all.push(...batch.values());
    lastId = batch.last().id;
    batches++;

    // Let the user know we're still alive on big channels
    if (batches % 5 === 0) {
      await updateProgress(interaction,
        `📥 Fetched ${all.length} messages so far...`);
    }

    await sleep(350); // gentle on the API
  }

  return all.reverse(); // oldest first
}


/**
 * Send a single message to the forum thread via webhook, preserving the
 * original author's display name, avatar, and any attachments.
 */
async function sendMigratedMessage(webhook, threadId, message) {
  const timestamp = Math.floor(message.createdTimestamp / 1000);
  const timestampSuffix = `\n-# <t:${timestamp}:f>`;

  // ── Build content ────────────────────────────────────────────────
  let content = message.content || '';

  // Note if this was a reply
  if (message.reference?.messageId) {
    const replyNote = '↩️ *replying to an earlier message*\n';
    content = replyNote + content;
  }

  // Note any stickers (can't be re-sent via webhooks)
  if (message.stickers.size > 0) {
    const stickerNames = [...message.stickers.values()].map(s => s.name).join(', ');
    content += `\n-# 🏷️ Sticker: ${stickerNames}`;
  }

  // Append timestamp — respect the 2000 char limit
  if (content.length + timestampSuffix.length > MAX_CONTENT_LEN) {
    content = content.substring(0, MAX_CONTENT_LEN - timestampSuffix.length - 4) + '…';
  }
  content += timestampSuffix;

  // If content is ONLY the timestamp (no real content), and there are no
  // attachments or embeds, there's nothing meaningful to send.
  if (content.trim() === timestampSuffix.trim()
      && message.attachments.size === 0
      && message.embeds.length === 0) {
    return;
  }

  // ── Build payload ────────────────────────────────────────────────
  const payload = {
    threadId,
    content,
    username:  sanitizeWebhookUsername(
      message.member?.displayName || message.author.displayName || message.author.username),
    avatarURL: message.author.displayAvatarURL({ size: 128, forceStatic: false }),
  };

  // ── Attachments: download and re-upload ──────────────────────────
  if (message.attachments.size > 0) {
    const files = [];

    for (const [, attachment] of message.attachments) {
      if (attachment.size > MAX_FILE_SIZE) {
        payload.content += `\n-# ⚠️ Skipped large file: **${attachment.name}** (${formatSize(attachment.size)})`;
        continue;
      }

      try {
        const resp = await fetch(attachment.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        files.push(new AttachmentBuilder(buf, {
          name: attachment.name || 'attachment',
          description: attachment.description || undefined,
        }));
      } catch (err) {
        payload.content += `\n-# ⚠️ Could not download: **${attachment.name}** — ${err.message}`;
      }
    }

    if (files.length > 10) {
      // Discord caps at 10 files per message — split if needed
      payload.files = files.slice(0, 10);
      // We'll lose files 11+ but this is an edge case
      payload.content += `\n-# ⚠️ ${files.length - 10} additional file(s) could not be included (10-file limit per message)`;
    } else if (files.length > 0) {
      payload.files = files;
    }
  }

  // ── Rich embeds (from bots) — skip auto-generated link previews ──
  const richEmbeds = message.embeds.filter(e => e.data?.type === 'rich');
  if (richEmbeds.length > 0) {
    payload.embeds = richEmbeds.map(e => e.toJSON());
  }

  await webhook.send(payload);
}


/**
 * Discord rejects certain words in webhook usernames.
 */
function sanitizeWebhookUsername(name) {
  if (!name || name.trim().length === 0) return 'Unknown User';
  return name
    .substring(0, 80)
    .replace(/discord/gi, 'Disc∙rd')
    .replace(/clyde/gi,   'Cl∙de')
    .replace(/```/g, "'''")
    || 'Unknown User';
}


/**
 * Safely update the interaction reply. Silently fails after the 15-min
 * interaction token expiry — we don't want to crash mid-migration.
 */
async function updateProgress(interaction, content) {
  try {
    await interaction.editReply({ content });
  } catch {
    // Token expired or other issue — migration continues regardless
  }
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024)        return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  if (bytes >= 1024)               return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
