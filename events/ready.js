// events/ready.js
const { checkReminders } = require('../tasks/reminderSystem'); 
const { REST } = require('@discordjs/rest'); 
const { Routes } = require('discord-api-types/v10'); 
const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'clientReady', 
    once: true, 
    async execute(client) {
        console.log(`🚀 Logged in as ${client.user.tag}`); 
        
        // Register slash commands
        const commands = client.commands.map(command => command.data.toJSON()); 

        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN); 
        
        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), 
                { body: commands } 
            );
            console.log('Slash commands registered successfully.'); 
        } catch (error) {
            console.error('Error registering slash commands:', error); 
        }

        // --- NEW UPDATES ANNOUNCEMENT & AUTOMATIC UPDATE ---
        try {
            const featuresPath = path.join(__dirname, '../features.json');
            const configPath = path.join(__dirname, '../config.json');

            if (fs.existsSync(featuresPath)) {
                const featuresData = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
                const newUpdates = featuresData.filter(item => item.isLive === false);

                if (newUpdates.length > 0) {
                    let modChannelId;

                    if (fs.existsSync(configPath)) {
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                        modChannelId = config.mediaRateLimit?.bookingFeatureChannelId; 
                    }

                    if (modChannelId) {
                        const channel = await client.channels.fetch(modChannelId).catch(() => null);

                        if (channel) {
                            // Map items according to their type ('feature' vs 'bug')
                            const fields = newUpdates.map(item => {
                                const isBug = item.type?.toLowerCase() === 'bug' || item.type?.toLowerCase() === 'bugfix';
                                const badge = isBug ? '🐛 **[Bug Fix]**' : '✨ **[Feature]**';

                                return {
                                    name: `${badge} ${item.featureName}`,
                                    value: item.description || 'No description provided.',
                                    inline: false
                                };
                            });

                            const embed = {
                                title: '🚀 System Deployment Report',
                                description: 'The following bot updates have been deployed and are now active:',
                                color: 0x5865F2, // Discord Blurple
                                fields: fields,
                                timestamp: new Date().toISOString()
                            };

                            await channel.send({ embeds: [embed] });
                            console.log(`[Updates Check] Announced ${newUpdates.length} update(s) in channel.`);

                            // Mark items as isLive = true and save features.json
                            const updatedFeatures = featuresData.map(item => {
                                if (item.isLive === false) {
                                    return { ...item, isLive: true };
                                }
                                return item;
                            });

                            fs.writeFileSync(featuresPath, JSON.stringify(updatedFeatures, null, 2), 'utf8');
                            console.log('[Updates Check] Updated features.json: Marked updates as isLive: true.');
                        } else {
                            console.error(`[Updates Check] Could not fetch channel with ID: ${modChannelId}`);
                        }
                    } else {
                        console.warn('[Updates Check] No modChannelId defined in config.json or process.env.');
                    }
                }
            }
        } catch (error) {
            console.error('[Updates Check Error]:', error);
        }
        
        // Start the background task
        setInterval(() => {
            checkReminders(client); 
        }, 60000); 
    },
};