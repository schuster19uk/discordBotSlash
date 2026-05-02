module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (!interaction.isChatInputCommand()) return;

        const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
        if (COMMAND_CHANNEL_ID && COMMAND_CHANNEL_ID !== '0' && interaction.channelId !== COMMAND_CHANNEL_ID) return;

        const command = client.commands.get(interaction.commandName);

        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(`Error in ${interaction.commandName}:`, error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: '❌ There was an error executing that command.', ephemeral: true });
            } else {
                await interaction.reply({ content: '❌ There was an error executing that command.', ephemeral: true });
            }
        }
    },
};