
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
        .setName('todayschedule')
        .setDescription('Show all booked and no-show slots (Admin Only)')
        .addIntegerOption(option => 
            option.setName('page').setDescription('Page number').setMinValue(1)),

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

        const itemsPerPage = 4;
        let page = interaction.options?.getInteger('page') || 1;
        if (interaction.isButton() && interaction.customId.startsWith('today_page_')) {
            page = parseInt(interaction.customId.split('_')[2]);
        }

        // 1. Get the current moment specifically in Nevada time
        const nevadaNow = DateTime.now().setZone('America/Los_Angeles');

        // 2. Capture the exact start and end of "Today" in Nevada, converted to UTC strings
        const startOfNevadaToday = nevadaNow.startOf('day').toUTC().toSQL(); // e.g., "2026-06-26 07:00:00"
        const endOfNevadaToday = nevadaNow.endOf('day').toUTC().toSQL();     // e.g., "2026-06-27 06:59:59"

        let conn;

        try {
            conn = await pool.getConnection();

            // Count total rows matching Nevada's "today" window
            const countRes = await conn.query(
                `SELECT COUNT(*) as total FROM booking_slots 
                WHERE (is_available = FALSE) 
                AND start_time >= ? 
                AND start_time <= ?
                AND booked_by_name IS NOT NULL
                AND slot_category = 'onstream'`,
                [startOfNevadaToday, endOfNevadaToday]
            );

            const totalItems = Number(countRes[0].total);
            const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

            if (page > totalPages) page = totalPages;
            if (page < 1) page = 1;

            const offset = (page - 1) * itemsPerPage;

            // Fetch the rows matching Nevada's "today" window
            const rows = await conn.query(
                `SELECT slot_id, start_time, "lesson", is_no_show 
                FROM booking_slots 
                WHERE (is_available = FALSE) 
                AND start_time >= ? 
                AND start_time <= ?
                AND booked_by_name IS NOT NULL
                AND slot_category = 'onstream'
                ORDER BY start_time ASC LIMIT ? OFFSET ?`,
                [startOfNevadaToday, endOfNevadaToday, itemsPerPage, offset]
            );

        // let conn;

        // try {
        //     conn = await pool.getConnection();

        //     // Count total matching rows
        //     const countRes = await conn.query(
        //         `SELECT COUNT(*) as total FROM booking_slots 
        //          WHERE (is_available = FALSE) 
        //          AND start_time >= NOW() - INTERVAL 3 HOUR 
        //          AND booked_by_name IS NOT NULL
        //          AND slot_category = 'onstream'`
        //     );

        //     const totalItems = Number(countRes[0].total);
        //     const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

        //     // Clamp page to valid range — prevents stale buttons showing out-of-range pages
        //     if (page > totalPages) page = totalPages;
        //     if (page < 1) page = 1;

        //     const offset = (page - 1) * itemsPerPage;

        //     const rows = await conn.query(
        //         `SELECT slot_id, start_time, "lesson", is_no_show 
        //         FROM booking_slots 
        //          WHERE (is_available = FALSE) 
        //          AND start_time >= NOW() - INTERVAL 3 HOUR
        //          AND booked_by_name IS NOT NULL
        //          AND slot_category = 'onstream'
        //          ORDER BY start_time ASC LIMIT ? OFFSET ?`,
        //         [itemsPerPage, offset]
        //     );

            if (!rows.length) return await interaction.editReply("📅 No bookings found.");

            let list = `## TODAY'S SCHEDULE (Page ${page}/${totalPages})\n`;
            const actionRows = [];

            rows.forEach((row, i) => {
                const sUnix = Math.floor(DateTime.fromJSDate(new Date(row.start_time)).toSeconds());
                const displayNum = offset + i + 1;
                
                const isNoShowBool = row.is_no_show === 1 || row.is_no_show === true;

                list += `**${displayNum}.** <t:${sUnix}:F> (60 min) | ${row.lesson} \n`;

                // actionRows.push(new ActionRowBuilder().addComponents(
                //     new ButtonBuilder()
                //         .setCustomId(`cancel_slot_${row.slot_id}`)
                //         .setLabel(`Cancel #${displayNum}`)
                //         .setStyle(ButtonStyle.Danger),
                //     new ButtonBuilder()
                //         .setCustomId(`noshow_slot_${row.slot_id}`)
                //         .setLabel(`No Show #${displayNum}`)
                //         .setStyle(ButtonStyle.Secondary)
                //         .setDisabled(isNoShowBool)
                // ));
            });

            const nav = new ActionRowBuilder();
            if (page > 1) nav.addComponents(new ButtonBuilder().setCustomId(`today_page_${page - 1}`).setLabel('⬅️').setStyle(ButtonStyle.Primary));
            if (page < totalPages) nav.addComponents(new ButtonBuilder().setCustomId(`today_page_${page + 1}`).setLabel('➡️').setStyle(ButtonStyle.Primary));
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