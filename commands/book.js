
const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('book')
        .setDescription('Book a slot')
        .addIntegerOption(option =>
            option.setName('slot')
                .setDescription('The slot ID to book')
                .setRequired(true)
        ),
    async execute(interaction) {
        const slotId = interaction.options.getInteger('slot');

        // 1. Role Check
        const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
        if (!interaction.member.roles.cache.has(REQUIRED_ROLE_ID)) {
            return interaction.reply({ content: "🚫 You do not have the required role to book slots.", ephemeral: true });
        }

        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();

            // 2. Attempt Atomic Update
            const result = await conn.query(
                `UPDATE booking_slots
                 SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE
                 WHERE slot_id = ? AND is_available = TRUE`,
                [interaction.user.id, interaction.user.username, slotId]
            );

            // 3. Check if booking was successful
            if (result.affectedRows > 0) {
                const [details] = await conn.query(
                    "SELECT start_time FROM booking_slots WHERE slot_id = ?",
                    [slotId]
                );

                /**
                 * 4. Time Conversion
                 * With dateStrings: true, details.start_time is a string "2026-04-26 13:00:00".
                 * We use fromSQL and force the 'utc' zone to prevent any local shifting.
                 */
                const unix = Math.floor(DateTime.fromSQL(details.start_time, { zone: 'utc' }).toSeconds());

                const embed = new EmbedBuilder()
                    .setTitle("✅ Booking Confirmed")
                    .setColor(0x57F287)
                    .addFields(
                        { name: "Slot ID", value: `#${slotId}`, inline: true },
                        { name: "Time", value: `<t:${unix}:F>`, inline: true }
                    )
                    .setFooter({ text: "A DM reminder will be sent 15-20 mins prior." });

                interaction.editReply({ embeds: [embed] });
            } else {
                interaction.editReply("❌ That slot is either invalid or already taken.");
            }
        } catch (err) {
            console.error("Error in book command:", err);
            interaction.editReply("❌ There was a database error while processing your booking.");
        } finally {
            if (conn) conn.release();
        }
    }
};