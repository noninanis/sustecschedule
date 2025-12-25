import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

const cache = {};

function normalizeUrl(href, baseUrl) {
    // Защита от некорректных данных
    if (!href) return null;
    if (typeof href !== 'string') {
        console.warn('Href is not a string:', typeof href, href);
        return null;
    }
    
    const cleanHref = href.trim();
    if (!cleanHref) return null;
    
    try {
        // Удаляем якоря и параметры для базового сравнения
        const hrefWithoutHash = cleanHref.split('#')[0];
        
        let result;
        
        if (hrefWithoutHash.startsWith('http://') || hrefWithoutHash.startsWith('https://')) {
            result = hrefWithoutHash;
        } else if (hrefWithoutHash.startsWith('//')) {
            result = 'https:' + hrefWithoutHash;
        } else if (hrefWithoutHash.startsWith('/')) {
            const base = new URL(baseUrl);
            result = base.origin + hrefWithoutHash;
        } else {
            result = new URL(hrefWithoutHash, baseUrl).href;
        }
        
        // Приводим к https
        result = result.replace('http://', 'https://');
        
        // Проверяем валидность
        new URL(result);
        return result;
        
    } catch (error) {
        console.warn('Invalid URL:', cleanHref, error.message);
        return null;
    }
}

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    
    try {
        // Проверяем валидность baseUrl
        new URL(baseUrl);
    } catch (error) {
        console.error('Invalid base URL:', baseUrl);
        return [];
    }
    
    const now = Date.now();
    
    // Кэш
    if (cache[baseUrl] && now - cache[baseUrl].timestamp < 300000) {
        return cache[baseUrl].data;
    }

    try {
        // Загружаем страницу
        const response = await axios.get(baseUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const $ = cheerio.load(response.data);
        
        // Ищем PDF ссылки
        const pdfLinks = [];
        const seenUrls = new Set();
        
        // Используем более безопасный подход
        const links = $('a[href]');
        console.log(`Found ${links.length} total links on page`);
        
        for (let i = 0; i < links.length; i++) {
            const href = $(links[i]).attr('href');
            
            // Базовая проверка
            if (!href || typeof href !== 'string') continue;
            
            // Проверяем расширение (без учета регистра)
            if (!/\.pdf$/i.test(href)) continue;
            
            // Создаем абсолютный URL
            const fullUrl = normalizeUrl(href, baseUrl);
            if (!fullUrl) continue;
            
            // Проверяем уникальность
            if (seenUrls.has(fullUrl)) continue;
            seenUrls.add(fullUrl);
            
            // Извлекаем имя файла
            let fileName = 'unknown.pdf';
            try {
                const urlObj = new URL(fullUrl);
                fileName = urlObj.pathname.split('/').pop().toLowerCase() || 'unknown.pdf';
            } catch {
                // Используем часть из URL
                const parts = fullUrl.split('/');
                fileName = parts[parts.length - 1].toLowerCase() || 'unknown.pdf';
            }
            
            // Убеждаемся что это PDF
            if (!fileName.endsWith('.pdf')) {
                fileName = fileName + '.pdf';
            }
            
            pdfLinks.push({
                url: fullUrl,
                name: fileName,
                originalHref: href
            });
        }
        
        console.log(`Found ${pdfLinks.length} PDF candidates`);
        
        // Проверяем доступность файлов
        const validFiles = [];
        
        // Ограничиваем параллельные запросы
        const batchSize = 5;
        for (let i = 0; i < pdfLinks.length; i += batchSize) {
            const batch = pdfLinks.slice(i, i + batchSize);
            const batchPromises = batch.map(async (file) => {
                try {
                    const headResponse = await axios.head(file.url, {
                        timeout: 5000,
                        validateStatus: (status) => status < 400
                    });
                    
                    // Проверяем что это PDF
                    const contentType = headResponse.headers['content-type'] || '';
                    const isPdf = contentType.includes('pdf') || 
                                 contentType.includes('application/pdf') ||
                                 file.name.endsWith('.pdf');
                    
                    if (!isPdf) return null;
                    
                    const size = parseInt(headResponse.headers['content-length']) || 0;
                    
                    return {
                        url: file.url,
                        name: file.name,
                        size: size,
                        sizeKB: Math.round(size / 1024),
                        status: headResponse.status,
                        lastModified: headResponse.headers['last-modified'] || null
                    };
                    
                } catch (error) {
                    // Файл недоступен
                    return null;
                }
            });
            
            const batchResults = await Promise.allSettled(batchPromises);
            
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    validFiles.push(result.value);
                }
            }
            
            // Задержка между батчами
            if (i + batchSize < pdfLinks.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`Found ${validFiles.length} accessible PDF files`);
        
        // Кэшируем результат
        cache[baseUrl] = {
            data: validFiles,
            timestamp: now
        };
        
        // Фоновая очистка кэша
        waitUntil(
            (async () => {
                try {
                    const cleanupTime = Date.now();
                    for (const key in cache) {
                        if (cleanupTime - cache[key].timestamp > 600000) {
                            delete cache[key];
                        }
                    }
                } catch (error) {
                    // Игнорируем ошибки очистки
                }
            })()
        );
        
        return validFiles;
        
    } catch (error) {
        console.error('PDF scan failed:', error.message);
        
        // Возвращаем кэш если есть
        return cache[baseUrl]?.data || [];
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