📁 Telegram File Sharing Bot

A powerful Telegram bot built with Node.js, MongoDB, and Redis that allows users to search, download, and manage files with daily limits, favorites, trending content, and admin controls.

This bot is optimized to handle 50k+ users.

✨ Features
👤 User Features
🔍 Search files using keywords
📥 Download files (auto-deleted after 1 minute)
⭐ Save files to favorites
📊 View daily usage limit
🔥 Trending & recent files
⚡ Inline search support
🛡 Admin Features
📤 Upload files (with confirmation)
🗑  Delete files by ID
✏️ Update file keywords
📢 Broadcast messages to all users (rate-limited & safe)
📈 View download statistics


🧰 Tech Stack
Node.js
node-telegram-bot-api
MongoDB Atlas
Redis (Upstash / Render Redis)
Express
Mongoose


🚀 Getting Started
1️⃣ Clone the repository
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name

2️⃣ Install dependencies
npm install

3️⃣ Setup environment variables
Copy .env.example to .env
cp .env.example .env
Fill in all required values in .env

4️⃣ Run the bot locally
node bot.js


🌐 Deployment (Render)
Create a Web Service on Render
Add all .env variables in Render Dashboard
Set start command:
node bot.js


📌 Notes
Files sent by the bot are automatically deleted after 1 minute
Redis is required for scalability (cooldowns, caching, broadcasts)
MongoDB Atlas free tier works well for moderate traffic


📄 License
MIT License
You are free to use, modify, and distribute this project.


🤝 Contribution
Pull requests are welcome.
If you find a bug or want a feature, open an issue.


❤️ Credits
Built with ❤️ by Aman