const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Инициализация Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function scrapeWhopPulse() {
  console.log('🚀 Запуск скрапера...');
  
  let browser;
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
        '--single-process'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('📡 Загрузка страницы...');
    await page.goto('https://whop.com/pulse/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Ждем дольше, чтобы накопилось больше данных (30 секунд вместо 5)
    console.log('⏳ Ожидание накопления данных (30 сек)...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Извлекаем данные
    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      
      // === ПАРСИМ NEW SEARCHES (ключевые слова) ===
      const searchesSection = bodyText.match(/New searches\n([\s\S]+?)(?=New transactions|$)/i);
      let searches = [];
      
      if (searchesSection) {
        const lines = searchesSection[1].split('\n');
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          // Пропускаем временные метки
          if (line.match(/Just now|\d+[smh] ago/i)) {
            continue;
          }
          
          // Если есть текст - это поисковый запрос
          if (line && !line.match(/New transactions/i)) {
            searches.push({
              keyword: line,
              timestamp: new Date().toISOString()
            });
          }
          
          // Берем больше поисков - до 50
          if (searches.length >= 50) break;
        }
      }
      
      // === ПАРСИМ NEW TRANSACTIONS (название + цена) ===
      const transactionsSection = bodyText.match(/New transactions\n([\s\S]+?)(?=New whops|$)/i);
      let transactions = [];
      
      if (transactionsSection) {
        const lines = transactionsSection[1].split('\n');
        let currentTransaction = {};
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          // Пропускаем пустые строки и временные метки
          if (!line || line.match(/Just now|\d+[smh] ago/i)) {
            continue;
          }
          
          // Проверяем, есть ли цена в строке
          const priceMatch = line.match(/(\$|€|£|A\$|C\$|₹|¥)([\d,.]+)/);
          
          if (priceMatch) {
            // Это строка с ценой
            currentTransaction.price = priceMatch[0];
            currentTransaction.amount = parseFloat(priceMatch[2].replace(',', ''));
            currentTransaction.currency = priceMatch[1];
            
            // Если есть название, сохраняем транзакцию
            if (currentTransaction.name) {
              transactions.push({
                ...currentTransaction,
                timestamp: new Date().toISOString()
              });
              currentTransaction = {};
            }
          } else if (line.length > 0 && !line.match(/New whops/i)) {
            // Это название транзакции
            currentTransaction.name = line;
          }
          
          // Берем больше транзакций - до 50
          if (transactions.length >= 50) break;
        }
        
        // Если осталась незавершенная транзакция без цены
        if (currentTransaction.name && !transactions.find(t => t.name === currentTransaction.name)) {
          transactions.push({
            name: currentTransaction.name,
            price: null,
            amount: null,
            currency: null,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      return {
        searches,
        transactions,
        scrapedAt: new Date().toISOString()
      };
    });
    
    console.log('📊 Собранные данные:');
    console.log('');
    console.log(`🔍 NEW SEARCHES (${data.searches.length}):`);
    data.searches.slice(0, 10).forEach((search, idx) => {
      console.log(`  ${idx + 1}. "${search.keyword}"`);
    });
    if (data.searches.length > 10) {
      console.log(`  ... и ещё ${data.searches.length - 10}`);
    }
    
    console.log('');
    console.log(`💳 NEW TRANSACTIONS (${data.transactions.length}):`);
    data.transactions.slice(0, 10).forEach((tx, idx) => {
      console.log(`  ${idx + 1}. ${tx.name} - ${tx.price || 'N/A'}`);
    });
    if (data.transactions.length > 10) {
      console.log(`  ... и ещё ${data.transactions.length - 10}`);
    }
    console.log('');
    
    // Сохраняем каждый поиск отдельно
    if (data.searches.length > 0) {
      const { error: searchError } = await supabase
        .from('searches')
        .insert(data.searches);
      
      if (searchError) {
        console.error('❌ Ошибка сохранения поисков:', searchError.message);
      } else {
        console.log(`✅ Сохранено ${data.searches.length} поисковых запросов`);
      }
    }
    
    // Сохраняем каждую транзакцию отдельно
    if (data.transactions.length > 0) {
      const { error: txError } = await supabase
        .from('transactions')
        .insert(data.transactions);
      
      if (txError) {
        console.error('❌ Ошибка сохранения транзакций:', txError.message);
      } else {
        console.log(`✅ Сохранено ${data.transactions.length} транзакций`);
      }
    }
    
    if (data.searches.length === 0 && data.transactions.length === 0) {
      console.log('⚠️  Не найдено данных для сохранения');
    }
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   🎬 Whop Pulse Monitor v2.1         ║');
  console.log('║   Extended Data Collection            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`⏱️  Интервал: ${process.env.SCRAPE_INTERVAL / 1000} секунд`);
  console.log(`🗄️  База данных: ${process.env.SUPABASE_URL}`);
  console.log('');
  
  // Первый запуск
  await scrapeWhopPulse();
  
  console.log('\n⏳ Ожидание следующего запуска...\n');
  
  // Цикл
  setInterval(async () => {
    await scrapeWhopPulse();
    console.log('\n⏳ Ожидание следующего запуска...\n');
  }, parseInt(process.env.SCRAPE_INTERVAL) || 300000);
}

process.on('SIGINT', () => {
  console.log('\n👋 Остановка скрапера...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Критическая ошибка:', error.message);
  process.exit(1);
});

main();