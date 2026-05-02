const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('availability')
        .setDescription('Show available booking slots'),
    async execute(interaction) {
        // We defer because DB queries can take longer than the 3-second interaction window
        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();
            const rows = await conn.query(
                `SELECT slot_id, start_time FROM booking_slots 
                 WHERE is_available = TRUE 
                 AND start_time >= NOW() + INTERVAL 24 HOUR 
                 ORDER BY start_time ASC LIMIT 20`
            );

            if (!rows || rows.length === 0) {
                return await interaction.editReply("📅 No slots found.");
            }

            let list = "━━━━━━━━━━━━━━━━━━━━━━━━\n**APPOINTMENTS AVAILABLE**\n*(All times localized to your device)*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n";

            rows.forEach(row => {
                let start;
                // Handle both SQL strings and JS Date objects
                if (row.start_time instanceof Date) {
                    start = DateTime.fromJSDate(row.start_time, { zone: 'utc' });
                } else {
                    start = DateTime.fromSQL(row.start_time, { zone: 'utc' });
                }

                if (!start.isValid) return;
                const sUnix = Math.floor(start.toSeconds());

                list += `📅 <t:${sUnix}:F> \n` +
                        `🔹 \`/book slot:${row.slot_id}\` \n` + // Updated to suggest slash command syntax
                        `──────────────────\n`;
            });

            if (list.length > 2000) {
                return await interaction.editReply("❌ List is too long to display. Please contact an admin to reduce the query limit.");
            }

            await interaction.editReply(list);
        } catch (err) {
            console.error("Database Error:", err);
            // Check if we already deferred/replied to avoid "Interaction already replied" errors
            if (interaction.deferred) {
                await interaction.editReply("❌ Error loading availability.");
            } else {
                await interaction.reply({ content: "❌ Error loading availability.", ephemeral: true });
            }
        } finally {
            if (conn) conn.release();
        }
    }
};