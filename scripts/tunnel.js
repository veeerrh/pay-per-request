// Starts ONE public HTTPS tunnel to the gateway (:8080) and writes PUBLIC_BASE_URL into .env.
// Usage: node scripts/tunnel.js [cloudflared|ngrok]
// cloudflared needs no account (the URL changes on every restart). ngrok needs a local auth token set with `ngrok config add-authtoken`.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ENV = path.join(__dirname, '..', '.env');
const tool = process.argv[2] || 'cloudflared';

function saveUrl(url) {
  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  env = /^PUBLIC_BASE_URL=.*$/m.test(env) ? env.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${url}`) : `${env.replace(/\n?$/, '\n')}PUBLIC_BASE_URL=${url}\n`;
  fs.writeFileSync(ENV, env);
  console.log(`\nPUBLIC_BASE_URL=${url} saved to .env`);
  console.log('Next: npm run start:public   (in another terminal; keep this one open)');
}

if (tool === 'cloudflared') {
  const p = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:8080'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let found = false;
  const onData = (d) => { const t = d.toString(); const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m && !found) { found = true; saveUrl(m[0]); } process.stdout.write(t.includes('trycloudflare') || t.includes('ERR') ? t : ''); };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', () => console.error('cloudflared is not installed. Install it, or use: node scripts/tunnel.js ngrok'));
  p.on('exit', (c) => process.exit(c || 0));
} else if (tool === 'ngrok') {
  const p = spawn('ngrok', ['http', '8080', '--log', 'stdout'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  p.on('error', () => console.error('ngrok is not installed'));
  const poll = setInterval(async () => {
    try { const j = await (await fetch('http://127.0.0.1:4040/api/tunnels')).json(); const t = j.tunnels.find((x) => x.public_url.startsWith('https://')); if (t) { clearInterval(poll); saveUrl(t.public_url); } } catch { /* not up yet */ }
  }, 1500);
  p.on('exit', (c) => process.exit(c || 0));
} else { console.error('usage: node scripts/tunnel.js [cloudflared|ngrok]'); process.exit(1); }
