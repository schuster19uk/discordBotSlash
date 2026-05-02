const pool = require('../database/pool');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // --- 1. HANDLE SLASH COMMANDS ---
        if (interaction.isChatInputCommand()) {
            const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
            if (COMMAND_CHANNEL_ID && COMMAND_CHANNEL_ID !== '0' && interaction.channelId !== COMMAND_CHANNEL_ID) {
                return interaction.reply({ content: '❌ You cannot use commands in this channel.', ephemeral: true });
            }

            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error in ${interaction.commandName}:`, error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Error executing command.', ephemeral: true });
                } else {
                    await interaction.followUp({ content: '❌ Error executing command.', ephemeral: true });
                }
            }
            return;
        }

        // --- 2. HANDLE BUTTON CLICKS (MARIADB OPTIMIZED) ---
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('book_slot_')) {
                // Extract and convert ID to number if your DB uses INT for slot_id
                const rawId = interaction.customId.replace('book_slot_', '');
                const slotId = isNaN(rawId) ? rawId : parseInt(rawId);
                
                let conn;

                try {
                    // 1. Stop the "loading" state on the button
                    await interaction.deferUpdate();

                    conn = await pool.getConnection();

                    // 2. Execute MariaDB Query
                    // Note: MariaDB driver returns a 'ResultSetHeader' object directly
                    const result = await conn.query(
                        `UPDATE booking_slots 
                         SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE 
                         WHERE slot_id = ? AND is_available = TRUE`, 
                        [interaction.user.id, interaction.user.username, slotId]
                    );

                    // 3. Check affectedRows (MariaDB uses BigInt for this sometimes)
                    // We check > 0 to be safe
                    if (!result || result.affectedRows == 0) {
                        return await interaction.followUp({
                            content: "⚠️ **Slot Unavailable:** This appointment was just booked by someone else.",
                            ephemeral: true
                        });
                    }

                    // 4. Success!
                    await interaction.followUp({
                        content: `✅ **Booking Confirmed!**\nSlot: **#${slotId}**\nUser: **${interaction.user.username}**`,
                        ephemeral: true
                    });

                } catch (error) {
                    console.error('--- MARIADB ERROR ---');
                    console.error(error);
                    
                    await interaction.followUp({ 
                        content: `❌ **Database Error:** ${error.message}`, 
                        ephemeral: true 
                    });
                } finally {
                    if (conn) conn.release();
                }
            }
        }
    },
};