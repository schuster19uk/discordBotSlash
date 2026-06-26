
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
        .setName('listlessons')
        .setDescription('Show all booked and no-show slots (Admin Only)')
        .addIntegerOption(option => 
            option.setName('page').setDescription('Page number').setMinValue(1)),

    async execute(interaction) {
        // 1. Permissions
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return await interaction.reply({ content: "🚫 Admin only.", flags: [MessageFlags.Ephemeral] });
        }

        // 2. Proper Acknowledgment
        if (!interaction.deferred && !interaction.replied) {
            if (interaction.isButton()) {
                await interaction.deferUpdate();
            } else {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            }
        }

        const itemsPerPage = 4;
        let page = interaction.options?.getInteger('page') || 1;
        if (interaction.isButton() && interaction.customId.startsWith('list_page_')) {
            page = parseInt(interaction.customId.split('_')[2]);
        }

        let conn;

        try {
            conn = await pool.getConnection();

            // Count total matching rows
            const countRes = await conn.query(
                `SELECT COUNT(*) as total FROM booking_slots 
                 WHERE (is_available = FALSE) AND start_time >= NOW() - INTERVAL 3 HOUR 
                 AND booked_by_name IS NOT NULL`
            );

            const totalItems = Number(countRes[0].total);
            const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

            // Clamp page to valid range — prevents stale buttons showing out-of-range pages
            if (page > totalPages) page = totalPages;
            if (page < 1) page = 1;

            const offset = (page - 1) * itemsPerPage;

            const rows = await conn.query(
                `SELECT slot_id, start_time, booked_by_name, is_no_show 
                FROM booking_slots 
                 WHERE (is_available = FALSE) 
                 AND start_time >= NOW() - INTERVAL 3 HOUR
                 AND booked_by_name IS NOT NULL 
                 ORDER BY start_time ASC LIMIT ? OFFSET ?`,
                [itemsPerPage, offset]
            );

            if (!rows.length) return await interaction.editReply("📅 No bookings found.");

            let list = `## MASTER BOOKING LIST (Page ${page}/${totalPages})\n`;
            const actionRows = [];

            rows.forEach((row, i) => {
                const sUnix = Math.floor(DateTime.fromJSDate(new Date(row.start_time)).toSeconds());
                const displayNum = offset + i + 1;
                
                const isNoShowBool = row.is_no_show === 1 || row.is_no_show === true;

                list += `**${displayNum}.** <t:${sUnix}:F> (60 min) | ${isNoShowBool ? "🚩 NO SHOW" : "✅ Booked"}\n👤 User: **${row.booked_by_name}**\n\n`;

                actionRows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_slot_${row.slot_id}`)
                        .setLabel(`Cancel #${displayNum}`)
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(`noshow_slot_${row.slot_id}`)
                        .setLabel(`No Show #${displayNum}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isNoShowBool)
                ));
            });

            const nav = new ActionRowBuilder();
            if (page > 1) nav.addComponents(new ButtonBuilder().setCustomId(`list_page_${page - 1}`).setLabel('⬅️').setStyle(ButtonStyle.Primary));
            if (page < totalPages) nav.addComponents(new ButtonBuilder().setCustomId(`list_page_${page + 1}`).setLabel('➡️').setStyle(ButtonStyle.Primary));
            if (nav.components.length > 0) actionRows.push(nav);

            await interaction.editReply({ content: list, components: actionRows });
        } catch (err) {
            console.error(err);
            await interaction.editReply("❌ DB Error.");
        } finally {
            if (conn) conn.release();
        }
    }
};