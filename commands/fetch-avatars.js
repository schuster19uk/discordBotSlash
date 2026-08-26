const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const archiverModule = require('archiver');
const ZipArchive = archiverModule.ZipArchive;

const OUTPUT_ROOT = path.join(__dirname, '..', 'avatars');

function safeFolderName(name) {
    const cleaned = name
        .replace(/[<>:"/\\|?*]/g, '_')
        .trim()
        .replace(/\.+$/, '');
    return cleaned || 'unknown';
}

// Normalize whitespace: collapse tabs/non-breaking spaces/multiple spaces
// down to single regular spaces, then trim the ends.
function normalizeWhitespace(str) {
    return str
        .replace(/[\u00A0\u2000-\u200B\u202F\uFEFF]/g, ' ') // NBSP & other unicode spaces
        .replace(/\s+/g, ' ')
        .trim();
}

// Strips ALL whitespace, used as a fallback match key so a username that
// picked up a stray internal space (e.g. from copy-paste) can still match.
function stripAllSpaces(str) {
    return str.replace(/\s+/g, '');
}

function parseUsernames(text) {
    const raw = text
        .split(/\r?\n/)
        .map((line) => normalizeWhitespace(line).toLowerCase())
        // Strip trailing " - Displayed ..." notes and leading "@" that
        // sometimes creep into pasted lists, keeping just the handle.
        .map((line) => line.replace(/^@/, '').split(/\s+-\s+/)[0])
        .map((line) => normalizeWhitespace(line))
        .filter(Boolean);

    const usernames = new Set(raw);

    // Fallback lookup: strip ALL spaces so a username that picked up a
    // stray internal space (e.g. "che msed" instead of "chemsed") can
    // still be matched. Maps stripped-form -> original list entries.
    const noSpaceToOriginal = new Map();
    for (const entry of raw) {
        const stripped = stripAllSpaces(entry);
        if (!noSpaceToOriginal.has(stripped)) {
            noSpaceToOriginal.set(stripped, []);
        }
        noSpaceToOriginal.get(stripped).push(entry);
    }

    return { usernames, noSpaceToOriginal };
}

async function zipDirectory(sourceDir, outPath) {
    await new Promise((resolve, reject) => {
        const output = createWriteStream(outPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });
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
            const { usernames, noSpaceToOriginal } = parseUsernames(text);

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
                const username = normalizeWhitespace(member.user.username).toLowerCase();
                const displayName = normalizeWhitespace(member.displayName).toLowerCase();

                let matchedEntries = [];

                if (usernames.has(username)) {
                    matchedEntries = [username];
                } else if (usernames.has(displayName)) {
                    matchedEntries = [displayName];
                } else {
                    // Fallback: match ignoring internal spaces, in case the
                    // list had a stray space inside the name, tried against
                    // both username and display name.
                    const strippedUsername = stripAllSpaces(username);
                    const strippedDisplay = stripAllSpaces(displayName);
                    if (noSpaceToOriginal.has(strippedUsername)) {
                        matchedEntries = noSpaceToOriginal.get(strippedUsername);
                    } else if (noSpaceToOriginal.has(strippedDisplay)) {
                        matchedEntries = noSpaceToOriginal.get(strippedDisplay);
                    }
                }

                if (matchedEntries.length === 0) continue;
                for (const entry of matchedEntries) {
                    found.add(entry);
                }

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