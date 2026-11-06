require('dotenv').config();
const { DiscordMCBot } = require('./core.js');

const altConfig = {
  discordToken: (process.env.B2_DISCORD_TOKEN || '').trim(),
  discordChannelId: process.env.BOT2_CHANNEL_ID || '',
  allowedUserId: process.env.B2_ALLOWED_USER_ID || '',
  discordGuildId: process.env.B2_DISCORD_GUILD_ID || '',

  mcHost: process.env.B2_MC_HOST || 'mc.ultranetwork.net',
  mcUsername: (process.env.B2_MC_USERNAME || 'thebestone01').trim(),
  mcAuth: process.env.B2_MC_AUTH || 'offline',
  mcVersion: process.env.B2_MC_VERSION || process.env.MC_VERSION || '1.20.4',

  commandPrefix: 'fih',
  wsPort: Number(process.env.B2_WS_PORT || 3001),
  defaultMode: 'prison',
  // Auto-login command sent on join and reconnect.
  loginCommand: process.env.MC_LOGIN_COMMAND || '', 

  autostart: true
};

if (!altConfig.discordToken) {
  console.error('Missing B2_DISCORD_TOKEN environment variable.');
  process.exit(1);
}

if (!altConfig.mcUsername) {
  console.error('Missing B2_MC_USERNAME environment variable.');
  process.exit(1);
}

const instance = new DiscordMCBot(altConfig);

module.exports = instance;
