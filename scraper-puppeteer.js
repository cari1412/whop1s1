const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Хранилище для уникальных данных
const seenSearches = new Set();
const seenTransactions = new Set();

// Константы для настройки
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 секунд между повторами
const PAGE_TIMEOUT = 60000; // 60 секунд вместо 30
const CYCLE_DELAY = 60000; // 60 секунд между циклами

async function scrapeWhopPulse() {
  console.log('🚀 Запуск расширенного скрапинга...');
  
  let browser = null;
  let page = null;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-accelerated-2d-canvas',
        '--disable-webgl',
        '--disable-web-security'
      ],
      timeout: 30000
    });
    
    page = await browser.newPage();
    
    // Устанавливаем таймаут для страницы
    page.setDefaultTimeout(PAGE_TIMEOUT);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // ВРЕМЕННО ОТКЛЮЧЕНО: блокировка ресурсов может ломать сайт
    // await page.setRequestInterception(true);
    // page.on('request', (req) => {
    //   const resourceType = req.resourceType();
    //   if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
    //     req.abort();
    //   } else {
    //     req.continue();
    //   }
    // });
    
    console.log('📡 Загрузка страницы...');
    await page.goto('https://whop.com/pulse/', {
      waitUntil: 'domcontentloaded', // Быстрее чем networkidle2
      timeout: PAGE_TIMEOUT
    });
    
    // Дополнительное ожидание для загрузки динамического контента
    console.log('⏰ Ожидание загрузки динамического контента (15 сек)...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // ДИАГНОСТИКА: Проверяем что видит браузер
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('📋 Первые 500 символов страницы:');
    console.log(bodyText.substring(0, 500));
    console.log('...\n');
    
    // Проверяем наличие ключевых секций
    const hasSearches = bodyText.includes('New searches');
    const hasTransactions = bodyText.includes('New transactions');
    console.log(`🔍 Найдено "New searches": ${hasSearches ? '✅' : '❌'}`);
    console.log(`💳 Найдено "New transactions": ${hasTransactions ? '✅' : '❌'}\n`);
    
    const allSearches = [];
    const allTransactions = [];
    
    // Мониторим страницу 4 минуты (240 секунд), собирая данные каждые 10 секунд
    const iterations = 24; // 24 * 10сек = 240 секунд
    
    console.log(`⏳ Мониторинг страницы в течение ${iterations * 10} секунд...`);
    
    for (let i = 0; i < iterations; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Проверяем, что страница все еще активна
      if (page.isClosed()) {
        throw new Error('Page was closed unexpectedly');
      }
      
      const data = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        
        // Парсим поиски
        const searchesSection = bodyText.match(/New searches\n([\s\S]+?)(?=New transactions|$)/i);
        let searches = [];
        
        if (searchesSection) {
          const lines = searchesSection[1].split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.match(/Just now|\d+[smh] ago|New transactions/i)) {
              searches.push(line);
            }
            if (searches.length >= 20) break;
          }
        }
        
        // Парсим транзакции
        const transactionsSection = bodyText.match(/New transactions\n([\s\S]+?)(?=New whops|$)/i);
        let transactions = [];
        
        if (transactionsSection) {
          const lines = transactionsSection[1].split('\n');
          let currentTx = {};
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.match(/Just now|\d+[smh] ago/i)) continue;
            
            const priceMatch = line.match(/(\$|€|£|A\$|C\$|₹|¥)([\d,.]+)/);
            
            if (priceMatch) {
              currentTx.price = priceMatch[0];
              currentTx.amount = parseFloat(priceMatch[2].replace(',', ''));
              currentTx.currency = priceMatch[1];
              
              if (currentTx.name) {
                transactions.push({...currentTx});
                currentTx = {};
              }
            } else if (line.length > 0 && !line.match(/New whops/i)) {
              currentTx.name = line;
            }
            
            if (transactions.length >= 20) break;
          }
          
          if (currentTx.name) {
            transactions.push({
              name: currentTx.name,
              price: null,
              amount: null,
              currency: null
            });
          }
        }
        
        return { searches, transactions };
      });
      
      // Добавляем только уникальные поиски
      data.searches.forEach(keyword => {
        if (!seenSearches.has(keyword)) {
          seenSearches.add(keyword);
          allSearches.push({
            keyword,
            timestamp: new Date().toISOString()
          });
        }
      });
      
      // Добавляем только уникальные транзакции
      data.transactions.forEach(tx => {
        const key = `${tx.name}|${tx.price}`;
        if (!seenTransactions.has(key)) {
          seenTransactions.add(key);
          allTransactions.push({
            ...tx,
            timestamp: new Date().toISOString()
          });
        }
      });
      
      // Логируем прогресс каждые 30 секунд
      if ((i + 1) % 3 === 0) {
        console.log(`   📈 Итерация ${i + 1}/${iterations}: Поиски ${allSearches.length}, Транзакции ${allTransactions.length}`);
      }
    }
    
    console.log('');
    console.log('📊 Итоговые собранные данные:');
    console.log(`🔍 Уникальных поисков: ${allSearches.length}`);
    console.log(`💳 Уникальных транзакций: ${allTransactions.length}`);
    console.log('');
    
    // Показываем примеры
    if (allSearches.length > 0) {
      console.log('Примеры поисков:');
      allSearches.slice(0, 5).forEach((s, i) => console.log(`  ${i + 1}. "${s.keyword}"`));
      if (allSearches.length > 5) console.log(`  ... и ещё ${allSearches.length - 5}`);
      console.log('');
    }
    
    if (allTransactions.length > 0) {
      console.log('Примеры транзакций:');
      allTransactions.slice(0, 5).forEach((t, i) => console.log(`  ${i + 1}. ${t.name} - ${t.price || 'N/A'}`));
      if (allTransactions.length > 5) console.log(`  ... и ещё ${allTransactions.length - 5}`);
      console.log('');
    }
    
    // Сохраняем в базу
    if (allSearches.length > 0) {
      const { error } = await supabase.from('searches').insert(allSearches);
      if (error) {
        console.error('❌ Ошибка сохранения поисков:', error.message);
      } else {
        console.log(`✅ Сохранено ${allSearches.length} поисковых запросов`);
      }
    }
    
    if (allTransactions.length > 0) {
      const { error } = await supabase.from('transactions').insert(allTransactions);
      if (error) {
        console.error('❌ Ошибка сохранения транзакций:', error.message);
      } else {
        console.log(`✅ Сохранено ${allTransactions.length} транзакций`);
      }
    }
    
    // Очищаем старые записи из памяти (оставляем последние 1000)
    if (seenSearches.size > 1000) {
      const arr = Array.from(seenSearches);
      seenSearches.clear();
      arr.slice(-1000).forEach(s => seenSearches.add(s));
    }
    if (seenTransactions.size > 1000) {
      const arr = Array.from(seenTransactions);
      seenTransactions.clear();
      arr.slice(-1000).forEach(t => seenTransactions.add(t));
    }
    
    return true; // Успешное выполнение
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return false; // Ошибка выполнения
  } finally {
    // КРИТИЧЕСКИ ВАЖНО: всегда закрываем браузер
    if (page && !page.isClosed()) {
      try {
        await page.close();
      } catch (e) {
        console.error('Ошибка закрытия страницы:', e.message);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Ошибка закрытия браузера:', e.message);
      }
    }
  }
}

async function scrapeWithRetry() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n🎯 Попытка ${attempt}/${MAX_RETRIES}`);
    
    const success = await scrapeWhopPulse();
    
    if (success) {
      return true;
    }
    
    if (attempt < MAX_RETRIES) {
      console.log(`⏳ Ожидание ${RETRY_DELAY / 1000} секунд перед повтором...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  
  console.error(`❌ Не удалось выполнить скрапинг после ${MAX_RETRIES} попыток`);
  return false;
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🎬 Whop Pulse Monitor v3.1         ║');
  console.log('║   Continuous Monitoring Mode          ║');
  console.log('║   + Enhanced Error Handling           ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`⏱️  Интервал: ${CYCLE_DELAY / 1000} секунд`);
  console.log(`🔄 Повторов при ошибке: ${MAX_RETRIES}`);
  console.log(`⏰ Таймаут загрузки: ${PAGE_TIMEOUT / 1000} секунд`);
  console.log(`🗄️  База данных: ${process.env.SUPABASE_URL}`);
  console.log('');
  
  let cycleCount = 0;
  
  // Запускаем непрерывно
  while (true) {
    cycleCount++;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📅 Цикл #${cycleCount} | ${new Date().toLocaleString('ru-RU')}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    await scrapeWithRetry();
    
    console.log(`\n⏳ Ожидание ${CYCLE_DELAY / 1000} секунд перед следующим циклом...\n`);
    await new Promise(resolve => setTimeout(resolve, CYCLE_DELAY));
    
    // Принудительная сборка мусора каждые 10 циклов (если доступна)
    if (cycleCount % 10 === 0 && global.gc) {
      console.log('🧹 Запуск сборки мусора...');
      global.gc();
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Получен сигнал остановки (SIGINT)...');
  console.log('🛑 Останавливаем скрапер...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Получен сигнал остановки (SIGTERM)...');
  console.log('🛑 Останавливаем скрапер...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Критическая ошибка (uncaughtException):', error.message);
  console.error(error.stack);
  // Не завершаем процесс сразу, даем время на cleanup
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Необработанное отклонение промиса:', reason);
  // Логируем, но продолжаем работу
});

// Запускаем
main().catch(error => {
  console.error('💥 Фатальная ошибка в main():', error);
  process.exit(1);
});