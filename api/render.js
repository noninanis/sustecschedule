// render.js
import axios from "axios";
import { Telegraf } from "telegraf";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjsLib from "./pdf.mjs";
import path from "path";

const bot = new Telegraf(process.env.TELEGRAM_TOKEN_BOT);

const standardFontsPath = path.join(process.cwd(), "standard_fonts");
const cmapsPath = path.join(process.cwd(), "cmaps");

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

async function loadPdf(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  const data = new Uint8Array(response.data);
  return await pdfjsLib.getDocument({
    data: data,
    standardFontDataUrl: `${standardFontsPath}/`,
    cMapUrl: `${cmapsPath}/`,
    cMapPacked: true
  }).promise;
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: 4.0 });
  const canvasFactory = new NodeCanvasFactory();
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  return canvas.toBuffer("image/png");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Проверяем секретный токен для защиты от внешних вызовов
  if (req.headers['protection-secret'] !== process.env.REQUEST_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }


  const chat_id = req.query.chat_id;
  const { url } = req.body;
  if (!chat_id || !url) return res.status(400).json({ error: "Missing chat_id or url" });

  try {
    const pdf = await loadPdf(url);
    const pagesToRender = Math.min(2, pdf.numPages);

    // Параллельный рендеринг страниц
    Promise.allSettled(
      Array.from({ length: pagesToRender }, (_, i) =>
        (async () => {
          const pageNum = i + 1;
          const page = await pdf.getPage(pageNum);
          const content = await page.getTextContent();
          if (!content.items || content.items.length === 0) return;

          const imgBuffer = await renderPage(page);
          await bot.telegram.sendPhoto(chat_id, { source: imgBuffer });
        })()
      )
    );
    res.status(200).json({ message: "PDF отправлен в Telegram" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка при рендеринге PDF" });
  }
}