// commands/setconfig.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const fs = require('fs');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setconfig')
        .setDescription('Updates the live media spam portal limits in config.json')
        .addIntegerOption(option => 
            option.setName('max_duplicates')
                .setDescription('Max total copies allowed across the server within the window')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('max_channels')
                .setDescription('Max unique channels an image can be posted in within the window')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('time_window_ms')
                .setDescription('The evaluation window in milliseconds (e.g., 5000 for 5s)')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('timeout_enabled')
                .setDescription('Whether the bot should actively timeout the spamming user')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('auto_blacklist_enabled')
                .setDescription('Whether the bot should automatically blacklist spam images')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('timeout_days')
                .setDescription('Number of days to communication timeout the spammer')
                .setRequired(false))
        .addChannelOption(option => 
            option.setName('mod_channel')
                .setDescription('The private channel where incident logs and image buffers are sent')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const configPath = path.join(__dirname, '../config.json');
        let currentConfig = {};

        if (fs.existsSync(configPath)) {
            try {
                currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (err) {
                console.error('Failed to parse config while writing updates:', err);
                return await interaction.editReply('❌ The current `config.json` file is malformed. Fix it manually first.');
            }
        }

        if (!currentConfig.mediaRateLimit) {
            currentConfig.mediaRateLimit = {
                maxDuplicates: 2,
                maxChannels: 2,
                timeWindowMs: 5000,
                hammingThreshold: 10,
                timeoutEnabled: true,
                autoBlacklistEnabled: true,
                timeoutDays: 1,
                modChannelId: ""
            };
        }

        const maxDuplicates = interaction.options.getInteger('max_duplicates');
        const maxChannels = interaction.options.getInteger('max_channels');
        const timeWindowMs = interaction.options.getInteger('time_window_ms');
        const timeoutEnabled = interaction.options.getBoolean('timeout_enabled');
        const autoBlacklistEnabled = interaction.options.getBoolean('auto_blacklist_enabled');
        const timeoutDays = interaction.options.getInteger('timeout_days');
        const modChannel = interaction.options.getChannel('mod_channel');

        let changesApplied = [];

        if (maxDuplicates !== null) {
            currentConfig.mediaRateLimit.maxDuplicates = maxDuplicates;
            changesApplied.push(`Max Duplicates ➔ \`${maxDuplicates}\``);
        }
        if (maxChannels !== null) {
            currentConfig.mediaRateLimit.maxChannels = maxChannels;
            changesApplied.push(`Max Channels ➔ \`${maxChannels}\``);
        }
        if (timeWindowMs !== null) {
            currentConfig.mediaRateLimit.timeWindowMs = timeWindowMs;
            changesApplied.push(`Time Window ➔ \`${timeWindowMs}ms\``);
        }
        if (timeoutEnabled !== null) {
            currentConfig.mediaRateLimit.timeoutEnabled = timeoutEnabled;
            changesApplied.push(`Timeout Action Enabled ➔ \`${timeoutEnabled}\``);
        }
        if (autoBlacklistEnabled !== null) {
            currentConfig.mediaRateLimit.autoBlacklistEnabled = autoBlacklistEnabled;
            changesApplied.push(`Auto-Blacklist Enabled ➔ \`${autoBlacklistEnabled}\``);
        }
        if (timeoutDays !== null) {
            currentConfig.mediaRateLimit.timeoutDays = timeoutDays;
            changesApplied.push(`Timeout Days ➔ \`${timeoutDays} day(s)\``);
        }
        if (modChannel !== null) {
            currentConfig.mediaRateLimit.modChannelId = modChannel.id;
            changesApplied.push(`Mod Log Channel ➔ <#${modChannel.id}>`);
        }

        if (changesApplied.length === 0) {
            return await interaction.editReply('⚠️ No configuration updates were specified.');
        }

        try {
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf8');
            const logSummary = changesApplied.map(change => `• ${change}`).join('\n');
            await interaction.editReply(`✅ **Configuration file successfully updated live:**\n${logSummary}`);
        } catch (writeError) {
            console.error('File system error trying to save config settings:', writeError);
            await interaction.editReply('❌ Failed to commit config updates to the server disk storage.');
        }
    }
};