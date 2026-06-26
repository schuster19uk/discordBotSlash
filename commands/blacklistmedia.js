// commands/blacklistmedia.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const imghash = require('imghash');
const axios = require('axios');
const pool = require('../database/pool');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('blacklistmedia')
        .setDescription('Hashes an image and manually blacklists it across the system.')
        .addAttachmentOption(option => 
            option.setName('image')
                .setDescription('The image file to permanently blacklist')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        
        const attachment = interaction.options.getAttachment('image');
        if (!/\.(jpg|jpeg|png|webp)$/i.test(attachment.name)) {
            return await interaction.editReply('❌ Provided file is not an eligible static image format.');
        }

        let conn;
        try {
            const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(response.data);
            const generatedHash = await imghash.hash(imageBuffer, 8, 'hex');

            conn = await pool.getConnection();
            
            // Explicitly logged as a MANUAL entry
            await conn.query(
                `INSERT INTO blacklisted_media 
                (image_hash, added_by_type, spammer_username, spammer_id) 
                VALUES (?, 'MANUAL', NULL, NULL)`,
                [generatedHash]
            );

            await interaction.editReply(`✅ Successfully blacklisted image signature: \`${generatedHash}\``);
        } catch (error) {
            console.error(error);
            await interaction.editReply('❌ Encountered an error hashing or uploading signature payload.');
        } finally {
            if (conn) conn.release();
        }
    }
};