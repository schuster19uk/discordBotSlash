const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addoldschedulecollaborator')
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
                1: ["11:00" ,"19:00"], // Mon
                2: ["11:00" ,"15:30","17:00","18:30" ], // Tue
                3: ["10:30" , "12:00" , "13:30" , "18:00" ],  // Wed
                4: ["10:30"], // Thu
                5: ["10:30" , "12:00", "13:30"] // Fri
            };

            for (let i = 1; i <= 11; i++) {
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
                             (start_time, end_time, uk_time_display, nevada_time_display, is_available , is_special_slot , slot_category) 
                             VALUES (?, ?, ?, ?, TRUE, TRUE , 'collaborator')`,
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