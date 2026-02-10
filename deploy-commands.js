// ─────────────────────────────────────────────────────────────────────────────
//  DRIFT — Discord Relay Into Forum Threads
//  deploy-commands.js — Slash command registration
// ─────────────────────────────────────────────────────────────────────────────
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import 'dotenv/config';

const commands = [
  // ── Single channel migration ──────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('drift')
    .setDescription('DRIFT a text channel into a forum post (preserves messages, attachments, authors)')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Source text channel to migrate')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addChannelOption(opt =>
      opt.setName('forum')
        .setDescription('Target forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('post-name')
        .setDescription('Custom name for the forum post (defaults to channel name, title-cased)')
        .setRequired(false))
    .addStringOption(opt =>
      opt.setName('tag')
        .setDescription('Forum tag to apply (must already exist on the forum)')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('pins-only')
        .setDescription('Only migrate pinned messages (default: false)')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('archive-source')
        .setDescription('Lock the source channel and add a redirect notice after migration (default: false)')
        .setRequired(false))
    .toJSON(),

  // ── Bulk category migration ───────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('drift-category')
    .setDescription('DRIFT ALL text channels in a category to individual forum posts')
    .addChannelOption(opt =>
      opt.setName('category')
        .setDescription('Source category containing artist channels')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(true))
    .addChannelOption(opt =>
      opt.setName('forum')
        .setDescription('Target forum channel')
        .addChannelTypes(ChannelType.GuildForum)
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('tag')
        .setDescription('Forum tag to apply to all migrated posts')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('archive-source')
        .setDescription('Lock each source channel after migration (default: false)')
        .setRequired(false))
    .addBooleanOption(opt =>
      opt.setName('preview')
        .setDescription('Just list what would be migrated — no changes made (default: false)')
        .setRequired(false))
    .toJSON(),

  // ── Preview / dry-run for a single channel ────────────────────────────
  new SlashCommandBuilder()
    .setName('drift-preview')
    .setDescription('Preview migration stats for a channel without making any changes')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Channel to preview')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .toJSON(),
];

// ── Register ──────────────────────────────────────────────────────────────
const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  console.log(`🌊 DRIFT — Registering ${commands.length} slash commands...`);

  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log(`✅ Commands registered for guild ${process.env.GUILD_ID} (instant)`);
  } else {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log('✅ Commands registered globally (may take up to 1 hour to propagate)');
  }
} catch (err) {
  console.error('❌ Failed to register commands:', err);
  process.exit(1);
}
