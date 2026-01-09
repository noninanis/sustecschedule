// api/cron.js
import db from './db.js';
import { SendRender } from './get.js';

export default async function handler(req, res) {

  console.log('Cron задача запущена:', new Date());

  try {
    // Получаем все группы из БД
    const groups = await db.getEnabledGroups();

    console.log(`Найдено активных групп: ${groups.length}`);

    if (groups.length === 0) {
      console.log('❌ Нет активных групп для отправки');
      return;
    }

    // Для каждой группы вызываем SendRender
    for (const group of groups) {
      if(group.enabled==true){
        console.log(`Отправка рендера в чат: ${group.id}`);
        try {
          await SendRender(group.id);
        } catch (err) {
          console.error(`Ошибка при отправке в чат ${group.id}:`, err.message || err);
        }
      }
    }

    console.log('Cron задача успешно завершена');
    return res.status(200).json({ success: true, processed: groups.length });
  } catch (error) {
    console.error('Критическая ошибка в cron задаче:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}