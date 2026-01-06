import db from './db.js';
import { getRedis } from './redis-client.js';
/**
 * Парсит username или ID из строки
 * @param {string} input - Входная строка (может быть: 123456, @username, username)
 * @returns {Object} { type: 'id'|'username', value: string }
 */
export function parseUserInput(input) {
  if (!input) return null;
  
  // Убираем @ в начале если есть
  const cleaned = input.startsWith('@') ? input.slice(1) : input;
  
  // Проверяем, является ли числом (ID)
  if (/^\d+$/.test(cleaned)) {
    return { type: 'id', value: parseInt(cleaned, 10) };
  }
  
  // Иначе считаем username
  return { type: 'username', value: cleaned.toLowerCase() };
}

/**
 * Находит пользователя по ID или username
 */
export async function findUser(input) {
  const parsed = parseUserInput(input);
  if (!parsed) return null;
  
  try {
    if (parsed.type === 'id') {
      // Ищем по ID
      return await db.getUserById(parsed.value);
    } else {
      // Ищем по username
      return await db.getUserByUsername(parsed.value);
    }
  } catch (error) {
    console.error('Find user error:', error);
    return null;
  }
}

/**
 * Форматирует информацию о пользователе для вывода
 */
export function formatUserInfo(user) {
  if (!user) return 'Пользователь не найден';
  
  const parts = [];
  
  if (user.first_name) parts.push(`Имя: ${user.first_name}`);
  if (user.last_name) parts.push(`Фамилия: ${user.last_name}`);
  if (user.username) parts.push(`Username: @${user.username}`);
  if (user.id) parts.push(`ID: ${user.id}`);
  
  return parts.join('\n');
}

export async function logAdminAction(adminId, action, data = {}) {
  try {
    const redis = await getRedis();
    const timestamp = Date.now();
    
    // Получаем информацию об админе
    const adminInfo = await db.getUserById(adminId).catch(() => null);
    
    const logEntry = {
      timestamp,
      date: new Date(timestamp).toISOString(),
      adminId,
      adminUsername: adminInfo?.username || 'unknown',
      adminFirstName: adminInfo?.first_name || 'Unknown',
      action,
      data
    };
    
    // Сохраняем в Redis (последние 1000 записей)
    await redis.lPush('admin:action:log', JSON.stringify(logEntry));
    await redis.lTrim('admin:action:log', 0, 999);
    
    // Также сохраняем отдельно для статистики
    const statsKey = `admin:stats:${adminId}:${action}`;
    await redis.incr(statsKey);
    await redis.expire(statsKey, 604800); // 7 дней
    
    console.log(`📝 Admin action logged: ${action} by ${adminId}`);
    
  } catch (error) {
    console.error('Admin log error:', error);
    // Не падаем если логирование не работает
  }
}

// Получить логи действий
export async function getAdminLogs(limit = 50) {
  try {
    const redis = await getRedis();
    const logs = await redis.lRange('admin:action:log', 0, limit - 1);
    
    return logs.map(log => JSON.parse(log));
  } catch (error) {
    console.error('Get logs error:', error);
    return [];
  }
}

// Статистика действий админа
export async function getAdminStats(adminId, days = 7) {
  try {
    const redis = await getRedis();
    const pattern = `admin:stats:${adminId}:*`;
    
    // В реальности нужно SCAN, но для простоты:
    const actions = ['sendto_start', 'sendto_success', 'sendto_error', 
                     'broadcast_start', 'broadcast_complete', 'broadcast_error'];
    
    const stats = {};
    for (const action of actions) {
      const key = `admin:stats:${adminId}:${action}`;
      const count = await redis.get(key);
      stats[action] = parseInt(count || '0');
    }
    
    return stats;
  } catch (error) {
    console.error('Get admin stats error:', error);
    return {};
  }
}