// get.js
import axios from "axios";
import * as cheerio from "cheerio";

const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    const now = Date.now();
    
    // Проверяем кэш
    if (cache[baseUrl] && now - cache[baseUrl].timestamp < CACHE_TTL) {
        console.log('Returning cached PDF URLs');
        return cache[baseUrl].data;
    }

    try {
        console.time('PDF scan');
        
        // Получаем страницу
        const { data } = await axios.get(baseUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const $ = cheerio.load(data);
        
        // Извлекаем все PDF ссылки
        const allLinks = [];
        const uniqueUrls = new Set();
        
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href && /\.pdf$/i.test(href)) {
                try {
                    // Создаем абсолютный URL
                    let fullUrl;
                    
                    if (href.startsWith('http://') || href.startsWith('https://')) {
                        fullUrl = href;
                    } else if (href.startsWith('//')) {
                        fullUrl = 'https:' + href;
                    } else if (href.startsWith('/')) {
                        const urlObj = new URL(baseUrl);
                        fullUrl = urlObj.origin + href;
                    } else {
                        fullUrl = new URL(href, baseUrl).href;
                    }
                    
                    // Приводим к https
                    fullUrl = fullUrl.replace('http://', 'https://');
                    
                    // Проверяем уникальность
                    if (!uniqueUrls.has(fullUrl)) {
                        uniqueUrls.add(fullUrl);
                        allLinks.push(fullUrl);
                    }
                    
                } catch (error) {
                    console.warn(`Invalid PDF URL skipped: ${href}`);
                }
            }
        });

        console.log(`Found ${allLinks.length} PDF links`);

        // Проверяем существование файлов (быстрая проверка)
        const validLinks = [];
        const fileSizes = new Set();
        
        // Проверяем первые 50 файлов для скорости
        const linksToCheck = allLinks.slice(0, 50);
        
        // Создаем промисы для проверки
        const checkPromises = linksToCheck.map(async (link) => {
            try {
                const response = await axios.head(link, {
                    timeout: 2000,
                    maxRedirects: 2,
                    validateStatus: (status) => status === 200
                });
                
                // Проверяем что это PDF
                const contentType = response.headers['content-type'] || '';
                const isPdf = contentType.includes('pdf') || 
                             contentType.includes('application/pdf') ||
                             link.toLowerCase().endsWith('.pdf');
                
                if (isPdf) {
                    return link;
                }
                const contentLength = response.headers['content-length'];
                if (!contentLength) {
                    // Если размер неизвестен, добавляем файл
                    return { url: link, size: 0 };
                }

                const size = parseInt(contentLength);
                
                // Проверяем уникальность по размеру
                const fileKey = `${size}`; // Ключ = размер файла
                
                if (!fileSizes.has(fileKey)) {
                    fileSizes.add(fileKey);
                    return { url: link, size: size };
                } else {
                    console.log(`Duplicate file by size (${size} bytes): ${link}`);
                    return null;
                }

                return null;
                
            } catch (error) {
                return null;
            }
        });

        // Выполняем проверки
        const results = await Promise.allSettled(checkPromises);
        
        // Собираем валидные ссылки
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                validLinks.push(result.value);
            }
        });

        console.timeEnd('PDF scan');
        console.log(`Found ${validLinks.length} accessible PDF files`);

        // Сохраняем в кэш
        cache[baseUrl] = {
            data: validLinks,
            timestamp: now
        };

        // Фоновая очистка кэша
        (async () => {
            try {
                const currentTime = Date.now();
                let cleaned = 0;
                
                for (const key in cache) {
                    if (currentTime - cache[key].timestamp > CACHE_TTL * 2) {
                        delete cache[key];
                        cleaned++;
                    }
                }
                
                if (cleaned > 0) {
                    console.log(`Cleaned ${cleaned} old cache entries`);
                }
            } catch (error) {
                // Игнорируем ошибки очистки
            }
        })().catch(() => {});

        return validLinks;
        
    } catch (error) {
        console.error('Error in getPDFstatus:', error.message);
        
        // Возвращаем кэш или пустой массив
        return cache[baseUrl]?.data || [];
    }
}

async function sendRequestRender(chat_id, pdfLinks) {
    Promise.all(
        pdfLinks.map(pdfUrl =>
            fetch(`https://${process.env.WEBHOOK_URL}/render?chat_id=${chat_id}`, {
                method: "POST",
                headers: {
                    'protection-secret': process.env.REQUEST_SECRET,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ url: pdfUrl }),
            }).catch(err => console.error("Ошибка render:", err.message))
        )
    );
}

async function SendRender(chat_id, res) {
    try {
        const pdfLinks = await getPDFstatus();

        if (pdfLinks.length === 0) {
            return res.status(404).json({ error: "PDF не найдены" });
        }
        
        console.log(`Processing ${pdfLinks.length} PDF files`);
        
        sendRequestRender(chat_id, pdfLinks);
        
        // Возвращаем ответ сразу
        return res.status(200).json({ 
            success: true, 
            message: "PDF processing started",
            count: pdfLinks.length 
        });
        
    } catch (error) {
        console.error("Error in SendRender:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
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