const { 
    SlashCommandBuilder, 
    PermissionFlagsBits,
    MessageFlags 
} = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('Show todays schedule and upcoming bookings (Everyone)'),

    async execute(interaction) {
        // 1. Permissions
        // if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        //     return await interaction.reply({ content: "🚫 Admin only.", flags: [MessageFlags.Ephemeral] });
        // }

        // 2. Proper Acknowledgment
        if (!interaction.deferred && !interaction.replied) {
            if (interaction.isButton()) {
                await interaction.deferUpdate();
            } else {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            }
        }

        let conn;

        try {
            conn = await pool.getConnection();

            // Get start and end of TODAY in PDT, converted to UTC for the query
            const todayPDT = DateTime.now().setZone('America/Los_Angeles');

            const startUTC = todayPDT.startOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss');
            const endUTC   = todayPDT.endOf('day').toUTC().toFormat('yyyy-MM-dd HH:mm:ss');

            const rows = await conn.query(
                `SELECT start_time, 
                        CASE 
                            WHEN is_special_slot = 1 THEN '📖 Other' 
                            ELSE '📖 Free Lesson' 
                        END AS session_type 
                 FROM booking_slots 
                 WHERE is_available = FALSE
                 AND slot_category NOT IN ('staff')
                 AND booked_by_name IS NOT NULL
                 AND start_time >= ?
                 AND start_time <= ?
                 ORDER BY start_time ASC`,
                [startUTC, endUTC]
            );

            if (!rows || !rows.length) {
                return await interaction.editReply({ content: "📅 No Schedule found for today." });
            }

            const lines = rows.map((row, i) => {
                const dt = DateTime.fromFormat(row.start_time, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
                if (!dt.isValid) {
                    console.warn(`Invalid date for row ${i}:`, row.start_time);
                    return null;
                }
                const sUnix = Math.floor(dt.toSeconds());
                return `<t:${sUnix}:F> (60 min) ${row.session_type}`;
            }).filter(Boolean);

            if (!lines.length) {
                return await interaction.editReply({ content: "📅 No active schedules to display right now." });
            }

            const list = `## 📅 TODAY'S SCHEDULE\n\n${lines.join('\n')}`;

            // Discord content limit is 2000 chars
            const content = list.length > 2000 ? list.slice(0, 1997) + '…' : list;

            await interaction.editReply({ content });

        } catch (err) {
            console.error("Database Execution Error: ", err);
            try {
                await interaction.editReply({ content: "❌ DB Error." });
            } catch (discordErr) {
                console.error("Failed to send error reply to Discord: ", discordErr);
            }
        } finally {
            if (conn) conn.release();
        }
    }
};