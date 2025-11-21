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

async function scrapeWhopPulse() {
  console.log('🚀 Запуск расширенного скрапинга...');
  
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
    
    const allSearches = [];
    const allTransactions = [];
    
    // Мониторим страницу 4 минуты (240 секунд), собирая данные каждые 10 секунд
    const iterations = 24; // 24 * 10сек = 240 секунд
    
    console.log(`⏳ Мониторинг страницы в течение ${iterations * 10} секунд...`);
    
    for (let i = 0; i < iterations; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      
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
  console.log('║   🎬 Whop Pulse Monitor v3.0         ║');
  console.log('║   Continuous Monitoring Mode          ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`⏱️  Интервал: ${process.env.SCRAPE_INTERVAL / 1000} секунд`);
  console.log(`🗄️  База данных: ${process.env.SUPABASE_URL}`);
  console.log('');
  
  // Запускаем непрерывно
  while (true) {
    await scrapeWhopPulse();
    console.log('\n⏳ Ожидание 60 секунд перед следующим циклом...\n');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
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