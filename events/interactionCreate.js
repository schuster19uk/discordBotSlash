const { MessageFlags } = require('discord.js');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // --- 1. HANDLE SLASH COMMANDS ---
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            try {
                // We let the command file handle its own defer/reply
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error in ${interaction.commandName}:`, error);
                const payload = { content: '❌ Error executing command.', flags: [MessageFlags.Ephemeral] };
                interaction.deferred || interaction.replied ? await interaction.followUp(payload) : await interaction.reply(payload);
            }
            return;
        }

        // --- 2. HANDLE BUTTON CLICKS ---
        if (interaction.isButton()) {
            const { customId } = interaction;

            // --- A. BOOKING ACTIONS & PAGINATION ---
            if (customId.startsWith('list_page_') || customId.startsWith('my_page_') || customId.startsWith('avail_page_') ||
                customId.startsWith('book_slot_') || customId.startsWith('cancel_slot_') || customId.startsWith('noshow_slot_')) {
                const bookingHandler = require('./handlers/buttonHandlers/bookingActionButtonHandler');
                await bookingHandler(interaction, client);
                return;
            }

            // --- B. TASK MANAGEMENT PAGINATION HUB ---
            if (customId.startsWith('tasks_page_')) {
                const command = client.commands.get('listtasks');
                if (command) await command.execute(interaction);
                return;
            }

            // --- C. PROJECT MANAGEMENT ---
            if (customId.startsWith('project_')) {
                const projectHandler = require('./handlers/buttonHandlers/projectManagementButtonHandler');
                await projectHandler(interaction, client);
                return;
            }
        }

        // --- 3. HANDLE SELECT MENUS ---
        if (interaction.isStringSelectMenu()) {
            const { customId } = interaction;
            if (customId === 'project_select_for_task' || customId.startsWith('project_task_complete_menu_')) {
                const projectHandler = require('./handlers/buttonHandlers/projectManagementButtonHandler');
                await projectHandler(interaction, client);
                return;
            }
        }

        // --- 4. HANDLE MODAL SUBMISSIONS ---
        if (interaction.isModalSubmit()) {
            const { customId } = interaction;
            if (customId.startsWith('task_modal_submit_')) {
                const projectHandler = require('./handlers/buttonHandlers/projectManagementButtonHandler');
                await projectHandler(interaction, client);
                return;
            }
        }
    },
};