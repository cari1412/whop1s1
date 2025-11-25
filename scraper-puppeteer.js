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
const PAGE_TIMEOUT = 30000; // 30 секунд (снижено с 60)
const CYCLE_DELAY = 60000; // 60 секунд между циклами
const MONITORING_TIME = 45000; // 45 секунд мониторинга (снижено со 240)
const CHECK_INTERVAL = 5000; // 5 секунд между проверками

async function scrapeWhopPulse() {
  console.log('🚀 Запуск расширенного скрапинга...');
  
  let browser = null;
  let page = null;
  
  try {
    // КРИТИЧЕСКИ ВАЖНО: правильные аргументы для Railway
    browser = await puppeteer.launch({
      headless: true, // Исправлено: убран устаревший 'new'
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // ВАЖНО для Railway
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-zygote', // ВАЖНО для контейнеров
        '--disable-accelerated-2d-canvas',
        '--disable-webgl',
        '--disable-web-security',
        // УБРАНО: --single-process (это причина крашей!)
        
        // Ограничение памяти
        '--js-flags="--max-old-space-size=512"',
        '--disable-blink-features=AutomationControlled'
      ],
      timeout: 30000,
      // Дополнительные настройки для стабильности
      protocolTimeout: 30000,
      ignoreHTTPSErrors: true
    });
    
    page = await browser.newPage();
    
    // Устанавливаем таймауты
    page.setDefaultTimeout(PAGE_TIMEOUT);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    
    // Устанавливаем viewport для экономии памяти
    await page.setViewport({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1
    });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Блокируем тяжелые ресурсы для экономии памяти
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      const url = req.url();
      
      // Блокируем изображения, шрифты, медиа
      if (['image', 'font', 'media', 'imageset'].includes(resourceType)) {
        req.abort();
      }
      // Блокируем аналитику и рекламу
      else if (url.includes('analytics') || 
               url.includes('tracking') || 
               url.includes('ads') ||
               url.includes('doubleclick') ||
               url.includes('google-analytics')) {
        req.abort();
      }
      else {
        req.continue();
      }
    });
    
    console.log('📡 Загрузка страницы...');
    await page.goto('https://whop.com/pulse/', {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT
    });
    
    // Ждем инициализацию контента
    console.log('⏰ Ожидание загрузки контента (10 сек)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const allSearches = [];
    const allTransactions = [];
    
    // Мониторим страницу 45 секунд вместо 240
    const iterations = Math.floor(MONITORING_TIME / CHECK_INTERVAL);
    
    console.log(`⏳ Мониторинг страницы в течение ${MONITORING_TIME / 1000} секунд (${iterations} проверок)...`);
    
    for (let i = 0; i < iterations; i++) {
      await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
      
      // Проверяем, что страница все еще активна
      if (page.isClosed()) {
        throw new Error('Page was closed unexpectedly');
      }
      
      try {
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
        
        // Логируем прогресс каждые 15 секунд
        if ((i + 1) % 3 === 0) {
          console.log(`   📈 Итерация ${i + 1}/${iterations}: Поиски ${allSearches.length}, Транзакции ${allTransactions.length}`);
        }
      } catch (evalError) {
        console.error(`⚠️ Ошибка парсинга на итерации ${i + 1}:`, evalError.message);
        // Продолжаем работу
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
    
    // Очищаем старые записи из памяти (оставляем последние 500)
    if (seenSearches.size > 500) {
      const arr = Array.from(seenSearches);
      seenSearches.clear();
      arr.slice(-500).forEach(s => seenSearches.add(s));
      console.log('🧹 Очищена память поисков');
    }
    if (seenTransactions.size > 500) {
      const arr = Array.from(seenTransactions);
      seenTransactions.clear();
      arr.slice(-500).forEach(t => seenTransactions.add(t));
      console.log('🧹 Очищена память транзакций');
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
        console.log('🔒 Страница закрыта');
      } catch (e) {
        console.error('⚠️ Ошибка закрытия страницы:', e.message);
      }
    }
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Браузер закрыт');
      } catch (e) {
        console.error('⚠️ Ошибка закрытия браузера:', e.message);
      }
    }
    
    // Принудительная очистка памяти
    if (global.gc) {
      global.gc();
      console.log('🧹 Сборка мусора выполнена');
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
  console.log('║   🎬 Whop Pulse Monitor v4.0         ║');
  console.log('║   Railway Optimized Edition           ║');
  console.log('║   + Memory Management                 ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`⏱️  Интервал между циклами: ${CYCLE_DELAY / 1000} сек`);
  console.log(`⏰ Время мониторинга: ${MONITORING_TIME / 1000} сек`);
  console.log(`🔄 Повторов при ошибке: ${MAX_RETRIES}`);
  console.log(`⏰ Таймаут загрузки: ${PAGE_TIMEOUT / 1000} сек`);
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
    
    // Принудительная сборка мусора каждые 5 циклов
    if (cycleCount % 5 === 0 && global.gc) {
      console.log('🧹 Плановая сборка мусора...');
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
  // Даем время на cleanup
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