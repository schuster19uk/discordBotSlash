const pool = require('../database/pool');
const { MessageFlags } = require('discord.js');
const { DateTime } = require('luxon');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // --- 1. HANDLE SLASH COMMANDS ---
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            try {
                // We let the command file handle its own defer/reply
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error in ${interaction.commandName}:`, error);
                const payload = { content: '❌ Error executing command.', flags: [MessageFlags.Ephemeral] };
                interaction.deferred || interaction.replied ? await interaction.followUp(payload) : await interaction.reply(payload);
            }
            return;
        }

        // --- 2. HANDLE BUTTON CLICKS ---
        if (interaction.isButton()) {
            const { customId } = interaction;

            // --- A. PAGINATION ---
            // DO NOT use deferUpdate() here. book.js will handle it.
            if (customId.startsWith('list_page_') || customId.startsWith('my_page_') || customId.startsWith('avail_page_')) {
                const cmdName = customId.startsWith('list_') ? 'listlessons' : (customId.startsWith('my_') ? 'mylessons' : 'book');
                const command = client.commands.get(cmdName);
                if (command) {
                    try {
                        // Crucial: We let the command handle the deferral
                        await command.execute(interaction);
                    } catch (error) {
                        console.error('Pagination Execution Error:', error);
                    }
                }
                return;
            }

            // --- B. DATABASE ACTIONS (Booking / Cancelling) ---
            let conn; 
            try {
                const isBooking = customId.startsWith('book_slot_');
                const isCancelling = customId.startsWith('cancel_slot_');
                const isNoShow = customId.startsWith('noshow_slot_');
                
                if (!isBooking && !isCancelling && !isNoShow) return;

                // We acknowledge ACTION buttons here immediately
                await interaction.deferUpdate();
                
                const slotId = parseInt(customId.split('_').pop());
                conn = await pool.getConnection();

                // 1. BOOKING LOGIC
                if (isBooking) {
                    const [slot] = await conn.query(
                        `SELECT start_time, is_available FROM booking_slots WHERE slot_id = ?`, [slotId]
                    );

                    if (!slot || !slot.is_available) {
                        return await interaction.followUp({ content: "⚠️ This slot is no longer available.", flags: [MessageFlags.Ephemeral] });
                    }

                    await conn.query(
                        `UPDATE booking_slots SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE WHERE slot_id = ?`, 
                        [interaction.user.id, interaction.user.username, slotId]
                    );

                    const unixTime = Math.floor(DateTime.fromJSDate(new Date(slot.start_time)).toSeconds());
                    await interaction.editReply({ 
                        content: `✅ **Booking Confirmed!**\n📅 **Date:** <t:${unixTime}:F> (60 min)`, 
                        components: []
                    });


                // 2. CANCELLATION LOGIC
                } else if (isCancelling) {
                    const [slot] = await conn.query(`SELECT start_time FROM booking_slots WHERE slot_id = ?`, [slotId]);
                    if (!slot) return;

                    const isAdmin = interaction.member.permissions.has('Administrator');
                    const start = DateTime.fromJSDate(new Date(slot.start_time), { zone: 'utc' });

                    if (!isAdmin && start.diff(DateTime.now().toUTC(), 'hours').hours < 6) {
                        return await interaction.followUp({ content: "🚫 Cancellation blocked (less than 6h left).", flags: [MessageFlags.Ephemeral] });
                    }

                    await conn.query(
                        `UPDATE booking_slots SET booked_by_id = NULL, booked_by_name = NULL, is_available = TRUE, is_no_show = FALSE 
                        WHERE slot_id = ?`, [slotId]
                    );

                    // Instead of a "Cancelled" message, we trigger the command again to show the fresh list
                    const command = client.commands.get('mylessons');
                    if (command) {
                        return await command.execute(interaction); 
                    }

                }

            } catch (error) {
                console.error('Button Error:', error);
                // If we already deferred (which we do at the start of the button handler)
                if (interaction.deferred || interaction.replied) {
                    // We use editReply to change the existing list into an error message
                    await interaction.editReply({ 
                        content: `❌ **Transaction Failed:** ${error.message}`, 
                        components: [] // Crucial: This removes the buttons so the user can't click them again
                    });
                } else {
                    // Fallback: if something failed before deferUpdate() was called
                    await interaction.reply({ 
                        content: `❌ **Error:** ${error.message}`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
            } finally {
                if (conn) conn.release();
            }
        }
    },
};