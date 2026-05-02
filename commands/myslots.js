const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    MessageFlags 
} = require('discord.js');
const pool = require('../database/pool');
const { DateTime } = require('luxon');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('myslots')
        .setDescription('View and manage your upcoming bookings'),
    async execute(interaction) {
        // 1. Role Check
        const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
        
        if (REQUIRED_ROLE_ID && !interaction.member.roles.cache.has(REQUIRED_ROLE_ID)) {
            return await interaction.reply({ 
                content: "🚫 You do not have the required role to trigger this command.", 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // 2. Defer as Ephemeral (Private)
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let conn;
        try {
            conn = await pool.getConnection();

            // Fetch only future slots booked by this specific user
            const rows = await conn.query(
                `SELECT slot_id, start_time FROM booking_slots 
                 WHERE booked_by_id = ? AND start_time > NOW()
                 ORDER BY start_time ASC LIMIT 5`, 
                [interaction.user.id]
            );

            if (!rows || rows.length === 0) {
                return await interaction.editReply("📝 You don't have any upcoming bookings.");
            }

            let dashboard = "## 🗓️ Your Booked Lessons \n*Select a button below to cancel an appointment.*\n\n";
            const actionRows = [];
            let currentRow = new ActionRowBuilder();

            rows.forEach((row, index) => {
                const start = row.start_time instanceof Date 
                    ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
                    : DateTime.fromSQL(row.start_time, { zone: 'utc' });

                const sUnix = Math.floor(start.toSeconds());
                dashboard += `**${index + 1}.** <t:${sUnix}:F> (ID: \`#${row.slot_id}\`)\n`;

                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_slot_${row.slot_id}`)
                        .setLabel(`Cancel #${index + 1}`)
                        .setStyle(ButtonStyle.Danger)
                );

                // Discord limit: 5 buttons per row
                if ((index + 1) % 5 === 0 || index === rows.length - 1) {
                    if (currentRow.components.length > 0) {
                        actionRows.push(currentRow);
                        currentRow = new ActionRowBuilder();
                    }
                }
            });

            await interaction.editReply({
                content: dashboard,
                components: actionRows
            });

        } catch (err) {
            console.error("Dashboard Error:", err);
            await interaction.editReply("❌ Error loading your dashboard.");
        } finally {
            if (conn) conn.release();
        }
    }
};