import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    
    try {
        const { data } = await axios.get(baseUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const $ = cheerio.load(data);

        const pdfLinks = [];
        const fileSizes = new Set(); // Храним уникальные размеры файлов
        const processedLinks = new Set(); // Для отслеживания уже обработанных URL
        
        // Сначала собираем все PDF ссылки
        const allLinks = [];
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href && typeof href === 'string' && /\.pdf$/i.test(href)) {
                try {
                    // Создаем абсолютный URL с обработкой ошибок
                    let fullUrl;
                    const cleanHref = href.trim();
                    
                    // Проверяем, является ли URL уже абсолютным
                    if (cleanHref.startsWith('http://') || cleanHref.startsWith('https://')) {
                        fullUrl = cleanHref;
                    } else if (cleanHref.startsWith('//')) {
                        fullUrl = 'https:' + cleanHref;
                    } else {
                        // Используем new URL для относительных путей
                        fullUrl = new URL(cleanHref, baseUrl).href;
                    }
                    
                    // Проверяем валидность URL
                    new URL(fullUrl); // Вызовет ошибку если URL невалидный
                    
                    // Нормализуем URL (убираем дублирование слешей и т.д.)
                    const normalizedUrl = fullUrl.replace(/([^:]\/)\/+/g, '$1');
                    
                    // Избегаем дублирования ссылок на этапе сбора
                    if (!processedLinks.has(normalizedUrl)) {
                        processedLinks.add(normalizedUrl);
                        allLinks.push(normalizedUrl);
                    }
                    
                } catch (urlError) {
                    console.warn(`Invalid PDF URL found: ${href}`, urlError.message);
                }
            }
        });

        console.log(`Found ${allLinks.length} PDF links to process`);

        // Проверяем каждый файл с ограничением параллельных запросов
        const BATCH_SIZE = 5; // Обрабатываем по 5 файлов за раз
        for (let i = 0; i < allLinks.length; i += BATCH_SIZE) {
            const batch = allLinks.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (link) => {
                try {
                    // Получаем заголовки файла без скачивания всего содержимого
                    const headResponse = await axios.head(link, {
                        timeout: 8000,
                        maxRedirects: 5,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/pdf, */*',
                            'Accept-Encoding': 'identity' // Получаем реальный размер без сжатия
                        },
                        validateStatus: function (status) {
                            // Принимаем только успешные ответы
                            return status >= 200 && status < 400;
                        }
                    });
                    
                    // Проверяем, что это действительно PDF
                    const contentType = headResponse.headers['content-type'] || '';
                    if (!contentType.includes('pdf') && !contentType.includes('application/pdf')) {
                        console.warn(`Not a PDF file (Content-Type: ${contentType}): ${link}`);
                        return null;
                    }
                    
                    const contentLength = headResponse.headers['content-length'];
                    const fileName = link.split('/').pop().toLowerCase();
                    const fileExtension = fileName.split('.').pop();
                    
                    // Проверяем расширение файла из заголовков
                    const contentDisposition = headResponse.headers['content-disposition'] || '';
                    let actualFileName = fileName;
                    
                    // Пытаемся извлечь имя файла из content-disposition
                    if (contentDisposition) {
                        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
                        if (match && match[1]) {
                            let extractedName = match[1].replace(/['"]/g, '');
                            actualFileName = extractedName.toLowerCase();
                        }
                    }
                    
                    if (contentLength) {
                        const size = parseInt(contentLength);
                        // Создаем уникальный ключ: размер + имя файла
                        const fileKey = `${size}_${actualFileName}`;
                        
                        if (!fileSizes.has(fileKey)) {
                            fileSizes.add(fileKey);
                            return {
                                url: link,
                                name: actualFileName,
                                size: size,
                                lastModified: headResponse.headers['last-modified'] || 
                                            headResponse.headers['date'] || 
                                            new Date().toISOString(),
                                contentType: contentType,
                                status: headResponse.status
                            };
                        } else {
                            console.log(`Duplicate file found (${fileKey}): ${link}`);
                            return null;
                        }
                    } else {
                        // Если размер неизвестен, добавляем файл с отметкой
                        return {
                            url: link,
                            name: actualFileName,
                            size: 0,
                            lastModified: headResponse.headers['last-modified'] || 
                                        headResponse.headers['date'] || 
                                        new Date().toISOString(),
                            contentType: contentType,
                            status: headResponse.status,
                            note: 'Size unknown'
                        };
                    }
                } catch (error) {
                    console.warn(`Failed to check file ${link}:`, error.message);
                    
                    // Пробуем получить файл через GET запрос (только заголовки)
                    try {
                        const getResponse = await axios.get(link, {
                            timeout: 5000,
                            responseType: 'stream',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Range': 'bytes=0-0' // Запрашиваем только первый байт
                            },
                            maxRedirects: 3
                        });
                        
                        getResponse.data.destroy(); // Закрываем поток
                        
                        const contentLength = getResponse.headers['content-length'];
                        const fileName = link.split('/').pop().toLowerCase();
                        
                        return {
                            url: link,
                            name: fileName,
                            size: contentLength ? parseInt(contentLength) : 0,
                            lastModified: getResponse.headers['last-modified'] || new Date().toISOString(),
                            contentType: getResponse.headers['content-type'] || 'unknown',
                            status: getResponse.status,
                            note: 'Retrieved via partial GET'
                        };
                    } catch (fallbackError) {
                        console.error(`Failed even with GET fallback for ${link}:`, fallbackError.message);
                        
                        // Добавляем файл с ошибкой
                        return {
                            url: link,
                            name: link.split('/').pop().toLowerCase(),
                            size: 0,
                            error: error.message,
                            status: 'failed'
                        };
                    }
                }
            });
            
            // Ожидаем завершения всех запросов в текущем батче
            const results = await Promise.allSettled(batchPromises);
            
            // Обрабатываем результаты
            results.forEach((result) => {
                if (result.status === 'fulfilled' && result.value) {
                    pdfLinks.push(result.value);
                }
            });
            
            // Небольшая задержка между батчами чтобы не перегружать сервер
            if (i + BATCH_SIZE < allLinks.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        console.log(`Successfully processed ${pdfLinks.length} unique PDF files`);
        
        // Сортируем по размеру (от большего к меньшему)
        pdfLinks.sort((a, b) => b.size - a.size);
        
        return pdfLinks;
        
    } catch (error) {
        console.error('Error in getPDFstatus:', error.message);
        throw new Error(`Failed to fetch PDF status: ${error.message}`);
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