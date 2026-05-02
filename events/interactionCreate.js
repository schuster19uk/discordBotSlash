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

                try {
                    // Always acknowledge the interaction immediately to prevent "Interaction Failed"
                    // deferUpdate() stops the loading state on the button without sending a new message
                    await interaction.deferUpdate();

                    // Perform your booking logic here (e.g., updating the database)
                    // const pool = require('../database/pool');
                    // await pool.query('UPDATE booking_slots SET is_available = FALSE WHERE slot_id = ?', [slotId]);

                    await interaction.followUp({
                        content: `✅ Successfully booked slot **#${slotId}**!`,
                        ephemeral: true
                    });

                } catch (error) {
                    console.error('Button Error:', error);
                    await interaction.followUp({ content: '❌ Failed to process booking.', ephemeral: true });
                }
            }
        }
    },
};