#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8081;
const HOST = '0.0.0.0';
const BACKEND_PORT = 8082;
const STARTUP_TIMEOUT = 60000; // 60秒启动超时
const HEALTH_CHECK_INTERVAL = 25000; // 25秒健康检查
const REQUEST_TIMEOUT = 60000; // 60秒请求超时
const RETRY_DELAYS = [1000, 2000, 5000]; // 重试延迟：1s, 2s, 5s（指数退避）

let isBackendReady = false;
let isBrowserInstalled = false;
let startupTimer = null;

console.log('========================================');
console.log(`🚀 启动 Playwright MCP 代理服务器 ${HOST}:${PORT}`);
console.log(`   环境: ${process.env.NODE_ENV || 'production'}`);
console.log(`   浏览器路径: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
console.log('========================================');

// 浏览器检查（仅检查，不安装）
const fs = require('fs');
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';

function checkBrowserInstalled() {
  if (!fs.existsSync(browsersPath)) {
    return false;
  }
  try {
    const files = fs.readdirSync(browsersPath);
    const hasChromium = files.some(f => f.startsWith('chromium'));
    if (hasChromium) {
      console.log(`✅ 浏览器已就绪: ${browsersPath}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`❌ 浏览器检查失败: ${err.message}`);
    return false;
  }
}

// 进程锁管理
const LOCK_FILE = '/tmp/playwright-mcp.lock';

function cleanupLocks() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (err) {
    // 静默失败
  }
}

cleanupLocks();

let playwrightProcess = null;
let isStarting = false;
let healthCheckTimer = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function startPlaywrightBackend() {
  if (playwrightProcess || isStarting) {
    return;
  }
  
  isStarting = true;
  console.log('🚀 启动 Playwright MCP 后端...');
  
  playwrightProcess = spawn('node', [
    'cli.js',
    '--headless',
    '--browser', 'chromium',
    '--no-sandbox',
    '--port', BACKEND_PORT,
    '--isolated',
    '--shared-browser-context',
    '--save-session',
    '--timeout-action=60000',
    '--timeout-navigation=60000',
    '--output-dir=/tmp/playwright-output'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  playwrightProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    // 仅记录关键启动信息
    if (message.includes('listening') || message.includes('started') || message.includes(BACKEND_PORT)) {
      isBackendReady = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      console.log('✅ 后端服务已就绪');
    }
  });

  playwrightProcess.stderr.on('data', (data) => {
    const errorMsg = data.toString().trim();
    // 仅记录关键错误
    if (errorMsg.includes('ETXTBSY')) {
      console.error('❌ 浏览器文件锁冲突 (ETXTBSY)');
      cleanupLocks();
    } else if (errorMsg.includes('not installed') || errorMsg.includes('Executable doesn')) {
      console.error('❌ 浏览器缺失错误');
    }
  });

  playwrightProcess.on('error', (error) => {
    console.error(`❌ 后端启动失败: ${error.message}`);
    isStarting = false;
    playwrightProcess = null;
  });

  playwrightProcess.on('exit', (code, signal) => {
    isStarting = false;
    playwrightProcess = null;
    if (code !== 0 && code !== null) {
      console.error(`❌ 后端异常退出 (code: ${code}, signal: ${signal})`);
    }
  });

  isStarting = false;
  startHealthMonitoring();
}

// 健康监控
function startHealthMonitoring() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }
  
  healthCheckTimer = setInterval(() => {
    if (!playwrightProcess || !isBackendReady) {
      return;
    }
    
    checkBackendHealth((healthy) => {
      if (healthy) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`❌ 后端健康检查失败 ${MAX_CONSECUTIVE_FAILURES} 次，重启中...`);
          consecutiveFailures = 0;
          
          if (playwrightProcess) {
            playwrightProcess.kill('SIGTERM');
            playwrightProcess = null;
          }
          
          isBackendReady = false;
          cleanupLocks();
          
          setTimeout(() => {
            startPlaywrightBackend();
          }, 3000);
        }
      }
    });
  }, HEALTH_CHECK_INTERVAL);
}


// 健康检查
function checkBackendHealth(callback) {
  const req = http.request({
    hostname: 'localhost',
    port: BACKEND_PORT,
    path: '/',
    method: 'GET',
    timeout: 2000
  }, (res) => {
    callback(true);
    req.destroy();
  });

  req.on('error', () => callback(false));
  req.on('timeout', () => {
    callback(false);
    req.destroy();
  });

  req.end();
}

// 等待后端就绪
function waitForBackend(callback) {
  if (isBackendReady) {
    callback();
    return;
  }

  const startTime = Date.now();
  const checkInterval = setInterval(() => {
    checkBackendHealth((healthy) => {
      if (healthy) {
        clearInterval(checkInterval);
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        isBackendReady = true;
        callback();
      }
    });
  }, 5000);

  startupTimer = setTimeout(() => {
    clearInterval(checkInterval);
    console.error('⚠️  后端启动超时');
    callback();
  }, STARTUP_TIMEOUT);
}


// 转发请求（带指数退避重试）
function forwardRequest(req, res, retryCount = 0) {
  const proxyHeaders = { ...req.headers };
  proxyHeaders.host = `localhost:${BACKEND_PORT}`;

  const proxyReq = http.request({
    hostname: 'localhost',
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: proxyHeaders,
    timeout: REQUEST_TIMEOUT
  }, (proxyRes) => {
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });
    res.writeHead(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    const canRetry = retryCount < RETRY_DELAYS.length && 
                     (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT');
    
    if (canRetry) {
      const delay = RETRY_DELAYS[retryCount];
      setTimeout(() => {
        forwardRequest(req, res, retryCount + 1);
      }, delay);
    } else {
      console.error(`❌ 请求失败: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Backend unavailable',
          message: error.message
        }));
      }
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timeout' }));
    }
  });

  req.pipe(proxyReq);
}

// 代理服务器
const proxyServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 健康检查
  if (req.url === '/health' || req.url === '/healthz') {
    if (isBackendReady && isBrowserInstalled) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting' }));
    }
    return;
  }

  // MCP 端点判断（支持查询参数）
  const urlPath = req.url.split('?')[0];
  const isMcpEndpoint = urlPath === '/mcp' || urlPath.startsWith('/mcp/');
  
  // MCP 端点：后端未就绪时返回 MCP 协议的初始化响应
  if (isMcpEndpoint && req.method === 'POST' && !isBackendReady) {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const mcpRequest = JSON.parse(body);
        
        // 处理 initialize 请求
        if (mcpRequest.method === 'initialize') {
          res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Retry-After': '10'
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: mcpRequest.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {
                tools: {},
                resources: {},
                prompts: {}
              },
              serverInfo: {
                name: 'playwright-mcp',
                version: '0.0.45'
              },
              instructions: '浏览器正在初始化中，请稍候...'
            }
          }));
          return;
        }
        
        // 处理 notifications/*（通知类消息，无需响应）
        if (mcpRequest.method && mcpRequest.method.startsWith('notifications/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(''); // 空响应，符合 JSON-RPC 2.0 规范
          return;
        }
        
        // 其他 MCP 请求：返回错误（仅当有 id 时）
        if (mcpRequest.id !== undefined) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: mcpRequest.id,
            error: {
              code: -32000,
              message: 'Server initializing',
              data: { status: 'starting' }
            }
          }));
        } else {
          // 无 id 的通知类消息，返回 200
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('');
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON-RPC request' }));
      }
    });
    return;
  }
  
  // 非 MCP 端点：后端未就绪时返回 503
  if (!isMcpEndpoint && !isBackendReady) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '10' });
    res.end(JSON.stringify({
      error: 'Service starting',
      message: '服务启动中，请稍后重试'
    }));
    return;
  }

  forwardRequest(req, res);
});

// 启动流程（支持后台异步浏览器初始化）
(async () => {
  try {
    // 立即启动代理服务器（不等待浏览器）
    proxyServer.listen(PORT, HOST, () => {
      console.log(`✅ 代理服务器已启动: http://${HOST}:${PORT}`);
      console.log('⏳ 等待浏览器初始化...');
    });
    
    // 后台等待浏览器初始化
    const browserCheckInterval = setInterval(() => {
      if (checkBrowserInstalled()) {
        clearInterval(browserCheckInterval);
        isBrowserInstalled = true;
        console.log('✅ 浏览器初始化完成');
        
        // 启动 Playwright 后端
        startPlaywrightBackend();
        
        // 等待后端就绪
        waitForBackend(() => {
          console.log('✅ 服务就绪');
        });
      }
    }, 1000); // 每秒检查
    
    // 超时保护（60秒）
    setTimeout(() => {
      if (!isBrowserInstalled) {
        clearInterval(browserCheckInterval);
        console.error('❌ 浏览器初始化超时');
        process.exit(1);
      }
    }, 60000);
  } catch (err) {
    console.error(`❌ 启动失败: ${err.message}`);
    process.exit(1);
  }
})();

// 进程清理
process.on('SIGTERM', () => {
  console.log('🛑 服务关闭中...');
  cleanupLocks();
  if (playwrightProcess) playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 服务关闭中...');
  cleanupLocks();
  if (playwrightProcess) playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});

process.on('exit', cleanupLocks);
