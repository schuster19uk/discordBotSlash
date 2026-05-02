const pool = require('../database/pool');
const { MessageFlags } = require('discord.js');
const { DateTime } = require('luxon');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // --- 1. HANDLE SLASH COMMANDS ---
        if (interaction.isChatInputCommand()) {
            const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
            if (COMMAND_CHANNEL_ID && COMMAND_CHANNEL_ID !== '0' && interaction.channelId !== COMMAND_CHANNEL_ID) {
                return interaction.reply({ 
                    content: '❌ You cannot use commands in this channel.', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error in ${interaction.commandName}:`, error);
                const errPayload = { content: '❌ Error executing command.', flags: [MessageFlags.Ephemeral] };
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply(errPayload);
                } else {
                    await interaction.followUp(errPayload);
                }
            }
            return;
        }

        // --- 2. HANDLE BUTTON CLICKS ---
        if (interaction.isButton()) {
            let conn; 

            try {
                const isBooking = interaction.customId.startsWith('book_slot_');
                const isCancelling = interaction.customId.startsWith('cancel_slot_');
                
                if (!isBooking && !isCancelling) return;

                const rawId = interaction.customId.replace('book_slot_', '').replace('cancel_slot_', '');
                const slotId = isNaN(rawId) ? rawId : parseInt(rawId);

                await interaction.deferUpdate();
                conn = await pool.getConnection();

                if (isBooking) {
                    // Use RETURNING start_time to get the date without a second SELECT query
                    const result = await conn.query(
                        `UPDATE booking_slots 
                         SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE 
                         WHERE slot_id = ? AND is_available = TRUE
                         RETURNING start_time`, 
                        [interaction.user.id, interaction.user.username, slotId]
                    );

                    // result in MariaDB returns an array of objects for RETURNING queries
                    if (!result || result.length === 0) {
                        return await interaction.followUp({
                            content: "⚠️ **Slot Unavailable:** Someone else just booked this.",
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    // Convert the returned time to a Discord Unix Timestamp
                    const bookedTime = result[0].start_time;
                    const start = bookedTime instanceof Date 
                        ? DateTime.fromJSDate(bookedTime, { zone: 'utc' }) 
                        : DateTime.fromSQL(bookedTime, { zone: 'utc' });
                    
                    const sUnix = Math.floor(start.toSeconds());

                    await interaction.followUp({
                        content: `✅ **Booking Confirmed!**\n📅 You are booked for: <t:${sUnix}:F>`,
                        flags: [MessageFlags.Ephemeral]
                    });

                } else if (isCancelling) {
                    const isAdmin = interaction.member.permissions.has('Administrator');
                    const result = await conn.query(
                        `UPDATE booking_slots 
                         SET booked_by_id = NULL, booked_by_name = NULL, is_available = TRUE, reminder_sent = FALSE
                         WHERE slot_id = ? AND (booked_by_id = ? OR ?)`,
                        [slotId, interaction.user.id, isAdmin]
                    );

                    if (result.affectedRows > 0) {
                        await interaction.editReply({ 
                            content: `✅ Successfully cancelled slot **#${slotId}**.`, 
                            components: [] 
                        });
                    } else {
                        await interaction.followUp({
                            content: "❌ Could not cancel. This slot may already be available.",
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                }

            } catch (error) {
                console.error('--- BUTTON HANDLER ERROR ---');
                console.error(error);
                await interaction.followUp({ 
                    content: `❌ **Database Error:** ${error.message}`, 
                    flags: [MessageFlags.Ephemeral] 
                });
            } finally {
                if (conn) conn.release();
            }
        }
    },
};