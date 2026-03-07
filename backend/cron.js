// cron.js — Triggers the bot via HTTP
// Called by: Render Cron Job, UptimeRobot, or manually
// Usage: node cron.js
// Or set UptimeRobot to ping: https://instraeach.onrender.com/api/bot/run?key=instraeach_cron_2024

const https = require('https');

const BASE_URL = process.env.APP_URL || 'instraeach.onrender.com';
const CRON_KEY = process.env.CRON_KEY || 'instraeach_cron_2024';

const url = `https://${BASE_URL}/api/bot/run?key=${CRON_KEY}`;
console.log('[Cron]', new Date().toISOString(), 'Triggering bot:', url);

https.get(url, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    console.log('[Cron] Response:', res.statusCode, data);
    process.exit(0);
  });
}).on('error', e => {
  console.error('[Cron] Error:', e.message);
  process.exit(1);
});