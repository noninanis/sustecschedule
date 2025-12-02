import { Telegraf, session } from "telegraf";
import { waitUntil } from "@vercel/functions";
import db from './db.js';

const bot = new Telegraf(process.env.TELEGRAM_TOKEN_BOT);
bot.use( session({ defaultSession: () => ({}) }) );

const admins = ['6799105484','819536434'];

bot.command("get", async (ctx) => {
  const chat_id = ctx.message.chat.id;

  // Fire-and-forget вызов /api/get через waitUntil
  waitUntil(
    fetch(`https://api.burger.moe/get?chat_id=${chat_id}`,{headers: {'protection-secret': process.env.REQUEST_SECRET}})
      .then(res => res.json())
      .catch(err => console.error("Ошибка вызова /api/get:", err.message))
  );

  await ctx.reply("📤 Начинаю отправку расписания...");
});

bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status;
  const chat = ctx.myChatMember.chat;

  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (status === 'member' || status === 'administrator') {
      // Бот добавлен — сохраним группу (даже без сообщения!)
      await db.upsertGroup(ctx);
    }
    // Если нужно — можно удалять из groups при status === 'left', но обычно проще не удалять
  }
});

bot.command('sendto', async (ctx) => {
  if (!admins.includes(String(ctx.from.id))) return;

  const args = ctx.message.text.split(' ').slice(1);
  const userId = args[0];

  if (!userId || isNaN(userId)) {
    return await ctx.reply('UsageId: `/sendto <user_id>`', { parse_mode: 'Markdown' });
  }

  const user = await db.getUserById(Number(userId));

  if (!user) {
    return await ctx.reply(`❌ Пользователь с ID ${userId} не найден в базе.`);
  }

  const sendto_alert = await ctx.reply(
    `📬 Отправьте сообщение для пользователя:\n` +
    `ID: ${userId}\n` +
    `Имя: ${user.first_name || '—'} ${user.last_name ? user.last_name : ''}\n` +
    `${user.username ? `@${user.username}` : ''}\n\n` +
    `Бот будет ждать ваш ответ на ЭТО сообщение.`
  );
  // Сохраняем режим и целевого пользователя в сессии
  ctx.session.awaitingSendTo = {
    userId: Number(userId),
    username: user.username || user.first_name || 'неизвестно',
    message_id: sendto_alert.message_id,
    chat_id: sendto_alert.chat.id
  };

});

bot.command('broadcast', async (ctx) => {
  if (!admins.includes(String(ctx.from.id))) return;

  const broadcast_alert = await ctx.reply('📩 Отправьте сообщение, которое нужно разослать всем пользователям в ответ на ЭТО сообщение');

  // Устанавливаем флаг в сессии
  ctx.session.awaitingBroadcast = {
    message_id: broadcast_alert.message_id,
    chat_id: broadcast_alert.chat.id
  };

});

bot.start(async (ctx) => {
  await db.upsertUser(ctx);
  await ctx.reply(
    "👋 Используй команду `/get`, чтобы получить расписание всех групп.",
    { parse_mode: "Markdown" }
  )
});

bot.on('message', async (ctx, next) => {
  await db.upsertUser(ctx);
  
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    await db.upsertGroup(ctx);
  }
  return next();
});

// Middleware для обработки ответа на /sendto
bot.on(['text', 'photo', 'document', 'video', 'audio', 'voice', 'sticker', 'animation'], async (ctx) => {
  if (!admins.includes(String(ctx.from.id))) return;
  if (ctx.session?.awaitingSendTo){
          const { userId, username, message_id=null, chat_id=null } = ctx.session.awaitingSendTo;
          if (!message_id || !chat_id) return;
          if (ctx.chat.id !== chat_id ||ctx.message.reply_to_message?.message_id !== message_id) return;
          await ctx.reply('✍️ Начинаю отправку...');
          ctx.session.awaitingSendTo = null; // сбрасываем

          try {
            // Пересылаем любое сообщение "как есть"
            await ctx.telegram.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
            await ctx.reply(`✅ Сообщение успешно отправлено пользователю @${username} (ID: ${userId})`);
          } catch (e) {
            console.error(`Ошибка отправки пользователю ${userId}:`, e.message);
            await ctx.reply(`❌ Не удалось отправить сообщение пользователю @${username} (ID: ${userId})\nОшибка: ${e.message}`);
          }
  // Middleware для обработки рассылки
  }
  if(ctx.session?.awaitingBroadcast){
          const { message_id=null, chat_id=null } = ctx.session.awaitingBroadcast;
          if (!message_id || !chat_id) return;
          if (ctx.chat.id !== chat_id ||ctx.message.reply_to_message?.message_id !== message_id) return;
          await ctx.reply('🚀 Начинаю рассылку...');
          ctx.session.awaitingBroadcast = null; // сбрасываем

          const users = await db.getAllUsers();
          let success = 0;

          for (const user of users) {
            try {
              // Пересылаем любое сообщение "как есть"
              await ctx.telegram.copyMessage(user.id, ctx.chat.id, ctx.message.message_id);
              await ctx.reply(`✅ Сообщение успешно отправлено пользователю @${user.username} (ID: ${user.id})`);
              success++;
            } catch (e) {
              console.error(`Ошибка отправки пользователю ${user.id}:`, e.message);
              await ctx.reply(`❌ Не удалось отправить сообщение пользователю @${user.username} (ID: ${user.id})\nОшибка: ${e.message}`);
            }
            // Небольшая задержка, чтобы не спамить Telegram API
            await new Promise(r => setTimeout(r, 100));
          }
          await ctx.reply(`✅ Рассылка завершена: отправлено ${success} из ${users.length} пользователей.`);
  }
});

export default async function handler(req, res) {

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    await bot.handleUpdate(req.body);
    res.status(200).send("OK");
  } catch (err) {
    console.error("Ошибка webhook:", err);
    res.status(500).send("Internal Server Error");
  }
}
