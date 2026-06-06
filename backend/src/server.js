'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const APP = process.env.APP_DIR || '/opt/mini-cpanel';
const DATA = path.join(APP, 'data');
const SITES = path.join(APP, 'sites');
const BACKUPS = path.join(APP, 'backups');
const LOGS = path.join(DATA, 'logs');
const PUBLIC = path.join(APP, 'backend', 'public');
const ENV_FILE = path.join(DATA, 'env');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

for (const dir of [DATA, SITES, BACKUPS, LOGS, PUBLIC, path.join(DATA, 'sessions')]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^=#]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  });
  return out;
}
const env = { ...readEnvFile(), ...process.env };
const ADMIN_USER = env.ADMIN_USER || 'admin';
const ADMIN_PASS = env.ADMIN_PASS || 'admin';
const SESSION_SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function fileFor(name) { return path.join(DATA, name); }
function readJson(name, fallback) {
  const p = fileFor(name);
  if (!fs.existsSync(p)) writeJson(name, fallback);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(name, value) {
  const p = fileFor(name);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}
function appendLog(name, line) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(path.join(LOGS, name), `[${new Date().toISOString()}] ${line}\n`);
}
function safeName(input) {
  return String(input || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
function validateRepo(url) {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(String(url || ''));
}
function validateDomain(domain) {
  if (!domain) return true;
  return /^(?:\*\.)?(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[A-Za-z]{2,63}$/.test(String(domain));
}
function run(cmd, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: options.timeout || 120000, maxBuffer: options.maxBuffer || 1024 * 1024 * 10, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && error.code ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? error.message : '' });
    });
    if (options.stdin) child.stdin.end(options.stdin);
  });
}
async function sh(command, options = {}) { return run('bash', ['-lc', command], options); }
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}
function publicIp(req) {
  return env.PUBLIC_IP || req.headers['x-forwarded-host'] || req.hostname || 'IP-VPS';
}
function nextPort() {
  const settings = readJson('settings.json', { nextSitePort: 4100 });
  const port = Number(settings.nextSitePort || 4100);
  settings.nextSitePort = port + 1;
  writeJson('settings.json', settings);
  return port;
}

async function getDisk() {
  const r = await sh("df -B1 / | tail -1 | awk '{print $2\" \"$3\" \"$4\" \"$5}'");
  const [total, used, free, percent] = r.stdout.trim().split(/\s+/);
  return { total: Number(total || 0), used: Number(used || 0), free: Number(free || 0), percent: percent || '0%' };
}
async function getCpuPercent() {
  const a = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  await new Promise((r) => setTimeout(r, 350));
  const b = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idleA = a[3] + (a[4] || 0), idleB = b[3] + (b[4] || 0);
  const totalA = a.reduce((x, y) => x + y, 0), totalB = b.reduce((x, y) => x + y, 0);
  const total = totalB - totalA, idle = idleB - idleA;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}
async function systemHealth() {
  const [disk, cpu, docker, nginx, mini, ports, updates] = await Promise.all([
    getDisk(), getCpuPercent(),
    sh('systemctl is-active docker || true'),
    sh('systemctl is-active nginx || true'),
    sh('systemctl is-active mini-cpanel || true'),
    sh("ss -tulnp | grep -E ':(80|443|3000|8090)\\b' || true"),
    sh('apt list --upgradable 2>/dev/null | tail -n +2 | wc -l || true')
  ]);
  return {
    hostname: os.hostname(), platform: os.platform(), arch: os.arch(), uptime: os.uptime(),
    load: os.loadavg(), cpuPercent: cpu, cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem(), percent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100) },
    disk,
    services: { docker: docker.stdout.trim(), nginx: nginx.stdout.trim(), miniPanel: mini.stdout.trim() },
    ports: ports.stdout.trim().split('\n').filter(Boolean),
    updates: Number(updates.stdout.trim() || 0),
    time: new Date().toISOString()
  };
}
async function dockerContainers() {
  const r = await sh("docker ps -a --format '{{json .}}' 2>/dev/null || true");
  return r.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
}
function detectProject(source) {
  const exists = (p) => fs.existsSync(path.join(source, p));
  if (exists('artisan') && exists('composer.json')) return 'laravel';
  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.build) return 'node-build';
      if (scripts.start) return 'node';
    } catch {}
    return 'node';
  }
  if (exists('index.html') || exists('dist') || exists('build')) return 'static';
  return 'static';
}
function writeDockerfile(siteDir, type) {
  const dockerfile = path.join(siteDir, 'Dockerfile.panel');
  if (type === 'laravel') {
    fs.writeFileSync(dockerfile, `FROM php:8.3-apache\nRUN apt-get update && apt-get install -y git unzip libzip-dev && docker-php-ext-install pdo pdo_mysql zip\nCOPY source/ /var/www/html/\nRUN a2enmod rewrite && if [ -f composer.json ]; then php -r "copy('https://getcomposer.org/installer','composer-setup.php');" && php composer-setup.php --install-dir=/usr/local/bin --filename=composer && composer install --no-dev --optimize-autoloader || true; fi\nRUN chown -R www-data:www-data /var/www/html\nEXPOSE 80\n`);
  } else if (type === 'node' || type === 'node-build') {
    fs.writeFileSync(dockerfile, `FROM node:20-alpine\nWORKDIR /app\nCOPY source/package*.json ./\nRUN npm install --omit=dev || npm install\nCOPY source/ ./\nRUN npm run build || true\nENV NODE_ENV=production PORT=3000 HOST=0.0.0.0\nEXPOSE 3000\nCMD ["sh","-lc","npm start || npm run preview -- --host 0.0.0.0 --port 3000 || npx serve -s dist -l 3000 || npx serve -s build -l 3000"]\n`);
  } else {
    fs.writeFileSync(dockerfile, `FROM nginx:alpine\nCOPY source/ /usr/share/nginx/html/\nRUN if [ -d /usr/share/nginx/html/dist ]; then cp -r /usr/share/nginx/html/dist/* /usr/share/nginx/html/; fi && if [ -d /usr/share/nginx/html/build ]; then cp -r /usr/share/nginx/html/build/* /usr/share/nginx/html/; fi\nEXPOSE 80\n`);
  }
  return dockerfile;
}
async function upsertNginxDomain(site) {
  if (!site.domain) return { ok: true, skipped: true };
  const conf = `/etc/nginx/sites-available/site-${site.name}.conf`;
  const upstreamPort = site.port;
  const body = `server {\n    listen 80;\n    server_name ${site.domain};\n    client_max_body_size 200M;\n    location / {\n        proxy_pass http://127.0.0.1:${upstreamPort};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
  fs.writeFileSync(conf, body);
  await sh(`ln -sf ${conf} /etc/nginx/sites-enabled/site-${site.name}.conf && nginx -t && systemctl reload nginx`);
  return { ok: true, conf };
}
async function deploySite({ name, repoUrl, domain, envText }) {
  name = safeName(name);
  if (!name) throw new Error('Tên site không hợp lệ');
  if (!validateRepo(repoUrl)) throw new Error('Repo GitHub không hợp lệ. Chỉ dùng https://github.com/user/repo');
  if (domain && !validateDomain(domain)) throw new Error('Domain không hợp lệ');
  const sites = readJson('sites.json', []);
  if (sites.find((s) => s.name === name)) throw new Error('Tên site đã tồn tại');
  const siteDir = path.join(SITES, name);
  const source = path.join(siteDir, 'source');
  fs.rmSync(siteDir, { recursive: true, force: true });
  fs.mkdirSync(siteDir, { recursive: true });
  appendLog('deploy.log', `START ${name} ${repoUrl}`);
  let r = await sh(`git clone --depth=1 ${JSON.stringify(repoUrl)} ${JSON.stringify(source)}`, { timeout: 180000 });
  if (!r.ok) throw new Error(`Git clone lỗi: ${r.stderr || r.stdout}`);
  if (envText) fs.writeFileSync(path.join(source, '.env'), String(envText));
  const type = detectProject(source);
  const port = nextPort();
  const image = `mini-site-${name}:latest`;
  const container = `mini-site-${name}`;
  writeDockerfile(siteDir, type);
  r = await sh(`cd ${JSON.stringify(siteDir)} && docker build -f Dockerfile.panel -t ${JSON.stringify(image)} .`, { timeout: 600000, maxBuffer: 1024 * 1024 * 30 });
  appendLog('deploy.log', `BUILD ${name} ok=${r.ok}\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  if (!r.ok) throw new Error(`Docker build lỗi: ${r.stderr || r.stdout}`);
  await sh(`docker rm -f ${JSON.stringify(container)} >/dev/null 2>&1 || true`);
  const internalPort = type === 'node' || type === 'node-build' ? 3000 : 80;
  r = await sh(`docker run -d --restart unless-stopped --name ${JSON.stringify(container)} -p 127.0.0.1:${port}:${internalPort} ${JSON.stringify(image)}`);
  if (!r.ok) throw new Error(`Docker run lỗi: ${r.stderr || r.stdout}`);
  const site = { id: crypto.randomUUID(), name, repoUrl, domain: domain || '', type, image, container, port, status: 'running', url: domain ? `http://${domain}` : `http://IP-VPS:${port}`, source, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  sites.push(site);
  writeJson('sites.json', sites);
  await upsertNginxDomain(site);
  appendLog('deploy.log', `DONE ${name} port=${port} type=${type}`);
  return site;
}
async function cyberStatus(req) {
  const services = ['lscpd', 'cyberpanel', 'lsws'];
  const statuses = {};
  for (const s of services) statuses[s] = (await sh(`systemctl is-active ${s} 2>/dev/null || true`)).stdout.trim();
  const port = (await sh("ss -tulnp | grep ':8090' || true")).stdout.trim();
  const installed = fs.existsSync('/usr/local/CyberCP') || fs.existsSync('/usr/local/lsws') || port.length > 0;
  return { installed, statuses, port8090: Boolean(port), portLine: port, url: `https://${publicIp(req)}:8090`, note: 'IP dùng self-signed HTTPS. Muốn SSL tin cậy cần domain thật.' };
}

const app = express();
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(morgan('combined', { stream: fs.createWriteStream(path.join(LOGS, 'access.log'), { flags: 'a' }) }));
app.use(session({
  store: new FileStore({ path: path.join(DATA, 'sessions'), retries: 0 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 }
}));

app.get('/health', async (req, res) => res.json({ ok: true, app: 'Momnz VPS Panel PRO', version: '4.0.0', time: new Date().toISOString() }));
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.user = { username: ADMIN_USER, role: 'admin' };
    return res.json({ ok: true, user: req.session.user });
  }
  res.status(401).json({ ok: false, error: 'Sai username hoặc password' });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ ok: true, user: req.session.user || null }));

app.use('/api', requireAuth);
app.get('/api/dashboard', async (req, res) => {
  const sites = readJson('sites.json', []);
  const backups = fs.readdirSync(BACKUPS).filter(Boolean);
  const health = await systemHealth();
  const cyber = await cyberStatus(req);
  const containers = await dockerContainers();
  res.json({ ok: true, stats: { sites: sites.length, runningSites: sites.filter((s) => s.status === 'running').length, backups: backups.length, containers: containers.length, cyberpanel: cyber.installed && cyber.port8090 ? 'running' : 'inactive' }, health, recentSites: sites.slice(-6).reverse(), recentBackups: backups.sort().reverse().slice(0, 6) });
});
app.get('/api/healthcare', async (req, res) => {
  const h = await systemHealth();
  const checks = [];
  checks.push({ name: 'CPU usage', status: h.cpuPercent < 85 ? 'good' : 'danger', value: `${h.cpuPercent}%`, hint: h.cpuPercent < 85 ? 'CPU ổn định' : 'CPU cao, cần kiểm tra process' });
  checks.push({ name: 'RAM usage', status: h.memory.percent < 85 ? 'good' : 'danger', value: `${h.memory.percent}%`, hint: h.memory.percent < 85 ? 'RAM ổn định' : 'RAM cao, cân nhắc swap/nâng RAM' });
  checks.push({ name: 'Disk usage', status: parseInt(h.disk.percent) < 85 ? 'good' : 'danger', value: h.disk.percent, hint: parseInt(h.disk.percent) < 85 ? 'Disk còn dung lượng' : 'Disk gần đầy, cần clean backup/log' });
  checks.push({ name: 'Nginx', status: h.services.nginx === 'active' ? 'good' : 'danger', value: h.services.nginx, hint: 'Reverse proxy cổng 80' });
  checks.push({ name: 'Docker', status: h.services.docker === 'active' ? 'good' : 'warning', value: h.services.docker, hint: 'Chạy website container' });
  checks.push({ name: 'Mini Panel', status: h.services.miniPanel === 'active' ? 'good' : 'danger', value: h.services.miniPanel, hint: 'Backend quản trị panel' });
  checks.push({ name: 'Security updates', status: h.updates < 30 ? 'good' : 'warning', value: `${h.updates} packages`, hint: 'Nhiều update thì nên apt upgrade lúc ít traffic' });
  res.json({ ok: true, health: h, checks });
});
app.get('/api/sites', (req, res) => res.json({ ok: true, sites: readJson('sites.json', []) }));
app.post('/api/sites', (req, res) => {
  const name = safeName(req.body.name);
  const domain = String(req.body.domain || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Tên site không hợp lệ' });
  if (domain && !validateDomain(domain)) return res.status(400).json({ ok: false, error: 'Domain không hợp lệ' });
  const sites = readJson('sites.json', []);
  if (sites.find((s) => s.name === name)) return res.status(409).json({ ok: false, error: 'Tên site đã tồn tại' });
  const site = { id: crypto.randomUUID(), name, domain, type: 'manual', status: 'created', createdAt: new Date().toISOString() };
  sites.push(site); writeJson('sites.json', sites); res.json({ ok: true, site });
});
app.post('/api/deploy', async (req, res) => {
  try { const site = await deploySite(req.body || {}); res.json({ ok: true, site }); }
  catch (e) { appendLog('deploy.log', `ERROR ${e.message}`); res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/sites/:name/start', async (req, res) => {
  const name = safeName(req.params.name); const sites = readJson('sites.json', []); const site = sites.find((s) => s.name === name);
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  const r = await sh(`docker start ${JSON.stringify(site.container)} 2>&1`); site.status = r.ok ? 'running' : 'error'; site.updatedAt = new Date().toISOString(); writeJson('sites.json', sites); res.json({ ok: r.ok, site, output: r.stdout || r.stderr });
});
app.post('/api/sites/:name/stop', async (req, res) => {
  const name = safeName(req.params.name); const sites = readJson('sites.json', []); const site = sites.find((s) => s.name === name);
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  const r = await sh(`docker stop ${JSON.stringify(site.container)} 2>&1`); site.status = r.ok ? 'stopped' : 'error'; site.updatedAt = new Date().toISOString(); writeJson('sites.json', sites); res.json({ ok: r.ok, site, output: r.stdout || r.stderr });
});
app.delete('/api/sites/:name', async (req, res) => {
  const name = safeName(req.params.name); let sites = readJson('sites.json', []); const site = sites.find((s) => s.name === name);
  if (!site) return res.status(404).json({ ok: false, error: 'Site not found' });
  await sh(`docker rm -f ${JSON.stringify(site.container)} >/dev/null 2>&1 || true`);
  await sh(`rm -f /etc/nginx/sites-enabled/site-${name}.conf /etc/nginx/sites-available/site-${name}.conf && nginx -t && systemctl reload nginx || true`);
  fs.rmSync(path.join(SITES, name), { recursive: true, force: true });
  sites = sites.filter((s) => s.name !== name); writeJson('sites.json', sites); res.json({ ok: true });
});
app.get('/api/sites/:name/logs', async (req, res) => {
  const name = safeName(req.params.name); const site = readJson('sites.json', []).find((s) => s.name === name);
  if (!site) return res.status(404).type('text/plain').send('Site not found');
  const r = await sh(`docker logs --tail=300 ${JSON.stringify(site.container)} 2>&1 || true`); res.type('text/plain').send(r.stdout || r.stderr || '');
});
app.get('/api/domains', (req, res) => res.json({ ok: true, domains: readJson('domains.json', []) }));
app.post('/api/domains', async (req, res) => {
  const domain = String(req.body.domain || '').trim().toLowerCase(); const siteName = safeName(req.body.siteName);
  if (!validateDomain(domain)) return res.status(400).json({ ok: false, error: 'Domain không hợp lệ' });
  const sites = readJson('sites.json', []); const site = sites.find((s) => s.name === siteName);
  if (!site || !site.port) return res.status(404).json({ ok: false, error: 'Site chưa deploy hoặc chưa có port' });
  site.domain = domain; await upsertNginxDomain(site); writeJson('sites.json', sites);
  const domains = readJson('domains.json', []); domains.push({ id: crypto.randomUUID(), domain, siteName, createdAt: new Date().toISOString() }); writeJson('domains.json', domains);
  res.json({ ok: true, domain, site });
});
app.post('/api/domains/:domain/ssl', async (req, res) => {
  const domain = String(req.params.domain || '').trim().toLowerCase(); if (!validateDomain(domain)) return res.status(400).json({ ok: false, error: 'Domain không hợp lệ' });
  const r = await sh(`certbot --nginx -d ${JSON.stringify(domain)} --non-interactive --agree-tos -m admin@${domain} --redirect`, { timeout: 300000 });
  res.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr });
});
app.get('/api/backups', (req, res) => res.json({ ok: true, backups: fs.readdirSync(BACKUPS).sort().reverse().map((n) => ({ name: n, size: fs.statSync(path.join(BACKUPS, n)).size, createdAt: fs.statSync(path.join(BACKUPS, n)).mtime })) }));
app.post('/api/backups', async (req, res) => {
  const name = `mini-cpanel-full-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  const out = path.join(BACKUPS, name);
  const r = await sh(`tar -czf ${JSON.stringify(out)} -C /opt mini-cpanel/data mini-cpanel/sites mini-cpanel/backend mini-cpanel/frontend 2>/dev/null || true`, { timeout: 300000 });
  res.json({ ok: true, backup: { name, size: fs.existsSync(out) ? fs.statSync(out).size : 0 }, output: r.stderr || r.stdout });
});
app.get('/api/monitor', async (req, res) => res.json({ ok: true, health: await systemHealth(), containers: await dockerContainers() }));
app.get('/api/vps/processes', async (req, res) => { const r = await sh("ps aux --sort=-%mem | head -25"); res.json({ ok: true, output: r.stdout }); });
app.post('/api/vps/action', async (req, res) => {
  const action = String(req.body.action || '');
  const allowed = { restartNginx: 'systemctl restart nginx', restartDocker: 'systemctl restart docker', restartPanel: 'systemctl restart mini-cpanel', cleanDocker: 'docker system prune -af' };
  if (!allowed[action]) return res.status(400).json({ ok: false, error: 'Action không hợp lệ' });
  const r = await sh(allowed[action], { timeout: 300000 }); res.json({ ok: r.ok, stdout: r.stdout, stderr: r.stderr });
});
app.get('/api/logs', (req, res) => res.json({ ok: true, logs: fs.readdirSync(LOGS).filter(Boolean) }));
app.get('/api/logs/:name', async (req, res) => {
  const name = path.basename(req.params.name); let p = path.join(LOGS, name);
  if (name === 'system') { const r = await sh('journalctl -u mini-cpanel -n 300 --no-pager'); return res.type('text/plain').send(r.stdout || r.stderr); }
  if (!fs.existsSync(p)) return res.status(404).type('text/plain').send('Log not found');
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(-500).join('\n'); res.type('text/plain').send(lines);
});
app.get('/api/settings', (req, res) => res.json({ ok: true, settings: readJson('settings.json', { panelName: 'Momnz VPS Panel PRO', theme: 'blue', nextSitePort: 4100 }) }));
app.post('/api/settings', (req, res) => { const old = readJson('settings.json', {}); const next = { ...old, ...(req.body || {}), updatedAt: new Date().toISOString() }; writeJson('settings.json', next); res.json({ ok: true, settings: next }); });
app.get('/api/cyberpanel/status', async (req, res) => res.json({ ok: true, cyberpanel: await cyberStatus(req) }));
app.post('/api/cyberpanel/:action', async (req, res) => {
  const action = req.params.action;
  if (!['start','stop','restart'].includes(action)) return res.status(400).json({ ok: false, error: 'Action không hợp lệ' });
  const r = await sh(`systemctl ${action} lscpd 2>&1 || systemctl ${action} cyberpanel 2>&1 || systemctl ${action} lsws 2>&1 || true`);
  res.json({ ok: true, output: r.stdout || r.stderr, cyberpanel: await cyberStatus(req) });
});
app.get('/api/cyberpanel/logs', async (req, res) => { const r = await sh('journalctl -u lscpd -u cyberpanel -u lsws -n 300 --no-pager 2>&1 || true'); res.type('text/plain').send(r.stdout || r.stderr); });

app.use(express.static(PUBLIC));
app.get('*', (req, res) => {
  const index = path.join(PUBLIC, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.send('<h1>Momnz VPS Panel PRO</h1><p>Frontend chưa build. Chạy cpanel-update.</p>');
});

app.listen(PORT, HOST, () => console.log(`Momnz VPS Panel PRO listening on ${HOST}:${PORT}`));
