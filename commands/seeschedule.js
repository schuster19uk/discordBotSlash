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

            const streamerThreshold = DateTime.now()
                .setZone('America/Los_Angeles')
                .minus({ hours: 3 })
                .toUTC()
                .toFormat('yyyy-MM-dd HH:mm:ss');

            const rows = await conn.query(
                `SELECT start_time, 
                        CASE 
                            WHEN is_special_slot = 1 THEN '🤝 Other' 
                            ELSE '📖 Free Lesson' 
                        END AS session_type 
                 FROM booking_slots 
                 WHERE (is_available = FALSE) 
                 AND start_time >= ? 
                 AND booked_by_name IS NOT NULL 
                 ORDER BY start_time ASC`,
                [streamerThreshold]
            );

            if (!rows || !rows.length) return await interaction.editReply("📅 No Schedule found.");

            let list = `## 📅 TODAY'S SCHEDULE\n`;

            rows.forEach((row, i) => {
                const sUnix = Math.floor(
                    DateTime.fromFormat(row.start_time, 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' }).toSeconds()
                );
                
                const displayNum = i + 1;

                // Outputs strictly: **1.** <timestamp> (60 min)\n🤝 Collab\n\n
                list += `<t:${sUnix}:F> (60 min) ${row.session_type}\n`;
            });

            await interaction.editReply({ content: list });
        } catch (err) {
            console.error("Database Execution Error: ", err);
            await interaction.editReply("❌ DB Error.");
        } finally {
            if (conn) conn.release();
        }
    }
};