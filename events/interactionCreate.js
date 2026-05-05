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
                const isNoShow = interaction.customId.startsWith('noshow_slot_');
                
                if (!isBooking && !isCancelling && !isNoShow) return;

                // Extract the ID regardless of which button was pressed
                const rawId = interaction.customId
                    .replace('book_slot_', '')
                    .replace('cancel_slot_', '')
                    .replace('noshow_slot_', '');
                const slotId = isNaN(rawId) ? rawId : parseInt(rawId);

                await interaction.deferUpdate();
                conn = await pool.getConnection();

                // --- LOGIC: BOOKING ---
                if (isBooking) {
                    const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
                    if (REQUIRED_ROLE_ID && !interaction.member.roles.cache.has(REQUIRED_ROLE_ID)) {
                        return await interaction.followUp({ 
                            content: "🚫 You do not have the required role to book slots.", 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }

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

                    const rows = await conn.query(
                        `SELECT start_time FROM booking_slots WHERE slot_id = ?`,
                        [slotId]
                    );

                    const start = rows[0].start_time instanceof Date 
                        ? DateTime.fromJSDate(rows[0].start_time, { zone: 'utc' }) 
                        : DateTime.fromSQL(rows[0].start_time, { zone: 'utc' });
                    
                    const sUnix = Math.floor(start.toSeconds());

                    await interaction.followUp({
                        content: `✅ **Booking Confirmed!**\n📅 You are booked for: <t:${sUnix}:F>`,
                        flags: [MessageFlags.Ephemeral]
                    });

                // --- LOGIC: CANCELLING OR NO-SHOW ---
                } else if (isCancelling || isNoShow) {
                    const isAdmin = interaction.member.permissions.has('Administrator');
                    
                    if (isNoShow && !isAdmin) {
                        return await interaction.followUp({
                            content: "🚫 Only administrators can log a No Show.",
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    let query;
                    let params;

                    if (isNoShow) {
                        // Logic for No Show: Keep user info, set the flag, but leave is_available = FALSE
                        // so the slot remains "occupied" in history.
                        query = `UPDATE booking_slots 
                                SET is_no_show = TRUE 
                                WHERE slot_id = ?`;
                        params = [slotId];
                    } else {
                        // Logic for standard Cancellation: Reset everything
                        query = `UPDATE booking_slots 
                                SET booked_by_id = NULL, booked_by_name = NULL, is_available = TRUE, reminder_sent = FALSE, is_no_show = FALSE
                                WHERE slot_id = ? AND (booked_by_id = ? OR ?)`;
                        params = [slotId, interaction.user.id, isAdmin];
                    }

                    const result = await conn.query(query, params);

                    if (result.affectedRows > 0) {
                        const message = isNoShow 
                            ? `🚩 Slot **#${slotId}** has been marked as a **No Show**. The user remains attached to the record.`
                            : `✅ Slot **#${slotId}** has been cancelled and is now available.`;
                            
                        await interaction.followUp({ content: message, flags: [MessageFlags.Ephemeral] });
                    } else {
                        await interaction.followUp({
                            content: "❌ Action failed. The slot may have already been modified.",
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