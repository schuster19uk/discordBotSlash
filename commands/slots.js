const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    MessageFlags 
} = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Paginated view of available booking slots')
        .addIntegerOption(option => 
            option.setName('page')
                .setDescription('The page number to view')
                .setMinValue(1)),
    
    async execute(interaction) {
        // 1. Role Check
        const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
        if (REQUIRED_ROLE_ID && !interaction.member.roles.cache.has(REQUIRED_ROLE_ID)) {
            return await interaction.reply({ 
                content: "🚫 You do not have the required role to trigger this command.", 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        // Handle if this was called from a button or slash command
        const isButton = interaction.isButton();
        if (!isButton) await interaction.deferReply();

        // 2. Pagination Math
        const itemsPerPage = 10;
        let page = interaction.options?.getInteger('page') || 1;
        
        // Extract page from customId if it's a button interaction
        if (isButton && interaction.customId.startsWith('avail_page_')) {
            page = parseInt(interaction.customId.replace('avail_page_', ''));
        }

        const offset = (page - 1) * itemsPerPage;

        let conn;
        try {
            conn = await pool.getConnection();
            
            // Get total count for nav logic
            const countResult = await conn.query(
                `SELECT COUNT(*) as total FROM booking_slots WHERE is_available = TRUE AND start_time >= NOW() + INTERVAL 24 HOUR`
            );
            const totalSlots = Number(countResult[0].total);
            const totalPages = Math.ceil(totalSlots / itemsPerPage);

            // Fetch specific slice of slots
            const rows = await conn.query(
                `SELECT slot_id, start_time FROM booking_slots 
                 WHERE is_available = TRUE AND is_special_slot = FALSE
                 AND start_time >= NOW() + INTERVAL 24 HOUR 
                 ORDER BY start_time ASC LIMIT ? OFFSET ?`,
                [itemsPerPage, offset]
            );

            if (!rows || rows.length === 0) {
                const errorMsg = `📅 No available slots found on page ${page}.`;
                return isButton ? await interaction.editReply(errorMsg) : await interaction.editReply(errorMsg);
            }

            let list = `━━━━━━━━━━━━━━━━━━━━━━━━\n**BOOKING SLOTS (Page ${page}/${totalPages})**\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            const actionRows = [];
            let slotButtons = new ActionRowBuilder();

            rows.forEach((row, index) => {
                const start = row.start_time instanceof Date 
                    ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
                    : DateTime.fromSQL(row.start_time, { zone: 'utc' });

                const sUnix = Math.floor(start.toSeconds());
                const displayIndex = offset + index + 1; // Numbering persists across pages
                
                list += `**${displayIndex}.** <t:${sUnix}:F>\n`;

                slotButtons.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`book_slot_${row.slot_id}`)
                        .setLabel(`${displayIndex}`) 
                        .setStyle(ButtonStyle.Primary)
                );

                if ((index + 1) % 5 === 0 || index === rows.length - 1) {
                    actionRows.push(slotButtons);
                    slotButtons = new ActionRowBuilder();
                }
            });

            // 3. Navigation Buttons
            const navRow = new ActionRowBuilder();
            
            if (page > 1) {
                navRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`avail_page_${page - 1}`)
                        .setLabel('⬅️ Previous')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            if (page < totalPages) {
                navRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`avail_page_${page + 1}`)
                        .setLabel('Next ➡️')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            if (navRow.components.length > 0) actionRows.push(navRow);

            // Update original message if button, otherwise new reply
            const payload = { content: list, components: actionRows };
            isButton ? await interaction.editReply(payload) : await interaction.editReply(payload);

        } catch (err) {
            console.error("Pagination Error:", err);
            const errMg = "❌ Error loading slots.";
            isButton ? await interaction.editReply(errMg) : await interaction.editReply(errMg);
        } finally {
            if (conn) conn.release();
        }
    }
};