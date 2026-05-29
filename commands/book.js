const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('book')
        .setDescription('View available booking slots')
        .addIntegerOption(option => option.setName('page').setDescription('Page number').setMinValue(1)),
    
    async execute(interaction) {
        // --- SAFE ACKNOWLEDGMENT ---
        // If the interaction hasn't been acknowledged yet, do it now.
        if (!interaction.deferred && !interaction.replied) {
            if (interaction.isButton()) {
                await interaction.deferUpdate(); // For pagination buttons
            } else {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // For /book command
            }
        }

        const itemsPerPage = 10;
        let page = interaction.options?.getInteger('page') || 1;
        
        if (interaction.isButton() && interaction.customId.startsWith('avail_page_')) {
            page = parseInt(interaction.customId.replace('avail_page_', ''));
        }

        const offset = (page - 1) * itemsPerPage;
        let conn;

        try {
            conn = await pool.getConnection();
            const countRes = await conn.query(`SELECT COUNT(*) as total FROM booking_slots WHERE is_available = TRUE AND start_time >= NOW() + INTERVAL 24 HOUR`);
            const totalItems = Number(countRes[0].total);
            const totalPages = Math.ceil(totalItems / itemsPerPage);

            const rows = await conn.query(
                `SELECT slot_id, start_time FROM booking_slots 
                 WHERE is_available = TRUE AND is_special_slot = 0 AND start_time >= NOW() + INTERVAL 24 HOUR 
                 ORDER BY start_time ASC LIMIT ? OFFSET ?`, [itemsPerPage, offset]
            );

            if (!rows.length) {
                return await interaction.editReply("📅 No slots available for the selected range.");
            }

            //let list = `**BOOKING SLOTS (Page ${page}/${totalPages})**\n━━━━━━━━━━━━━━━━━━━━\n`;
            let list = `**BOOKING SLOTS (Page ${page}/${totalPages})**\n━━━━━━━━━━━━━━━━━━━━\n`;
            list += `\n⏰ All times are shown in your local time zone.\n`;
            list += `📌 Book by clicking the square number button.\n\n`;
            const actionRows = [];
            let currentButtons = new ActionRowBuilder();

            rows.forEach((row, i) => {
                const sUnix = Math.floor(DateTime.fromJSDate(new Date(row.start_time)).toSeconds());
                const displayNum = offset + i + 1;
                
                list += `**${displayNum}.** <t:${sUnix}:F> (Duration 60 minutes) \n`;
                
                currentButtons.addComponents(
                    new ButtonBuilder().setCustomId(`book_slot_${row.slot_id}`).setLabel(`${displayNum}`).setStyle(ButtonStyle.Primary)
                );

                if (currentButtons.components.length === 5 || i === rows.length - 1) {
                    actionRows.push(currentButtons);
                    currentButtons = new ActionRowBuilder();
                }
            });

            const nav = new ActionRowBuilder();
            if (page > 1) nav.addComponents(new ButtonBuilder().setCustomId(`avail_page_${page - 1}`).setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary));
            if (page < totalPages) nav.addComponents(new ButtonBuilder().setCustomId(`avail_page_${page + 1}`).setLabel('Next ➡️').setStyle(ButtonStyle.Secondary));
            if (nav.components.length > 0) actionRows.push(nav);

            // Using editReply ensures we update the existing message/deferred state correctly
            await interaction.editReply({ content: list, components: actionRows });

        } catch (err) {
            console.error("Database Error in Book:", err);
            await interaction.editReply("❌ Error loading slots.");
        } finally {
            if (conn) conn.release();
        }
    }
};