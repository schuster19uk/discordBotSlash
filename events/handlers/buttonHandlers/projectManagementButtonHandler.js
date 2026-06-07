const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const pool = require("../../../database/pool"); // Adjust path if necessary

module.exports = async (interaction, client) => {
    const { customId } = interaction;

    try {
        // ==========================================
        // FLOW A: User selected a project -> Show Form Modal
        // ==========================================
        if (interaction.isStringSelectMenu() && customId === 'project_select_for_task') {
            const selectedProjectId = interaction.values[0];

            // Setup container (Passing project ID through customId state)
            const modal = new ModalBuilder()
                .setCustomId(`task_modal_submit_${selectedProjectId}`)
                .setTitle('Create New Project Task');

            const titleInput = new TextInputBuilder()
                .setCustomId('task_title')
                .setLabel("Task Title")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("e.g., Fix database connection leak")
                .setRequired(true)
                .setMaxLength(255);

            const descInput = new TextInputBuilder()
                .setCustomId('task_description')
                .setLabel("Task Description")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Provide detailed requirements or instructions...")
                .setRequired(false);

            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(descInput)
            );

            // Open the form. Note: NO interaction.deferUpdate() used prior to showModal!
            await interaction.showModal(modal);
            return;
        }

        // ==========================================
        // FLOW B: User submitted the Modal -> Write to Database
        // ==========================================
        if (interaction.isModalSubmit() && customId.startsWith('task_modal_submit_')) {
            // Acknowledge the modal submission privately
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const projectId = parseInt(customId.split('_').pop());
            const title = interaction.fields.getTextInputValue('task_title');
            const description = interaction.fields.getTextInputValue('task_description') || null;

            let conn;
            try {
                conn = await pool.getConnection();

                const projectName = await conn.query(`SELECT project_name FROM projects WHERE project_id = ?`, [projectId]);


                // 1. Resolve internal member ID via matching discord ID profile
                const [rows] = await conn.query(
                    `SELECT member_id FROM project_members WHERE discord_id = ? AND is_active = TRUE`,
                    [interaction.user.id]
                );


                const member = (Array.isArray(rows) && rows.length > 0) ? rows[0] : (rows && !Array.isArray(rows) ? rows : null);

                if (!member || !member.member_id) {
                    return await interaction.editReply({
                        content: "❌ **Error:** You are not registered as an active project team member in the system database."
                    });
                }

                // 2. Insert into task tables using default presets configured in schema layout
                await conn.query(
                    `INSERT INTO project_tasks (project_id, title, description, assignee_id) 
                     VALUES (?, ?, ?, ?)`,
                    [projectId, title, description, member.member_id]
                );

                // --- 🌟 THE FIX: AUTO-DISMISS THE OLD DROPDOWN MESSAGE VIA WEBHOOK 🌟 ---
                if (interaction.message) {
                    try {
                        // This instructs Discord to instantly wipe the old ephemeral dropdown message off the user's screen
                        await interaction.webhook.deleteMessage(interaction.message.id);
                    } catch (msgErr) {
                        // Log a silent warning if Discord has already closed the interaction token channel
                        console.warn("Could not auto-dismiss the original dropdown message:", msgErr.message);
                    }
                }

                // Send the fresh task creation success confirmation
                await interaction.editReply({
                    content: `✅ **Task Created Successfully!**\n **Project:** ${projectName[0].project_name}\n **Title:** ${title}\n **Description:** ${description || 'No description provided.'}`
                });

            } catch (dbError) {
                console.error('Database insertion error:', dbError);
                await interaction.editReply({ content: `❌ **Database Query Error:** ${dbError.message}` });
            } finally {
                if (conn) conn.release();
            }
            return;
        }


        // ==========================================
        // FLOW C: User selected a task from completion dropdown menu
        // ==========================================
        if (interaction.isStringSelectMenu() && customId.startsWith('project_task_complete_menu_')) {
            await interaction.deferUpdate();

            // Extract page tracking context state safely from string array payload
            const currentPage = parseInt(customId.split('_').pop()) || 1;
            const taskId = parseInt(interaction.values[0]);
            let conn;

            try {
                conn = await pool.getConnection();

                // Update database: Mark status_id = 4 (Done) and configure soft-delete flag
                await conn.query(
                    `UPDATE project_tasks 
                     SET status_id = 4, is_deleted = TRUE 
                     WHERE task_id = ?`,
                    [taskId]
                );

                // Auto refresh view panel preserving correct page memory coordinates
                const listCommand = client.commands.get('listtasks');
                if (listCommand) {
                    interaction.customPage = currentPage; // Injecting custom state variable memory
                    return await listCommand.execute(interaction);
                } else {
                    return await interaction.followUp({
                        content: "✅ Task marked as done successfully!",
                        flags: [MessageFlags.Ephemeral]
                    });
                }

            } catch (dbError) {
                console.error('Database update error during dropdown task closure:', dbError);
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: `❌ **Database Error:** ${dbError.message}`, flags: [MessageFlags.Ephemeral] });
                }
            } finally {
                if (conn) conn.release();
            }
            return;
        }

    } catch (error) {
        console.error('Project Management Button Error:', error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content: `❌ **Error:** ${error.message}`,
                components: []
            });
        } else {
            await interaction.reply({
                content: `❌ **Error:** ${error.message}`,
                flags: [MessageFlags.Ephemeral]
            });
        }
    }
};