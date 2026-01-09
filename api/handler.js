// handler.js
import { Telegraf, session } from "telegraf";
import { checkRateLimit, isBanned } from './rate-limit.js';
import { getStatusRedis, isAdmin, addAdmin, removeAdmin } from './admin.js';
import db from './db.js';
import { parseUserInput, findUser, formatUserInfo, logAdminAction, getAdminLogs } from './tools.js';

const bot = new Telegraf(process.env.TELEGRAM_TOKEN_BOT);
bot.use( session({ defaultSession: () => ({}) }) );

// rate-limit проверка
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next(); // Если нет юзера, пропускаем
  
  // Проверяем бан
  if (await isBanned(userId)) {
    console.log(`${userId} забанен`);
    // Можно не отвечать, просто игнорируем
    return; // Прерываем обработку
  }
  
  // Проверяем rate limit //

  // Определяем тип действия
  let action = 'message';
  if (ctx.updateType === 'callback_query') action = 'callback';
  if (ctx.message?.entities?.[0]?.type === 'bot_command') action = 'command';
  
  const limitResult = await checkRateLimit(userId, action);
  
  if (!limitResult.ok) {
    console.log(`Rate limit для ${userId}: ${limitResult.current}/${limitResult.limit}`);
    
    // Отвечаем только в личке
    if (ctx.chat?.type === 'private') {
      try {
        await ctx.reply(`⚠️ ${limitResult.message}`);
      } catch (e) {
        // Игнорируем ошибку отправки
      }
    }
    
    return; // Не обрабатываем дальше
  }
  // добавляем инфу в контекст
  ctx.rateLimit = {
    ok: true,
    remaining: limitResult.remaining,
    current: limitResult.current
  };
  
  await next();
});

// Статистика админов
bot.command('admin_stats', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  try {
    // Получаем всех админов из Redis
    const adminIds = await getAdmins();
    
    // Статистика из БД
    const dbStats = await db.adminStats();

    const stats = dbStats[0];
    
    // Формируем сообщение
    const message = `
📊 *Статистика системы:*

👥 Пользователей всего: ${stats.total_users || 0}
👑 Админов: ${stats.total_admins || 0}
🚫 Забанено: ${stats.total_banned || 0}

🔄 Админов в Redis: ${adminIds.length}
💾 Админов в кеше: ${getAdminCount()}

🕐 Время сервера: ${new Date().toLocaleString('ru-RU')}
✅ Redis: ${await getStatusRedis() ? 'подключен' : 'ошибка'}
    `.trim();
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Admin stats error:', error);
    await ctx.reply('❌ Ошибка получения статистики');
  }
});

// Показать всех админов
bot.command('admin_list', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  try {
    const adminIds = await getAdmins();
    
    if (adminIds.length === 0) {
      return ctx.reply('📭 Список админов пуст');
    }
    
    // Получаем информацию о админах из БД
    const adminsInfo = await db.getAdminInfo(adminIds.map(id => parseInt(id)));
    
    let message = '👑 *Список админов:*\n\n';
    
    adminsInfo.forEach((admin, index) => {
      const date = new Date(admin.created_at).toLocaleDateString('ru-RU');
      const name = admin.first_name || 'Без имени';
      const username = admin.username ? `@${admin.username}` : 'нет username';
      
      message += `${index + 1}. ${name} (${username})\n`;
      message += `   ID: ${admin.id}\n`;
      message += `   Добавлен: ${date}\n\n`;
    });
    
    message += `Всего: ${adminsInfo.length} админов`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('Admin list error:', error);
    await ctx.reply('❌ Ошибка получения списка');
  }
});

// Добавление админа
bot.command('admin_add', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  const targetId = args[0];
  
  // Проверка аргумента
  if (!targetId) {
    return ctx.reply('❌ Укажи ID пользователя\n\nИспользование: /admin_add <user_id>');
  }
  
  if (!/^\d+$/.test(targetId)) {
    return ctx.reply('❌ ID должен быть числом');
  }
  
  // Проверяем, не админ ли уже
  if (await isAdmin(targetId)) {
    return ctx.reply('⚠️ Этот пользователь уже админ');
  }
  
  try {
    // Проверяем, существует ли пользователь в БД
    const userCheck = await db.getUserById(targetId);
    
    if (userCheck.length === 0) {
      return ctx.reply('❌ Пользователь не найден в базе данных');
    }
    
    const user = userCheck[0];
    
    // 1. Добавляем в PostgreSQL
    await db.setAdminById(true,targetId);
    
    // 2. Добавляем в Redis
    await addAdmin(targetId);
    
    const userName = user.first_name || user.username || targetId;
    
    await ctx.reply(
      `✅ *Пользователь добавлен в админы*\n\n` +
      `👤 Имя: ${userName}\n` +
      `🆔 ID: ${targetId}\n` +
      `📱 Username: ${user.username ? '@' + user.username : 'не указан'}\n` +
      `🕐 Время: ${new Date().toLocaleString('ru-RU')}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Add admin error:', error);
    await ctx.reply('❌ Ошибка добавления админа');
  }
});

// Удаление админа
bot.command('admin_remove', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  const targetId = args[0];
  
  // Проверка аргумента
  if (!targetId) {
    return ctx.reply('❌ Укажи ID пользователя\n\nИспользование: /admin_remove <user_id>');
  }
  
  if (!/^\d+$/.test(targetId)) {
    return ctx.reply('❌ ID должен быть числом');
  }
  
  // Проверяем, админ ли вообще
  if (!await isAdmin(targetId)) {
    return ctx.reply('⚠️ Этот пользователь и так не админ');
  }
  
  // Не даем удалить себя
  if (targetId === ctx.from.id.toString()) {
    return ctx.reply('❌ Нельзя удалить самого себя!');
  }
  
  try {
    // Получаем информацию о пользователе
    const userInfo = await db.getUserById(targetId);
    
    const user = userInfo[0] || {};
    const userName = user.first_name || user.username || targetId;
    
    // 1. Удаляем из PostgreSQL
    await db.setAdminById(false,targetId);
    
    // 2. Удаляем из Redis
    await removeAdmin(targetId);
    
    await ctx.reply(
      `⛔ *Пользователь удален из админов*\n\n` +
      `👤 Имя: ${userName}\n` +
      `🆔 ID: ${targetId}\n` +
      `🕐 Время: ${new Date().toLocaleString('ru-RU')}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Remove admin error:', error);
    await ctx.reply('❌ Ошибка удаления админа');
  }
});

// Справка по админ-командам
bot.command('admin_help', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  const helpMessage = `
🛠️ *Админ-команды:*

📊 /admin_stats — статистика системы
📋 /admin_list — список всех админов
👑 /admin_add <id> — добавить админа
⛔ /admin_remove <id> — удалить админа
❓ /admin_help — эта справка

⚠️ *Внимание:*
• ID должен быть числом
• Нельзя удалить самого себя
• Все изменения логируются
• Redis кеш обновляется сразу

📝 *Примеры:*
\`/admin_add 123456789\`
\`/admin_remove 987654321\`
  `.trim();
  
  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

bot.command("get", async (ctx) => {
  const chat_id = ctx.message.chat.id;
  
  await ctx.reply("📤 Начинаю отправку расписания...");
  
  try {
    await fetch(
      `https://${process.env.WEBHOOK_URL}/get?chat_id=${chat_id}`,
      {
        headers: {'protection-secret': process.env.REQUEST_SECRET},
        signal: AbortSignal.timeout(8000) // Таймаут 8 секунд
      }
    );
    
  } catch (err) {
    console.error("Ошибка:", err.message);
  }
});

bot.on('my_chat_member', async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status;
  const chat = ctx.myChatMember.chat;

  if (chat.type === 'group' || chat.type === 'supergroup') {
    if (status === 'member' || status === 'administrator') {
      // Бот добавлен — сохраним группу (даже без сообщения)
      await db.upsertGroup(ctx);
    }
  }
});

bot.command('sendto', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ Нет доступа');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  const userInput = args[0];
  
  // Проверка аргумента
  if (!userInput) {
    return ctx.reply(
      '❌ Укажите ID или username пользователя\n\n' +
      '📝 *Примеры:*\n' +
      '`/sendto 123456789` — по ID\n' +
      '`/sendto @username` — по username с @\n' +
      '`/sendto username` — по username без @\n\n' +
      'ℹ️ Можно использовать как ID, так и username',
      { parse_mode: 'Markdown' }
    );
  }
  
  // Парсим ввод
  const parsed = parseUserInput(userInput);
  
  if (!parsed) {
    return ctx.reply('❌ Неверный формат. Используйте ID или username');
  }
  
  // Ищем пользователя
  const user = await findUser(userInput);
  
  if (!user) {
    // Даем подсказку что не найдено
    if (parsed.type === 'id') {
      return ctx.reply(`❌ Пользователь с ID \`${parsed.value}\` не найден`, {
        parse_mode: 'Markdown'
      });
    } else {
      return ctx.reply(
        `❌ Пользователь @${parsed.value} не найден\n\n` +
        'ℹ️ *Возможные причины:*\n' +
        '• Пользователь не запускал бота\n' +
        '• Username изменился\n' +
        '• Ошибка в написании\n\n' +
        'Попробуйте использовать ID пользователя',
        { parse_mode: 'Markdown' }
      );
    }
  }
  
  // Проверяем, не пытаемся ли отправить себе
  if (user.id === ctx.from.id) {
    return ctx.reply('🤔 Нельзя отправлять сообщения самому себе');
  }
  
  // Формируем сообщение с информацией о пользователе
  const userInfo = formatUserInfo(user);
  
  const confirmation = await ctx.reply(
    `📬 *Выбран получатель:*\n\n` +
    `${userInfo}\n\n` +
    `📝 *Отправьте сообщение для этого пользователя*\n\n` +
    `ℹ️ Бот будет ждать ваш ответ на это сообщение`,
    { parse_mode: 'Markdown' }
  );
  
  // Сохраняем в сессии
  ctx.session.awaitingSendTo = {
    userId: user.id,
    username: user.username || user.first_name || 'пользователь',
    messageId: confirmation.message_id,
    chatId: confirmation.chat.id,
    timestamp: Date.now()
  };
  
  // Добавляем кнопку отмены (опционально)
  try {
    await ctx.reply(
      '❌ Чтобы отменить отправку, используйте /cancel',
      { reply_to_message_id: confirmation.message_id }
    );
  } catch (error) {
    // Игнорируем ошибку если не можем ответить
  }
});

bot.command('cancel', async (ctx) => {
  if (ctx.session?.awaitingSendTo) {
    delete ctx.session.awaitingSendTo;
    await ctx.reply('✅ Отправка отменена');
  } else {
    await ctx.reply('ℹ️ Нет активной отправки для отмены');
  }
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const broadcast_alert = await ctx.reply('📩 Отправьте сообщение, которое нужно разослать всем пользователям в ответ на ЭТО сообщение');

  // Устанавливаем флаг в сессии
  ctx.session.awaitingBroadcast = {
    message_id: broadcast_alert.message_id,
    chat_id: broadcast_alert.chat.id
  };
});

bot.command('subscribe', async (ctx) => {
  try {
    // Получаем новый статус после переключения
    const newStatus = await db.toggleSubscription(ctx);
    
    if (newStatus === null || newStatus === undefined) {
      return ctx.reply('❌ Не удалось обновить статус подписки. Попробуйте позже.');
    }
    
    const message = newStatus 
      ? '✅ Вы успешно подписались на обновления!'
      : '🔇 Вы отписались от обновлений.';
    
    await ctx.reply(message);
  } catch (error) {
    console.error('Subscribe command error:', error);
    await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
  }
});

bot.command('admin_logs', async (ctx) => {
  if (!await isAdmin(ctx.from.id)) return;
  
  const logs = await getAdminLogs(20);
  
  if (logs.length === 0) {
    return ctx.reply('📭 Логи действий пусты');
  }
  
  let message = '📝 *Последние действия админов:*\n\n';
  
  logs.forEach((log, index) => {
    const date = new Date(log.timestamp).toLocaleString('ru-RU');
    const admin = log.adminFirstName || log.adminId;
    
    message += `${index + 1}. ${date}\n`;
    message += `   👤 ${admin} (${log.action})\n`;
    
    if (log.data?.targetUsername) {
      message += `   👥 Кому: @${log.data.targetUsername}\n`;
    }
    
    message += '\n';
  });
  
  // Если сообщение слишком длинное, разбиваем
  if (message.length > 4000) {
    message = message.substring(0, 4000) + '...\n(логи обрезаны)';
  }
  
  await ctx.reply(message, { parse_mode: 'Markdown' });
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

bot.on(['text', 'photo', 'document', 'video', 'audio', 'voice', 'sticker', 'animation'], async (ctx) => {
  // Проверка админа
  if (!await isAdmin(ctx.from.id)) return;
  
  // ===== ОТПРАВКА ОДНОМУ ПОЛЬЗОВАТЕЛЮ =====
  if (ctx.session?.awaitingSendTo) {
    const { userId, username, message_id = null, chat_id = null } = ctx.session.awaitingSendTo;
    
    // Валидация данных сессии
    if (!message_id || !chat_id || !userId || !username) {
      console.error('Invalid awaitingSendTo session:', ctx.session.awaitingSendTo);
      delete ctx.session.awaitingSendTo;
      return;
    }
    
    // Проверяем, что ответ именно на то сообщение
    if (ctx.chat.id !== chat_id || ctx.message.reply_to_message?.message_id !== message_id) {
      return;
    }
    
    // Запрещаем отправку самому себе
    if (userId === ctx.from.id) {
      await ctx.reply('❌ Нельзя отправлять сообщение самому себе');
      delete ctx.session.awaitingSendTo;
      return;
    }
    
    await ctx.reply('✍️ Начинаю отправку...');
    delete ctx.session.awaitingSendTo; // сбрасываем сразу
    
    try {
      // Логируем начало отправки
      await logAdminAction(ctx.from.id, 'sendto_start', {
        targetUserId: userId,
        targetUsername: username,
        messageType: ctx.updateType,
        messageId: ctx.message.message_id
      });
      
      // Пересылаем сообщение "как есть"
      await ctx.telegram.copyMessage(
        userId, 
        ctx.chat.id, 
        ctx.message.message_id
      );
      
      // Логируем успех
      await logAdminAction(ctx.from.id, 'sendto_success', {
        targetUserId: userId,
        targetUsername: username,
        messageType: ctx.updateType,
        messageId: ctx.message.message_id
      });
      
      await ctx.reply(
        `✅ Сообщение успешно отправлено\n` +
        `👤 Получатель: @${username}\n` +
        `🆔 ID: ${userId}\n` +
        `📊 Тип: ${ctx.updateType}`
      );
      
    } catch (error) {
      console.error(`Ошибка отправки пользователю ${userId}:`, error);
      
      // Логируем ошибку
      await logAdminAction(ctx.from.id, 'sendto_error', {
        targetUserId: userId,
        targetUsername: username,
        error: error.message,
        errorCode: error.code,
        messageType: ctx.updateType
      });
      
      // Детальные сообщения об ошибках
      let errorMessage = `❌ Не удалось отправить сообщение`;
      
      if (error.code === 403) {
        errorMessage += `\n👤 Пользователь @${username} заблокировал бота`;
      } else if (error.code === 400) {
        errorMessage += `\n👤 Пользователь @${username} не найден (удалился/сменил username)`;
      } else if (error.code === 429) {
        errorMessage += `\n⚠️ Слишком много запросов. Подождите немного`;
      } else {
        errorMessage += `\n⚠️ Ошибка: ${error.message}`;
      }
      
      await ctx.reply(errorMessage);
    }
    
    return; // Прерываем, чтобы не обрабатывать дальше
  }
  
  // ===== РАССЫЛКА ВСЕМ ПОЛЬЗОВАТЕЛЯМ =====
  if (ctx.session?.awaitingBroadcast) {
    const { message_id = null, chat_id = null } = ctx.session.awaitingBroadcast;
    
    // Валидация
    if (!message_id || !chat_id) {
      console.error('Invalid awaitingBroadcast session:', ctx.session.awaitingBroadcast);
      delete ctx.session.awaitingBroadcast;
      return;
    }
    
    if (ctx.chat.id !== chat_id || ctx.message.reply_to_message?.message_id !== message_id) {
      return;
    }
    
    await ctx.reply('🚀 Начинаю рассылку...');
    delete ctx.session.awaitingBroadcast; // сбрасываем сразу
    
    try {
      // Логируем начало рассылки
      await logAdminAction(ctx.from.id, 'broadcast_start', {
        messageType: ctx.updateType,
        messageId: ctx.message.message_id,
        adminUsername: ctx.from.username
      });
      
      const users = await db.getAllUsers();
      let success = 0;
      let failed = 0;
      const failedUsers = [];
      
      // Прогресс-бар
      const progressMsg = await ctx.reply(`⏳ Отправлено: 0/${users.length}`);
      
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        
        try {
          // Пропускаем самого админа если хочет
          if (user.id === ctx.from.id) {
            success++;
            continue;
          }
          
          // Пересылаем сообщение
          await ctx.telegram.copyMessage(
            user.id, 
            ctx.chat.id, 
            ctx.message.message_id
          );
          
          success++;
          
          // Обновляем прогресс каждые 10 отправок
          if (success % 10 === 0 || i === users.length - 1) {
            try {
              await ctx.telegram.editMessageText(
                progressMsg.chat.id,
                progressMsg.message_id,
                null,
                `⏳ Отправлено: ${success}/${users.length} (${Math.round((success / users.length) * 100)}%)`
              );
            } catch (editError) {
              // Игнорируем ошибки редактирования
            }
          }
          
        } catch (error) {
          failed++;
          failedUsers.push({
            id: user.id,
            username: user.username,
            error: error.message,
            code: error.code
          });
          
          // Логируем конкретную ошибку пользователя
          await logAdminAction(ctx.from.id, 'broadcast_user_error', {
            targetUserId: user.id,
            targetUsername: user.username,
            error: error.message,
            errorCode: error.code
          });
        }
        
        // Задержка для избежания лимитов Telegram API (20 сообщений/сек)
        await new Promise(r => setTimeout(r, 50)); // 50ms = 20/сек
      }
      
      // Удаляем прогресс-бар
      try {
        await ctx.telegram.deleteMessage(progressMsg.chat.id, progressMsg.message_id);
      } catch (e) {
        // Игнорируем
      }
      
      // Логируем завершение рассылки
      await logAdminAction(ctx.from.id, 'broadcast_complete', {
        totalUsers: users.length,
        successCount: success,
        failedCount: failed,
        messageType: ctx.updateType
      });
      
      // Формируем итоговый отчет
      let report = `✅ Рассылка завершена!\n\n`;
      report += `📊 Статистика:\n`;
      report += `• Всего пользователей: ${users.length}\n`;
      report += `• Успешно отправлено: ${success}\n`;
      report += `• Не удалось отправить: ${failed}\n`;
      report += `• Процент успеха: ${Math.round((success / users.length) * 100)}%\n\n`;
      
      if (failed > 0) {
        report += `⚠️ Не отправлено ${failed} пользователям:\n`;
        
        // Группируем ошибки для краткости
        const errorGroups = {};
        failedUsers.forEach(fu => {
          const errorKey = fu.code || fu.error.substring(0, 50);
          errorGroups[errorKey] = (errorGroups[errorKey] || 0) + 1;
        });
        
        for (const [error, count] of Object.entries(errorGroups)) {
          report += `• ${count} пользователей: ${error}\n`;
        }
      }
      
      await ctx.reply(report);
      
    } catch (error) {
      console.error('Broadcast error:', error);
      
      await logAdminAction(ctx.from.id, 'broadcast_error', {
        error: error.message,
        errorCode: error.code
      });
      
      await ctx.reply(`❌ Ошибка при рассылке: ${error.message}`);
    }
    
    return; // Прерываем обработку
  }
});

export default async function handler(req, res) {

  // Проверяем секретный токен для защиты от внешних вызовов
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    console.error('Получен неверный secret_token!')
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method Not Allowed");
  }
  const update = req.body;

  try {
    if (!update || typeof update !== 'object' || update.update_id === undefined) {
      new Error("⚠️ Невалидный update от Telegram");
      ;
    }
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout: обработка превысила 9 секунд'));
      }, 9000); // 9 секунд
    });
    await Promise.race([
      bot.handleUpdate(update),
      timeoutPromise
    ]);
    console.log(`✅ Обработан update ${update.update_id}`);
    res.status(200).send("OK");
  } catch (err) {
    console.error("Ошибка webhook:", err);
    res.status(500).send("Internal Server Error");
  }
}
