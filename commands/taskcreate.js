const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('taskcreate')
        .setDescription('Create a new project task via interactive forms'),

    async execute(interaction) {
        // Safe initial acknowledgment
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        let conn;
        try {
            conn = await pool.getConnection();

            // 1. SECURITY CHECK: Verify the user is an active database project member
            const [memberRows] = await conn.query(
                `SELECT member_id FROM project_members WHERE discord_id = ? AND is_active = TRUE`,
                [interaction.user.id]
            );

            // Handle both empty array layouts gracefully depending on your driver version
            const member = Array.isArray(memberRows) ? memberRows[0] : memberRows;

            if (!member) {
                return await interaction.editReply({
                    content: "🚫 **Access Denied:** You are not registered as an active team member in the project database. Please contact an administrator to be added."
                });
            }

            // 2. Fetch available projects since they are verified
            const projects = await conn.query('SELECT project_id, project_name FROM projects LIMIT 25');

            if (!projects || projects.length === 0) {
                return await interaction.editReply("⚠️ No projects found in the database. Please add a project first.");
            }

            // 3. Build the project selection menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('project_select_for_task')
                .setPlaceholder('Select the project this task belongs to...')
                .addOptions(
                    projects.map(proj => ({
                        label: proj.project_name,
                        value: proj.project_id.toString()
                    }))
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            await interaction.editReply({
                content: "✨ **Let's create a new task!** Select a project below to open up the task form:",
                components: [row]
            });

        } catch (error) {
            console.error("Error in taskcreate command:", error);
            await interaction.editReply("❌ An error occurred while validating your member permissions.");
        } finally {
            if (conn) conn.release();
        }
    }
};