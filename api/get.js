import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

// LRU кэш для лучшей производительности
class LRUCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    get(key) {
        if (!this.cache.has(key)) return null;
        
        const value = this.cache.get(key);
        // Перемещаем в конец (самый недавний)
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Удаляем самый старый элемент
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }
}

const pdfCache = new LRUCache(50);
const CACHE_TTL = 300000; // 5 минут

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    const cacheKey = `pdf-${Buffer.from(baseUrl).toString('base64').slice(0, 20)}`;
    
    // Проверяем кэш
    const cached = pdfCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }

    try {
        // Быстро получаем HTML
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const { data } = await axios.get(baseUrl, {
            timeout: 8000,
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept-Encoding': 'gzip, deflate, br',
            }
        });
        
        clearTimeout(timeoutId);

        const $ = cheerio.load(data);
        
        // Эффективно извлекаем ссылки
        const urlSet = new Set();
        const pdfFiles = [];
        
        // Используем более специфичные селекторы для скорости
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || !href.includes('.pdf')) return;
            
            try {
                let fullUrl;
                
                if (href.startsWith('/')) {
                    const origin = new URL(baseUrl).origin;
                    fullUrl = origin + href;
                } else if (href.startsWith('http')) {
                    fullUrl = href;
                } else if (href.startsWith('//')) {
                    fullUrl = 'https:' + href;
                } else {
                    fullUrl = new URL(href, baseUrl).href;
                }
                
                fullUrl = fullUrl.replace('http://', 'https://');
                
                // Убираем дубликаты по URL
                if (!urlSet.has(fullUrl)) {
                    urlSet.add(fullUrl);
                    
                    const fileName = fullUrl.split('/').pop().toLowerCase();
                    if (fileName.endsWith('.pdf')) {
                        pdfFiles.push({
                            url: fullUrl,
                            name: fileName
                        });
                    }
                }
            } catch {
                // Пропускаем некорректные URL
            }
        });

        // Быстрая валидация самых вероятных файлов (первые 30)
        const filesToCheck = pdfFiles.slice(0, 30);
        const validFiles = [];
        
        // Создаем промисы для проверки
        const checkPromises = filesToCheck.map(async (file, index) => {
            try {
                // Небольшая задержка для распределения нагрузки
                if (index > 0) {
                    await new Promise(resolve => setTimeout(resolve, index * 10));
                }
                
                const response = await axios.head(file.url, {
                    timeout: 2000,
                    maxRedirects: 1,
                    validateStatus: status => status === 200,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                
                const size = parseInt(response.headers['content-length']) || 0;
                if (size > 0) {
                    return {
                        ...file,
                        size: size,
                        sizeKB: Math.round(size / 1024)
                    };
                }
            } catch {
                return null;
            }
        });

        // Параллельная проверка
        const results = await Promise.allSettled(checkPromises);
        
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                validFiles.push(result.value);
            }
        });

        // Подготавливаем результат
        const result = {
            files: validFiles,
            totalFound: pdfFiles.length,
            validCount: validFiles.length,
            scannedAt: new Date().toISOString()
        };

        // Кэшируем результат
        const cacheData = {
            data: result,
            timestamp: Date.now()
        };
        
        pdfCache.set(cacheKey, cacheData);
        
        // Используем waitUntil для фоновых задач
        waitUntil(async () => {
            try {
                const now = Date.now();
                for (const [key, value] of pdfCache.cache.entries()) {
                    if (now - value.timestamp > CACHE_TTL * 3) {
                        pdfCache.cache.delete(key);
                    }
                }
            } catch (error) {
                // Игнорируем ошибки в фоновых задачах
            }
        });

        return result;
        
    } catch (error) {
        console.error('PDF scan error:', error.message);
        
        // Пробуем вернуть старый кэш если есть
        const cached = pdfCache.get(cacheKey);
        if (cached) {
            return cached.data;
        }
        
        return {
            files: [],
            totalFound: 0,
            validCount: 0,
            error: error.message,
            scannedAt: new Date().toISOString()
        };
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