// events/messageCreate.js
// new messageCreate with better multi-channel spam detection and global blocklist checks
const { EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const imghash = require('imghash');
const gifFrames = require('gif-frames');
const nsfwjs = require('nsfwjs');
const tf = require('@tensorflow/tfjs');
const { PNG } = require('pngjs');
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
const gifFrameCount     = Math.max(1, Math.floor(mediaLimits.gifFrameCount !== undefined ? mediaLimits.gifFrameCount : 5));
const gifSfwCheckEnabled = mediaLimits.gifSfwCheckEnabled !== undefined ? mediaLimits.gifSfwCheckEnabled : true;
const gifNsfwThreshold  = mediaLimits.gifNsfwThreshold !== undefined ? mediaLimits.gifNsfwThreshold : 0.7;

const daysConfigured = timeoutDays > 0 ? timeoutDays : 1;
const TIMEOUT_DURATION_MS = daysConfigured * 24 * 60 * 60 * 1000;

const globalSpeedTrapTracker = new Map();
let nsfwModelPromise;

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
const gifBlacklistCache = {
    data: [],
    lastFetched: 0,
    dirty: true,
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

async function getBlacklistedGifHashes(conn) {
    const isStale = Date.now() - gifBlacklistCache.lastFetched > BLACKLIST_CACHE_TTL_MS;
    if (gifBlacklistCache.dirty || isStale) {
        const rawRecords = await conn.query('SELECT image_hash FROM gifmedia_blacklist');
        gifBlacklistCache.data = rawRecords || [];
        gifBlacklistCache.lastFetched = Date.now();
        gifBlacklistCache.dirty = false;
        console.info(`🔄 GIF blocklist cache refreshed. ${gifBlacklistCache.data.length} entries loaded.`);
    }
    return gifBlacklistCache.data;
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

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        stream.once('error', reject);
    });
}

function isGifProviderUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        return /(^|\.)giphy\.com$/i.test(hostname)
            || /(^|\.)tenor\.com$/i.test(hostname)
            || /(^|\.)tenor\.co$/i.test(hostname);
    } catch {
        return false;
    }
}

function isGifUrl(url) {
    if (isGifProviderUrl(url)) return true;

    try {
        return /\.gif$/i.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

async function getGifFrameHashes(imageBuffer) {
    const frameIndexes = gifFrameCount === 1 ? 0 : `0-${gifFrameCount - 1}`;
    console.info(`[GIF FILTER] Decoding GIF buffer (${imageBuffer.length} bytes), sampling frames ${frameIndexes}.`);
    const frames = await gifFrames({
        url: imageBuffer,
        frames: frameIndexes,
        outputType: 'png',
        cumulative: true,
    });

    const frameHashes = await Promise.all(frames.map(async frame => {
        const frameBuffer = await streamToBuffer(frame.getImage());
        return {
            buffer: frameBuffer,
            hash: await imghash.hash(frameBuffer, 16, 'hex'),
        };
    }));
    console.info(`[GIF FILTER] Decoded ${frameHashes.length} frame(s) and generated hashes.`);
    return frameHashes;
}

async function getNsfwModel() {
    if (!nsfwModelPromise) {
        nsfwModelPromise = nsfwjs.load();
    }
    return nsfwModelPromise;
}

async function isGifFrameNsfw(frameBuffer) {
    const png = PNG.sync.read(frameBuffer);
    const rgbaTensor = tf.tensor3d(png.data, [png.height, png.width, 4], 'int32');
    const rgbTensor = rgbaTensor.slice([0, 0, 0], [-1, -1, 3]);

    try {
        const predictions = await (await getNsfwModel()).classify(rgbTensor);
        const predictionSummary = predictions
            .map(prediction => `${prediction.className}=${prediction.probability.toFixed(3)}`)
            .join(', ');
        console.info(`[GIF NSFW] ${predictionSummary} | threshold=${gifNsfwThreshold.toFixed(3)}`);
        return predictions.some(prediction =>
            ['Porn', 'Hentai', 'Sexy'].includes(prediction.className)
            && prediction.probability >= gifNsfwThreshold
        );
    } finally {
        rgbaTensor.dispose();
        rgbTensor.dispose();
    }
}

async function storeBlacklistedGifHashes(conn, hashes, userId) {
    for (const hash of new Set(hashes)) {
        await conn.query(
            `INSERT IGNORE INTO gifmedia_blacklist (image_hash) VALUES (?)`,
            [hash]
        );
    }
    await conn.query(
        `INSERT IGNORE INTO gifmedia_offenders (discord_user_id) VALUES (?)`,
        [userId]
    );
    gifBlacklistCache.dirty = true;
}

async function storeBlacklistedGifHashesOnly(conn, hashes) {
    for (const hash of new Set(hashes)) {
        await conn.query(
            `INSERT IGNORE INTO gifmedia_blacklist (image_hash) VALUES (?)`,
            [hash]
        );
    }
    gifBlacklistCache.dirty = true;
}

async function storeBlacklistedImageHash(conn, hash, username, userId) {
    await conn.query(
        `INSERT IGNORE INTO blacklisted_media (image_hash, added_by_type, spammer_username, spammer_id) VALUES (?, 'AUTOMATED', ?, ?)`,
        [hash, username, userId]
    );
    blacklistCache.dirty = true;
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

async function getMessageMediaSource(message) {
    message.attachments.forEach((att, index) => {
        console.info(`Attachment #${index} RAW DATA -> Name: "${att.name}" | ContentType: "${att.contentType}" | URL: "${att.url ? 'Yes' : 'No'}"`);
    });

    const imageAttachment = message.attachments.find(att => {
        const isImgExtension = /\.(jpg|jpeg|png|webp|gif)$/i.test(att.name);
        const isImgType = att.contentType && att.contentType.startsWith('image/');
        return isImgExtension || isImgType;
    });
    if (imageAttachment) return imageAttachment;

    const giphyUrl = (message.content.match(/https?:\/\/[^\s<>]+/gi) || [])
        .map(url => url.replace(/[),.]+$/, ''))
        .find(isGifUrl);
    if (!giphyUrl) return null;

    console.info(`[GIF FILTER] Fetching GIF provider URL: ${giphyUrl}`);
    const pageResponse = await axios.get(giphyUrl, { responseType: 'arraybuffer' });
    const pageContentType = pageResponse.headers['content-type'] || '';
    if (pageContentType.toLowerCase().includes('image/')) {
        return { url: giphyUrl, name: 'provider.gif', contentType: pageContentType };
    }

    const html = Buffer.from(pageResponse.data).toString('utf8');
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!ogImageMatch) return null;

    const mediaUrl = ogImageMatch[1].replace(/&amp;/g, '&');
    return { url: mediaUrl, name: 'provider.gif', contentType: 'image/gif' };
}

function messageContainsGif(message) {
    const hasGifAttachment = message.attachments.some(att =>
        /\.gif$/i.test(att.name)
        || (att.contentType && att.contentType.toLowerCase().includes('gif'))
    );
    if (hasGifAttachment) return true;

    return (message.content.match(/https?:\/\/[^\s<>]+/gi) || [])
        .some(url => isGifUrl(url.replace(/[),.]+$/, '')));
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

        let gifMessageDeleted = false;
        const containsGif = messageContainsGif(message);
        console.info(`[GIF FILTER] Message ${message.id} from ${message.author.id}: containsGif=${containsGif}, attachments=${message.attachments.size}.`);
        if (containsGif) {
            await message.delete()
                .then(() => {
                    gifMessageDeleted = true;
                    console.info('🧪 GIF message quarantined for validation.');
                })
                .catch(error => console.error('❌ Failed to quarantine GIF message:', error));
        }

        const imageAttachment = await getMessageMediaSource(message);
        console.info(`[GIF FILTER] Media source: ${imageAttachment ? `${imageAttachment.name} (${imageAttachment.contentType || 'unknown type'})` : 'NONE'}.`);
        if (!imageAttachment) return;

        let conn;
        const releaseConnection = () => {
            if (conn) {
                conn.release();
                conn = null;
            }
        };
        try {
            console.info('Attempting to download and hash image...');
            const response = await axios.get(imageAttachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            const isGif = imageAttachment.name.toLowerCase().endsWith('.gif')
                || (imageAttachment.contentType && imageAttachment.contentType.toLowerCase().includes('gif'));
            console.info(`[GIF FILTER] Classified media as isGif=${isGif}.`);
            let hashesToCheck;
            let currentImageHash;
            let nsfwGifFrameIndexes = [];

            if (isGif) {
                const gifFramesToCheck = await getGifFrameHashes(imageBuffer);
                if (gifSfwCheckEnabled) {
                    for (const [index, frame] of gifFramesToCheck.entries()) {
                        if (await isGifFrameNsfw(frame.buffer)) {
                            nsfwGifFrameIndexes.push(index);
                        }
                    }
                }
                hashesToCheck = gifFramesToCheck.map(frame => frame.hash);
                currentImageHash = hashesToCheck[0];
                console.info(`[GIF FILTER] NSFW scan complete: flaggedFrames=${nsfwGifFrameIndexes.length}/${gifFramesToCheck.length}.`);
            } else {
                currentImageHash = await imghash.hash(imageBuffer, 16, 'hex');
                hashesToCheck = [currentImageHash];
            }

            // ==========================================
            // OPTION 1: GLOBAL DATABASE BLOCKLIST CHECK
            // ==========================================
            console.info('Connecting to MariaDB database...');
            conn = await pool.getConnection();
            
            console.info('Fetching blacklisted hashes (cached)...');
            const blacklistedRecords = isGif
                ? await getBlacklistedGifHashes(conn)
                : await getBlacklistedHashes(conn);

            console.info(`Blocklist lookup complete. Total blocked items in cache: ${blacklistedRecords.length}`);
            
            let isGloballyBanned = false;
            let matchedHash = currentImageHash;
            if (blacklistedRecords.length > 0) {
                for (const imageHash of hashesToCheck) {
                    for (const record of blacklistedRecords) {
                        if (!record.image_hash) continue; // Skip malformed rows
                        const distance = getHammingDistance(imageHash, record.image_hash);
                        if (distance <= hammingThreshold) {
                            isGloballyBanned = true;
                            matchedHash = imageHash;
                            break;
                        }
                    }
                    if (isGloballyBanned) break;
                }
            }

            if (isGloballyBanned) {
                console.info(`[GIF FILTER] Result=BLOCKED_GLOBAL, matchedHash=${matchedHash}.`);
                releaseConnection();
                await sendModIncidentLog(
                    client, message.author, message.channel, imageBuffer, imageAttachment.name, matchedHash, 'GLOBAL BLOCKLIST', '🗑️ Auto-deleted matching message entry.'
                );
                if (!gifMessageDeleted) {
                    await message.delete().catch(err => console.error("❌ Failed to delete globally banned message:", err));
                }
                return; 
            }

            if (nsfwGifFrameIndexes.length > 0) {
                const explicitFrameHashes = nsfwGifFrameIndexes.map(index => hashesToCheck[index]);
                await storeBlacklistedGifHashes(
                    conn,
                    explicitFrameHashes,
                    message.author.id
                );
                releaseConnection();
                console.info(`[GIF FILTER] Result=BLOCKED_NSFW, flaggedFrames=${explicitFrameHashes.length}; hashes stored.`);
                await sendModIncidentLog(
                    client,
                    message.author,
                    message.channel,
                    imageBuffer,
                    imageAttachment.name,
                    explicitFrameHashes[0],
                    'NSFW GIF',
                    `🗑️ Deleted and stored ${explicitFrameHashes.length} explicit GIF frame hash(es).`
                );
                if (!gifMessageDeleted) {
                    await message.delete().catch(err => console.error("❌ Failed to delete NSFW GIF:", err));
                }
                return;
            }

            console.info(`[GIF FILTER] Result=NO_BLOCKLIST_MATCH, checkedHashes=${hashesToCheck.length}. Proceeding to speed trap.`);

            // GIFs share one per-user speed-trap bucket so changing the GIF does not bypass the limit.
            if (!currentImageHash) {
                throw new Error('No hash was generated for the attached image.');
            }

            // ==========================================
            // OPTION 2: MULTI-CHANNEL SPEED TRAP
            // ==========================================
            const trackingKey = isGif
                ? `${message.author.id}_GIF_SPAM`
                : `${message.author.id}_${currentImageHash}`;
            const now = Date.now();

            let trackingPayload = globalSpeedTrapTracker.get(trackingKey) || { history: [] };
            if (trackingPayload.blockedUntil > now) {
                console.info(`[GIF FILTER] Result=BLOCKED_MEDIA_BURST, suppression active for ${message.author.id}.`);
                releaseConnection();
                await message.delete().catch(() => {});
                return;
            }
            if (trackingPayload.blockedUntil && trackingPayload.blockedUntil <= now) {
                trackingPayload = { history: [] };
            }
            trackingPayload.history = trackingPayload.history.filter(item => (now - item.timestamp) <= timeWindowMs);
            trackingPayload.history.push({ timestamp: now, messageId: message.id, channelId: message.channel.id, repostedMessageId: null });
            globalSpeedTrapTracker.set(trackingKey, trackingPayload);

            const uniquelyTargetedChannels = new Set(trackingPayload.history.map(item => item.channelId));
            const totalPostsInWindow = trackingPayload.history.length;

            if (totalPostsInWindow > maxDuplicates || uniquelyTargetedChannels.size > maxChannels) {
                console.info('🚨 MULTI-CHANNEL SPEED TRAP ENGAGED: Executing mass purge superpowers...');
                
                if (autoBlacklistEnabled) {
                    try {
                        if (isGif) {
                            await storeBlacklistedGifHashesOnly(
                                conn,
                                [currentImageHash]
                            );
                        } else {
                            await storeBlacklistedImageHash(
                                conn,
                                currentImageHash,
                                message.author.username,
                                message.author.id
                            );
                        }
                    } catch (insertErr) {
                        throw insertErr;
                    }
                }

                releaseConnection();

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
                    if (entry.repostedMessageId) {
                        channelGroups[entry.channelId].push(entry.repostedMessageId);
                    }
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

                trackingPayload.blockedUntil = now + timeWindowMs;
                globalSpeedTrapTracker.set(trackingKey, trackingPayload);

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

            releaseConnection();

            if (isGif && gifMessageDeleted) {
                const activeRecord = globalSpeedTrapTracker.get(trackingKey);
                if (activeRecord?.blockedUntil > Date.now()) {
                    console.info(`[GIF FILTER] Result=BLOCKED_MEDIA_BURST, skipping approved repost for ${message.author.id}.`);
                    return;
                }
                const repostedMessage = await message.channel.send({
                    content: `**${message.author.tag}** shared a GIF:`,
                    files: [{ attachment: imageBuffer, name: imageAttachment.name || 'approved.gif' }]
                });
                const currentRecord = globalSpeedTrapTracker.get(trackingKey);
                const currentEntry = currentRecord?.history.find(entry => entry.messageId === message.id);
                if (currentEntry) {
                    currentEntry.repostedMessageId = repostedMessage.id;
                    globalSpeedTrapTracker.set(trackingKey, currentRecord);
                }
                console.info(`[GIF FILTER] Result=APPROVED, reposted GIF for ${message.author.id}.`);
            }

        } catch (error) {
            console.error(`[GIF FILTER] Result=ERROR for message ${message.id}:`, error);
        } finally {
            if (conn) conn.release(); 
        }
    },
};