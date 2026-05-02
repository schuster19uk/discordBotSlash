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
                const errorMessage = { content: '❌ There was an error executing that command.', ephemeral: true };
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(errorMessage);
                } else {
                    await interaction.reply(errorMessage);
                }
            }
            return; // Exit after handling command
        }

        // --- 2. HANDLE BUTTON CLICKS ---
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('book_slot_')) {
                const slotId = interaction.customId.replace('book_slot_', '');
                let conn;

                try {
                    // 1. Acknowledge the click immediately
                    await interaction.deferUpdate();

                    conn = await pool.getConnection();

                    // 2. Execute the query using the user's Discord info
                    const result = await conn.query(
                        `UPDATE booking_slots 
                        SET booked_by_id = ?, booked_by_name = ?, is_available = FALSE 
                        WHERE slot_id = ? AND is_available = TRUE`, 
                        [interaction.user.id, interaction.user.username, slotId]
                    );

                    /**
                     * Note: result.affectedRows works for the 'mysql2' and 'mariadb' packages.
                     * If the slot was already taken, affectedRows will be 0.
                     */
                    if (result.affectedRows === 0) {
                        return await interaction.followUp({
                            content: "⚠️ **Booking Failed:** This slot was just taken by someone else or is no longer available.",
                            ephemeral: true
                        });
                    }

                    // 3. Confirm success to the user
                    await interaction.followUp({
                        content: `✅ **Success!** You have booked slot **#${slotId}**.\n📅 Check your DMs for confirmation (if applicable).`,
                        ephemeral: true
                    });

                } catch (error) {
                    console.error('Database Update Error:', error);
                    await interaction.followUp({ 
                        content: '❌ **Error:** Could not process booking at this time.', 
                        ephemeral: true 
                    });
                } finally {
                    if (conn) conn.release();
                }
            }
        }
    },
};