const { SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('addslot')
        .setDescription('Add a new booking slot')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option =>
            option.setName('date')
                .setDescription('Date in YYYY-MM-DD format')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('start_time')
                .setDescription('Start time in HH:MM format (Nevada time)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('end_time')
                .setDescription('End time in HH:MM format (Nevada time)')
                .setRequired(true)
        ),
    async execute(interaction) {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: '❌ Permission denied.', ephemeral: true });
        }

        const datePart = interaction.options.getString('date');
        const startPart = interaction.options.getString('start_time');
        const endPart = interaction.options.getString('end_time');

        await interaction.deferReply();

        try {
            // 1. Parse times in Nevada context
            const nevadaStart = DateTime.fromISO(`${datePart}T${startPart}`, { zone: 'America/Los_Angeles' });
            const nevadaEnd = DateTime.fromISO(`${datePart}T${endPart}`, { zone: 'America/Los_Angeles' });

            // 2. GUARDRAIL: Logical Validation
            if (!nevadaStart.isValid || !nevadaEnd.isValid) {
                return interaction.editReply("❌ Invalid date or time format.");
            }

            if (nevadaEnd <= nevadaStart) {
                return interaction.editReply("❌ Error: The **End Time** must be after the **Start Time**.");
            }

            // 3. Convert to UTC for DB operations
            const utcStart = nevadaStart.toUTC();
            const utcEnd = nevadaEnd.toUTC();
            const sqlStart = utcStart.toSQL({ includeOffset: false });
            const sqlEnd = utcEnd.toSQL({ includeOffset: false });

            let conn;
            try {
                conn = await pool.getConnection();

                // 4. GUARDRAIL: Overlap Check
                // This SQL finds any slot where: (ExistingStart < NewEnd) AND (ExistingEnd > NewStart)
                const conflicts = await conn.query(
                    `SELECT slot_id, start_time, end_time FROM booking_slots
                     WHERE start_time < ? AND end_time > ? LIMIT 1`,
                    [sqlEnd, sqlStart]
                );

                if (conflicts.length > 0) {
                    const conflict = conflicts[0];
                    // Since dateStrings: true is on, conflict.start_time is a string
                    const conflictStart = DateTime.fromSQL(conflict.start_time, { zone: 'utc' });
                    const unixConflict = Math.floor(conflictStart.toSeconds());

                    return interaction.editReply(
                        `🚫 **Scheduling Conflict!**\n` +
                        `This time overlaps with **Slot #${conflict.slot_id}**, which starts at <t:${unixConflict}:t>.\n` +
                        `Please choose a different time.`
                    );
                }

                // 5. Success Logic: If we passed the guardrails, insert the slot
                const ukTimeStr = utcStart.setZone('Europe/London').toFormat('HH:mm ZZZZ');
                const unixStart = Math.floor(utcStart.toSeconds());

                await conn.query(
                    "INSERT INTO booking_slots (start_time, end_time, uk_time_display, is_available) VALUES (?, ?, ?, TRUE)",
                    [sqlStart, sqlEnd, ukTimeStr]
                );

                interaction.editReply(
                    `✅ **Slot #${datePart} Added!**\n` +
                    `🇺🇸 **Nevada:** ${startPart} (${nevadaStart.offsetNameShort})\n` +
                    `🇬🇧 **UK Display:** ${ukTimeStr}\n` +
                    `📍 **Local Preview:** <t:${unixStart}:F>`
                );

            } finally {
                if (conn) conn.release();
            }

        } catch (err) {
            console.error(err);
            interaction.editReply("❌ System error while validating the slot.");
        }
    }
};