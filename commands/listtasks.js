const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('listtasks')
        .setDescription('View your active project tasks and manage their statuses')
        .addIntegerOption(option => option.setName('page').setDescription('Page number').setMinValue(1)),

    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            if (interaction.isButton()) {
                await interaction.deferUpdate(); 
            } else {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            }
        }

        const itemsPerPage = 5; 
        let page = 1;

        if (interaction.options && typeof interaction.options.getInteger === 'function') {
            page = interaction.options.getInteger('page') || 1;
        }
        
        if (interaction.isButton() && interaction.customId?.startsWith('tasks_page_')) {
            page = parseInt(interaction.customId.split('_')[2]);
        }

        let conn;
        try {
            conn = await pool.getConnection();

            // 1. Resolve member
            // mariadb driver returns rows directly as an array — never destructure
            const memberRows = await conn.query(
                `SELECT member_id FROM project_members WHERE discord_id = ? AND is_active = 1`,
                [interaction.user.id]
            );

            const member = memberRows.length > 0 ? memberRows[0] : null;

            if (!member) {
                return await interaction.editReply("🚫 You are not registered as an active project team member.");
            }

            // 2. Count total tasks
            const countRows = await conn.query(
                `SELECT COUNT(*) as total FROM project_tasks 
                 WHERE assignee_id = ? AND is_deleted = FALSE AND status_id != 3`,
                [member.member_id]
            );

            const totalItems = countRows.length > 0 ? Number(countRows[0].total) : 0;
            const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;

            if (page > totalPages) page = totalPages;
            if (page < 1) page = 1;

            const offset = (page - 1) * itemsPerPage;

            // 3. Fetch tasks for current page
            const tasks = await conn.query(
                `SELECT 
                    t.task_id,
                    t.title, 
                    t.description, 
                    COALESCE(p.project_name, 'No Project') AS project_name,
                    s.status_name,
                    pr.priority_name
                FROM project_tasks t
                LEFT JOIN projects p ON t.project_id = p.project_id
                INNER JOIN lk_task_statuses s ON t.status_id = s.status_id
                INNER JOIN lk_task_priorities pr ON t.priority_id = pr.priority_id
                WHERE t.assignee_id = ? AND t.is_deleted = FALSE AND t.status_id != 3
                ORDER BY t.created_at DESC
                LIMIT ? OFFSET ?`, 
                [member.member_id, Number(itemsPerPage), Number(offset)]
            );

            if (!tasks || tasks.length === 0) {
                return await interaction.editReply("🎉 You have no pending active tasks assigned to you right now!");
            }

            const embed = new EmbedBuilder()
                .setTitle(`📌 Pending Tasks for ${interaction.user.username}`)
                .setDescription("Select a task from the dropdown menu below to mark it as complete.")
                .setColor('#2F3136')
                .setFooter({ text: `Page ${page} of ${totalPages} • Total Tasks: ${totalItems}` })
                .setTimestamp();

            const menuOptions = [];
            const actionRows = [];

            tasks.forEach((task, index) => {
                const displayNum = offset + index + 1; 
                const descriptionText = task.description ? `\n*${task.description}*` : '';

                embed.addFields({
                    name: `**#${displayNum}** — ⚙️ ${task.title}`,
                    value: `📁 **Project:** ${task.project_name}\n📊 **Status:** ${task.status_name} | **Priority:** ${task.priority_name}${descriptionText}`,
                    inline: false
                });

                menuOptions.push({
                    label: `#${displayNum} - ${task.title.substring(0, 50)}`,
                    description: `Project: ${task.project_name}`,
                    value: task.task_id.toString()
                });
            });

            actionRows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`project_task_complete_menu_${page}`)
                    .setPlaceholder('Choose a task to mark complete...')
                    .addOptions(menuOptions)
            ));

            const navRow = new ActionRowBuilder();
            if (page > 1) navRow.addComponents(new ButtonBuilder().setCustomId(`tasks_page_${page - 1}`).setLabel('⬅️ Previous').setStyle(ButtonStyle.Secondary));
            if (page < totalPages) navRow.addComponents(new ButtonBuilder().setCustomId(`tasks_page_${page + 1}`).setLabel('Next ➡️').setStyle(ButtonStyle.Secondary));
            
            if (navRow.components.length > 0) actionRows.push(navRow);

            await interaction.editReply({ embeds: [embed], components: actionRows });

        } catch (error) {
            console.error("Error in listtasks command:", error);
            await interaction.editReply("❌ An error occurred while retrieving your tasks.");
        } finally {
            if (conn) conn.release();
        }
    }
};