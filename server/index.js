'use strict';

/**
 * 掼蛋服务端入口：静态资源 + /healthz + WebSocket（/ws）。
 * 零第三方依赖，只用 Node 内置模块。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WSServer } = require('./ws');
const { Hub } = require('./rooms');
const { PROTOCOL } = require('./version');

const STARTED_AT = new Date();

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveHost(env) {
  return (env && env.HOST) || '0.0.0.0';
}

function clientIp(req) {
  const trustProxy = process.env.TRUST_PROXY === '1';
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd.slice(0, 64);
  }
  return req.socket.remoteAddress || 'local';
}

function sendFile(res, file, status) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(status || 200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function createServer() {
  const hub = new Hub();

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      res.writeHead(400); res.end('bad request'); return;
    }
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/healthz' || pathname === '/health') {
      // protocol / startedAt 是给"这个进程到底是不是最新代码"用的：
      // 浏览器打开 /healthz 就能看到，省得再猜是不是没重启。
      const body = JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        protocol: PROTOCOL,
        startedAt: STARTED_AT.toISOString(),
        ...hub.stats(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end('method not allowed'); return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(PUBLIC, rel);
    if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    sendFile(res, target);
  });

  const wss = new WSServer(server, { maxMessage: 64 * 1024, maxConnections: 500 });
  hub.attach(wss);

  // 心跳：清理半开连接
  const beat = setInterval(() => {
    for (const conn of wss.clients) {
      try {
        if (!conn.isAlive) { conn._destroy(); continue; }
        conn.ping();
      } catch (e) {
        // 定时器回调里抛异常会直接崩掉进程
        try { conn._destroy(); } catch (e2) { /* ignore */ }
      }
    }
  }, 25000);
  if (beat.unref) beat.unref();

  return { server, hub, wss };
}

// 虚拟/隧道/代理网卡：这些地址同一 WiFi 下的其它设备连不上，不能当"局域网访问"推荐
const VIRTUAL_ADAPTER = /(vEthernet|Virtual|VMware|VirtualBox|Hyper-V|WSL|Docker|Loopback|TAP|Tailscale|ZeroTier|tun|tap|singbox|clash|utun|wg\d|WireGuard|Proxy|VPN)/i;

function lanAddresses() {
  const real = [], virtual = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const item of nets[name] || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (String(item.address).startsWith('169.254.')) continue;
      const entry = { name, address: item.address, virtual: VIRTUAL_ADAPTER.test(name) };
      (entry.virtual ? virtual : real).push(entry);
    }
  }
  return real.concat(virtual);
}

function start() {
  const host = resolveHost(process.env);
  const port = Number(process.env.PORT || 8790);
  const { server } = createServer();

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error('  端口 ' + port + ' 已被占用 —— 多半是上一轮的服务端还在跑。');
      console.error('  注意：那个进程里装的是**旧代码**，换端口起一个新的只会让你连错。');
      console.error('');
      console.error('  在 PowerShell 里按端口杀掉它（Git Bash 的 pkill 杀不掉原生 Windows 进程）：');
      console.error('    Get-NetTCPConnection -LocalPort ' + port + ' -State Listen |');
      console.error('      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
      console.error('');
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    console.log('');
    console.log('  掼蛋服务端已启动（' + host + ':' + port + '）');
    console.log('    协议版本 v' + PROTOCOL + ' · 启动于 ' + STARTED_AT.toLocaleTimeString('zh-CN', { hour12: false }));
    console.log('    （改了 server/ 下的代码必须重启本进程，否则跑的还是旧逻辑）');
    console.log('    本机访问：http://127.0.0.1:' + port);
    const addrs = lanAddresses();
    const lan = addrs.filter(a => !a.virtual);
    if (lan.length) {
      console.log('    局域网访问（同一 WiFi / 网线下用手机或另一台电脑打开）：');
      for (const a of lan) console.log('      http://' + a.address + ':' + port + '   [' + a.name + ']');
    }
    const virt = addrs.filter(a => a.virtual);
    if (virt.length) {
      console.log('    以下地址属于虚拟网卡，同一 WiFi 下的其它设备连不上，仅本机可用：');
      for (const a of virt) console.log('      http://' + a.address + ':' + port + '   [' + a.name + ']');
    }
    console.log('');
    console.log('    局域网是明文 HTTP，请只在自家 / 信任的网络里这么跑。');
    console.log('');
  });

  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, resolveHost, lanAddresses, clientIp };
