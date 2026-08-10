const pool = require("../../../database/pool");
const { MessageFlags } = require('discord.js');
const { DateTime } = require('luxon');

module.exports = async (interaction, client) => {
    const { customId } = interaction;
    let conn;

    try {
        // --- PAGINATION ---
        if (customId.startsWith('list_page_') || customId.startsWith('my_page_') || 
            customId.startsWith('avail_page_') || customId.startsWith('today_page_')) {
            
            const cmdName = customId.startsWith('list_') ? 'listlessons' 
                : customId.startsWith('my_') ? 'mylessons' 
                : customId.startsWith('today_') ? 'todayschedule'
                : 'book';
            const command = client.commands.get(cmdName);
            if (command) await command.execute(interaction);
            return;
        }

        // --- BOOKING ACTIONS ---
        const isBooking = customId.startsWith('book_slot_');
        const isCancelling = customId.startsWith('cancel_slot_');
        const isNoShow = customId.startsWith('noshow_slot_');

        if (!isBooking && !isCancelling && !isNoShow) return;

        // Acknowledge the interaction immediately
        await interaction.deferUpdate();

        const slotId = parseInt(customId.split('_').pop());
        conn = await pool.getConnection();

        // 1. BOOKING LOGIC
        if (isBooking) {
            // Fetch the slot being requested first
            const [slot] = await conn.query(
                `SELECT start_time, is_available FROM booking_slots WHERE slot_id = ?`, [slotId]
            );

            if (!slot || !slot.is_available) {
                return await interaction.followUp({ 
                    content: "⚠️ This slot is no longer available.", 
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            const ADDPERIODCONSTRAINT = process.env.ADDPERIODCONSTRAINT;
            if (ADDPERIODCONSTRAINT === 'true') {
                // Fetch the user's most recent booked slot prior to this new slot
                const [lastSlot] = await conn.query(
                    `SELECT start_time FROM booking_slots 
                    WHERE booked_by_id = ? AND start_time < ? 
                    ORDER BY start_time DESC LIMIT 1`,
                    [interaction.user.id, slot.start_time]
                );

                if (lastSlot) {
                    const targetStart = DateTime.fromJSDate(new Date(slot.start_time), { zone: 'utc' });
                    const lastStart = DateTime.fromJSDate(new Date(lastSlot.start_time), { zone: 'utc' });

                    const daysBetween = targetStart.diff(lastStart, 'days').days;

                    if (daysBetween < 14) {
                        return await interaction.followUp({
                            content: "🚫 You must wait at least 14 days after your previous lesson to book this slot.",
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                }
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
        }
        // 2. CANCELLATION LOGIC
        else if (isCancelling) {
            const [slot] = await conn.query(`SELECT start_time FROM booking_slots WHERE slot_id = ? AND is_available = FALSE`, [slotId]);
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

            // Trigger the command again to show the fresh list
            const command = client.commands.get('mylessons');
            if (command) {
                return await command.execute(interaction);
            }
        }
        
        else if (isNoShow) {
            const [slot] = await conn.query(`SELECT start_time FROM booking_slots WHERE slot_id = ? AND is_no_show = FALSE`, [slotId]);
            if (!slot) return;

            const isAdmin = interaction.member.permissions.has('Administrator');
            const start = DateTime.fromJSDate(new Date(slot.start_time), { zone: 'utc' });

            // if (!isAdmin && start.diff(DateTime.now().toUTC(), 'hours').hours < 6) {
            //     return await interaction.followUp({ content: "🚫 No-Show blocked (less than 6h left).", flags: [MessageFlags.Ephemeral] });
            // }

            await conn.query(
                `UPDATE booking_slots SET is_available = FALSE, is_no_show = TRUE 
                WHERE slot_id = ?`, [slotId]
            );

            // Trigger the command again to show the fresh list
            const command = client.commands.get('mylessons');
            if (command) {
                return await command.execute(interaction);
            }
        }

    } catch (error) {
        console.error('Booking Button Error:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content: `❌ **Transaction Failed:** ${error.message}`,
                components: []
            });
        } else {
            await interaction.reply({
                content: `❌ **Error:** ${error.message}`,
                flags: [MessageFlags.Ephemeral]
            });
        }
    } finally {
        if (conn) conn.release();
    }
};