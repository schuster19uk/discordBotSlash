require('dotenv').config();
const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,      
        GatewayIntentBits.MessageContent,   
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction] // 🌟 FORCES DISCORD TO SEND HOLLOW DATA RATHER THAN DROPPING IT
});

client.commands = new Collection();

// --- 1. LOAD COMMANDS ---
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    // Set a new item in the Collection with the key as the command name
    client.commands.set(command.data.name, command);
}

// --- 2. LOAD EVENTS ---
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
}

// --- 3. EMBEDDED API FOR YOUR WEBSITE ---
const app = express();
const PORT = process.env.PORT || 3005; // Choose any open port

app.get('/api/user-by-username', async (req, res) => {
    const targetUsername = req.query.name;

    if (!targetUsername) {
        return res.status(400).json({ error: "Missing 'name' query parameter" });
    }

    // Force lowercase since Discord usernames are strictly lowercase under the hood
    const cleanUsername = targetUsername.toLowerCase().trim(); 
    
    // Replace with your actual Discord Server (Guild) ID
    const GUILD_ID = process.env.GUILD_ID; 
    const guild = client.guilds.cache.get(GUILD_ID);

    if (!guild) {
        return res.status(500).json({ error: "Bot is not in the specified server or guild ID is invalid." });
    }

    // A. Check the bot's local cache first for an exact username match
    let member = guild.members.cache.find(m => m.user.username === cleanUsername);

    // B. Fallback: If cache isn't ready or user is missing from cache, fetch fresh from Discord API
    if (!member) {
        try {
            const fetchedMembers = await guild.members.fetch({ query: cleanUsername, limit: 10 });
            member = fetchedMembers.find(m => m.user.username === cleanUsername);
        } catch (error) {
            console.error("Discord API fetch error:", error);
            return res.status(500).json({ error: "Failed to fetch data from Discord API" });
        }
    }

    if (member) {
        // Return exactly what your website needs to save the booking
        return res.json({ 
            id: member.user.id, 
            username: member.user.username,
            displayName: member.displayName 
        });
    } else {
        return res.status(404).json({ error: "No user found with that exact username in this server" });
        // return res.json({ 
        //     id: 0, 
        //     username: cleanUsername,
        //     displayName: "username not found in server" 
        // });
    }
});

// Start the API web server
app.listen(PORT, () => {
    console.log(`Website API portal listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);