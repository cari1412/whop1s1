const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Инициализация Supabase клиента
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function scrapeWhopPulse() {
  console.log('🚀 Запуск скрапера...');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const page = await context.newPage();
    
    // Переход на страницу
    await page.goto('https://whop.com/pulse/', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    // Ждем загрузки контента
    await page.waitForTimeout(3000);
    
    // Извлекаем данные
    const data = await page.evaluate(() => {
      const getText = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };
      
      return {
        activeUsers: getText('body'),
        timestamp: new Date().toISOString(),
        pageContent: document.body.innerText
      };
    });
    
    console.log('📊 Собранные данные:', data);
    
    // Сохранение в Supabase
    const { error } = await supabase
      .from('pulse_data')
      .insert([{
        active_users: data.activeUsers,
        raw_data: data
      }]);
    
    if (error) {
      console.error('❌ Ошибка сохранения:', error);
    } else {
      console.log('✅ Данные успешно сохранены');
    }
    
  } catch (error) {
    console.error('❌ Ошибка скрапинга:', error);
  } finally {
    await browser.close();
  }
}

// Основной цикл
async function main() {
  console.log('🎬 Запуск мониторинга Whop Pulse');
  console.log(`⏱️  Интервал: ${process.env.SCRAPE_INTERVAL / 1000} секунд`);
  
  // Первый запуск сразу
  await scrapeWhopPulse();
  
  // Затем по интервалу
  setInterval(async () => {
    await scrapeWhopPulse();
  }, parseInt(process.env.SCRAPE_INTERVAL) || 300000); // По умолчанию 5 минут
}

// Обработка завершения
process.on('SIGINT', () => {
  console.log('\n👋 Остановка скрапера...');
  process.exit(0);
});

main();