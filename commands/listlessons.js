// const { 
//     SlashCommandBuilder, 
//     ActionRowBuilder, 
//     ButtonBuilder, 
//     ButtonStyle,
//     MessageFlags,
//     PermissionFlagsBits 
// } = require('discord.js');
// const { DateTime } = require('luxon');
// const pool = require('../database/pool');

// module.exports = {
//     data: new SlashCommandBuilder()
//         .setName('listlessons')
//         .setDescription('Show all booked and no-show slots (Owner/Admin Only)'),
//     async execute(interaction) {
//         // 1. Permissions Check
//         const REQUIRED_ROLE_ID = process.env.REQUIRED_ROLE_ID;
//         const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

//         //&& REQUIRED_ROLE_ID && !interaction.member.roles.cache.has(REQUIRED_ROLE_ID)
//         if (!isAdmin) {
//             return await interaction.reply({ 
//                 content: "🚫 You do not have permission to view the master booking list.", 
//                 flags: [MessageFlags.Ephemeral] 
//             });
//         }

//         await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

//         let conn;
//         try {
//             conn = await pool.getConnection();
            
//             // Querying both booked and no-show slots from 3 hours ago onwards
//             const rows = await conn.query(
//                 `SELECT slot_id, start_time, booked_by_name, is_no_show FROM booking_slots 
//                  WHERE (is_available = FALSE OR is_no_show = TRUE)
//                  AND start_time >= NOW() - INTERVAL 3 HOUR 
//                  ORDER BY start_time ASC LIMIT 10`
//             );

//             if (!rows || rows.length === 0) {
//                 return await interaction.editReply("📅 No upcoming or recent bookings found.");
//             }

//             let list = "━━━━━━━━━━━━━━━━━━━━━━━━\n**MASTER BOOKING LIST**\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
//             const actionRows = [];

//             rows.forEach((row, index) => {
//                 const start = row.start_time instanceof Date 
//                     ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
//                     : DateTime.fromSQL(row.start_time, { zone: 'utc' });

//                 const sUnix = Math.floor(start.toSeconds());
                
//                 // Status indicator
//                 const statusEmoji = row.is_no_show ? "🚩 **NO SHOW**" : "✅ Booked";
                
//                 list += `**${index + 1}.** <t:${sUnix}:F>\n👤 User: **${row.booked_by_name || 'Unknown'}** | ${statusEmoji}\n\n`;

//                 const rowButtons = new ActionRowBuilder();
                
//                 // Always add a Cancel button
//                 rowButtons.addComponents(
//                     new ButtonBuilder()
//                         .setCustomId(`cancel_slot_${row.slot_id}`)
//                         .setLabel(`Cancel #${index + 1}`) 
//                         .setStyle(ButtonStyle.Danger)
//                 );

//                 // Only add a No Show button if they haven't been marked yet
//                 if (!row.is_no_show) {
//                     rowButtons.addComponents(
//                         new ButtonBuilder()
//                             .setCustomId(`noshow_slot_${row.slot_id}`)
//                             .setLabel(`No Show #${index + 1}`) 
//                             .setStyle(ButtonStyle.Secondary)
//                     );
//                 }
                
//                 actionRows.push(rowButtons);
//             });

//             await interaction.editReply({
//                 content: list,
//                 components: actionRows
//             });

//         } catch (err) {
//             console.error("Booked Command Error:", err);
//             await interaction.editReply("❌ Error loading master booking list." + (err.message ? `\n\n\`\`\`${err.message}\`\`\`` : ""));
//         } finally {
//             if (conn) conn.release();
//         }
//     }
// };



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
        .setDescription('Show all booked and no-show slots (Owner/Admin Only)'),
    async execute(interaction) {
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
            return await interaction.reply({ 
                content: "🚫 You do not have permission to view the master booking list.", 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        const isButton = interaction.isButton();
        if (!isButton) await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        // 1. Pagination Math
        const itemsPerPage = 10;
        let page = 1;
        
        // If triggered by a button like 'list_page_2', extract the '2'
        if (isButton && interaction.customId.startsWith('list_page_')) {
            page = parseInt(interaction.customId.split('_')[2]);
        }
        const offset = (page - 1) * itemsPerPage;

        let conn;
        try {
            conn = await pool.getConnection();
            
            // Get total count for page calculations
            const countRes = await conn.query(
                `SELECT COUNT(*) as total FROM booking_slots 
                 WHERE (is_available = FALSE OR is_no_show = TRUE)
                 AND start_time >= NOW() - INTERVAL 3 HOUR`
            );
            const totalItems = Number(countRes[0].total);
            const totalPages = Math.ceil(totalItems / itemsPerPage);

            // Fetch only 10 items for the CURRENT page
            const rows = await conn.query(
                `SELECT slot_id, start_time, booked_by_name, is_no_show FROM booking_slots 
                 WHERE (is_available = FALSE OR is_no_show = TRUE)
                 AND start_time >= NOW() - INTERVAL 3 HOUR 
                 ORDER BY start_time ASC LIMIT ? OFFSET ?`,
                [itemsPerPage, offset]
            );

            if (!rows || rows.length === 0) {
                return await interaction.editReply("📅 No bookings found for this page.");
            }

            let list = `**MASTER BOOKING LIST (Page ${page}/${totalPages})**\n*Total Bookings: ${totalItems}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            const actionRows = [];
            let currentRow = new ActionRowBuilder();

            rows.forEach((row, index) => {
                const start = row.start_time instanceof Date 
                    ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
                    : DateTime.fromSQL(row.start_time, { zone: 'utc' });

                const sUnix = Math.floor(start.toSeconds());
                const statusEmoji = row.is_no_show ? "🚩 **NO SHOW**" : "✅ Booked";
                
                // Index is offset + current loop index to show #11, #12, etc.
                const displayIndex = offset + index + 1;
                list += `**${displayIndex}.** <t:${sUnix}:F>\n👤 User: **${row.booked_by_name || 'Unknown'}** | ${statusEmoji}\n\n`;

                // Add buttons (Max 2 lessons per row to keep within Discord limits)
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_slot_${row.slot_id}`)
                        .setLabel(`Cancel #${displayIndex}`) 
                        .setStyle(ButtonStyle.Danger)
                );

                if (!row.is_no_show) {
                    currentRow.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`noshow_slot_${row.slot_id}`)
                            .setLabel(`No Show #${displayIndex}`) 
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                if (currentRow.components.length >= 4 || index === rows.length - 1) {
                    actionRows.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
            });

            // 2. Add Navigation Buttons Row
            const navRow = new ActionRowBuilder();
            if (page > 1) {
                navRow.addComponents(
                    new ButtonBuilder().setCustomId(`list_page_${page - 1}`).setLabel('⬅️ Previous').setStyle(ButtonStyle.Primary)
                );
            }
            if (page < totalPages) {
                navRow.addComponents(
                    new ButtonBuilder().setCustomId(`list_page_${page + 1}`).setLabel('Next ➡️').setStyle(ButtonStyle.Primary)
                );
            }

            if (navRow.components.length > 0) actionRows.push(navRow);

            await interaction.editReply({
                content: list,
                components: actionRows.slice(0, 5) // Absolute safety for Discord's 5-row limit
            });

        } catch (err) {
            console.error(err);
            await interaction.editReply("❌ Error loading master list.");
        } finally {
            if (conn) conn.release();
        }
    }
};