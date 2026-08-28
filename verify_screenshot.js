const http = require('http');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 7777, path, method, headers: { 'Content-Type': 'application/json' } };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data.slice(0, 200) }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // 1. 列出配置
  let list = await req('GET', '/api/profiles');
  console.log('profiles status:', list.status, list.body);
  if (!list.body || !list.body.length) {
    console.log('no profiles');
    return;
  }
  const id = list.body[0].id;
  console.log('using profile id:', id);

  // 2. 启动
  const launch = await req('POST', `/api/browser/${id}/launch`, {});
  console.log('launch status:', launch.status, JSON.stringify(launch.body).slice(0, 200));

  // 3. 等 3 秒
  await new Promise(r => setTimeout(r, 3000));

  // 4. 截图
  const shot = await req('GET', `/api/browser/${id}/screenshot?t=${Date.now()}`);
  console.log('screenshot status:', shot.status);
  if (shot.body && shot.body.data) {
    console.log('screenshot data type:', typeof shot.body.data);
    console.log('screenshot data keys:', Object.keys(shot.body.data));
    if (typeof shot.body.data === 'string') {
      console.log('screenshot data length:', shot.body.data.length);
      console.log('screenshot data prefix:', shot.body.data.slice(0, 80));
      require('fs').writeFileSync('C:/tmp/fpb_screenshot_debug.png', Buffer.from(shot.body.data, 'base64'));
      console.log('saved to C:/tmp/fpb_screenshot_debug.png');
    } else {
      console.log('screenshot data value:', shot.body.data);
    }
  } else {
    console.log('screenshot body:', JSON.stringify(shot.body).slice(0, 300));
  }

  // 5. 停止
  await req('POST', `/api/browser/${id}/stop`, {});
})();
