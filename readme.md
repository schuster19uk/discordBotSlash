Run this to start the bot 

npx nodemon index.js

use 
!bookingAvailability to check availability


How to install on GCP

Let’s get your environment ready. Since we've already handled the networking, we'll now focus on the "inside" of your server.

Open the SSH terminal from your Google Cloud Console and follow these steps:

1. Update and Install Node.js
We’ll install Node.js 20 (the current Long Term Support version) to ensure all your modern JavaScript features work perfectly.

Bash
# Update the system's package list
sudo apt update && sudo apt upgrade -y

# Download and run the NodeSource setup script
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

# Install Node.js and the build tools
sudo apt install -y nodejs build-essential
2. Install and Setup MariaDB
This will be your "database elsewhere" (hosted on the VM).

Bash
# Install the MariaDB server
sudo apt install mariadb-server -y

# Install GIT
sudo apt update && sudo apt install git -y

# Run the security script (Important!)
sudo mysql_secure_installation
During the Security Script:

It will ask for a root password (set something strong and save it!).

Say Y (Yes) to: Remove anonymous users, disallow root login remotely, and remove the test database.

3. Create Your Bot's Database & Table
Now, let's log into MySQL to create your structure.

Bash
# sudo mariadb -u root -p
(Enter the password you just created). Once inside the MariaDB prompt, run these:

SQL
-- Create the database
CREATE DATABASE booking_system;

-- Create a specific user for your bot (Safer than using root)
CREATE USER 'bot_user'@'localhost' IDENTIFIED BY 'your_strong_password';
GRANT ALL PRIVILEGES ON booking_system.* TO 'bot_user'@'localhost';
FLUSH PRIVILEGES;

-- Switch to the database
USE booking_system;

-- Create the table (with start_time and end_time)
CREATE TABLE booking_slots (
    slot_id INT AUTO_INCREMENT PRIMARY KEY,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    booked_by_id VARCHAR(255) DEFAULT NULL,
    booked_by_name VARCHAR(255) DEFAULT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    reminder_sent BOOLEAN DEFAULT FALSE,
    uk_time_display VARCHAR(100)
    nevada_time_display VARCHAR(100)
);

EXIT;
4. Deploy Your Code
The easiest way is to use Git. If your repository is private, you may need to use a GitHub Personal Access Token.

Bash
# Clone your repo
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name

# Install your dependencies
npm install
5. Create Your .env File
This is critical. Since your .env shouldn't be on GitHub, you need to create it manually on the server.

Bash
nano .env
Paste your details (adjust as needed):

Code snippet
DISCORD_TOKEN=your_token_here
REQUIRED_ROLE_ID=your_role_id
BOOKING_CHANNEL_ID=your_channel_id
DB_HOST=localhost
DB_USER=bot_user
DB_PASSWORD=your_strong_password
DB_NAME=booking_system
(Press CTRL+O, Enter to save, and CTRL+X to exit).

6. Keep it Running (PM2)
If you run node index.js, the bot dies when you close the SSH window. PM2 keeps it alive.

Bash
# Install PM2 globally
sudo npm install pm2 -g

# Start your bot
pm2 start index.js --name "booking-bot"

# Set it to start automatically if the server reboots
pm2 startup
# (Copy and paste the command that PM2 generates in the terminal)
pm2 save



# After Install and setup

# The Standard Restart
If you just edited your .env file or fixed a small bug in your code, run:

# Bash
pm2 restart booking-bot
(Note: If you named your bot something else, use that name. If you forgot the name, type pm2 list to see it.)

2. The "Hard" Restart (Resetting Memory)
If the bot is acting glitchy or freezing, you can stop it completely and start it fresh:

# Bash
pm2 stop booking-bot
pm2 start booking-bot

# Restarting After a Code Update (git pull)
If you pushed new code from your home PC to GitHub and want to pull it onto the VM:

# Bash
git pull
npm install  # Only needed if you added new packages
pm2 restart booking-bot



pm2 start index.js --name "booking-bot-slash"
pm2 startup
pm2 save

pm2 restart booking-bot-slash

pm2 list
