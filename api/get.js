import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    
    try {
        // Получаем страницу
        const { data } = await axios.get(baseUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(data);

        // Собираем все PDF ссылки
        const linksMap = new Map();
        
        $("a[href$='.pdf'], a[href$='.PDF']").each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            
            try {
                let fullUrl;
                const cleanHref = href.trim();
                
                if (cleanHref.startsWith('/')) {
                    const base = new URL(baseUrl);
                    fullUrl = base.origin + cleanHref;
                } else if (!cleanHref.startsWith('http')) {
                    fullUrl = new URL(cleanHref, baseUrl).href;
                } else {
                    fullUrl = cleanHref;
                }
                
                // Используем https
                fullUrl = fullUrl.replace('http://', 'https://');
                const fileName = fullUrl.split('/').pop().toLowerCase();
                
                // Сохраняем только первую ссылку для каждого имени файла
                if (!linksMap.has(fileName)) {
                    linksMap.set(fileName, fullUrl);
                }
                
            } catch (error) {
                // Пропускаем некорректные URL
            }
        });

        console.log(`Found ${linksMap.size} unique PDF links by filename`);

        // Быстрая проверка существования файлов
        const existingFiles = [];
        const checkPromises = Array.from(linksMap.entries()).map(async ([fileName, url]) => {
            try {
                // Быстрый HEAD запрос с коротким таймаутом
                await axios.head(url, {
                    timeout: 3000,
                    maxRedirects: 1,
                    validateStatus: (status) => status === 200
                });
                
                existingFiles.push({
                    url: url,
                    name: fileName,
                    exists: true
                });
                
            } catch (error) {
                // Файл не существует - не добавляем
                console.log(`File not found: ${fileName}`);
            }
        });

        // Параллельная проверка всех файлов
        await Promise.allSettled(checkPromises);
        
        console.log(`Found ${existingFiles.length} existing PDF files`);
        
        return existingFiles;
        
    } catch (error) {
        console.error('Error:', error.message);
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