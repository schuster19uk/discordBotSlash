const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    MessageFlags,
    PermissionFlagsBits 
} = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('booked')
        .setDescription('Show all booked and no-show slots (Owner/Admin Only)'),
    async execute(interaction) {
        // 1. Permissions Check
        const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        //&& REQUIRED_ROLE_ID && !interaction.member.roles.cache.has(REQUIRED_ROLE_ID)
        if (!isAdmin) {
            return await interaction.reply({ 
                content: "🚫 You do not have permission to view the master booking list.", 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let conn;
        try {
            conn = await pool.getConnection();
            
            // Querying both booked and no-show slots from 3 hours ago onwards
            const rows = await conn.query(
                `SELECT slot_id, start_time, booked_by_name, is_no_show FROM booking_slots 
                 WHERE (is_available = FALSE OR is_no_show = TRUE)
                 AND start_time >= NOW() - INTERVAL 3 HOUR 
                 ORDER BY start_time ASC LIMIT 10`
            );

            if (!rows || rows.length === 0) {
                return await interaction.editReply("📅 No upcoming or recent bookings found.");
            }

            let list = "━━━━━━━━━━━━━━━━━━━━━━━━\n**MASTER BOOKING LIST**\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
            const actionRows = [];

            rows.forEach((row, index) => {
                const start = row.start_time instanceof Date 
                    ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
                    : DateTime.fromSQL(row.start_time, { zone: 'utc' });

                const sUnix = Math.floor(start.toSeconds());
                
                // Status indicator
                const statusEmoji = row.is_no_show ? "🚩 **NO SHOW**" : "✅ Booked";
                
                list += `**${index + 1}.** <t:${sUnix}:F>\n👤 User: **${row.booked_by_name || 'Unknown'}** | ${statusEmoji}\n\n`;

                const rowButtons = new ActionRowBuilder();
                
                // Always add a Cancel button
                rowButtons.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_slot_${row.slot_id}`)
                        .setLabel(`Cancel #${index + 1}`) 
                        .setStyle(ButtonStyle.Danger)
                );

                // Only add a No Show button if they haven't been marked yet
                if (!row.is_no_show) {
                    rowButtons.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`noshow_slot_${row.slot_id}`)
                            .setLabel(`No Show #${index + 1}`) 
                            .setStyle(ButtonStyle.Secondary)
                    );
                }
                
                actionRows.push(rowButtons);
            });

            await interaction.editReply({
                content: list,
                components: actionRows
            });

        } catch (err) {
            console.error("Booked Command Error:", err);
            await interaction.editReply("❌ Error loading master booking list.");
        } finally {
            if (conn) conn.release();
        }
    }
};