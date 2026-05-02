const pool = require('../database/pool');
const { MessageFlags } = require('discord.js');

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
                // Determine Slot ID and Action
                const isBooking = interaction.customId.startsWith('book_slot_');
                const isCancelling = interaction.customId.startsWith('cancel_slot_');
                
                if (!isBooking && !isCancelling) return;

                const rawId = interaction.customId.replace('book_slot_', '').replace('cancel_slot_', '');
                const slotId = isNaN(rawId) ? rawId : parseInt(rawId);

                // Acknowledge immediately
                await interaction.deferUpdate();

                conn = await pool.getConnection();

                if (isBooking) {
                    const result = await conn.query(
                        `UPDATE booking_slots 
                         SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE 
                         WHERE slot_id = ? AND is_available = TRUE`, 
                        [interaction.user.id, interaction.user.username, slotId]
                    );

                    if (!result || result.affectedRows == 0) {
                        return await interaction.followUp({
                            content: "⚠️ **Slot Unavailable:** Someone else just booked this.",
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    await interaction.followUp({
                        content: `✅ **Booking Confirmed!** Slot: **#${slotId}**`,
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