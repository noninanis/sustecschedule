import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    
    try {
        console.time('Fetch page');
        const { data } = await axios.get(baseUrl, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        console.timeEnd('Fetch page');
        
        const $ = cheerio.load(data);
        console.log('Page loaded, searching for PDF links...');

        // Собираем все возможные PDF ссылки
        const potentialLinks = new Set();
        
        $("a").each((_, el) => {
            const href = $(el).attr("href");
            if (href && typeof href === 'string' && /\.pdf$/i.test(href)) {
                const cleanHref = href.trim();
                
                try {
                    let fullUrl;
                    
                    if (cleanHref.startsWith('http://') || cleanHref.startsWith('https://')) {
                        fullUrl = cleanHref;
                    } else if (cleanHref.startsWith('//')) {
                        fullUrl = 'https:' + cleanHref;
                    } else if (cleanHref.startsWith('/')) {
                        const base = new URL(baseUrl);
                        fullUrl = base.origin + cleanHref;
                    } else {
                        fullUrl = new URL(cleanHref, baseUrl).href;
                    }
                    
                    // Нормализуем URL (исправляем протокол если нужно)
                    fullUrl = fullUrl.replace('http://', 'https://');
                    
                    // Проверяем валидность
                    new URL(fullUrl);
                    potentialLinks.add(fullUrl);
                    
                } catch (error) {
                    console.warn(`Invalid URL skipped: ${href}`);
                }
            }
        });

        console.log(`Found ${potentialLinks.size} potential PDF links`);

        // Преобразуем Set в массив для обработки
        const linksArray = Array.from(potentialLinks);
        
        // Проверяем существование файлов параллельно
        console.time('Check links');
        const checkPromises = linksArray.map(async (link) => {
            try {
                // Быстрая проверка через HEAD запрос
                const response = await axios.head(link, {
                    timeout: 5000,
                    maxRedirects: 2,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    validateStatus: (status) => status < 400 // Принимаем только успешные статусы
                });

                // Проверяем, что это PDF
                const contentType = response.headers['content-type'] || '';
                if (!contentType.includes('pdf') && !contentType.includes('application/pdf')) {
                    console.log(`Skipping non-PDF (${contentType}): ${link}`);
                    return null;
                }

                const contentLength = response.headers['content-length'];
                const fileName = link.split('/').pop().toLowerCase();
                
                // Извлекаем имя файла из content-disposition если есть
                let actualFileName = fileName;
                const contentDisposition = response.headers['content-disposition'] || '';
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename\*?=["']?([^"';]+)["']?/i);
                    if (match && match[1]) {
                        actualFileName = decodeURIComponent(match[1]).toLowerCase();
                    }
                }

                return {
                    url: link,
                    name: actualFileName,
                    size: contentLength ? parseInt(contentLength) : 0,
                    exists: true,
                    lastModified: response.headers['last-modified'] || null,
                    status: response.status
                };

            } catch (error) {
                // Файл не существует или недоступен
                return {
                    url: link,
                    name: link.split('/').pop().toLowerCase(),
                    size: 0,
                    exists: false,
                    error: error.message,
                    status: error.response?.status || 0
                };
            }
        });

        // Обрабатываем все проверки параллельно
        const results = await Promise.allSettled(checkPromises);
        console.timeEnd('Check links');

        // Фильтруем результаты
        const pdfLinks = [];
        const uniqueFiles = new Set();
        
        results.forEach((result) => {
            if (result.status === 'fulfilled' && result.value) {
                const fileInfo = result.value;
                
                // Пропускаем несуществующие файлы
                if (!fileInfo.exists) {
                    console.log(`File not found (${fileInfo.status}): ${fileInfo.url}`);
                    return;
                }
                
                // Проверяем уникальность по имени файла и размеру
                const uniqueKey = `${fileInfo.name}_${fileInfo.size}`;
                
                if (!uniqueFiles.has(uniqueKey) && fileInfo.size > 0) {
                    uniqueFiles.add(uniqueKey);
                    pdfLinks.push(fileInfo);
                } else if (fileInfo.size > 0) {
                    console.log(`Duplicate file skipped: ${fileInfo.name} (${fileInfo.size} bytes)`);
                }
            }
        });

        console.log(`Found ${pdfLinks.length} existing and unique PDF files out of ${potentialLinks.size} links`);
        
        // Сортируем по имени файла для удобства
        pdfLinks.sort((a, b) => a.name.localeCompare(b.name));
        
        // Логируем статистику
        if (pdfLinks.length > 0) {
            console.log('PDF files found:');
            pdfLinks.slice(0, 10).forEach((file, index) => {
                console.log(`${index + 1}. ${file.name} - ${(file.size / 1024).toFixed(1)} KB`);
            });
            if (pdfLinks.length > 10) {
                console.log(`... and ${pdfLinks.length - 10} more files`);
            }
        }

        return pdfLinks;
        
    } catch (error) {
        console.error('Error in getPDFstatus:', error.message);
        // Возвращаем пустой массив вместо выброса ошибки
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