// events/messageCreate.js
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const imghash = require('imghash');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const pool = require('../database/pool');

const configPath = path.join(__dirname, '../config.json');
let rawConfig = {};

if (fs.existsSync(configPath)) {
    try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (parseError) {
        console.error('⚠️ Critical Error: config.json is malformed.', parseError);
    }
}

const mediaLimits = rawConfig.mediaRateLimit || {};

const maxDuplicates    = mediaLimits.maxDuplicates !== undefined ? mediaLimits.maxDuplicates : 2;
const maxChannels      = mediaLimits.maxChannels !== undefined ? mediaLimits.maxChannels : 2;
const timeWindowMs     = mediaLimits.timeWindowMs !== undefined ? mediaLimits.timeWindowMs : 5000;
const hammingThreshold = mediaLimits.hammingThreshold !== undefined ? mediaLimits.hammingThreshold : 10;
const timeoutEnabled   = mediaLimits.timeoutEnabled !== undefined ? mediaLimits.timeoutEnabled : true; // 🌟 NEW PARAM
const autoBlacklistEnabled = mediaLimits.autoBlacklistEnabled !== undefined ? mediaLimits.autoBlacklistEnabled : true; // 🌟 NEW PARAM
const timeoutDays      = mediaLimits.timeoutDays !== undefined ? mediaLimits.timeoutDays : 1;
const modChannelId     = mediaLimits.modChannelId || "";

const daysConfigured = timeoutDays > 0 ? timeoutDays : 1;
const TIMEOUT_DURATION_MS = daysConfigured * 24 * 60 * 60 * 1000;

const globalSpeedTrapTracker = new Map();

function getHammingDistance(hash1, hash2) {
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        const val1 = parseInt(hash1[i], 16);
        const val2 = parseInt(hash2[i], 16);
        let xor = val1 ^ val2;
        while (xor > 0) {
            if (xor & 1) distance++;
            xor >>= 1;
        }
    }
    return distance;
}

async function sendModIncidentLog(client, user, channel, imageBuffer, fileName, hash, triggerType, notes = '') {
    if (!modChannelId) return;
    try {
        const targetChannel = await client.channels.fetch(modChannelId);
        if (!targetChannel) return;

        const fileAttachment = new AttachmentBuilder(imageBuffer, { name: `spam_${fileName}` });

        const logEmbed = new EmbedBuilder()
            .setTitle(`🚨 Media Filter Alert: ${triggerType}`)
            .setColor(0xff0000)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'Spammer Username', value: `\`${user.username}\``, inline: true },
                { name: 'Spammer Discord ID', value: `\`${user.id}\``, inline: true },
                { name: 'Target Channel', value: `${channel} (\`${channel.id}\`)`, inline: true },
                { name: 'Perceptual Hash', value: `\`${hash}\``, inline: false }
            )
            .setImage(`attachment://spam_${fileName}`)
            .setTimestamp();

        if (notes) {
            logEmbed.addFields({ name: 'Action Taken', value: notes });
        }

        await targetChannel.send({ 
            content: `**Spam Incident Detected**\n**User:** ${user.tag}\n**ID:** \`${user.id}\``,
            embeds: [logEmbed], 
            files: [fileAttachment] 
        });
    } catch (err) {
        console.error('Failed to dispatch incident report payload to mod channel:', err);
    }
}

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        console.info('messageCreate event triggered');
        if (message.author.bot || !message.guild || !message.member) return;
        // if (message.member.permissions.has('Administrator')) return;
        console.info('messageCreate event triggered2');
        if (message.flags.has(MessageFlags.HasSnapshot)) return;

        const imageAttachment = message.attachments.find(att => 
            /\.(jpg|jpeg|png|webp)$/i.test(att.name)
        );
        console.info(`Found attachment: ${imageAttachment ? imageAttachment.name : 'NONE'}`);
        if (!imageAttachment) return;

        let conn;
        try {
            console.info('Attempting to download and hash image...');
            const response = await axios.get(imageAttachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            const currentImageHash = await imghash.hash(imageBuffer, 8, 'hex');

            // ==========================================
            // OPTION 1: GLOBAL DATABASE BLOCKLIST CHECK
            // ==========================================
            console.info('Connecting to MariaDB database...');
            conn = await pool.getConnection();
            const blacklistedRecords = await conn.query('SELECT image_hash FROM blacklisted_media');
            console.info('messageCreate image stuff');
            let isGloballyBanned = false;
            for (const record of blacklistedRecords) {
                const distance = getHammingDistance(currentImageHash, record.image_hash);
                if (distance <= hammingThreshold) {
                    isGloballyBanned = true;
                    break;
                }
            }

            if (isGloballyBanned) {
                await sendModIncidentLog(
                    client, message.author, message.channel, imageBuffer, imageAttachment.name, currentImageHash, 'GLOBAL BLOCKLIST', '🗑️ Auto-deleted matching message entry.'
                );
                await message.delete().catch(() => {});
                return; 
            }
            console.info('globally banned check complete');

            // ==========================================
            // OPTION 2: MULTI-CHANNEL SPEED TRAP
            // ==========================================
            const trackingKey = `${message.author.id}_${currentImageHash}`;
            const now = Date.now();

            let trackingPayload = globalSpeedTrapTracker.get(trackingKey) || { history: [] };
            trackingPayload.history = trackingPayload.history.filter(item => (now - item.timestamp) <= timeWindowMs);
            trackingPayload.history.push({ timestamp: now, messageId: message.id, channelId: message.channel.id });
            globalSpeedTrapTracker.set(trackingKey, trackingPayload);

            const uniquelyTargetedChannels = new Set(trackingPayload.history.map(item => item.channelId));
            const totalPostsInWindow = trackingPayload.history.length;

            if (totalPostsInWindow > maxDuplicates || uniquelyTargetedChannels.size > maxChannels) {
                console.info('multi-channel speed trap triggered');
                const exactCheck = await conn.query('SELECT media_id FROM blacklisted_media WHERE image_hash = ?', [currentImageHash]);
                if (autoBlacklistEnabled) {
                    if (exactCheck.length === 0) {
                        await conn.query(
                            `INSERT INTO blacklisted_media (image_hash, added_by_type, spammer_username, spammer_id) VALUES (?, 'AUTOMATED', ?, ?)`,
                            [currentImageHash, message.author.username, message.author.id]
                        );
                    }
                }

                // Compile audit summary dynamically based on whether active punishments are toggled on
                const penaltyStatusText = timeoutEnabled 
                    ? `🤐 Issued timeout penalty for **${daysConfigured} day(s)**.` 
                    : `🛡️ Timeout skipped (Action disabled in config).`;

                const actionTakenNotes = `⏳ Auto-blacklisted hash.\n🧹 Bulk-deleted messages across **${uniquelyTargetedChannels.size} channels**.\n${penaltyStatusText}`;
                
                await sendModIncidentLog(
                    client, message.author, message.channel, imageBuffer, imageAttachment.name, currentImageHash, 'MULTI-CHANNEL MEDIA RAID', actionTakenNotes
                );

                // Purge messages
                for (const entry of trackingPayload.history) {
                    try {
                        const targetChan = await message.guild.channels.fetch(entry.channelId);
                        if (targetChan) {
                            const targetMsg = await targetChan.messages.fetch(entry.messageId);
                            if (targetMsg) await targetMsg.delete().catch(() => {});
                        }
                    } catch (e) {}
                }

                globalSpeedTrapTracker.delete(trackingKey);

                // 🌟 EXECUTE TIMEOUT CONDITIONALLY 🌟
                if (timeoutEnabled) {
                    if (message.member.moderatable) {
                        await message.member.timeout(TIMEOUT_DURATION_MS, 'Automated Multi-Channel Media Spam Portal: Exceeded distribution limits.');
                        const timeLabel = daysConfigured === 1 ? '1 day' : `${daysConfigured} days`;
                        await message.channel.send(`🚨 **${message.author.username}** has been timed out for ${timeLabel} due to cross-channel media spamming.`);
                    }
                }
                
                return;
            }

            setTimeout(() => {
                const currentRecord = globalSpeedTrapTracker.get(trackingKey);
                if (currentRecord) {
                    const validHistory = currentRecord.history.filter(item => (Date.now() - item.timestamp) <= timeWindowMs);
                    if (validHistory.length === 0) {
                        globalSpeedTrapTracker.delete(trackingKey);
                    } else {
                        globalSpeedTrapTracker.set(trackingKey, { history: validHistory });
                    }
                }
            }, timeWindowMs + 1000);

        } catch (error) {
            console.error('Error running cross-channel image protection logic:', error);
        } finally {
            if (conn) conn.release(); 
        }
    },
};