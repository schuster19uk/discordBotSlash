const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addschedule')
        .setDescription('Set the default schedule dynamically'),
    async execute(interaction) {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
        }

        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();

            // --- CONFIGURATION ---
            const applyDateFilter = true; // Set to false to add 30 days from now
            const filterStartDate = DateTime.fromISO('2026-09-01T00:00:00', { zone: 'utc' });
            // ---------------------

            const schedule = {
                1: [], // Mon
                2: [],                             // Tue
                3: ["15:00", "16:00"],                                     // Wed
                4: [],           // Thu
                5: ["15:00", "16:00", "17:00", "18:00", "19:30", "20:30", "21:30"], // Fri
                6: ["11:00", "12:00"], // Sat
                7: [] // Sun
            };

            // 1. Establish the baseline and end boundaries dynamically
            let currentLoopDate;
            let endDate;

            if (applyDateFilter) {
                // Start from the filter date (converted to Nevada time so dayOfWeek matches local schedules)
                currentLoopDate = filterStartDate.setZone('America/Los_Angeles');
                // End exactly 30 days after the filter date
                endDate = currentLoopDate.plus({ days: 31 });
            } else {
                // Start from tomorrow morning in Nevada time
                currentLoopDate = DateTime.now().setZone('America/Los_Angeles').plus({ days: 1 });
                // End exactly 30 days from now
                endDate = currentLoopDate.plus({ days: 31 });
            }

            // 2. Loop day-by-day until we reach the calculated endDate
            while (currentLoopDate <= endDate) {
                const dayOfWeek = currentLoopDate.weekday; // 1=Mon, 5=Fri

                if (schedule[dayOfWeek]) {
                    for (const timeStr of schedule[dayOfWeek]) {
                        const [hour, minute] = timeStr.split(':');

                        // Define Nevada Start Time for this specific slot
                        const startNV = currentLoopDate.set({
                            hour: parseInt(hour),
                            minute: parseInt(minute),
                            second: 0,
                            millisecond: 0
                        });

                        // Double-check: skip specific times slots that fall before the UTC timestamp 
                        // (e.g., if the filter date starts midway through day 1 at 05:30 UTC)
                        if (applyDateFilter && startNV.toUTC() < filterStartDate) {
                            continue; 
                        }

                        // 2. Format Nevada Display
                        const nvDisplay = startNV.toFormat('HH:mm') + " " + startNV.offsetNameShort;

                        // 3. Format UK Display
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

                // Advance to the next day
                currentLoopDate = currentLoopDate.plus({ days: 1 });
            }

            const successMessage = applyDateFilter 
                ? `✅ Schedule restocked for 30 days starting from ${filterStartDate.toFormat('yyyy-MM-dd HH:mm')} UTC!` 
                : "✅ Schedule restocked for the next 30 days from now!";

            interaction.editReply(successMessage);

        } catch (err) {
            console.error(err);
            interaction.editReply("❌ Error generating schedule.");
        } finally {
            if (conn) conn.release();
        }
    }
};