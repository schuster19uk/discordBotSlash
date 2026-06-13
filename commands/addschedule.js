const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addschedule')
        .setDescription('Set the default schedule for the next 30 days'),
    async execute(interaction) {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
        }

        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();

            const schedule = {
                1: [], // Mon "12:00", "13:00", "14:00", "15:30", "16:30", "17:30"
                2: ["13:00", "14:00"],                             // Tue "12:00",
                3: ["15:00", "16:00"],                                     // Wed
                4: ["15:00", "16:00"],           // Thu
                5: ["15:00", "16:00", "17:00", "18:00", "19:30", "20:30", "21:30"] // Fri
            };

            for (let i = 1; i <= 49; i++) {
                // Get the date in Nevada
                const nvDate = DateTime.now().setZone('America/Los_Angeles').plus({ days: i });
                const dayOfWeek = nvDate.weekday; // 1=Mon, 5=Fri

                if (schedule[dayOfWeek]) {
                    for (const timeStr of schedule[dayOfWeek]) {
                        const [hour, minute] = timeStr.split(':');

                        // 1. Define Nevada Start Time
                        const startNV = nvDate.set({
                            hour: parseInt(hour),
                            minute: parseInt(minute),
                            second: 0,
                            millisecond: 0
                        });

                        // 2. Format Nevada Display (e.g., "12:00 GMT-7")
                        const nvDisplay = startNV.toFormat('HH:mm') + " " + startNV.offsetNameShort;

                        // 3. Format UK Display (e.g., "20:00 GMT+1")
                        const startUK = startNV.setZone('Europe/London');
                        const ukDisplay = startUK.toFormat('HH:mm') + " " + startUK.offsetNameShort;

                        // 4. UTC for Storage
                        const startUTC = startNV.toUTC().toSQL({ includeOffset: false });
                        const endUTC = startNV.plus({ hours: 1 }).toUTC().toSQL({ includeOffset: false });

                        // Updated Query to include nevada_time_display
                        await conn.query(
                            `INSERT IGNORE INTO booking_slots
                             (start_time, end_time, uk_time_display, nevada_time_display, is_available , slot_category)
                             VALUES (?, ?, ?, ?, TRUE , 'onstream')`,
                            [startUTC, endUTC, ukDisplay, nvDisplay]
                        );
                    }
                }
            }

            interaction.editReply("✅ Schedule restocked with Dual-Timezone display columns!");

        } catch (err) {
            console.error(err);
            interaction.editReply("❌ Error generating schedule.");
        } finally {
            if (conn) conn.release();
        }
    }
};