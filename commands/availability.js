
// const { 
//     SlashCommandBuilder, 
//     ActionRowBuilder, 
//     ButtonBuilder, 
//     ButtonStyle 
// } = require('discord.js');
// const { DateTime } = require('luxon');
// const pool = require('../database/pool');

// module.exports = {
//     data: new SlashCommandBuilder()
//         .setName('availability')
//         .setDescription('Show 20 available booking slots'),
//     async execute(interaction) {
//         await interaction.deferReply();

//         let conn;
//         try {
//             conn = await pool.getConnection();
//             const rows = await conn.query(
//                 `SELECT slot_id, start_time FROM booking_slots 
//                  WHERE is_available = TRUE 
//                  AND start_time >= NOW() + INTERVAL 24 HOUR 
//                  ORDER BY start_time ASC LIMIT 20`
//             );

//             if (!rows || rows.length === 0) {
//                 return await interaction.editReply("📅 No slots found.");
//             }

//             let list = "━━━━━━━━━━━━━━━━━━━━━━━━\n**SELECT A SLOT TO BOOK**\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
//             const actionRows = [];
//             let currentRow = new ActionRowBuilder();

//             rows.forEach((row, index) => {
//                 const start = row.start_time instanceof Date 
//                     ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
//                     : DateTime.fromSQL(row.start_time, { zone: 'utc' });

//                 const sUnix = Math.floor(start.toSeconds());
//                 list += `**${index + 1}.** <t:${sUnix}:F>\n`;

//                 // Add button to the current row
//                 currentRow.addComponents(
//                     new ButtonBuilder()
//                         .setCustomId(`book_slot_${row.slot_id}`)
//                         .setLabel(`${index + 1}`) // Short label so buttons stay small
//                         .setStyle(ButtonStyle.Secondary)
//                 );

//                 // Every 5 buttons, push the row and start a new one
//                 if ((index + 1) % 5 === 0 || index === rows.length - 1) {
//                     actionRows.push(currentRow);
//                     currentRow = new ActionRowBuilder();
//                 }
//             });

//             await interaction.editReply({
//                 content: list,
//                 components: actionRows
//             });

//         } catch (err) {
//             console.error(err);
//             await interaction.editReply("❌ Error loading availability.");
//         } finally {
//             if (conn) conn.release();
//         }
//     }
// };

const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');
const { DateTime } = require('luxon');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('availability')
        .setDescription('Show 20 available booking slots'),
    async execute(interaction) {
        await interaction.deferReply();

        let conn;
        try {
            conn = await pool.getConnection();
            const rows = await conn.query(
                `SELECT slot_id, start_time FROM booking_slots 
                 WHERE is_available = TRUE 
                 AND start_time >= NOW() + INTERVAL 24 HOUR 
                 ORDER BY start_time ASC LIMIT 20`
            );

            if (!rows || rows.length === 0) {
                return await interaction.editReply("📅 No available slots found for the next 24+ hours.");
            }

            let list = "━━━━━━━━━━━━━━━━━━━━━━━━\n**SELECT A SLOT TO BOOK**\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
            const actionRows = [];
            let currentRow = new ActionRowBuilder();

            rows.forEach((row, index) => {
                const start = row.start_time instanceof Date 
                    ? DateTime.fromJSDate(row.start_time, { zone: 'utc' }) 
                    : DateTime.fromSQL(row.start_time, { zone: 'utc' });

                const sUnix = Math.floor(start.toSeconds());
                list += `**${index + 1}.** <t:${sUnix}:F>\n`;

                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`book_slot_${row.slot_id}`)
                        .setLabel(`${index + 1}`) 
                        .setStyle(ButtonStyle.Primary) // Changed to Primary (Blue) for better visibility
                );

                // Push row every 5 buttons OR if it's the last item
                if ((index + 1) % 5 === 0 || index === rows.length - 1) {
                    if (currentRow.components.length > 0) {
                        actionRows.push(currentRow);
                        currentRow = new ActionRowBuilder();
                    }
                }
            });

            await interaction.editReply({
                content: list,
                components: actionRows
            });

        } catch (err) {
            console.error("Availability Command Error:", err);
            await interaction.editReply("❌ Error loading availability. Please try again later.");
        } finally {
            if (conn) conn.release();
        }
    }
};