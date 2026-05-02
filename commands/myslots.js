const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('myslots')
        .setDescription('Show your booked slots'),
    async execute(interaction) {
        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();

            // 1. Fetch only unexpired/unreminded slots booked by this user
            const rows = await conn.query(
                "SELECT slot_id, start_time FROM booking_slots WHERE booked_by_id = ? AND reminder_sent = FALSE ORDER BY start_time ASC",
                [interaction.user.id]
            );

            if (rows.length === 0) {
                return interaction.editReply("📋 You don't have any active upcoming bookings at the moment.");
            }

            // 2. Build the display list
            let list = `**📅 Your Active Bookings:**\n*Times are shown in your local timezone.*\n\n`;

            rows.forEach(row => {
                /**
                 * THE FIX:
                 * Using fromSQL because dateStrings: true is enabled.
                 * We force UTC zone because the DB stores the time in UTC.
                 */
                const start = DateTime.fromSQL(row.start_time, { zone: 'utc' });
                const unix = Math.floor(start.toSeconds());

                // 3. Format with Discord timestamps
                // <t:unix:F> is Full Date/Time, <t:unix:R> is Relative (e.g. "in 2 hours")
                list += `🔹 **Slot #${row.slot_id}**: <t:${unix}:F> (<t:${unix}:R>)\n` +
                        `   *To cancel: \`/cancel slot: ${row.slot_id}\`*\n\n`;
            });

            interaction.editReply(list);

        } catch (err) {
            console.error("Error in myslots command:", err);
            interaction.editReply("❌ Database error while fetching your bookings.");
        } finally {
            if (conn) conn.release();
        }
    }
};