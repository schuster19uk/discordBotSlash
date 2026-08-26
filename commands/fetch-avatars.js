const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const archiverModule = require('archiver');
const archiver = archiverModule.default || archiverModule;

const OUTPUT_ROOT = path.join(__dirname, '..', 'avatars');

function safeFolderName(name) {
    const cleaned = name
        .replace(/[<>:"/\\|?*]/g, '_')
        .trim()
        .replace(/\.+$/, '');
    return cleaned || 'unknown';
}

function parseUsernames(text) {
    return new Set(
        text
            .split(/\r?\n/)
            .map((line) => line.trim().toLowerCase())
            // Strip trailing " - Displayed ..." notes and leading "@" that
            // sometimes creep into pasted lists, keeping just the handle.
            .map((line) => line.replace(/^@/, '').split(/\s+-\s+/)[0])
            .filter(Boolean)
    );
}

async function zipDirectory(sourceDir, outPath) {
    await new Promise((resolve, reject) => {
        const output = createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('fetch-avatars')
        .setDescription('Download avatars for a list of usernames (for video credits, etc.)')
        .addAttachmentOption((option) =>
            option
                .setName('list')
                .setDescription('A .txt file with one username per line')
                .setRequired(true)
        ),
    async execute(interaction) {
        if (!interaction.member.permissions.has('Administrator')) {
            return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const attachment = interaction.options.getAttachment('list', true);
            if (!attachment.name.endsWith('.txt')) {
                return interaction.editReply('❌ Please attach a .txt file, one username per line.');
            }

            const fileResponse = await fetch(attachment.url);
            if (!fileResponse.ok) {
                return interaction.editReply('❌ Could not download the attached file.');
            }
            const text = await fileResponse.text();
            const usernames = parseUsernames(text);

            if (usernames.size === 0) {
                return interaction.editReply('❌ That file did not contain any usernames.');
            }

            const guild = interaction.guild;
            if (!guild) {
                return interaction.editReply('❌ This command must be run inside a server.');
            }

            const members = await guild.members.fetch();

            const runDir = path.join(OUTPUT_ROOT, `run-${Date.now()}`);
            await fs.mkdir(runDir, { recursive: true });

            const found = new Set();
            const downloadFailures = []; // { username, id, status }

            for (const member of members.values()) {
                const username = member.user.username.toLowerCase();
                if (!usernames.has(username)) continue;

                found.add(username);

                const avatarUrl = member.displayAvatarURL({ extension: 'png', size: 256 });
                const folder = path.join(runDir, safeFolderName(member.user.username));
                await fs.mkdir(folder, { recursive: true });

                let avatarResponse;
                try {
                    avatarResponse = await fetch(avatarUrl);
                } catch (fetchErr) {
                    downloadFailures.push({
                        username: member.user.username,
                        id: member.id,
                        status: `network error: ${fetchErr.message}`,
                    });
                    continue;
                }

                if (!avatarResponse.ok) {
                    downloadFailures.push({
                        username: member.user.username,
                        id: member.id,
                        status: avatarResponse.status,
                    });
                    console.error(`Failed to download ${member.user.username}: ${avatarResponse.status}`);
                    continue;
                }
                const image = Buffer.from(await avatarResponse.arrayBuffer());
                const outputFile = path.join(folder, `${member.id}.png`);
                await fs.writeFile(outputFile, image);
            }

            const missing = [...usernames].filter((u) => !found.has(u));

            // Write a log file of anyone whose avatar failed to download so
            // it travels along with the zip instead of only living in console output.
            if (downloadFailures.length > 0) {
                const logLines = downloadFailures.map(
                    (f) => `${f.username} (id: ${f.id}) - ${f.status}`
                );
                await fs.writeFile(
                    path.join(runDir, 'failed-downloads.txt'),
                    logLines.join('\n'),
                    'utf8'
                );
            }

            const zipPath = path.join(OUTPUT_ROOT, `avatars-${Date.now()}.zip`);
            await zipDirectory(runDir, zipPath);

            const summaryLines = [
                `✅ Found and downloaded avatars for **${found.size}/${usernames.size}** users.`,
            ];
            if (missing.length > 0) {
                summaryLines.push('', '**Not found in this server:**', missing.map((u) => `- ${u}`).join('\n'));
            }
            if (downloadFailures.length > 0) {
                summaryLines.push(
                    '',
                    `**Avatar download failed for ${downloadFailures.length} user(s)** (included in zip as failed-downloads.txt):`,
                    downloadFailures.map((f) => `- ${f.username} — ${f.status}`).join('\n')
                );
            }

            const zipStats = await fs.stat(zipPath);
            const files = [];
            if (zipStats.size < 8 * 1024 * 1024) {
                files.push(new AttachmentBuilder(zipPath, { name: 'avatars.zip' }));
            } else {
                summaryLines.push('', '(Zip too large to attach — check the `avatars/` folder on disk.)');
            }

            await interaction.editReply({
                content: summaryLines.join('\n'),
                files,
            });
        } catch (err) {
            console.error(err);
            interaction.editReply('❌ Error fetching avatars.');
        }
    }
};