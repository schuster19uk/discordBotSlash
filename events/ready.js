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
        //const commands = client.commands.map(command => command.data.toJSON());
        const commands = [];
        client.commands.forEach(command => {
            // Add the original command
            commands.push(command.data.toJSON());

            // Check for a custom "aliases" property (optional but helpful)
            // Or manually add duplicates for specific commands:
            if (command.data.name === 'slots') {
                const bookAlias = command.data.toJSON();
                bookAlias.name = 'book';
                bookAlias.description = 'Book a lesson';
                commands.push(bookAlias);
            }
            if (command.data.name === 'mylessons') {
                const slotsAlias = command.data.toJSON();
                slotsAlias.name = 'myslots';
                slotsAlias.description = 'View and manage your upcoming bookings';
                commands.push(slotsAlias);
            }

        });

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