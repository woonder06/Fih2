const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, Routes, SlashCommandBuilder, REST, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { pathfinder, goals, Movements } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const { createCanvas } = require('@napi-rs/canvas');

function flattenComponent(comp) {
  if (typeof comp === 'string') return comp;
  if (Array.isArray(comp)) return comp.map(flattenComponent).join('');
  if (comp && typeof comp === 'object') {
    const isObfuscated = comp.obfuscated || (comp.json && comp.json.obfuscated);
    if (isObfuscated) {
      const raw = (typeof comp.text === 'string' ? comp.text : '') || (comp.json && typeof comp.json.text === 'string' ? comp.json.text : '');
      return raw.replace(/\S/g, ''); 
    }
    let out = '';
    if (typeof comp.text === 'string') out += comp.text;
    if (typeof comp[''] === 'string') out += comp[''];
    if (comp.json && typeof comp.json[''] === 'string') out += comp.json[''];
    if (Array.isArray(comp.extra)) out += flattenComponent(comp.extra);
    if (Array.isArray(comp.with)) out += comp.with.map(flattenComponent).join('');
    return out;
  }
  return '';
}

function normalizeReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'string') {
    try {
      const parsed = JSON.parse(reason);
      return normalizeReason(parsed);
    } catch (e) {
      return reason.trim().toLowerCase();
    }
  }
  if (typeof reason === 'object') {
    let str = flattenComponent(reason);
    if (!str && reason.value) {
      if (typeof reason.value === 'string') str = reason.value;
      else str = flattenComponent(reason.value);
    }
    if (!str && reason.translate) {
      str = reason.translate;
      if (Array.isArray(reason.with)) str += ' ' + reason.with.map(flattenComponent).join(' ');
    }
    if (!str && reason.text) str = reason.text;
    if (!str && reason.message) str = reason.message;
    if (str) return str.trim().toLowerCase();
    try {
      return JSON.stringify(reason).toLowerCase();
    } catch (e) {
      return String(reason).toLowerCase();
    }
  }
  return String(reason).trim().toLowerCase();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeDiscordMarkdown(text) {
  return text
    .replace(/^(\s*)-(?=\s)/gm, '$1\\-')
    .replace(/^(\s*)\*(?=\s)/gm, '$1\\*')
    .replace(/^(\s*)#/gm, '$1\\#')
    .replace(/^>/gm, '\\>');
}

const RANK_ORDER = [
  'Owner', 'Admin', 'Mod', 'Helper',
  'Void', 'Totem', 'Netherite', 'Elytra', 'Emerald',
  'Diamond', 'Gold', 'Lapis', 'Redstone', 'Iron', 'Coal', 'Bedrock', 'Member'
];

const RANK_COLORS = {
  Owner: '#ef4444',
  Admin: '#f97316',
  Mod: '#eab308',
  Helper: '#06b6d4',
  Void: '#a855f7',
  Totem: '#f59e0b',
  Netherite: '#6366f1',
  Elytra: '#06b6d4',
  Emerald: '#22c55e',
  Diamond: '#38bdf8',
  Gold: '#eab308',
  Lapis: '#3b82f6',
  Redstone: '#ef4444',
  Iron: '#cbd5e1',
  Coal: '#64748b',
  Bedrock: '#94a3b8',
  Member: '#94a3b8'
};

function formatChatLine(rawText) {
  if (!rawText) return '';
  const clean = rawText.replace(/§[0-9a-fk-or]/gi, '').trim();

  // Match chat line: [Rank] Player [Tag] » Message
  const arrowMatch = clean.match(/^(.+?\s*»)\s*(.*)$/);
  if (arrowMatch) {
    const sender = arrowMatch[1].trim().replace(/_/g, '\\_');
    const msg = arrowMatch[2];
    return `**${sender}** ${escapeDiscordMarkdown(msg)}`;
  }

  // Match [Rank] Player: message
  const colonMatch = clean.match(/^(\[[^\]]+\]\s+[a-zA-Z0-9_]{2,16}\s*:)\s*(.*)$/);
  if (colonMatch) {
    const sender = colonMatch[1].trim().replace(/_/g, '\\_');
    const msg = colonMatch[2];
    return `**${sender}** ${escapeDiscordMarkdown(msg)}`;
  }

  // Match <Player> message
  const bracketMatch = clean.match(/^(<[a-zA-Z0-9_]{2,16}>)\s*(.*)$/);
  if (bracketMatch) {
    const sender = bracketMatch[1].replace(/_/g, '\\_');
    const msg = bracketMatch[2];
    return `**${sender}** ${escapeDiscordMarkdown(msg)}`;
  }

  return escapeDiscordMarkdown(clean);
}

function getItemEmoji(name = '') {
  return '';
}

function getItemDisplayName(item) {
  if (!item) return '';
  if (item.customName) {
    try {
      const parsed = typeof item.customName === 'string' ? JSON.parse(item.customName) : item.customName;
      const flat = flattenComponent(parsed).replace(/§[0-9a-fk-or]/gi, '').trim();
      if (flat) return flat;
    } catch {}
    const raw = String(item.customName).replace(/§[0-9a-fk-or]/gi, '').trim();
    if (raw) return raw;
  }

  if (item.nbt && item.nbt.value && item.nbt.value.display && item.nbt.value.display.value) {
    const rawName = item.nbt.value.display.value.Name?.value;
    if (rawName) {
      try {
        const parsed = typeof rawName === 'string' ? JSON.parse(rawName) : rawName;
        const flat = flattenComponent(parsed).replace(/§[0-9a-fk-or]/gi, '').trim();
        if (flat) return flat;
      } catch {}
      const raw = String(rawName).replace(/§[0-9a-fk-or]/gi, '').trim();
      if (raw) return raw;
    }
  }

  if (item.displayName) {
    return item.displayName.replace(/§[0-9a-fk-or]/gi, '').trim();
  }

  return (item.name || 'Unknown').replace(/_/g, ' ');
}

function parsePlayer(p) {
  let raw = '';
  if (p.displayName) {
    raw = flattenComponent(p.displayName).trim();
  }
  if (!raw) raw = p.username || 'Unknown';
  const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();

  for (const rank of RANK_ORDER) {
    if (rank === 'Member') continue;
    const regex = new RegExp(`^(?:\\[?${rank}\\]?\\s+)(.+)$`, 'i');
    const m = clean.match(regex);
    if (m) {
      return { rank, username: m[1].trim() };
    }
  }

  return { rank: 'Member', username: clean };
}

function renderInventoryCanvas(window, isContainer) {
  const slots = window.slots || [];
  const displaySlotsCount = isContainer ? Math.min(slots.length, window.inventoryStart || 54) : Math.min(slots.length, 36);
  const rows = Math.max(3, Math.ceil(displaySlotsCount / 9));

  const colCount = 9;
  const slotW = 72;
  const slotH = 72;
  const gap = 8;
  const paddingX = 24;
  const paddingTop = 65;
  const paddingBottom = 20;

  const width = paddingX * 2 + colCount * slotW + (colCount - 1) * gap;
  const height = paddingTop + rows * slotH + (rows - 1) * gap + paddingBottom;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  // Top header bar
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, width, 50);

  // Title text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  const title = isContainer ? 'Container / Server GUI' : 'Player Inventory';
  ctx.fillText(title, paddingX, 32);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '13px sans-serif';
  ctx.fillText(`${displaySlotsCount} slots`, width - paddingX - 60, 32);

  // Draw slots
  for (let i = 0; i < displaySlotsCount; i++) {
    const col = i % 9;
    const row = Math.floor(i / 9);
    const x = paddingX + col * (slotW + gap);
    const y = paddingTop + row * (slotH + gap);

    const item = slots[i];
    const isOccupied = Boolean(item);

    // Slot box
    ctx.fillStyle = isOccupied ? '#1e293b' : '#141c2e';
    ctx.fillRect(x, y, slotW, slotH);

    ctx.strokeStyle = isOccupied ? '#3b82f6' : '#273549';
    ctx.lineWidth = isOccupied ? 2 : 1;
    ctx.strokeRect(x, y, slotW, slotH);

    // Slot number in top-left
    ctx.fillStyle = isOccupied ? '#38bdf8' : '#475569';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(`${i}`, x + 5, y + 14);

    if (item) {
      const displayName = getItemDisplayName(item);
      const emoji = getItemEmoji(item.name);

      // Emoji in center
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emoji, x + slotW / 2, y + 36);

      // Truncated Display Name
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 10px sans-serif';
      const shortName = displayName.length > 9 ? displayName.slice(0, 8) + '..' : displayName;
      ctx.fillText(shortName, x + slotW / 2, y + 52);

      // Count in bottom right
      if (item.count > 1) {
        ctx.fillStyle = '#4ade80';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`x${item.count}`, x + slotW - 5, y + slotH - 5);
      }
      ctx.textAlign = 'left';
    }
  }

  return canvas.toBuffer('image/png');
}

function renderOnlinePlayersCanvas(players) {
  const grouped = new Map();
  for (const r of RANK_ORDER) grouped.set(r, []);

  for (const p of players) {
    const { rank, username } = parsePlayer(p);
    if (!grouped.has(rank)) grouped.set(rank, []);
    grouped.get(rank).push(username);
  }

  const activeRanks = [];
  for (const [rank, list] of grouped.entries()) {
    if (list.length > 0) {
      activeRanks.push({
        rank,
        color: RANK_COLORS[rank] || '#94a3b8',
        list: list.sort((a, b) => a.localeCompare(b))
      });
    }
  }

  const width = 880;
  const height = Math.max(380, 100 + activeRanks.length * 42);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Online indicator dot
  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(36, 40, 7, 0, Math.PI * 2);
  ctx.fill();

  // Header Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(`UltraNetwork — Online Players (${players.length})`, 54, 47);

  // Divider
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, 70);
  ctx.lineTo(width - 24, 70);
  ctx.stroke();

  // Render each rank
  let currentY = 100;
  for (const { rank, color, list } of activeRanks) {
    // Rank badge pill
    const badgeText = `${rank.toUpperCase()} (${list.length})`;
    ctx.font = 'bold 12px sans-serif';
    const textW = ctx.measureText(badgeText).width;
    const badgeW = textW + 16;
    const badgeH = 24;

    ctx.fillStyle = color + '26'; // 15% opacity hex
    ctx.beginPath();
    ctx.roundRect(28, currentY - 17, badgeW, badgeH, 6);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fillText(badgeText, 36, currentY);

    // Player names line
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '14px sans-serif';
    const namesStr = list.join('  •  ');
    let displayNames = namesStr;
    const maxWidth = width - badgeW - 70;
    while (ctx.measureText(displayNames).width > maxWidth && displayNames.length > 10) {
      displayNames = displayNames.slice(0, -6) + '...';
    }

    ctx.fillText(displayNames, 36 + badgeW + 16, currentY);
    currentY += 38;
  }

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '12px sans-serif';
  ctx.fillText(`mc.ultranetwork.net • ${new Date().toLocaleTimeString()}`, 28, height - 16);

  return canvas.toBuffer('image/png');
}

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

class DiscordMCBot {
  constructor(config) {
    this.config = config;
    
    // Discord Client
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    this.discordChannel = null;
    
    // Bot State
    this.mcBot = null;
    this.state = 'OFFLINE'; // OFFLINE, CONNECTING, ONLINE, RECONNECTING
    
    // State Persistence
    this.stateFilePath = path.join(__dirname, `.${this.config.commandPrefix}_state.json`);
    let initialManualStop = !config.autostart;
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'));
        if (typeof saved.manualStop === 'boolean') {
          initialManualStop = saved.manualStop;
        }
      }
    } catch (e) {}
    this.manualStop = initialManualStop;
    
    // Reconnect & Delays
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    
    // Game State
    this.autoNavigate = true;
    this.targetMode = config.defaultMode || 'prison';
    this.currentMode = this.targetMode;
    this.pendingModeSelection = false;
    this.modeClickInProgress = false;

    // Chat Batching & Embed Queue
    this.chatBuffer = [];
    this.chatFlushTimer = null;
    this.recentChats = [];

    // Terminal Environment
    this.terminalCwd = process.env.HOME || '/FTP/discordbot';
    
    this.setupDiscord();
    this.setupWebSocket();
  }

  log(msg) {
    console.log(`[${this.config.commandPrefix.toUpperCase()}] ${msg}`);
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify({ manualStop: this.manualStop }), 'utf8');
    } catch (e) {}
  }

  getSpecialEmbed(text) {
    if (!text) return null;
    const t = text.trim();

    // 1. Unscramble challenge: "Unscramble the word '...' for a reward!"
    if (/unscramble the word/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0x55FF55 // Lime Green
      };
    }

    // 2. Unscramble winners: "1st. G45 unscrambled the word in 2.32s"
    if (/^\d+(?:st|nd|rd|th)\.?\s+.*unscrambled the word/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0xFFAA00 // Gold / Orange
      };
    }

    // 3. Chat Reaction over: "Chat Reaction is over! The word was '...'"
    if (/chat reaction is over/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0x55FFFF // Aqua / Cyan
      };
    }

    // 4. Prestige: "... has prestiged their pickaxe to ..."
    if (/has prestiged their pickaxe to/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0x55FFFF // Aqua / Cyan
      };
    }

    // 5. Vault Key / Crate win: "... opened a ... Key and won ..."
    if (/opened a .* (?:vault )?key and won/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0xFF5555 // Red
      };
    }

    // 6. Vote party countdown: "... more votes until voteparty!"
    if (/more votes until voteparty/i.test(t)) {
      return {
        description: `**${t}**`,
        color: 0x55FFFF // Aqua / Cyan
      };
    }

    return null;
  }

  queueMessage(fullMessage) {
    if (!this.recentChats) this.recentChats = [];
    const cleanMsg = (fullMessage || '').replace(/§[0-9a-fk-or]/gi, '').trim();
    if (cleanMsg) {
      this.recentChats.push({
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        text: cleanMsg
      });
      if (this.recentChats.length > 100) this.recentChats.shift();
    }

    const embed = this.getSpecialEmbed(fullMessage);
    if (embed) {
      this.flushChatQueue();
      if (this.discordChannel) {
        this.discordChannel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    const formatted = formatChatLine(fullMessage);
    this.chatBuffer.push(formatted);
    if (this.chatBuffer.length >= 8 || this.chatBuffer.join('\n').length >= 1400) {
      this.flushChatQueue();
    } else if (!this.chatFlushTimer) {
      this.chatFlushTimer = setTimeout(() => {
        this.flushChatQueue();
      }, 1500);
    }
  }

  flushChatQueue() {
    if (this.chatFlushTimer) {
      clearTimeout(this.chatFlushTimer);
      this.chatFlushTimer = null;
    }
    if (!this.chatBuffer || this.chatBuffer.length === 0 || !this.discordChannel) return;

    const toSend = this.chatBuffer.join('\n').slice(0, 1900);
    this.chatBuffer = [];
    this.discordChannel.send(toSend).catch(() => {});
  }

  sendToDiscord(msg) {
    if (!this.discordChannel) return;
    this.flushChatQueue();
    this.discordChannel.send(escapeDiscordMarkdown(String(msg)).slice(0, 1900)).catch(() => {});
  }

  async setupDiscord() {
    const slashCommands = [
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}autostart`).setDescription('Enable/disable auto-reconnect and start/stop the bot'),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}online`).setDescription('Show who is online on the server'),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}screen`).setDescription('Show bot GUI/inventory'),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}select`).setDescription('Click first item matching name or ID')
        .addStringOption(opt => opt.setName('item_id').setDescription('Item name/ID').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}click`).setDescription('Left-click a slot')
        .addIntegerOption(opt => opt.setName('slot').setDescription('Slot number').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}shiftclick`).setDescription('Shift-left-click a slot')
        .addIntegerOption(opt => opt.setName('slot').setDescription('Slot number').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}rightclick`).setDescription('Right-click selected/held item')
        .addIntegerOption(opt => opt.setName('slot').setDescription('Hotbar slot 0-8').setRequired(false)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}slot`).setDescription('Select a hotbar slot')
        .addIntegerOption(opt => opt.setName('slot').setDescription('Hotbar slot 0-8').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}walk`).setDescription('Walk forward by blocks')
        .addIntegerOption(opt => opt.setName('steps').setDescription('Block steps').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}move`).setDescription('Move the bot in a direction by blocks')
        .addIntegerOption(opt => opt.setName('blocks').setDescription('Number of blocks to move').setRequired(true))
        .addStringOption(opt => opt.setName('direction').setDescription('Direction').setRequired(true).addChoices(
          { name: 'north', value: 'north' }, { name: 'south', value: 'south' }, { name: 'east', value: 'east' },
          { name: 'west', value: 'west' }, { name: 'forward', value: 'forward' }, { name: 'backward', value: 'backward' },
          { name: 'left', value: 'left' }, { name: 'right', value: 'right' }
        )),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}rotate`).setDescription('Rotate bot view')
        .addNumberOption(opt => opt.setName('yaw').setDescription('Yaw').setRequired(true))
        .addNumberOption(opt => opt.setName('pitch').setDescription('Pitch').setRequired(true)),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}relog`).setDescription('Toggle auto navigation after login'),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}closegui`).setDescription('Force close current GUI'),
      new SlashCommandBuilder().setName(`${this.config.commandPrefix}change`).setDescription('Change gamemode/server')
        .addStringOption(opt => opt.setName('mode').setDescription('Target mode').setRequired(true).addChoices(
          { name: 'prison', value: 'prison' }, { name: 'survival', value: 'survival' }
        ))
    ];

    this.client.once('ready', async () => {
      this.log(`Discord logged in as ${this.client.user.tag}`);
      try {
        this.discordChannel = await this.client.channels.fetch(this.config.discordChannelId);
      } catch (err) {
        this.log(`Failed to fetch channel: ${err.message}`);
      }

      if (this.config.terminalChannelId) {
        try {
          this.terminalChannel = await this.client.channels.fetch(this.config.terminalChannelId);
          this.log(`Terminal channel connected: #${this.terminalChannel.name} (${this.config.terminalChannelId})`);
          this.terminalChannel.send(`**Linux Terminal Online**\nConnected to \`${process.env.USER || 'bot'}@local\` (\`/FTP/discordbot\`).\nReady for commands from <@${this.config.allowedUserId}>.`).catch(() => {});
        } catch (err) {
          this.log(`Terminal channel fetch failed: ${err.message} (Check bot permissions in #${this.config.terminalChannelId})`);
        }
      }

      const rest = new REST({ version: '10' }).setToken(this.config.discordToken);
      try {
        await rest.put(
          Routes.applicationGuildCommands(this.client.application.id, this.config.discordGuildId),
          { body: slashCommands.map(cmd => cmd.toJSON()) }
        );
        this.log('Slash commands registered to guild');
      } catch (err) {
        this.log(`Failed to register slash commands: ${err.message}`);
      }

      if (!this.manualStop) {
        this.start('startup');
      }
    });

    this.client.on('error', err => {
      this.log(`Discord client error: ${err.message}`);
    });

    this.client.on('interactionCreate', async interaction => {
      if (!interaction.isChatInputCommand() || interaction.user.id !== this.config.allowedUserId) return;
      try {
        await interaction.deferReply({ ephemeral: true });
        const name = interaction.commandName;
        const reply = msg => interaction.editReply({ content: msg });

        if (name === `${this.config.commandPrefix}autostart`) {
          this.manualStop = !this.manualStop;
          this.saveState();
          if (!this.manualStop) {
            if (this.state === 'ONLINE') return reply('Autostart enabled; bot already running.');
            this.start('slash-autostart');
            return reply('Autostart enabled; starting bot...');
          } else {
            this.stop('manual');
            return reply('Autostart disabled; bot stopped.');
          }
        }

        if (name === `${this.config.commandPrefix}change`) {
          const mode = interaction.options.getString('mode');
          this.targetMode = mode;
          this.currentMode = mode;
          this.pendingModeSelection = true;
          this.manualStop = false;
          this.saveState();

          if (this.state === 'ONLINE') {
            this.mcBot.chat(`/${mode}`);
            return reply(`Switching to ${mode}...`);
          } else {
            this.start(`slash-change-${mode}`);
            return reply(`Starting bot targeting ${mode}...`);
          }
        }
        
        if (name === `${this.config.commandPrefix}relog`) {
          this.autoNavigate = !this.autoNavigate;
          return reply(`Auto-navigation is now ${this.autoNavigate ? 'ON' : 'OFF'}.`);
        }

        if (name === `${this.config.commandPrefix}online`) {
          if (this.state !== 'ONLINE' || !this.mcBot) {
            return reply('Bot is not currently connected to the server.');
          }

          const players = Object.values(this.mcBot.players || {});
          if (!players.length) {
            return reply('No players found in the player list.');
          }

          const totalOnline = players.length;
          const imageBuf = renderOnlinePlayersCanvas(players);
          const attachment = new AttachmentBuilder(imageBuf, { name: 'online-players.png' });

          const embed = new EmbedBuilder()
            .setTitle(`UltraNetwork — Online Players (${totalOnline})`)
            .setColor(0x5865F2)
            .setImage('attachment://online-players.png')
            .setFooter({ text: `Total Online: ${totalOnline} • mc.ultranetwork.net` })
            .setTimestamp();

          return interaction.editReply({
            embeds: [embed],
            files: [attachment]
          });
        }

        // Rest of the commands require the bot to be online
        if (this.state !== 'ONLINE' || !this.mcBot) {
          return reply('Bot is not currently fully connected.');
        }

        const window = this.mcBot.currentWindow ?? this.mcBot.inventory;
        const slot = interaction.options.getInteger('slot');

        if (name === `${this.config.commandPrefix}screen`) {
          const isContainer = Boolean(this.mcBot.currentWindow);
          const imageBuf = renderInventoryCanvas(window, isContainer);
          const attachment = new AttachmentBuilder(imageBuf, { name: 'screen.png' });

          const occupied = [];
          for (let i = 0; i < window.slots.length; i++) {
            const item = window.slots[i];
            if (item) {
              const displayName = getItemDisplayName(item);
              occupied.push(`• **Slot ${i}:** ${item.count}x **${displayName}** (\`${item.name}\`)`);
            }
          }

          let summaryText = `**Items in ${isContainer ? 'open GUI' : 'inventory'}:**\n`;
          if (!occupied.length) {
            summaryText += '*(No items found)*';
          } else {
            summaryText += occupied.slice(0, 20).join('\n');
            if (occupied.length > 20) {
              summaryText += `\n*(+${occupied.length - 20} more items)*`;
            }
          }

          return interaction.editReply({
            content: summaryText.slice(0, 1950),
            files: [attachment]
          });
        }

        if (name === `${this.config.commandPrefix}click`) {
          await this.mcBot.clickWindow(slot, 0, 0);
          return reply(`Clicked slot ${slot}.`);
        }

        if (name === `${this.config.commandPrefix}shiftclick`) {
          await this.mcBot.clickWindow(slot, 0, 1);
          return reply(`Shift-clicked slot ${slot}.`);
        }

        if (name === `${this.config.commandPrefix}rightclick`) {
          if (slot !== null && slot >= 0 && slot <= 8) this.mcBot.setQuickBarSlot(slot);
          await this.mcBot.activateItem();
          return reply(slot !== null ? `Right-clicked hotbar slot ${slot}.` : 'Right-clicked held item.');
        }

        if (name === `${this.config.commandPrefix}slot`) {
          if (slot < 0 || slot > 8) return reply('Slot must be 0-8.');
          this.mcBot.setQuickBarSlot(slot);
          return reply(`Selected hotbar slot ${slot}.`);
        }

        if (name === `${this.config.commandPrefix}select`) {
          const query = interaction.options.getString('item_id')?.toLowerCase();
          const match = window.slots.find(item => item && (item.name.toLowerCase().includes(query) || item.type.toString() === query));
          if (!match) return reply(`No item matching "${query}" found.`);
          await this.mcBot.clickWindow(match.slot, 0, 0);
          return reply(`Clicked ${match.count}x ${match.name} in slot ${match.slot}`);
        }
        
        if (name === `${this.config.commandPrefix}closegui`) {
          if (!this.mcBot.currentWindow) return reply('No GUI open.');
          this.mcBot.closeWindow(this.mcBot.currentWindow);
          return reply('GUI closed.');
        }

        if (name === `${this.config.commandPrefix}walk`) {
          if (!this.mcBot?.entity?.position || typeof this.mcBot.entity.yaw !== 'number' || Number.isNaN(this.mcBot.entity.yaw)) {
            return reply('Cannot walk: bot position or rotation is not ready yet.');
          }
          const steps = interaction.options.getInteger('steps');
          if (typeof steps !== 'number' || Number.isNaN(steps) || steps <= 0) {
            return reply('Steps must be a positive number.');
          }
          const curPos = this.mcBot.entity.position;
          if (Number.isNaN(curPos.x) || Number.isNaN(curPos.y) || Number.isNaN(curPos.z)) {
            return reply('Cannot walk: bot position has invalid coordinates.');
          }
          const dir = this.mcBot.entity.yaw;
          const dx = -Math.sin(dir) * steps;
          const dz = Math.cos(dir) * steps;
          if (Number.isNaN(dx) || Number.isNaN(dz)) {
            return reply('Cannot calculate destination: invalid coordinate math.');
          }
          const targetX = Math.floor(curPos.x + dx);
          const targetY = Math.floor(curPos.y);
          const targetZ = Math.floor(curPos.z + dz);
          if (Number.isNaN(targetX) || Number.isNaN(targetY) || Number.isNaN(targetZ)) {
            return reply('Cannot calculate destination: NaN coordinates detected.');
          }
          if (!this.mcBot.pathfinder) {
            return reply('Pathfinder is not ready.');
          }
          this.mcBot.physicsEnabled = true;
          this.mcBot.pathfinder.setGoal(new GoalBlock(targetX, targetY, targetZ));
          const onWalkDone = () => {
            if (this.mcBot) this.mcBot.physicsEnabled = false;
            this.mcBot?.removeListener('goal_reached', onWalkDone);
          };
          this.mcBot.once('goal_reached', onWalkDone);
          setTimeout(() => { if (this.mcBot) this.mcBot.physicsEnabled = false; }, steps * 1000 + 4000);
          return reply(`Walking forward ${steps} blocks to (${targetX}, ${targetY}, ${targetZ}).`);
        }

        if (name === `${this.config.commandPrefix}move`) {
          if (!this.mcBot?.entity?.position) {
            return reply('Cannot move: bot position is not ready yet.');
          }
          const curPos = this.mcBot.entity.position;
          if (Number.isNaN(curPos.x) || Number.isNaN(curPos.y) || Number.isNaN(curPos.z)) {
            return reply('Cannot move: bot position has invalid coordinates.');
          }
          const blocks = interaction.options.getInteger('blocks');
          if (typeof blocks !== 'number' || Number.isNaN(blocks) || blocks <= 0) {
            return reply('Block count must be a positive number.');
          }
          const direction = (interaction.options.getString('direction') || '').toLowerCase();
          const yaw = typeof this.mcBot.entity.yaw === 'number' && !Number.isNaN(this.mcBot.entity.yaw) ? this.mcBot.entity.yaw : 0;
          let dx = 0;
          let dz = 0;
          if (direction === 'north') {
            dz = -blocks;
          } else if (direction === 'south') {
            dz = blocks;
          } else if (direction === 'east') {
            dx = blocks;
          } else if (direction === 'west') {
            dx = -blocks;
          } else if (direction === 'forward') {
            dx = -Math.sin(yaw) * blocks;
            dz = Math.cos(yaw) * blocks;
          } else if (direction === 'backward') {
            dx = Math.sin(yaw) * blocks;
            dz = -Math.cos(yaw) * blocks;
          } else if (direction === 'left') {
            dx = -Math.sin(yaw + Math.PI / 2) * blocks;
            dz = Math.cos(yaw + Math.PI / 2) * blocks;
          } else if (direction === 'right') {
            dx = -Math.sin(yaw - Math.PI / 2) * blocks;
            dz = Math.cos(yaw - Math.PI / 2) * blocks;
          } else {
            return reply(`Invalid direction "${direction}". Use north, south, east, west, forward, backward, left, or right.`);
          }

          if (Number.isNaN(dx) || Number.isNaN(dz)) {
            return reply('Cannot calculate destination: invalid coordinate offset.');
          }
          const targetX = Math.floor(curPos.x + dx);
          const targetY = Math.floor(curPos.y);
          const targetZ = Math.floor(curPos.z + dz);
          if (Number.isNaN(targetX) || Number.isNaN(targetY) || Number.isNaN(targetZ)) {
            return reply('Cannot calculate destination: NaN coordinates detected.');
          }
          if (!this.mcBot.pathfinder) {
            return reply('Pathfinder is not ready.');
          }
          this.mcBot.physicsEnabled = true;
          this.mcBot.pathfinder.setGoal(new GoalBlock(targetX, targetY, targetZ));
          const onMoveDone = () => {
            if (this.mcBot) this.mcBot.physicsEnabled = false;
            this.mcBot?.removeListener('goal_reached', onMoveDone);
          };
          this.mcBot.once('goal_reached', onMoveDone);
          setTimeout(() => { if (this.mcBot) this.mcBot.physicsEnabled = false; }, blocks * 1000 + 4000);
          return reply(`Moving ${direction} by ${blocks} blocks to (${targetX}, ${targetY}, ${targetZ}).`);
        }
        
        if (name === `${this.config.commandPrefix}rotate`) {
          if (!this.mcBot?.entity) {
            return reply('Cannot rotate: bot entity is not ready.');
          }
          const yaw = interaction.options.getNumber('yaw');
          const pitch = interaction.options.getNumber('pitch');
          if (typeof yaw !== 'number' || Number.isNaN(yaw) || typeof pitch !== 'number' || Number.isNaN(pitch)) {
            return reply('Yaw and pitch must be valid numbers.');
          }
          await this.mcBot.look(yaw, pitch, true);
          return reply(`Rotated to yaw: ${yaw.toFixed(2)}, pitch: ${pitch.toFixed(2)}.`);
        }

      } catch (err) {
        this.log(`Command error: ${err}`);
      }
    });

    this.client.on('messageCreate', async msg => {
      if (msg.author.bot) return;

      // Handle dedicated Terminal channel
      if (this.config.terminalChannelId && msg.channel.id === this.config.terminalChannelId) {
        if (msg.author.id !== this.config.allowedUserId) {
          this.log(`Terminal unauthorized attempt from ${msg.author.tag} (${msg.author.id})`);
          return;
        }
        this.log(`Terminal command received: "${msg.content}"`);
        await this.handleTerminalMessage(msg);
        return;
      }

      // Handle in-game chat relay
      if (!this.mcBot || this.state !== 'ONLINE' || msg.author.id !== this.config.allowedUserId || msg.channel.id !== this.config.discordChannelId) return;
      this.mcBot.chat(msg.content);
    });

    this.client.login(this.config.discordToken);
  }

  async handleTerminalMessage(msg) {
    const rawContent = msg.content.trim();
    if (!rawContent) return;

    // Strip codeblock wrappers if user typed ```bash ... ``` or `...`
    let command = rawContent;
    if (command.startsWith('```') && command.endsWith('```')) {
      command = command.slice(3, -3).trim();
      if (command.startsWith('bash\n') || command.startsWith('sh\n')) {
        command = command.slice(command.indexOf('\n') + 1).trim();
      }
    } else if (command.startsWith('`') && command.endsWith('`')) {
      command = command.slice(1, -1).trim();
    }

    if (!command) return;

    // Built-in cd command
    if (command.startsWith('cd ') || command === 'cd') {
      const targetDir = command === 'cd' ? (process.env.HOME || '/FTP/discordbot') : command.slice(3).trim();
      const resolved = path.resolve(this.terminalCwd, targetDir.replace(/^~/, process.env.HOME || '/home/bot'));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        this.terminalCwd = resolved;
        return msg.reply(`**Directory:** \`${this.terminalCwd}\``);
      } else {
        return msg.reply(`Directory not found: \`${targetDir}\``);
      }
    }

    // Built-in pwd command
    if (command === 'pwd') {
      return msg.reply(`**Current directory:** \`${this.terminalCwd}\``);
    }

    // Indicate typing indicator
    await msg.channel.sendTyping().catch(() => {});

    // Automatically inject password for sudo if needed
    let execCommand = command;
    if (/^\s*sudo\s+/i.test(command)) {
      execCommand = `echo '0123' | sudo -S ${command.replace(/^\s*sudo\s+/i, '')}`;
    }

    exec(execCommand, {
      cwd: this.terminalCwd,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/bash'
    }, (err, stdout, stderr) => {
      let output = (stdout || '') + (stderr || '');
      output = output.replace(/\[sudo\] password for [^:]+:\s*/g, '').trim();

      if (!output) {
        if (err) {
          return msg.reply(`Command failed: \`${err.message}\``);
        }
        return msg.reply('Process exited with code 0 (no output).');
      }

      if (output.length <= 1900) {
        return msg.reply(`\`\`\`bash\n${output}\n\`\`\``);
      }

      // If output exceeds Discord message limit (2000 chars), attach as output.txt
      const buffer = Buffer.from(output, 'utf-8');
      const attachment = new AttachmentBuilder(buffer, { name: 'output.txt' });
      const preview = output.slice(0, 400);
      return msg.reply({
        content: `\`\`\`bash\n${preview}\n... (truncated, ${output.length} characters total)\n\`\`\``,
        files: [attachment]
      });
    });
  }

  setupWebSocket() {
    const wss = new WebSocket.Server({ port: this.config.wsPort }, () => {
      this.log(`WebSocket server running on port ${this.config.wsPort}`);
    });
    
    wss.on('error', err => {
      this.log(`WebSocket server error: ${err.message}`);
    });
    
    wss.on('connection', ws => {
      ws.on('error', err => {
        this.log(`WebSocket connection error: ${err.message}`);
      });
      
      ws.on('message', msg => {
        const cmd = msg.toString().trim();
        if (cmd === 'start') {
          this.manualStop = false;
          this.start('websocket-start');
          ws.send(this.state !== 'OFFLINE' ? 'starting_or_running' : 'start_failed');
        } else if (cmd === 'stop') {
          this.stop('manual');
          ws.send('stopped');
        } else if (this.state === 'ONLINE' && this.mcBot) {
          this.mcBot.chat(cmd);
          ws.send(`sent:${cmd}`);
        } else {
          ws.send('not_running');
        }
      });
    });
  }

  stop(reason = 'manual') {
    if (reason === 'manual') {
      this.manualStop = true;
      this.saveState();
    }
    this.log(`Stopping bot... (${reason})`);
    this.sendToDiscord(`Stopping bot... (${reason})`);
    
    this.state = 'OFFLINE';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    
    this.modeClickInProgress = false;

    if (this.chatFlushTimer) {
      clearTimeout(this.chatFlushTimer);
      this.chatFlushTimer = null;
    }
    this.chatBuffer = [];

    if (this.mcBot) {
      const botToStop = this.mcBot;
      this.mcBot = null;

      // Keep dummy error handlers during teardown so socket drop errors are absorbed and cannot crash Node
      try {
        botToStop.removeAllListeners();
        botToStop.on('error', () => {});
        if (botToStop._client) {
          botToStop._client.removeAllListeners();
          botToStop._client.on('error', () => {});
          try { botToStop._client.socket?.destroy(); } catch (e) {}
          try { botToStop._client.end(); } catch (e) {}
        }
        try { botToStop.end(); } catch (e) {}
      } catch (e) {}
    }
  }

  start(reason = 'manual') {
    if (this.manualStop) {
      this.log(`Start skipped (${reason}): bot is manually stopped.`);
      return;
    }
    if (this.state === 'CONNECTING' || this.state === 'ONLINE') return;
    
    this.state = 'CONNECTING';
    this.navigatedOnSpawn = false;
    this.log(`Starting bot (${reason})...`);
    this.sendToDiscord(`Starting bot (${reason})...`);
    
    this.mcBot = mineflayer.createBot({
      host: this.config.mcHost,
      port: 25565,
      username: this.config.mcUsername,
      auth: this.config.mcAuth,
      version: this.config.mcVersion,
      checkTimeoutInterval: 60 * 1000,
      
      onMsaCode: (data) => {
        this.log(`MSA Code: ${data.user_code} (${data.verification_uri})`);
        this.sendToDiscord(`**Microsoft Authentication Required:**\nVisit: ${data.verification_uri}\nEnter code: \`${data.user_code}\``);
      }
    });

    // Unified disconnect and error handling registered immediately
    const onDisconnect = (event, reason) => {
      if (this.manualStop || this.state === 'OFFLINE') return;
      const reasonStr = normalizeReason(reason);
      this.log(`Disconnected (${event}): ${reasonStr}`);
      if (reason) {
        try {
          console.log(`[${this.config.commandPrefix.toUpperCase()}] [RAW DISCONNECT]`, typeof reason === 'object' ? JSON.stringify(reason) : reason);
        } catch (e) {}
      }
      this.sendToDiscord(`Disconnected (${event}): ${reasonStr}`);
      this.handleDisconnect(reasonStr);
    };

    this.mcBot.on('end', r => onDisconnect('end', r));
    this.mcBot.on('kicked', r => onDisconnect('kicked', r));
    this.mcBot.on('error', err => onDisconnect('error', err?.message));

    this.mcBot.loadPlugin(pathfinder);

    this.mcBot.once('connect', () => {
      this.log('TCP connected.');
    });

    this.mcBot.once('spawn', async () => {
      this.state = 'ONLINE';
      this.reconnectAttempts = 0;
      this.log('Bot spawned in-game.');
      this.sendToDiscord('Bot spawned in-game.');

      try {
        const mcData = require('minecraft-data')(this.mcBot.version);
        const defaultMovements = new Movements(this.mcBot, mcData);
        defaultMovements.canDig = false;
        defaultMovements.scafoldingBlocks = [];
        this.mcBot.pathfinder.setMovements(defaultMovements);
      } catch (err) {}

      this.navigatedOnSpawn = false;

      // Once spawned and settled, suspend 3D physics collision calculations (drops CPU from 16% to < 2%)
      setTimeout(() => {
        if (this.mcBot && this.state === 'ONLINE') {
          this.mcBot.physicsEnabled = false;
          this.log('Ultra-Low CPU mode active: idle physics suspended.');
        }
      }, 5000);

      // Fallback: if server login message is not received within 6 seconds, attempt navigation
      setTimeout(() => {
        if (this.state === 'ONLINE' && this.mcBot && !this.navigatedOnSpawn && this.autoNavigate && this.targetMode) {
          this.navigatedOnSpawn = true;
          this.navigateWithCompass(this.targetMode);
        }
      }, 6000);
    });

    this.mcBot.on('message', async (jsonMsg) => {
      let fullMessage = '';
      if (jsonMsg.unsigned) fullMessage = flattenComponent(jsonMsg.unsigned).trim();
      else if (jsonMsg.json) fullMessage = flattenComponent(jsonMsg.json).trim();
      else fullMessage = jsonMsg.toString().trim();
      
      if (!fullMessage) return;
      
      const t = fullMessage.toLowerCase();

      // Trigger gamemode navigation ONLY after the server confirms authentication
      if (!this.navigatedOnSpawn && (t.includes('successfully logged in') || t.includes('automatically logged in') || t.includes('welcome to ultranetwork') || t.includes("you're already logged in"))) {
        this.navigatedOnSpawn = true;
        this.log('Authentication confirmed by server. Navigating with compass in 2.5s...');
        setTimeout(() => {
          if (this.state === 'ONLINE' && this.mcBot) {
            this.navigateWithCompass(this.targetMode);
          }
        }, 2500);
      }

      if (t.includes('you have started auto mining') || t.includes('you were sent back to auto mining') || t.includes('+ 466p')) {
        this.currentMode = 'prison';
        this.targetMode = 'prison';
        this.pendingModeSelection = false;
      }
      if (t.includes('connecting to survival') || t.includes('selected survival')) {
        this.currentMode = 'survival';
        this.targetMode = 'survival';
        this.pendingModeSelection = false;
      }
      
      this.queueMessage(fullMessage);
    });
  }

  handleDisconnect(reasonStr) {
    if (this.manualStop || this.state === 'OFFLINE') {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      return;
    }
    
    if (reasonStr.includes('failed to obtain profile data') || reasonStr.includes('does the account own minecraft')) {
      this.log('Authentication failed. Stopping reconnect loop.');
      this.sendToDiscord('Authentication failed: Microsoft account profile could not be verified. Autostart stopped.');
      this.stop('manual');
      return;
    }

    this.stop('reconnecting');
    this.state = 'RECONNECTING';
    
    // Calculate exponential backoff (min 25s to prevent CPU watchdog triggers)
    let delayMs = Math.min(25000 + (this.reconnectAttempts * 20000), 180000);
    
    if (reasonStr.includes('you are already connected to this proxy')) {
      // Heavy exponential backoff for proxy ghost sessions
      delayMs = Math.min(45000 + (this.reconnectAttempts * 45000), 300000);
    } else if (reasonStr.includes('socketclosed') || reasonStr.includes('timeout')) {
      delayMs = Math.min(30000 + (this.reconnectAttempts * 15000), 90000);
    }
    
    this.reconnectAttempts++;
    this.log(`Scheduling reconnect #${this.reconnectAttempts} in ${delayMs / 1000}s...`);
    this.sendToDiscord(`Reconnecting in ${delayMs / 1000}s...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.start('auto-reconnect');
    }, delayMs);
  }

  async navigateWithCompass(targetMode) {
    if (this.state !== 'ONLINE' || !this.mcBot || this.modeClickInProgress) return;
    this.modeClickInProgress = true;
    if (this.mcBot) this.mcBot.physicsEnabled = true;
    
    this.log(`Auto-navigating to ${targetMode}...`);
    this.sendToDiscord(`Auto-navigating to ${targetMode}...`);
    
    // Find compass in hotbar (slots 36-44)
    const compass = this.mcBot.inventory.slots.slice(36, 45).find(i => i && i.name && i.name.includes('compass'));
    if (!compass) {
      this.log('No compass found in hotbar.');
      this.modeClickInProgress = false;
      setTimeout(() => { if (this.mcBot && this.state === 'ONLINE') this.mcBot.physicsEnabled = false; }, 3000);
      return;
    }
    
    const hotbarSlot = compass.slot - 36;
    this.mcBot.setQuickBarSlot(hotbarSlot);
    await delay(1000);
    
    const onWindowOpen = async (window) => {
      this.mcBot.removeListener('windowOpen', onWindowOpen);
      await delay(2500); // Wait for GUI to populate
      
      if (this.state !== 'ONLINE') return;
      const targetItemName = targetMode === 'survival' ? 'grass_block' : 'netherite_pickaxe';
      const targetItem = window.slots.find(i => i && i.name === targetItemName);
      
      if (targetItem) {
        try {
          await this.mcBot.clickWindow(targetItem.slot, 0, 0);
          this.log(`Successfully clicked ${targetItemName} for ${targetMode}.`);
          this.sendToDiscord(`Successfully clicked ${targetItemName} for ${targetMode}.`);
          this.pendingModeSelection = false;
        } catch (e) {
          this.log(`Failed to click ${targetItemName}: ${e.message}`);
        }
      } else {
        this.log(`Could not find ${targetItemName} in GUI.`);
      }
      this.modeClickInProgress = false;
      setTimeout(() => { if (this.mcBot && this.state === 'ONLINE') this.mcBot.physicsEnabled = false; }, 4000);
    };
    
    this.mcBot.once('windowOpen', onWindowOpen);
    
    try {
      await this.mcBot.activateItem();
    } catch (e) {
      this.log(`Failed to activate compass: ${e.message}`);
      this.modeClickInProgress = false;
      setTimeout(() => { if (this.mcBot && this.state === 'ONLINE') this.mcBot.physicsEnabled = false; }, 3000);
    }
  }

  getStatus() {
    const isOnline = this.state === 'ONLINE' && this.mcBot?.entity;
    return {
      prefix: this.config.commandPrefix,
      username: this.mcBot?.username || this.config.mcUsername || 'Unknown',
      state: this.state, // ONLINE, CONNECTING, OFFLINE, RECONNECTING
      manualStop: Boolean(this.manualStop),
      mode: this.currentMode || this.targetMode,
      targetMode: this.targetMode,
      health: this.mcBot?.health != null ? Math.round(this.mcBot.health) : null,
      food: this.mcBot?.food != null ? Math.round(this.mcBot.food) : null,
      ping: this.mcBot?.player?.ping != null ? this.mcBot.player.ping : null,
      pos: isOnline && this.mcBot.entity.position ? {
        x: Math.round(this.mcBot.entity.position.x * 10) / 10,
        y: Math.round(this.mcBot.entity.position.y * 10) / 10,
        z: Math.round(this.mcBot.entity.position.z * 10) / 10,
        yaw: typeof this.mcBot.entity.yaw === 'number' ? Math.round(this.mcBot.entity.yaw * 180 / Math.PI) : 0,
        pitch: typeof this.mcBot.entity.pitch === 'number' ? Math.round(this.mcBot.entity.pitch * 180 / Math.PI) : 0
      } : null,
      hasWindow: Boolean(this.mcBot?.currentWindow),
      windowTitle: this.mcBot?.currentWindow ? (this.mcBot.currentWindow.title || 'Container') : null
    };
  }

  getRecentChats() {
    return this.recentChats || [];
  }

  sendChat(msg) {
    if (!this.mcBot || this.state !== 'ONLINE') {
      throw new Error('Bot is not online.');
    }
    const clean = String(msg || '').trim();
    if (!clean) return false;
    this.mcBot.chat(clean);
    if (!this.recentChats) this.recentChats = [];
    this.recentChats.push({
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      text: `> ${clean}`
    });
    if (this.recentChats.length > 100) this.recentChats.shift();
    return true;
  }

  async doWalk(steps = 5) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    if (!this.mcBot.entity?.position || typeof this.mcBot.entity.yaw !== 'number' || Number.isNaN(this.mcBot.entity.yaw)) {
      throw new Error('Bot position or rotation is not ready yet.');
    }
    const numSteps = Number(steps) || 5;
    const curPos = this.mcBot.entity.position;
    const dir = this.mcBot.entity.yaw;
    const dx = -Math.sin(dir) * numSteps;
    const dz = Math.cos(dir) * numSteps;
    const targetX = Math.floor(curPos.x + dx);
    const targetY = Math.floor(curPos.y);
    const targetZ = Math.floor(curPos.z + dz);
    if (!this.mcBot.pathfinder) throw new Error('Pathfinder is not ready.');
    this.mcBot.physicsEnabled = true;
    this.mcBot.pathfinder.setGoal(new GoalBlock(targetX, targetY, targetZ));
    const onDone = () => {
      if (this.mcBot) this.mcBot.physicsEnabled = false;
      this.mcBot?.removeListener('goal_reached', onDone);
    };
    this.mcBot.once('goal_reached', onDone);
    setTimeout(() => { if (this.mcBot) this.mcBot.physicsEnabled = false; }, numSteps * 1000 + 4000);
    return `Walking ${numSteps} blocks forward to (${targetX}, ${targetY}, ${targetZ})`;
  }

  async doMove(direction, blocks = 3) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    if (!this.mcBot.entity?.position) throw new Error('Bot position is not ready yet.');
    const numBlocks = Number(blocks) || 3;
    const curPos = this.mcBot.entity.position;
    const yaw = typeof this.mcBot.entity.yaw === 'number' && !Number.isNaN(this.mcBot.entity.yaw) ? this.mcBot.entity.yaw : 0;
    let dx = 0;
    let dz = 0;
    const d = (direction || '').toLowerCase();
    if (d === 'north') dz = -numBlocks;
    else if (d === 'south') dz = numBlocks;
    else if (d === 'east') dx = numBlocks;
    else if (d === 'west') dx = -numBlocks;
    else if (d === 'forward') {
      dx = -Math.sin(yaw) * numBlocks;
      dz = Math.cos(yaw) * numBlocks;
    } else if (d === 'backward') {
      dx = Math.sin(yaw) * numBlocks;
      dz = -Math.cos(yaw) * numBlocks;
    } else if (d === 'left') {
      dx = -Math.sin(yaw + Math.PI / 2) * numBlocks;
      dz = Math.cos(yaw + Math.PI / 2) * numBlocks;
    } else if (d === 'right') {
      dx = -Math.sin(yaw - Math.PI / 2) * numBlocks;
      dz = Math.cos(yaw - Math.PI / 2) * numBlocks;
    } else {
      throw new Error(`Invalid direction: ${direction}. Use north, south, east, west, forward, backward, left, or right.`);
    }
    const targetX = Math.floor(curPos.x + dx);
    const targetY = Math.floor(curPos.y);
    const targetZ = Math.floor(curPos.z + dz);
    if (!this.mcBot.pathfinder) throw new Error('Pathfinder is not ready.');
    this.mcBot.physicsEnabled = true;
    this.mcBot.pathfinder.setGoal(new GoalBlock(targetX, targetY, targetZ));
    const onDone = () => {
      if (this.mcBot) this.mcBot.physicsEnabled = false;
      this.mcBot?.removeListener('goal_reached', onDone);
    };
    this.mcBot.once('goal_reached', onDone);
    setTimeout(() => { if (this.mcBot) this.mcBot.physicsEnabled = false; }, numBlocks * 1000 + 4000);
    return `Moving ${direction} ${numBlocks} blocks to (${targetX}, ${targetY}, ${targetZ})`;
  }

  async doClickSlot(slot, mode = 0) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    const s = Number(slot);
    if (Number.isNaN(s) || s < 0) throw new Error('Invalid slot number.');
    await this.mcBot.clickWindow(s, 0, mode);
    return `Clicked slot ${s} (${mode === 1 ? 'Shift-Click' : 'Left-Click'})`;
  }

  async doSelectHotbar(slot) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    const s = Number(slot);
    if (Number.isNaN(s) || s < 0 || s > 8) throw new Error('Slot must be between 0 and 8.');
    this.mcBot.setQuickBarSlot(s);
    return `Selected hotbar slot ${s}`;
  }

  async doRightClick(slot = null) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    if (slot !== null && slot !== undefined && slot !== '') {
      const s = Number(slot);
      if (!Number.isNaN(s) && s >= 0 && s <= 8) {
        this.mcBot.setQuickBarSlot(s);
      }
    }
    await this.mcBot.activateItem();
    return 'Right-clicked held item';
  }

  doCloseGui() {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    if (!this.mcBot.currentWindow) throw new Error('No GUI window is currently open.');
    this.mcBot.closeWindow(this.mcBot.currentWindow);
    return 'GUI closed';
  }

  doChangeMode(mode) {
    if (!this.mcBot || this.state !== 'ONLINE') throw new Error('Bot is not online.');
    const m = (mode || '').toLowerCase();
    if (m !== 'prison' && m !== 'survival') throw new Error('Mode must be prison or survival.');
    this.targetMode = m;
    this.navigateWithCompass(m);
    return `Switching to ${m}...`;
  }

  doStart() {
    this.manualStop = false;
    this.saveState();
    this.start('web-action');
    return 'Bot start initiated';
  }

  doStop() {
    this.stop('manual');
    return 'Bot stopped';
  }

  async doRestart() {
    this.stop('manual');
    await delay(2000);
    this.manualStop = false;
    this.saveState();
    this.start('web-restart');
    return 'Bot restarting';
  }

  getScreenImage() {
    if (!this.mcBot || this.state !== 'ONLINE') return null;
    const win = this.mcBot.currentWindow || this.mcBot.inventory;
    if (!win) return null;
    return renderInventoryCanvas(win, Boolean(this.mcBot.currentWindow));
  }
}

module.exports = {
  DiscordMCBot,
  renderInventoryCanvas,
  renderOnlinePlayersCanvas,
  getItemDisplayName
};
