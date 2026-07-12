// events/messageCreate.js
// new messageCreate with better multi-channel spam detection and global blocklist checks
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
// NOTE: threshold scale changed when pHash grid size went from 8x8 (64 bits)
// to 16x16 (256 bits). Old default of 10 was tuned for 64-bit hashes;
// 40 is the equivalent starting point for 256-bit hashes (~15% difference).
// Retune based on real false-positive/negative data once live.
const hammingThreshold = mediaLimits.hammingThreshold !== undefined ? mediaLimits.hammingThreshold : 40;
const timeoutEnabled   = mediaLimits.timeoutEnabled !== undefined ? mediaLimits.timeoutEnabled : true; // 🌟 NEW PARAM
const autoBlacklistEnabled = mediaLimits.autoBlacklistEnabled !== undefined ? mediaLimits.autoBlacklistEnabled : true; // 🌟 NEW PARAM
const timeoutDays      = mediaLimits.timeoutDays !== undefined ? mediaLimits.timeoutDays : 1;
const modChannelId     = mediaLimits.modChannelId || "";

const daysConfigured = timeoutDays > 0 ? timeoutDays : 1;
const TIMEOUT_DURATION_MS = daysConfigured * 24 * 60 * 60 * 1000;

const globalSpeedTrapTracker = new Map();

// In-memory cache of the blocklist. Querying the entire blacklisted_media
// table on every single image message doesn't scale as the table grows.
// Instead we cache it and refresh periodically, plus force-refresh
// immediately after we add a new hash ourselves (see `dirty` flag below).
const BLACKLIST_CACHE_TTL_MS = 60 * 1000; // refresh at most once a minute
const blacklistCache = {
    data: [],       // array of { image_hash }
    lastFetched: 0,
    dirty: true,    // true forces a refresh on next lookup
};

async function getBlacklistedHashes(conn) {
    const isStale = Date.now() - blacklistCache.lastFetched > BLACKLIST_CACHE_TTL_MS;
    if (blacklistCache.dirty || isStale) {
        const rawRecords = await conn.query('SELECT image_hash FROM blacklisted_media');
        blacklistCache.data = rawRecords || [];
        blacklistCache.lastFetched = Date.now();
        blacklistCache.dirty = false;
        console.info(`🔄 Blocklist cache refreshed. ${blacklistCache.data.length} entries loaded.`);
    }
    return blacklistCache.data;
}

function getHammingDistance(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) {
        // Mismatched lengths happen if old (8x8) and new (16x16) hashes
        // are ever compared during a migration transition. Treat as
        // "no match" rather than producing a meaningless distance.
        return Infinity;
    }
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

        // 🌟 REPAIR THE HOLLOW OBJECT IF IT IS A PARTIAL:
        if (message.partial) {
            try {
                await message.fetch();
            } catch (error) {
                console.error('Something went wrong when fetching the partial message data:', error);
                return;
            }
        }

        console.info('messageCreate event triggered');
        if (message.author.bot || !message.guild || !message.member) return;
        // if (message.member.permissions.has('Administrator')) return;
        console.info('messageCreate event triggered2');
        if (message.flags.has(MessageFlags.HasSnapshot)) return;

        message.attachments.forEach((att, index) => {
            console.info(`Attachment #${index} RAW DATA -> Name: "${att.name}" | ContentType: "${att.contentType}" | URL: "${att.url ? 'Yes' : 'No'}"`);
        });

        const imageAttachment = message.attachments.find(att => {
            const isImgExtension = /\.(jpg|jpeg|png|webp)/i.test(att.name);
            const isImgType = att.contentType && att.contentType.startsWith('image/');
            // Exclude gifs since imghash is meant for static images
            const isGif = att.name.endsWith('.gif') || (att.contentType && att.contentType.includes('gif'));
            
            return (isImgExtension || isImgType) && !isGif;
        });
        console.info(`Found attachment: ${imageAttachment ? imageAttachment.name : 'NONE'}`);
        if (!imageAttachment) return;

        let conn;
        try {
            console.info('Attempting to download and hash image...');
            const response = await axios.get(imageAttachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            const currentImageHash = await imghash.hash(imageBuffer, 16, 'hex');

            // ==========================================
            // OPTION 1: GLOBAL DATABASE BLOCKLIST CHECK
            // ==========================================
            console.info('Connecting to MariaDB database...');
            conn = await pool.getConnection();
            
            console.info('Fetching blacklisted hashes (cached)...');
            const blacklistedRecords = await getBlacklistedHashes(conn);

            console.info(`Blocklist lookup complete. Total blocked items in cache: ${blacklistedRecords.length}`);
            
            let isGloballyBanned = false;
            if (blacklistedRecords.length > 0) {
                for (const record of blacklistedRecords) {
                    if (!record.image_hash) continue; // Skip malformed rows
                    const distance = getHammingDistance(currentImageHash, record.image_hash);
                    if (distance <= hammingThreshold) {
                        isGloballyBanned = true;
                        break;
                    }
                }
            }

            if (isGloballyBanned) {
                console.info('🎯 Match found in Global Blocklist! Deleting message...');
                await sendModIncidentLog(
                    client, message.author, message.channel, imageBuffer, imageAttachment.name, currentImageHash, 'GLOBAL BLOCKLIST', '🗑️ Auto-deleted matching message entry.'
                );
                await message.delete().catch(err => console.error("❌ Failed to delete globally banned message:", err));
                return; 
            }
            console.info('✅ Globally banned check complete (No matches found). Proceeding to Speed Trap...');

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
                console.info('🚨 MULTI-CHANNEL SPEED TRAP ENGAGED: Executing mass purge superpowers...');
                
                if (autoBlacklistEnabled) {
                    try {
                        await conn.query(
                            `INSERT INTO blacklisted_media (image_hash, added_by_type, spammer_username, spammer_id) VALUES (?, 'AUTOMATED', ?, ?)`,
                            [currentImageHash, message.author.username, message.author.id]
                        );
                        // New hash added — invalidate the in-memory cache so
                        // the next lookup picks it up immediately.
                        blacklistCache.dirty = true;
                    } catch (insertErr) {
                        // ER_DUP_ENTRY (1062): another concurrent request already
                        // inserted this exact hash first. That's fine — the hash
                        // is blacklisted either way, so just continue.
                        if (insertErr.code !== 'ER_DUP_ENTRY' && insertErr.errno !== 1062) {
                            throw insertErr;
                        }
                    }
                }

                const penaltyStatusText = timeoutEnabled 
                    ? `🤐 Issued timeout penalty for **${daysConfigured} day(s)**.` 
                    : `🛡️ Timeout skipped (Action disabled in config).`;

                const actionTakenNotes = `⏳ Auto-blacklisted hash.\n🧹 Bulk-deleted messages across **${uniquelyTargetedChannels.size} channels** via Admin Override.\n${penaltyStatusText}`;
                
                await sendModIncidentLog(
                    client, message.author, message.channel, imageBuffer, imageAttachment.name, currentImageHash, 'MULTI-CHANNEL MEDIA RAID', actionTakenNotes
                );

                // 🌟 SUPERPOWER BULK PURGE: Group message IDs by channel to wipe them instantly
                const channelGroups = {};
                for (const entry of trackingPayload.history) {
                    if (!channelGroups[entry.channelId]) {
                        channelGroups[entry.channelId] = [];
                    }
                    channelGroups[entry.channelId].push(entry.messageId);
                }

                // Execute absolute mass wipe across all channels simultaneously
                for (const [chanId, messageIds] of Object.entries(channelGroups)) {
                    try {
                        const targetChan = await message.guild.channels.fetch(chanId);
                        if (targetChan && typeof targetChan.bulkDelete === 'function') {
                            // Wipes all gathered spam messages in this channel in ONE single call!
                            await targetChan.bulkDelete(messageIds, true).catch(() => {});
                        } else if (targetChan) {
                            // Fallback for DM or threads where bulkDelete isn't available
                            for (const msgId of messageIds) {
                                const targetMsg = await targetChan.messages.fetch(msgId).catch(() => null);
                                if (targetMsg) await targetMsg.delete().catch(() => {});
                            }
                        }
                    } catch (e) {
                        console.error(`Failed executing mass override purge on channel ${chanId}:`, e);
                    }
                }

                globalSpeedTrapTracker.delete(trackingKey);

                // TIMEOUT CONDITIONALLY
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