// events/ready.js
const { checkReminders } = require('../tasks/reminderSystem');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`🚀 Logged in as ${client.user.tag}`);
        
        // Register slash commands
        const commands = client.commands.map(command => command.data.toJSON());
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        try {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
                { body: commands }
            );
            console.log('Slash commands registered successfully.');
        } catch (error) {
            console.error('Error registering slash commands:', error);
        }
        
        // Start the background task
        setInterval(() => {
            checkReminders(client);
        }, 60000);
    },
};