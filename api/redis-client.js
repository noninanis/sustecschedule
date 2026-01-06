import { createClient } from 'redis';

let client = null;

export async function getRedis() {
  if (client?.isOpen) return client;
  
  console.log('🔌 Подключаю Redis...');
  
  client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 10000,
      keepAlive: 5000
    }
  });
  
  client.on('error', (err) => console.error('Redis error:', err));
  client.on('connect', () => console.log('✅ Redis подключен'));
  
  await client.connect();
  return client;
}

// Просто чтобы не забыть закрыть при дебаге
export async function closeRedis() {
  if (client) await client.quit();
}