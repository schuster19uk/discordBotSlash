// const { SlashCommandBuilder } = require('discord.js');
// const pool = require('../database/pool');

// module.exports = {
//     data: new SlashCommandBuilder()
//         .setName('cancel')
//         .setDescription('Cancel a booking')
//         .addIntegerOption(option =>
//             option.setName('slot')
//                 .setDescription('The slot ID to cancel')
//                 .setRequired(true)
//         ),
//     async execute(interaction) {
//         const slotId = interaction.options.getInteger('slot');

//         await interaction.deferReply();

//         let conn;
//         try {
//             conn = await pool.getConnection();

//             // 1. Check if the slot exists and who booked it
//             const [slot] = await conn.query(
//                 "SELECT booked_by_id FROM booking_slots WHERE slot_id = ?",
//                 [slotId]
//             );

//             if (!slot) {
//                 return interaction.editReply("❌ That Slot ID does not exist.");
//             }

//             // 2. Security Check: Only the person who booked it (or an Admin) can cancel
//             const isOwner = slot.booked_by_id === interaction.user.id;
//             const isAdmin = interaction.member.permissions.has('Administrator');

//             if (!isOwner && !isAdmin) {
//                 return interaction.editReply("🚫 You can only cancel your own bookings.");
//             }

//             // 3. Update the database to make it available again
//             // We reset everything: booked_by, is_available, and reminder_sent
//             const result = await conn.query(
//                 `UPDATE booking_slots
//                  SET booked_by_id = NULL,
//                      booked_by_name = NULL,
//                      is_available = TRUE,
//                      reminder_sent = FALSE
//                  WHERE slot_id = ?`,
//                 [slotId]
//             );

//             if (result.affectedRows > 0) {
//                 interaction.editReply(`✅ **Cancelled!** Slot #${slotId} is now available for others to book.`);
//             } else {
//                 interaction.editReply("❌ Something went wrong. The slot might already be cancelled.");
//             }

//         } catch (err) {
//             console.error("Error in cancel command:", err);
//             interaction.editReply("❌ Database error during cancellation.");
//         } finally {
//             if (conn) conn.release();
//         }
//     }
// };