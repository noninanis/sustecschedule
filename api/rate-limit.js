import { getRedis } from './redis-client.js';

export async function checkRateLimit(userId, action = 'message', limit = 30) {
  const redis = await getRedis();
  const key = `limit:${action}:${userId}`;
  
  // Берем текущее значение
  const current = await redis.incr(key);
  
  // Если первый запрос — ставим TTL на минуту
  if (current === 1) {
    await redis.expire(key, 60);
  }
  
  // Если превысил — бан на 5 минут
  if (current > limit) {
    const banKey = `ban:${userId}`;
    await redis.setEx(banKey, 300, '1');
    
    return {
      ok: false,
      current,
      limit,
      banned: true,
      message: 'Слишком много запросов, подожди 5 минут'
    };
  }
  
  return {
    ok: true,
    current,
    limit,
    remaining: limit - current
  };
}

export async function isBanned(userId) {
  const redis = await getRedis();
  const banned = await redis.exists(`ban:${userId}`);
  return banned > 0;
}