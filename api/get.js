import axios from "axios";
import * as cheerio from "cheerio";
import { waitUntil } from "@vercel/functions";

async function getPDFstatus() {
    const baseUrl = `https://${process.env.COLLEGE_ENDPOINT_URL}`;
    const { data } = await axios.get(baseUrl);
    const $ = cheerio.load(data);

    const pdfLinks = [];
    const fileSizes = new Set(); // Храним уникальные размеры файлов
    
    // Сначала собираем все PDF ссылки
    const allLinks = [];
    $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (href && /\.pdf$/i.test(href)) {
            const fullUrl = new URL(href, baseUrl).href;
            allLinks.push(fullUrl);
        }
    });

    // Проверяем каждый файл
    for (const link of allLinks) {
        try {
            // Получаем заголовки файла без скачивания всего содержимого
            const headResponse = await axios.head(link, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            const contentLength = headResponse.headers['content-length'];
            const fileName = link.split('/').pop().toLowerCase();
            
            if (contentLength) {
                // Создаем уникальный ключ: размер + имя файла (или только размер)
                const fileKey = `${contentLength}_${fileName}`;
                // Или только по размеру: const fileKey = contentLength;
                
                if (!fileSizes.has(fileKey)) {
                    fileSizes.add(fileKey);
                    pdfLinks.push({
                        url: link,
                        name: fileName,
                        size: parseInt(contentLength)
                    });
                }
            } else {
                // Если размер неизвестен, добавляем файл
                pdfLinks.push({
                    url: link,
                    name: link.split('/').pop().toLowerCase(),
                    size: 0
                });
            }
        } catch (error) {
            console.warn(`Не удалось проверить файл ${link}:`, error.message);
        }
    }

    return pdfLinks;
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