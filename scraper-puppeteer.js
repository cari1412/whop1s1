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
    
    // Ждем загрузки данных
    await page.waitForTimeout(5000);
    
    // Извлекаем данные
    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      
      // Парсим статистику (12.0M+ Active users, и т.д.)
      const statsPattern = /(\d+\.?\d*[MK]\+?)\s*(Active users|Creators|Products)/gi;
      const stats = {};
      let match;
      
      while ((match = statsPattern.exec(bodyText)) !== null) {
        const value = match[1];
        const label = match[2].toLowerCase();
        
        if (label.includes('active')) {
          stats.activeUsers = value;
        } else if (label.includes('creator')) {
          stats.creators = value;
        } else if (label.includes('product')) {
          stats.products = value;
        }
      }
      
      // Парсим новые поиски
      const searchesSection = bodyText.match(/New searches\n([\s\S]+?)(?=New transactions|$)/i);
      const newSearches = searchesSection ? 
        searchesSection[1].split('\n')
          .filter(line => line.trim() && !line.match(/\d+[smh] ago|Just now/))
          .slice(0, 5)
        : [];
      
      // Парсим новые транзакции
      const transactionsSection = bodyText.match(/New transactions\n([\s\S]+?)(?=New whops|$)/i);
      const newTransactions = transactionsSection ?
        transactionsSection[1].split('\n')
          .filter(line => line.trim() && !line.match(/Just now|\$\d+/))
          .slice(0, 5)
        : [];
      
      // Парсим новые whops
      const whopsSection = bodyText.match(/New whops\n([\s\S]+?)$/i);
      const newWhops = whopsSection ?
        whopsSection[1].split('\n')
          .filter(line => line.trim() && !line.match(/\d+[mh] ago/))
          .slice(0, 5)
        : [];
      
      return {
        ...stats,
        newSearches: newSearches.join(', '),
        newTransactions: newTransactions.join(', '),
        newWhops: newWhops.join(', '),
        fullText: bodyText.substring(0, 1000),
        timestamp: new Date().toISOString()
      };
    });
    
    console.log('📊 Собранные данные:');
    console.log('  👥 Active Users:', data.activeUsers || 'N/A');
    console.log('  🎨 Creators:', data.creators || 'N/A');
    console.log('  📦 Products:', data.products || 'N/A');
    console.log('  🔍 New Searches:', data.newSearches ? data.newSearches.substring(0, 50) + '...' : 'N/A');
    console.log('  💳 New Transactions:', data.newTransactions ? data.newTransactions.substring(0, 50) + '...' : 'N/A');
    console.log('  🆕 New Whops:', data.newWhops ? data.newWhops.substring(0, 50) + '...' : 'N/A');
    
    // Сохранение в Supabase
    const { data: insertedData, error } = await supabase
      .from('pulse_data')
      .insert([{
        active_users: data.activeUsers || null,
        creators: data.creators || null,
        products: data.products || null,
        new_searches: data.newSearches || null,
        new_transactions: data.newTransactions || null,
        new_whops: data.newWhops || null,
        raw_data: {
          fullText: data.fullText,
          timestamp: data.timestamp
        }
      }])
      .select();
    
    if (error) {
      console.error('❌ Ошибка сохранения:', error);
      console.log('\n💡 Совет: Отключи Row Level Security в Supabase');
      console.log('   Путь: Table Editor → pulse_data → Settings → Enable RLS = OFF');
    } else {
      console.log('✅ Данные успешно сохранены!');
      if (insertedData && insertedData[0]) {
        console.log('   ID записи:', insertedData[0].id);
      }
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
  console.log('║   🎬 Whop Pulse Monitor v1.0         ║');
  console.log('║      Puppeteer Edition                ║');
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