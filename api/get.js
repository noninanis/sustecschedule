import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

// Простой кэш
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    const cacheKey = `pdf-${Buffer.from(baseUrl).toString('base64')}`;
    
    // Проверяем кэш
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('Returning cached PDF results');
        return cached.data;
    }

    try {
        console.time('PDF scan');
        
        // 1. Получаем HTML страницы
        const { data } = await axios.get(baseUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(data);
        
        // 2. Извлекаем все PDF ссылки
        const linksMap = new Map();
        
        $('a[href*=".pdf"]').each((_, el) => {
            try {
                const href = $(el).attr('href');
                if (!href) return;
                
                let fullUrl;
                const cleanHref = href.trim();
                
                // Нормализуем URL
                if (cleanHref.startsWith('http')) {
                    fullUrl = cleanHref;
                } else if (cleanHref.startsWith('//')) {
                    fullUrl = 'https:' + cleanHref;
                } else if (cleanHref.startsWith('/')) {
                    const urlObj = new URL(baseUrl);
                    fullUrl = urlObj.origin + cleanHref;
                } else {
                    fullUrl = new URL(cleanHref, baseUrl).href;
                }
                
                // Принудительно используем https
                fullUrl = fullUrl.replace('http://', 'https://');
                
                // Извлекаем имя файла
                const urlObj = new URL(fullUrl);
                const fileName = urlObj.pathname.split('/').pop().toLowerCase();
                
                // Проверяем что это PDF
                if (!fileName.endsWith('.pdf')) return;
                
                // Сохраняем только если это новый файл
                if (!linksMap.has(fileName)) {
                    linksMap.set(fileName, {
                        url: fullUrl,
                        name: fileName
                    });
                }
                
            } catch (error) {
                // Пропускаем некорректные URL
            }
        });
        
        console.log(`Found ${linksMap.size} potential PDF files`);

        // 3. Проверяем существование файлов
        const existingFiles = [];
        const linkEntries = Array.from(linksMap.values());
        
        // Создаем промисы для проверки файлов
        const checkPromises = linkEntries.map(async (file) => {
            try {
                // Быстрая проверка через HEAD запрос
                const response = await axios.head(file.url, {
                    timeout: 3000,
                    maxRedirects: 2,
                    validateStatus: (status) => status === 200
                });
                
                // Проверяем что это PDF
                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('pdf') && !contentType.includes('application/pdf')) {
                    return null;
                }
                
                const size = parseInt(response.headers['content-length']) || 0;
                
                return {
                    ...file,
                    size: size,
                    sizeKB: Math.round(size / 1024),
                    lastModified: response.headers['last-modified'] || null,
                    status: 200
                };
                
            } catch (error) {
                // Файл не существует
                return null;
            }
        });

        // Выполняем все проверки параллельно
        const results = await Promise.allSettled(checkPromises);
        
        // Обрабатываем результаты
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                existingFiles.push(result.value);
            }
        });

        // 4. Подготавливаем результат
        const result = existingFiles
            .filter(file => file.size > 0)
            .sort((a, b) => b.size - a.size)
            .map(file => ({
                url: file.url,
                name: file.name,
                size: file.size,
                sizeKB: file.sizeKB,
                lastModified: file.lastModified
            }));

        console.timeEnd('PDF scan');
        console.log(`Found ${result.length} valid PDF files`);

        // 5. Сохраняем в кэш
        const cacheData = {
            data: result,
            timestamp: Date.now()
        };
        
        cache.set(cacheKey, cacheData);
        
        // 6. Используем waitUntil для фоновой очистки кэша (как в примере)
        waitUntil(
            Promise.all([
                // Очищаем старый кэш в фоне
                (async () => {
                    try {
                        const now = Date.now();
                        const keysToDelete = [];
                        
                        for (const [key, value] of cache.entries()) {
                            if (now - value.timestamp > CACHE_TTL * 2) {
                                keysToDelete.push(key);
                            }
                        }
                        
                        // Удаляем старые записи
                        keysToDelete.forEach(key => cache.delete(key));
                        
                        if (keysToDelete.length > 0) {
                            console.log(`Cleaned up ${keysToDelete.length} old cache entries`);
                        }
                    } catch (error) {
                        console.error('Cache cleanup error:', error);
                    }
                })(),
                
                // Можно добавить другие фоновые задачи
                (async () => {
                    try {
                        // Дополнительная фоновая обработка если нужно
                        // Например, логирование статистики
                        if (result.length > 0) {
                            const totalSize = result.reduce((sum, file) => sum + file.size, 0);
                            console.log(`Total PDF size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
                        }
                    } catch (error) {
                        // Игнорируем ошибки в фоновых задачах
                    }
                })()
            ]).catch(error => {
                console.error('Background tasks error:', error);
            })
        );

        return result;
        
    } catch (error) {
        console.error('Error in getPDFstatus:', error.message);
        
        // Пробуем вернуть старые кэшированные данные
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log('Returning stale cache due to error');
            return cached.data;
        }
        
        // Всегда возвращаем массив
        return [];
    }
}



async function sendRequestRender(chat_id,pdfLinks){
    waitUntil(
      Promise.all(
        pdfLinks.map(pdfUrl =>
          fetch(`https://${process.env.WEBHOOK_URL}/render?chat_id=${chat_id}`, {
            method: "POST",
            headers: {'protection-secret': process.env.REQUEST_SECRET, "Content-Type": "application/json" },
            body: JSON.stringify({ url: pdfUrl }),
          }).catch(err => console.error("Ошибка render:", err.message))
        )
      )
  );
}

async function SendRender(chat_id){
    const pdfLinks = await getPDFstatus();

    if (pdfLinks.length === 0) return res.status(404).json({ error: "PDF не найдены" });
      // Fire-and-forget POST на /api/render через waitUntil
    await sendRequestRender(chat_id,pdfLinks);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method Not Allowed");
  
  // Проверяем секретный токен для защиты от внешних вызовов
  if (req.headers['protection-secret'] !== process.env.REQUEST_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const chat_id = req.query.chat_id;
  if (!chat_id) return res.status(400).send("Missing chat_id");

  try {
      await SendRender(chat_id);
      return res.status(200).json({ message: "Запросы на рендеринг PDF отправлены" });
  } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Ошибка при получении PDF" });
  }
}

export { SendRender };