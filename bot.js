// ─────────────────────────────────────────────────────────────────────────────
//  DRIFT — Discord Relay Into Forum Threads
//  bot.js — Main entry point
//
//  Commands:
//    /drift            — Migrate a single channel to a forum post
//    /drift-category   — Migrate all channels in a category to forum posts
//    /drift-preview    — Dry run: show stats without making changes
// ─────────────────────────────────────────────────────────────────────────────
import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import 'dotenv/config';
import { migrateChannel, previewChannel } from './lib/migrator.js';

const BULK_DELAY = (parseInt(process.env.BULK_CHANNEL_DELAY, 10) || 30) * 1000;

// ── Bot setup ─────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`🌊 DRIFT online as ${c.user.tag}`);
  console.log(`   Guilds: ${c.guilds.cache.size}`);
  console.log(`   Rate limit delay: ${process.env.RATE_LIMIT_DELAY || 1500}ms`);
});

// ── Command router ────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'drift':          return await handleMigrate(interaction);
      case 'drift-category': return await handleMigrateCategory(interaction);
      case 'drift-preview':  return await handlePreview(interaction);
      default: break;
    }
  } catch (err) {
    console.error(`Command /${interaction.commandName} failed:`, err);
    const msg = `❌ **Command Failed**\n\`\`\`\n${err.message}\n\`\`\``;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch { /* can't even reply — give up */ }
  }
});

// ── /migrate ──────────────────────────────────────────────────────────────────
async function handleMigrate(interaction) {
  const sourceChannel = interaction.options.getChannel('channel');
  const forumChannel  = interaction.options.getChannel('forum');
  const postName      = interaction.options.getString('post-name');
  const tagName       = interaction.options.getString('tag');
  const pinsOnly      = interaction.options.getBoolean('pins-only')      ?? false;
  const archiveSource = interaction.options.getBoolean('archive-source') ?? false;

  await interaction.deferReply({ ephemeral: true });

  console.log(`[MIGRATE] #${sourceChannel.name} → ${forumChannel.name} (by ${interaction.user.tag})`);

  const result = await migrateChannel({
    sourceChannel,
    forumChannel,
    postName,
    tagName,
    pinsOnly,
    archiveSource,
    interaction,
    guild: interaction.guild,
  });

  const summary = [
    '✅ **Migration Complete**',
    '',
    `📁 Source: <#${sourceChannel.id}>`,
    `📋 Forum Post: ${result.threadUrl}`,
    `💬 Messages: **${result.messageCount}**`,
    `📎 Attachments: **${result.attachmentCount}**`,
    result.skippedCount > 0 ? `⏭️ Skipped: **${result.skippedCount}** (system/empty)` : '',
    result.errorCount > 0   ? `⚠️ Errors: **${result.errorCount}**` : '',
    `⏱️ Duration: **${result.duration}**`,
    '',
    archiveSource
      ? '🔒 Source channel has been locked with a redirect notice.'
      : '💡 Source channel is still active. Use `/migrate` with `archive-source: true` to lock it.',
  ].filter(Boolean).join('\n');

  await safeEditReply(interaction, summary);

  console.log(`[MIGRATE] ✅ #${sourceChannel.name} done — ${result.messageCount} msgs in ${result.duration}`);
}

// ── /migrate-category ─────────────────────────────────────────────────────────
async function handleMigrateCategory(interaction) {
  const category       = interaction.options.getChannel('category');
  const forumChannel   = interaction.options.getChannel('forum');
  const tagName        = interaction.options.getString('tag');
  const archiveSource  = interaction.options.getBoolean('archive-source') ?? false;
  const previewOnly    = interaction.options.getBoolean('preview')        ?? false;

  await interaction.deferReply({ ephemeral: true });

  // Find all text channels in the category
  const textChannels = category.children.cache
    .filter(ch => ch.type === ChannelType.GuildText)
    .sort((a, b) => a.position - b.position);

  if (textChannels.size === 0) {
    return await interaction.editReply('❌ No text channels found in that category.');
  }

  // ── Preview mode ─────────────────────────────────────────────────
  if (previewOnly) {
    const lines = [
      `📂 **Category: ${category.name}**`,
      `📋 Target Forum: <#${forumChannel.id}>`,
      '',
      `Found **${textChannels.size}** text channels to migrate:`,
      '',
      ...textChannels.map((ch, i) =>
        `${i + 1}. <#${ch.id}> — ${ch.topic ? `"${ch.topic.substring(0, 50)}"` : '(no topic)'}`
      ),
      '',
      `Run the command again without \`preview: true\` to start migration.`,
    ];
    return await interaction.editReply(lines.join('\n'));
  }

  // ── Execute bulk migration ───────────────────────────────────────
  console.log(`[BULK] Starting migration of ${textChannels.size} channels from "${category.name}"`);

  await interaction.editReply(
    `🚀 **Bulk Migration Starting**\n` +
    `📂 Category: **${category.name}** (${textChannels.size} channels)\n` +
    `📋 Target: <#${forumChannel.id}>\n\n` +
    `This will take a while. Progress updates below...`
  );

  // Use a log thread for detailed progress (avoids the 15-min interaction timeout)
  let logThread;
  try {
    logThread = await interaction.channel.threads.create({
      name: `DRIFT Log — ${category.name} — ${new Date().toLocaleDateString()}`,
      autoArchiveDuration: 1440, // 24 hours
      reason: 'Bulk migration progress log',
    });
    await logThread.send(
      `📂 **Migrating category: ${category.name}**\n` +
      `📋 Target forum: <#${forumChannel.id}>\n` +
      `🔢 Channels: ${textChannels.size}\n` +
      `⏱️ Started: <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
      `---`
    );
  } catch (err) {
    console.warn('Could not create log thread, falling back to interaction replies:', err.message);
    logThread = null;
  }

  const results = [];
  let completed = 0;

  for (const [, channel] of textChannels) {
    completed++;
    const prefix = `[${completed}/${textChannels.size}]`;

    const logMsg = `${prefix} ⏳ Migrating <#${channel.id}>...`;
    if (logThread) await logThread.send(logMsg).catch(() => {});
    console.log(`${prefix} Migrating #${channel.name}`);

    try {
      const result = await migrateChannel({
        sourceChannel: channel,
        forumChannel,
        postName: null,
        tagName,
        pinsOnly: false,
        archiveSource,
        interaction,
        guild: interaction.guild,
      });

      results.push({ channel: channel.name, success: true, ...result });

      const successMsg = `${prefix} ✅ **${channel.name}** → ${result.threadUrl} (${result.messageCount} msgs, ${result.duration})`;
      if (logThread) await logThread.send(successMsg).catch(() => {});
      console.log(`${prefix} ✅ #${channel.name} — ${result.messageCount} msgs`);

    } catch (err) {
      results.push({ channel: channel.name, success: false, error: err.message });

      const errorMsg = `${prefix} ❌ **${channel.name}** failed: \`${err.message}\``;
      if (logThread) await logThread.send(errorMsg).catch(() => {});
      console.error(`${prefix} ❌ #${channel.name}: ${err.message}`);
    }

    // Delay between channels to cool down rate limits
    if (completed < textChannels.size) {
      const delaySec = Math.round(BULK_DELAY / 1000);
      if (logThread) {
        await logThread.send(`⏸️ Cooling down ${delaySec}s before next channel...`).catch(() => {});
      }
      await new Promise(r => setTimeout(r, BULK_DELAY));
    }
  }

  // ── Final summary ──────────────────────────────────────────────
  const succeeded = results.filter(r => r.success);
  const failed    = results.filter(r => !r.success);
  const totalMsgs = succeeded.reduce((n, r) => n + r.messageCount, 0);
  const totalAtts = succeeded.reduce((n, r) => n + r.attachmentCount, 0);

  const summaryLines = [
    '## 🏁 Bulk Migration Complete',
    '',
    `✅ **${succeeded.length}** channels migrated successfully`,
    failed.length > 0 ? `❌ **${failed.length}** channels failed` : '',
    `💬 **${totalMsgs}** total messages migrated`,
    `📎 **${totalAtts}** total attachments migrated`,
    '',
  ];

  if (failed.length > 0) {
    summaryLines.push('**Failed channels:**');
    for (const f of failed) {
      summaryLines.push(`• **${f.channel}**: ${f.error}`);
    }
  }

  const summaryText = summaryLines.filter(Boolean).join('\n');

  if (logThread) await logThread.send(summaryText).catch(() => {});
  await safeEditReply(interaction, summaryText);

  console.log(`[BULK] ✅ Complete — ${succeeded.length}/${results.length} channels migrated`);
}

// ── /migrate-preview ──────────────────────────────────────────────────────────
async function handlePreview(interaction) {
  const channel = interaction.options.getChannel('channel');

  await interaction.deferReply({ ephemeral: true });

  const stats = await previewChannel(channel, interaction);

  const preview = [
    `## 🔍 Migration Preview: #${stats.channelName}`,
    '',
    `📝 Topic: *${stats.channelTopic}*`,
    `📅 Created: ${stats.createdAt}`,
    '',
    `**Messages:**`,
    `💬 Total: **${stats.totalMessages}**`,
    `📌 Pinned: **${stats.pinnedMessages}**`,
    `💭 Text-only: **${stats.textOnly}**`,
    `🖼️ With images: **${stats.withImages}**`,
    `📁 With files: **${stats.withFiles}**`,
    `🤖 From bots: **${stats.botMessages}**`,
    `⚙️ System: **${stats.systemMessages}** (will be skipped)`,
    '',
    `👤 Unique authors: **${stats.uniqueAuthors}**`,
    `💾 Total attachment size: **${stats.totalAttachSize}**`,
    '',
    `⏱️ Estimated migration time: **~${estimateTime(stats.totalMessages)}**`,
    '',
    `Use \`/migrate\` to start the migration.`,
  ].join('\n');

  await interaction.editReply(preview);
}


// ── Utilities ─────────────────────────────────────────────────────────────────

function estimateTime(msgCount) {
  const delay = parseInt(process.env.RATE_LIMIT_DELAY, 10) || 1500;
  const totalSec = Math.ceil((msgCount * delay) / 1000);
  const m = Math.floor(totalSec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

/**
 * Edit the interaction reply, silently failing if the token has expired.
 */
async function safeEditReply(interaction, content) {
  try {
    await interaction.editReply({ content });
  } catch {
    // 15-minute token expired — migration still succeeded
    try { await interaction.followUp({ content, ephemeral: true }); } catch { /* oh well */ }
  }
}

// ── Launch ────────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

console.log('🌊 Starting DRIFT...');
client.login(process.env.DISCORD_TOKEN);
