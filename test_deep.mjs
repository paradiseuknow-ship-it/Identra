const KEY = process.env.DEEPSEEK_API_KEY || 'sk-95533a3f00904e6da2c58c40ebf12164';
const base = 'https://api.deepseek.com';
try {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ping, reply with the single word: ok' }], max_tokens: 10, temperature: 0 }),
  });
  const txt = await res.text();
  console.log('HTTP', res.status);
  console.log(txt.slice(0, 400));
} catch (e) {
  console.log('FETCH_ERROR', e.message);
}
