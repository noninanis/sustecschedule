// admin.js
import { getRedis } from './redis-client.js';
import db from './db.js';

class AdminManager {
  constructor() {
    this.localCache = new Map();
    this.lastLoadTime = 0;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 минут
    this.redis = null;
  }
  
  async getRedis() {
    if (!this.redis) {
      this.redis = await getRedis();
    }
    return this.redis;
  }
  
  // Ленивая загрузка при первом запросе
  async ensureLoaded() {
    const now = Date.now();
    
    // Если кеш пустой или устарел (>5 минут)
    if (this.localCache.size === 0 || now - this.lastLoadTime > this.CACHE_TTL) {
      await this.loadFromRedis();
    }
  }
  
  async loadFromRedis() {
    try {
      const redis = await this.getRedis();
      
      // Пробуем взять из Redis
      const adminIds = await redis.sMembers('admin:users');
      
      // Если Redis пустой — синхронизируем с БД
      if (adminIds.length === 0) {
        await this.syncFromDB();
        // Пробуем снова
        const freshIds = await redis.sMembers('admin:users');
        this.updateLocalCache(freshIds);
      } else {
        this.updateLocalCache(adminIds);
      }
      
      this.lastLoadTime = Date.now();
      
    } catch (error) {
      console.error('Error loading admins from Redis:', error);
      this.localCache.clear();
    }
  }
  
  async syncFromDB() {
    try {
      const redis = await this.getRedis();
      const result = await db.getAllAdmins();
      
      if (result.length > 0) {
        const pipeline = redis.multi();
        
        for (const user of result) {
          pipeline.sAdd('admin:users', user.id.toString());
          pipeline.setEx(`admin:${user.id}`, 86400, '1'); // TTL 24ч
        }
        
        await pipeline.exec();
        console.log(`✅ Synced ${result.length} admins to Redis`);
        
        return result.map(r => r.id.toString());
      }
      
      return [];
      
    } catch (error) {
      console.error('Error syncing admins from DB:', error);
      return [];
    }
  }
  
  updateLocalCache(adminIds) {
    this.localCache.clear();
    adminIds.forEach(id => this.localCache.set(id, true));
    console.log(`✅ Admin cache updated: ${adminIds.length} admins`);
  }
  
  // Основной метод проверки
  async isAdmin(userId) {
    await this.ensureLoaded();
    
    // 1. Быстрая проверка в памяти
    if (this.localCache.has(userId.toString())) {
      return true;
    }
    
    // 2. Если нет в кеше — проверяем Redis (на случай рассинхрона)
    try {
      const redis = await this.getRedis();
      const isAdminInRedis = await redis.get(`admin:${userId}`);
      
      // Если нашли в Redis — обновляем локальный кеш
      if (isAdminInRedis === '1') {
        this.localCache.set(userId.toString(), true);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error('Error checking admin in Redis:', error);
      return false;
    }
  }
  
  // Добавление админа (вызывается при команде /admin_add)
  async addAdmin(userId) {
    try {
      // 1. Обновляем БД
      await db.setAdminById(userId,true);
      
      // 2. Обновляем Redis
      const redis = await this.getRedis();
      await redis.sAdd('admin:users', userId.toString());
      await redis.setEx(`admin:${userId}`, 86400, '1');
      
      // 3. Обновляем локальный кеш
      this.localCache.set(userId.toString(), true);
      
      console.log(`✅ Added admin ${userId}`);
      
    } catch (error) {
      console.error('Error adding admin:', error);
      throw error;
    }
  }
  
  // Удаление админа (вызывается при команде /admin_remove)
  async removeAdmin(userId) {
    try {
      // 1. Обновляем БД
      await db.setAdminById(userId,false);
      
      // 2. Обновляем Redis
      const redis = await this.getRedis();
      await redis.sRem('admin:users', userId.toString());
      await redis.del(`admin:${userId}`);
      
      // 3. Обновляем локальный кеш
      this.localCache.delete(userId.toString());
      
      console.log(`✅ Removed admin ${userId}`);
      
    } catch (error) {
      console.error('Error removing admin:', error);
      throw error;
    }
  }
  
  // Принудительное обновление кеша (для тестов/cron)
  async forceReload() {
    this.localCache.clear();
    this.lastLoadTime = 0;
    await this.loadFromRedis();
  }
}

// Singleton с ленивой инициализацией
let adminManagerInstance = null;

export function getAdminManager() {
  if (!adminManagerInstance) {
    adminManagerInstance = new AdminManager();
  }
  return adminManagerInstance;
}

// Для удобства
export async function isAdmin(userId) {
  const manager = getAdminManager();
  return await manager.isAdmin(userId);
}

export async function addAdmin(userId) {
  const manager = getAdminManager();
  await manager.addAdmin(userId);
}

export async function removeAdmin(userId) {
  const manager = getAdminManager();
  await manager.removeAdmin(userId);
}