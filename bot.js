require('dotenv').config();
const { DiscordMCBot } = require('./core.js');

const altConfig = {
  discordToken: (process.env.B1_DISCORD_TOKEN || '').trim(),
  discordChannelId: process.env.BOT1_CHANNEL_ID,
  allowedUserId: process.env.B1_ALLOWED_USER_ID,
  discordGuildId: process.env.B1_DISCORD_GUILD_ID,

  mcHost: process.env.B1_MC_HOST || 'mc.ultranetwork.net',
  mcUsername: (process.env.B1_MC_USERNAME || 'Woonderhoy').trim(),
  mcAuth: process.env.B1_MC_AUTH || 'microsoft',
  mcVersion: process.env.B1_MC_VERSION || process.env.MC_VERSION || '1.20.4',

  commandPrefix: 'main',
  wsPort: Number(process.env.B1_WS_PORT || 3005),
  defaultMode: 'prison',

  autostart: true
};

if (!altConfig.discordToken) {
  console.error('Missing B1_DISCORD_TOKEN environment variable.');
  process.exit(1);
}

if (!altConfig.mcUsername) {
  console.error('Missing B1_MC_USERNAME environment variable.');
  process.exit(1);
}

const instance = new DiscordMCBot(altConfig);

module.exports = instance;
