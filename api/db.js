// db.js
import { Pool } from 'pg';

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
  }

  // === USERS ===

  async upsertUser(ctx) {
    const user = ctx.from;
    if (!user) return;

    const { id, username, first_name, last_name, is_premium, language_code } = user;

    const query = `
      INSERT INTO users (id, username, first_name, last_name, is_premium, language_code, added_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        is_premium = EXCLUDED.is_premium,
        language_code = EXCLUDED.language_code;
    `;

    await this.pool.query(query, [
      id,
      username || null,
      first_name || null,
      last_name || null,
      Boolean(is_premium),
      language_code || null
    ]);
  }

  async getAllUsers() {
    const res = await this.pool.query('SELECT * FROM users ORDER BY added_at DESC');
    return res.rows;
  }

  async getUserById(id) {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] || null;
  };

  async getUserByUsername(username) {
    const res = await this.pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return res.rows[0] || null;
  };

  // === GROUPS ===
  async upsertGroup(ctx) {
    const chat = ctx.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;

    const { id, title, type } = chat;

    const query = `
      INSERT INTO groups (id, title, type, added_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        type = EXCLUDED.type;
    `;

    await this.pool.query(query, [id, title || null, type]);
  }

  async getAllGroups() {
    const res = await this.pool.query('SELECT * FROM groups ORDER BY added_at DESC');
    return res.rows;
  }

  // === Утилиты ===

  async toggleSubscription(ctx) {
    const chat = ctx.chat;
    if (!chat) return;

    const { id: chatId, type } = chat;
    
    try {
      if (type === 'group' || type === 'supergroup') {
        await this.pool.query(
          'UPDATE groups SET enable = NOT enable WHERE id = $1',
          [chatId]
        );
      } else if (type === 'private') {
        const userId = ctx.from?.id;
        if (!userId) return;
        
        await this.pool.query(
          'UPDATE users SET status = NOT status WHERE id = $1',
          [userId]
        );
      }
      return true;
    } catch (error) {
      console.error('Ошибка при обновлении статуса:', error);
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }
}

export default new Database();