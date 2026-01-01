import dotenv from 'dotenv';
dotenv.config();

import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('Redis connected'));
redis.on('error', err => console.error('Redis error', err));


import TelegramBot from 'node-telegram-bot-api';
import mongoose from 'mongoose';
import crypto from 'crypto';
import express from 'express';

//handle error
process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
});


const {
  PORT = 3000,
  RENDER_EXTERNAL_URL
} = process.env;

const {
  TELEGRAM_TOKEN,
  MONGODB_URI,
  ADMIN_IDS = '',
  DAILY_LIMIT = '10',
  RESULTS_PER_PAGE = '6'
} = process.env;

const app = express();
app.use(express.json());

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

//ejs
app.set('view engine', 'ejs');

//website landing page
app.get('/', (req, res) => {
  res.render('index', {
    botName: 'Movie Ark Bot',
    botUsername: 'Movie_ark_bot',
    supportChannel: 'dnafork_support',
    description: 'This Telegram bot lets you search, download, and manage Movies with daily limits, favorites, trending content, and more.'
  });
});

//listening port 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

//bot webhook
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${TELEGRAM_TOKEN}`);

//if token is not available
if (!TELEGRAM_TOKEN || !MONGODB_URI) {
  console.error('Missing TELEGRAM_TOKEN or MONGODB_URI in .env');
  process.exit(1);
}

const ADMIN_SET = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const DAILY_LIMIT_NUM = Number(DAILY_LIMIT) || 10;
const RESULTS_PER_PAGE_NUM = Number(RESULTS_PER_PAGE) || 6;

//Mongoose models
await mongoose.connect(MONGODB_URI, { dbName: 'TelegramMovies' });
const Schema = mongoose.Schema;

// Collection for files
const FileSchema = new Schema({
  customId: { type: String, unique: true }, // F0001...
  file_id: { type: String, required: true, unique: true }, // telegram file_id
  file_name: String,
  caption: String,
  type: String,
  keywords: [String],
  uploader_id: String,
  uploaded_at: { type: Date, default: Date.now },
  downloads: { type: Number, default: 0 }, // how many times sent
  searches: { type: Number, default: 0 } // aggregate search hits
});
FileSchema.index({ file_name: 'text', caption: 'text', keywords: 'text' });
const File = mongoose.model('File', FileSchema);

//solve index problem 
mongoose.connection.once('open', async () => {
  try {
    await File.collection.createIndex({
      file_name: 'text',
      caption: 'text',
      keywords: 'text'
    });
    console.log('✅ Text index ensured');
  } catch (err) {
    console.error('❌ Index creation failed:', err.message);
  }
});

// Sequence counter for customId
const CounterSchema = new Schema({
  _id: String,
  seq: Number
});
const Counter = mongoose.model('Counter', CounterSchema);

// Per-user daily limits
const LimitSchema = new Schema({
  userId: String,
  date: String, // YYYY-MM-DD
  count: { type: Number, default: 0 }
});
LimitSchema.index({ userId: 1, date: 1 }, { unique: true });
const Limit = mongoose.model('Limit', LimitSchema);

// Favorites
const FavoriteSchema = new Schema({
  userId: String,
  customId: String,
  savedAt: { type: Date, default: Date.now }
});
FavoriteSchema.index({ userId: 1, customId: 1 }, { unique: true });
const Favorite = mongoose.model('Favorite', FavoriteSchema);

// Pending admin uploads (confirmation)
const PendingSchema = new Schema({
  adminId: String,
  chatId: String,
  messageId: Number,
  file_id: String,
  file_name: String,
  caption: String,
  type: String,
  keywords: [String],
  created_at: { type: Date, default: Date.now }
});
const Pending = mongoose.model('Pending', PendingSchema);

// MongoDB Indexes
FileSchema.index({ downloads: -1 });
FileSchema.index({ uploaded_at: -1 });
FavoriteSchema.index({ userId: 1 });
PendingSchema.index({ created_at: 1 }, { expireAfterSeconds: 600 });


//Utility helpers
function autoDeleteMessage(bot, chatId, messageId, delayMs = 60000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
      //console.log(`🧹 Auto-deleted message ${messageId} in chat ${chatId}`);
    } catch (err) {
      // Ignore if already deleted
      if (!/message to delete not found/i.test(err.message)) {
        console.error('Auto-delete error:', err.message);
      }
    }
  }, delayMs);
}

function normalizeKeywords(arrOrString) {
  if (!arrOrString) return [];
  const arr = Array.isArray(arrOrString) ? arrOrString : String(arrOrString).split(/[\s,]+/);
  return arr.map(s => String(s).toLowerCase().trim().replace(/[.,;:!?(){}\[\]"']/g, '')).filter(Boolean);
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

async function nextSequence(name = 'file') {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).exec();
  const n = doc.seq || 1;
  return 'F' + String(n).padStart(4, '0');
}

async function incrementUserLimit(userId) {
  const today = todayString();
  // use updateOne + upsert then fetch to avoid value null issues
  await Limit.updateOne(
    { userId, date: today },
    { $inc: { count: 1 }, $setOnInsert: { userId, date: today } },
    { upsert: true }
  ).exec();
  const doc = await Limit.findOne({ userId, date: today }).lean().exec();
  return doc?.count || 0;
}

async function getUserLimitCount(userId) {
  const today = todayString();
  const doc = await Limit.findOne({ userId, date: today }).lean().exec();
  return doc?.count || 0;
}

// store per-user search results in memory maps
async function setUserSearchResults(userId, results, ttlSeconds = 300) {
  await redis.set(
    `search:${userId}`,
    JSON.stringify(results),
    'EX',
    ttlSeconds
  );
}

//Telegram bot
console.log('Bot started');

/* Set menu commands */
bot.setMyCommands([
  { command: '/start', description: 'Start the bot' },
  { command: '/help', description: 'How to use the bot' },
  { command: '/myaccount', description: 'Show your daily usage' },
  { command: '/recent', description: 'Show recent uploads' },
  { command: '/trending', description: 'Show trending files' },
  { command: '/favorites', description: 'Show your saved files' },

]).catch(e => console.warn('setMyCommands failed', e));


// start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from?.first_name || 'there';
  const startText = `👋 Hi *${name}*!

📁 *Welcome to the File Sharing Bot*

📌 You can search and download files by simply typing keywords.
The sent file will be automatically deleted after 1 minute.

━━━━━━━━━━━━━━━
🧑‍💻 *User Commands*:
/help — How to use this bot
/myaccount — View your daily usage limit
/recent — View recently uploaded files
/trending — View most downloaded files
/favorites — View your saved favorite files

💡 Just type words like \`war\` or \`movie\` to search files.

━━━━━━━━━━━━━━━
🛡 *Admin Commands*:
/delete FileID — Delete a file by its short ID
/update FileID kw1,kw2,... — Update keywords for a file
/stats — View top downloads
/broadcast message — Send message to all users

━━━━━━━━━━━━━━━`;


  // reply keyboard with short example buttons (values only)
  await bot.sendMessage(chatId, startText, {
    reply_markup: {
      keyboard: [
        [{ text: '/trending' }, { text: 'movie' }],
        [{ text: '/help' }, { text: '/myaccount' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

// help with a single inline "Try: war" button
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;

  const text = `📖 *How to Use This Bot*
  
  • Type keywords (like \`war\`) to search files
  • /myaccount → check your usage
  • /recent → view new uploads
  • /trending → view popular files`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔍 Try example: Avatar', callback_data: 'EX_SEARCH:avatar' }]
      ]
    }
  });
});


// admin-only /stats command
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_SET.has(String(msg.from.id))) return bot.sendMessage(chatId, 'Unauthorized');
  const totalFiles = await File.countDocuments().exec();
  const topDownloads = await File.find().sort({ downloads: -1 }).limit(5).lean().exec();
  const top = topDownloads.map(f => `${f.customId} (${f.downloads}) ${f.file_name}`).join('\n') || '—';
  await bot.sendMessage(chatId, `📊 Stats\nFiles: ${totalFiles}\nTop downloaded:\n${top}`);
});

// recent
bot.onText(/\/recent/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = await redis.get('recent');
  let recents;

  if (cached) {
    recents = JSON.parse(cached);
  } else {
    recents = await File.find().sort({ uploaded_at: -1 }).limit(10).lean().exec();
    await redis.set('recent', JSON.stringify(recents), 'EX', 60);
  }

  if (!recents.length) return bot.sendMessage(chatId, 'No uploads yet.');

  const keyboard = recents.map(f => [
    { text: `${f.file_name} (${f.customId})`, callback_data: `GET:${f.customId}` }
  ]);

  const recentList = await bot.sendMessage(chatId, '📥 Recent uploads:', {
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, chatId, recentList.message_id);

});


// trending (by downloads)
bot.onText(/\/trending/, async (msg) => {
  const chatId = msg.chat.id;
  const cached = await redis.get('trending');
  let top;

  if (cached) {
    top = JSON.parse(cached);
  } else {
    top = await File.find().sort({ downloads: -1 }).limit(10).lean().exec();
    await redis.set('trending', JSON.stringify(top), 'EX', 60);
  }

  if (!top.length) return bot.sendMessage(chatId, 'No trending data yet.');

  const keyboard = top.map(f => [
    { text: `${f.file_name} (${f.customId})`, callback_data: `GET:${f.customId}` }
  ]);

  const recentList = await bot.sendMessage(chatId, '🔥 Trending files:', {
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, chatId, recentList.message_id);

});

//User account
bot.onText(/\/myaccount/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const today = new Date().toISOString().slice(0, 10);

  try {
    const doc = await Limit.findOne({ userId, date: today }).lean().exec();
    let used = doc?.count || 0;

    // Ensure used can't go above the limit
    if (used > DAILY_LIMIT_NUM) {
      used = DAILY_LIMIT_NUM;
    }

    const remaining = Math.max(DAILY_LIMIT_NUM - used, 0);

    const text = `
  👤 *Your Account*
  
  📅 Date: ${today}
  ✅ Used: *${used}* files
  ⏳ Remaining: *${remaining}* files
  🎯 Daily Limit: *${DAILY_LIMIT_NUM}* files
  
  🔄 Limit resets at midnight.
  `;

    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('myaccount error', err);
    await bot.sendMessage(chatId, '❌ Failed to fetch account info.');
    // Try to send a message, but if it fails, don't crash the app.
    bot.sendMessage(chatId, '❌ Failed to fetch account info.').catch(err => {
      console.error('Failed to send the error message to user:', err.message);
    });
  }
});


//Handle admin upload: when admin sends a file, create a Pending and ask to confirm
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const fromId = String(msg.from.id);
    const text = msg.text?.trim();

    // ignore commands handled elsewhere
    if (text && text.startsWith('/')) return;

    // file detection
    const fileInfo = (() => {
      if (msg.document) return { type: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name || 'document' };
      if (msg.photo) { const p = msg.photo[msg.photo.length - 1]; return { type: 'photo', file_id: p.file_id, file_name: 'photo' }; }
      if (msg.video) return { type: 'video', file_id: msg.video.file_id, file_name: msg.video.file_name || 'video' };
      if (msg.audio) return { type: 'audio', file_id: msg.audio.file_id, file_name: msg.audio.file_name || 'audio' };
      if (msg.voice) return { type: 'voice', file_id: msg.voice.file_id, file_name: 'voice' };
      return null;
    })();

    // If non-admin tries to send file -> polite rejection
    if (fileInfo && !ADMIN_SET.has(fromId)) {
      await bot.sendMessage(chatId, '🙏 Thanks — but only admins may upload files here. You can search files by sending keywords.');
      return;
    }

    // If admin sent a file -> ask for confirmation
    if (fileInfo && ADMIN_SET.has(fromId)) {
      const caption = msg.caption || '';
      const keywords = normalizeKeywords(caption);
      const pending = new Pending({
        adminId: fromId,
        chatId: String(chatId),
        messageId: msg.message_id,
        file_id: fileInfo.file_id,
        file_name: fileInfo.file_name,
        caption,
        type: fileInfo.type,
        keywords
      });
      await pending.save();

      const kwText = keywords.length ? keywords.join(', ') : '(none)';
      const confirmText = `You uploaded: ${fileInfo.file_name}\nKeywords: ${kwText}\nConfirm upload?`;
      await bot.sendMessage(chatId, confirmText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm', callback_data: `PENDING_CONFIRM:${pending._id}` }],
            [{ text: '❌ Cancel', callback_data: `PENDING_CANCEL:${pending._id}` }]
          ]
        }
      });
      return;
    }

    // ---------- If message is plain text (user search) ----------
    if (text) {
      const userId = String(fromId);

      // check daily limit
      const used = await getUserLimitCount(userId);
      if (used >= DAILY_LIMIT_NUM) {
        await bot.sendMessage(chatId, `⚠️ You reached daily limit (${DAILY_LIMIT_NUM}).`);
        return;
      }

      // Provide immediate feedback
      const searchingMsg = await bot.sendMessage(chatId, `🔎 Searching for "${text}"...`);

      // Multi-word normalization
      const tokens = normalizeKeywords(text);
      if (!tokens.length) {
        await bot.editMessageText('Please enter a valid keyword.', { chat_id: chatId, message_id: searchingMsg.message_id });
        return;
      }

      if (/^F\d{4}$/i.test(text)) {
        const file = await File.findOne({ customId: text }).lean().exec();
        if (!file) return bot.sendMessage(chatId, '❌ File not found or removed.');
        const sent = await bot.sendDocument(chatId, file.file_id, {
          caption: `${file.file_name}\n\n⚠️ This file will be deleted in 1 minute.`
        });

        // auto delete after 1 minute
        autoDeleteMessage(bot, chatId, sent.message_id);

        return;

      }


      // Search: preferential exact keyword matches, then text search
      let results = [];
      // exact keyword match
      results = await File.find({ keywords: { $in: tokens } }).sort({ uploaded_at: -1 }).lean().exec();

      if (!results.length) {
        // text search
        results = await File.find({ $text: { $search: text } }).sort({ score: { $meta: 'textScore' }, uploaded_at: -1 }).lean().exec();
      }

      if (!results.length) {
        // regex fallback
        const regex = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        results = await File.find({ $or: [{ file_name: { $regex: regex } }, { caption: { $regex: regex } }] }).sort({ uploaded_at: -1 }).lean().exec();
      }

      if (!results.length) {
        await bot.editMessageText(`❌ No results found for "${text}".`, { chat_id: chatId, message_id: searchingMsg.message_id });
        return;
      }

      // increment search counter for matched files (soft)
      const bulkOps = results.slice(0, 30).map(r => ({ updateOne: { filter: { _id: r._id }, update: { $inc: { searches: 1 } } } }));
      if (bulkOps.length) await File.bulkWrite(bulkOps);

      // Pagination: show first page
      const total = results.length;
      const page = 0;
      const pageResults = results.slice(page * RESULTS_PER_PAGE_NUM, (page + 1) * RESULTS_PER_PAGE_NUM);

      // store results for callback (map by user)
      await setUserSearchResults(userId, results);

      // build keyboard: each button callback uses CUSTOM:customId or INDEX (index within stored results)
      const keyboard = pageResults.map((r, idx) => [{ text: `${r.file_name} (${r.customId})`, callback_data: `GET:${r.customId}` }]);

      // pagination controls
      const pages = Math.ceil(total / RESULTS_PER_PAGE_NUM);
      if (pages > 1) {
        const navRow = [];
        if (page > 0) navRow.push({ text: '◀ Prev', callback_data: `PAGE:${encodeURIComponent(text)}:${page - 1}` });
        if (page < pages - 1) navRow.push({ text: 'Next ▶', callback_data: `PAGE:${encodeURIComponent(text)}:${page + 1}` });
        keyboard.push(navRow);
      }

      await bot.editMessageText(`Found ${total} result(s) for "${text}" — showing ${page * RESULTS_PER_PAGE_NUM + 1}-${page * RESULTS_PER_PAGE_NUM + pageResults.length}.`, {
        chat_id: chatId,
        message_id: searchingMsg.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });

      // Delete user's original search query after 2 seconds
      autoDeleteMessage(bot, chatId, msg.message_id, 2000);

      // Auto-delete the search result list after 1 minute
      // lastListMessage[chatId] = searchingMsg.message_id;
      autoDeleteMessage(bot, chatId, searchingMsg.message_id);

      return;
    }

  } catch (err) {
    console.error('message handler error', err);
  }
});

async function isCooling(userId, seconds = 3) {
  const key = `cooldown:${userId}`;
  const exists = await redis.get(key);
  if (exists) return true;
  await redis.set(key, '1', 'EX', seconds);
  return false;
}

//Callback query handling
bot.on('callback_query', async (q) => {
  try {
    const data = String(q.data || '');
    const chatId = q.message.chat.id;
    const fromId = String(q.from.id);

    // Broadcast handle first 
    if (data.startsWith('BC_SEND:') || data.startsWith('BC_CANCEL:')) {
      const parts = data.split(':');
      const key = parts[1];
      const obj = await getBroadcast(key);
      if (!obj) {
        await bot.answerCallbackQuery(q.id, { text: 'Expired.' });
        return;
      }
      if (data.startsWith('BC_CANCEL:')) {
        await deleteBroadcast(key);
        await bot.editMessageText('Broadcast cancelled.', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => { });
        await bot.answerCallbackQuery(q.id, { text: 'Cancelled.' });
        return;
      }
      // send broadcast
      const text = obj.text;

      const users = await Limit.distinct('userId').exec();

      const DELAY_MS = 35; // safe for Telegram
      for (const u of users) {
        try {
          await bot.sendMessage(u, `📣 Broadcast:\n\n${text}`);
          await new Promise(res => setTimeout(res, DELAY_MS));
        } catch (e) {
          console.warn('send to', u, 'failed');
        }
      }

      await deleteBroadcast(key);
      await bot.editMessageText('Broadcast sent.', { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => { });
      await bot.answerCallbackQuery(q.id, { text: 'Broadcast sent.' });
      return;
    }

    // Pending confirm/cancel
    if (data.startsWith('PENDING_CONFIRM:') || data.startsWith('PENDING_CANCEL:')) {
      const parts = data.split(':');
      const id = parts[1];
      const pending = await Pending.findById(id).exec();
      if (!pending) {
        await bot.answerCallbackQuery(q.id, { text: 'Pending upload expired.' });
        return;
      }

      // Only uploader admin or any admin can confirm/cancel
      if (!ADMIN_SET.has(fromId) && pending.adminId !== fromId) {
        await bot.answerCallbackQuery(q.id, { text: 'Not authorized.' });
        return;
      }

      if (data.startsWith('PENDING_CANCEL:')) {
        await Pending.deleteOne({ _id: id }).exec();
        await bot.editMessageText('❌ Upload cancelled.', { chat_id: pending.chatId, message_id: q.message.message_id }).catch(() => { });
        await bot.answerCallbackQuery(q.id, { text: 'Cancelled.' });
        return;
      }

      // Confirm -> check duplicate Telegram file_id
      const exists = await File.findOne({ file_id: pending.file_id }).lean().exec();
      if (exists) {
        await Pending.deleteOne({ _id: id }).exec();
        await bot.editMessageText('⚠️ This file is already in the library.', { chat_id: pending.chatId, message_id: q.message.message_id }).catch(() => { });
        await bot.answerCallbackQuery(q.id, { text: 'Already exists.' });
        return;
      }

      // create a short customId
      const customId = await nextSequence('file');

      const f = new File({
        customId,
        file_id: pending.file_id,
        file_name: pending.file_name,
        caption: pending.caption,
        type: pending.type,
        keywords: pending.keywords,
        uploader_id: pending.adminId
      });
      await f.save();
      await Pending.deleteOne({ _id: id }).exec();

      await bot.editMessageText(`✅ Uploaded as ${customId}`, { chat_id: pending.chatId, message_id: q.message.message_id }).catch(() => { });
      await bot.answerCallbackQuery(q.id, { text: 'File saved.' });
      return;
    }

    if (data.startsWith('PAGE:')) {
      // PAGE:<encodedQuery>:<page>
      const parts = data.split(':');
      const term = decodeURIComponent(parts[1]);
      const page = Number(parts[2]) || 0;
      // re-run search for term and show page
      const results = await (async () => {
        const tokens = normalizeKeywords(term);
        let r = await File.find({ keywords: { $in: tokens } }).sort({ uploaded_at: -1 }).lean().exec();
        if (!r.length) r = await File.find({ $text: { $search: term } }).sort({ score: { $meta: 'textScore' }, uploaded_at: -1 }).lean().exec();
        if (!r.length) {
          const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          r = await File.find({ $or: [{ file_name: { $regex: regex } }, { caption: { $regex: regex } }] }).sort({ uploaded_at: -1 }).lean().exec();
        }
        return r;
      })();

      if (!results.length) {
        await bot.answerCallbackQuery(q.id, { text: 'No results.' });
        return;
      }

      await setUserSearchResults(fromId, results);
      const total = results.length;
      const pageResults = results.slice(page * RESULTS_PER_PAGE_NUM, (page + 1) * RESULTS_PER_PAGE_NUM);
      const keyboard = pageResults.map(r => [{ text: `${r.file_name} (${r.customId})`, callback_data: `GET:${r.customId}` }]);
      const pages = Math.ceil(total / RESULTS_PER_PAGE_NUM);
      if (pages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: '◀ Prev', callback_data: `PAGE:${encodeURIComponent(term)}:${page - 1}` });
        if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `PAGE:${encodeURIComponent(term)}:${page + 1}` });
        keyboard.push(nav);
      }

      await bot.editMessageText(`Found ${total} result(s) — showing ${page * RESULTS_PER_PAGE_NUM + 1}-${page * RESULTS_PER_PAGE_NUM + pageResults.length}.`, {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    //here new code 
    if (data.startsWith('EX_SEARCH:')) {
      const keyword = data.split(':')[1];

      await bot.answerCallbackQuery(q.id, { text: `Searching for "${keyword}"...` });

      // Simulate a search by calling your search logic
      const results = await File.find({
        $text: { $search: keyword }
      }).sort({ score: { $meta: 'textScore' }, uploaded_at: -1 }).limit(10).lean().exec();

      if (!results.length) {
        await bot.sendMessage(chatId, `❌ No results found for "${keyword}".`);
        return;
      }

      const keyboard = results.map(f => [
        { text: `${f.file_name} (${f.customId})`, callback_data: `GET:${f.customId}` }
      ]);

      const listMsg = await bot.sendMessage(chatId, `🔍 Results for "${keyword}":`, {
        reply_markup: { inline_keyboard: keyboard }
      });

      autoDeleteMessage(bot, chatId, listMsg.message_id);

      return;
    }


    if (data.startsWith('GET:')) {
      if (await isCooling(fromId)) {
        await bot.answerCallbackQuery(q.id, { text: '⏳ Slow down' });
        return;
      }

      const customId = data.split(':')[1];
      const userId = q.from.id;

      // ⛔ Check if user joined the channel
      try {
        const member = await bot.getChatMember(process.env.REQUIRED_CHANNEL, userId);
        if (
          member.status !== 'member' &&
          member.status !== 'administrator' &&
          member.status !== 'creator'
        ) {
          await bot.answerCallbackQuery(q.id, { text: 'Join the channel first!' });
          await bot.sendMessage(q.message.chat.id,
            `📢 Please join our channel to download files:\n\n👉 ${process.env.REQUIRED_CHANNEL}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ I've Joined", callback_data: `GET:${customId}` }]
                ]
              }
            }
          );
          return; // stop here
        }
      } catch (err) {
        console.error('getChatMember error', err.message);
        await bot.sendMessage(q.message.chat.id, '⚠️ Could not verify channel membership. Try again later.');
        return;
      }

      // ✅ if user is a member, continue sending file as before
      const fileDoc = await File.findOne({ customId }).lean().exec();
      if (!fileDoc) {
        await bot.answerCallbackQuery(q.id, { text: 'File not found.' });
        return;
      }

      // quota check
      const used = await getUserLimitCount(fromId);
      if (used >= DAILY_LIMIT_NUM) {
        await bot.answerCallbackQuery(q.id, { text: 'Daily limit reached' });
        return;
      }

      await incrementUserLimit(fromId);


      // increment download counter
      await File.updateOne({ _id: fileDoc._id }, { $inc: { downloads: 1 } }).exec();

      try {
        await bot.answerCallbackQuery(q.id, { text: 'Sending file...' });

        // ⬇️ send the actual file and capture the sent message
        let sent;
        const caption = `${fileDoc.file_name}\nID: ${fileDoc.customId}\n\n⚠️ This file will be deleted in 1 Minute.`;
        if (fileDoc.type === 'document')
          sent = await bot.sendDocument(q.message.chat.id, fileDoc.file_id, { caption });

        else if (fileDoc.type === 'video')
          sent = await bot.sendVideo(q.message.chat.id, fileDoc.file_id, {
            caption,
            reply_markup: { inline_keyboard: [[{ text: '⭐ Favorite', callback_data: `FAV:${fileDoc.customId}` }]] }
          });

        else if (fileDoc.type === 'audio')
          sent = await bot.sendAudio(q.message.chat.id, fileDoc.file_id, { caption });
        else if (fileDoc.type === 'photo')
          sent = await bot.sendPhoto(q.message.chat.id, fileDoc.file_id, { caption });
        else
          sent = await bot.sendMessage(q.message.chat.id, `File: ${fileDoc.file_name}\nID: ${fileDoc.customId}`);

        // ⭐ Favorite button
        // const favMsg = await bot.sendMessage(q.message.chat.id, `⭐ Save to favorites?`, {
        //   reply_markup: { inline_keyboard: [[{ text: '⭐ Favorite', callback_data: `FAV:${fileDoc.customId}` }]] }
        // });

        // ⏳ schedule deletion after 1 Minute
        setTimeout(async () => {
          try {
            await bot.deleteMessage(q.message.chat.id, sent.message_id);
            // await bot.deleteMessage(q.message.chat.id, favMsg.message_id);
            // console.log(`🗑 Deleted message ${sent.message_id} from chat ${q.message.chat.id}`);
          } catch (err) {
            console.error('Failed to delete file message:', err.message);
          }
        }, 1 * 60 * 1000); // 1 Minute

      } catch (err) {
        console.error('send file error', err);
        await bot.sendMessage(q.message.chat.id, 'Failed to send file. It might be invalid on Telegram.');
      }
      return;
    }


    // Favorite toggle
    if (data.startsWith('FAV:')) {
      const customId = data.split(':')[1];
      const fileDoc = await File.findOne({ customId }).lean().exec();
      if (!fileDoc) {
        await bot.answerCallbackQuery(q.id, { text: 'File not found.' });
        return;
      }
      const userId = fromId;
      const exists = await Favorite.findOne({ userId, customId }).lean().exec();
      if (exists) {
        await Favorite.deleteOne({ userId, customId }).exec();
        await bot.answerCallbackQuery(q.id, { text: 'Removed from favorites.' });
      } else {
        await Favorite.create({ userId, customId });
        await bot.answerCallbackQuery(q.id, { text: 'Added to favorites.' });
      }
      return;
    }

    // Example quick-search button on help
    if (data.startsWith('EX_SEARCH:')) {
      const term = data.split(':')[1];
      // simulate a user search by calling internal message flow: reuse code by sending a fake message
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(q.message.chat.id, term); // user will get search flow
      return;
    }

    await bot.answerCallbackQuery(q.id);

  } catch (err) {
    console.error('callback_query error', err);
    try { await bot.answerCallbackQuery(q.id, { text: 'Error processing action.' }); } catch { }
  }
});

//Admin commands: /delete and /update and /broadcast
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  if (!ADMIN_SET.has(userId)) return bot.sendMessage(chatId, 'Unauthorized.');
  const customId = match[1].trim();
  const res = await File.deleteOne({ customId }).exec();
  if (res.deletedCount > 0) await bot.sendMessage(chatId, `Deleted ${customId}`);
  else await bot.sendMessage(chatId, 'Not found.');
});

bot.onText(/\/update (.+?) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  if (!ADMIN_SET.has(userId)) return bot.sendMessage(chatId, 'Unauthorized.');
  const customId = match[1].trim();
  const kwRaw = match[2];
  const kws = normalizeKeywords(kwRaw);
  const res = await File.findOneAndUpdate({ customId }, { $set: { keywords: kws } }, { new: true }).lean().exec();
  if (res) await bot.sendMessage(chatId, `Updated ${customId} keywords: ${kws.join(', ')}`);
  else await bot.sendMessage(chatId, 'Not found.');
});

// broadcast with simple confirm flow
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  if (!ADMIN_SET.has(userId)) return bot.sendMessage(chatId, 'Unauthorized.');
  const text = match[1];
  // ask confirm
  const pendingKey = crypto.randomBytes(6).toString('hex');
  // store in memory simple map (one-off) or you can implement a DB pending. For brevity use map:

  await setBroadcast(pendingKey, { text, admin: userId });

  await bot.sendMessage(chatId, `Broadcast preview:\n\n${text}\n\nConfirm sending?`, {
    reply_markup: { inline_keyboard: [[{ text: '✅ Send', callback_data: `BC_SEND:${pendingKey}` }, { text: '❌ Cancel', callback_data: `BC_CANCEL:${pendingKey}` }]] }
  });
});

// broadcast
async function setBroadcast(key, value) {
  await redis.set(`broadcast:${key}`, JSON.stringify(value), 'EX', 300);
}

async function getBroadcast(key) {
  const raw = await redis.get(`broadcast:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function deleteBroadcast(key) {
  await redis.del(`broadcast:${key}`);
}

//Favorites listing
bot.onText(/\/favorites/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  const favs = await Favorite.find({ userId }).lean().exec();
  if (!favs.length) return bot.sendMessage(chatId, '⭐ You have no favorite files yet.');

  // Get the actual file info for these favorite customIds
  const ids = favs.map(f => f.customId);
  const files = await File.find({ customId: { $in: ids } }).lean().exec();
  if (!files.length) return bot.sendMessage(chatId, '⭐ No valid files found in your favorites.');

  const keyboard = files.map(f => [
    { text: `${f.file_name} (${f.customId})`, callback_data: `GET:${f.customId}` }
  ]);

  const recentList = await bot.sendMessage(chatId, '⭐ Your Favorite Files:', {
    reply_markup: { inline_keyboard: keyboard }
  });
  autoDeleteMessage(bot, chatId, recentList.message_id);

});

//Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try { await mongoose.disconnect(); } catch { }
  process.exit(0);
});
