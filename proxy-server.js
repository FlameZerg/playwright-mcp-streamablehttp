#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8081;
const HOST = '0.0.0.0';
const BACKEND_PORT = 8082;
const STARTUP_TIMEOUT = 60000; // 60 seconds
const HEALTH_CHECK_INTERVAL = 10000; // 10 seconds
const REQUEST_TIMEOUT = 60000; // 60 seconds

let isBackendReady = false;
let startupTimer = null;

console.log('========================================');
console.log(`Starting Playwright MCP server proxy on ${HOST}:${PORT}`);
console.log(`Environment: NODE_ENV=${process.env.NODE_ENV}`);
console.log(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
console.log(`BACKEND_PORT=${BACKEND_PORT}`);
console.log('========================================');

// Verify browser installation path exists
const fs = require('fs');
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
const autoInstall = process.env.PLAYWRIGHT_AUTO_INSTALL === 'true';

function checkBrowserInstalled() {
  if (!fs.existsSync(browsersPath)) {
    return false;
  }
  try {
    const files = fs.readdirSync(browsersPath);
    // 检查是否有 chromium 目录
    const hasChromium = files.some(f => f.startsWith('chromium'));
    if (hasChromium) {
      console.log(`✅ Browser cache found at: ${browsersPath}`);
      console.log(`   Contents: ${files.join(', ')}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Failed to read browser cache: ${err.message}`);
    return false;
  }
}

// 浏览器自动安装功能（后台异步执行，不阻塞启动）
function installBrowserInBackground() {
  if (checkBrowserInstalled()) {
    return;
  }

  console.warn(`⚠️  Browser not found at: ${browsersPath}`);

  if (!autoInstall) {
    console.error('❌ Auto-install is disabled. Please install browser manually.');
    console.error('   Run: npx playwright-core install chromium');
    return;
  }

  console.log('🔧 Auto-installing Chromium browser in background...');
  console.log('   This may take 1-2 minutes. Server will be ready shortly.');

  const installProcess = spawn('npx', ['-y', 'playwright-core', 'install', '--no-shell', 'chromium'], {
    stdio: 'pipe',
    env: { ...process.env },
    detached: false
  });

  installProcess.stdout.on('data', (data) => {
    console.log(`[Install] ${data.toString().trim()}`);
  });

  installProcess.stderr.on('data', (data) => {
    console.error(`[Install Error] ${data.toString().trim()}`);
  });

  installProcess.on('exit', (code) => {
    if (code === 0) {
      console.log('✅ Browser installation completed successfully');
      if (checkBrowserInstalled()) {
        isBackendReady = true;
      } else {
        console.error('❌ Browser installation succeeded but browser not found');
      }
    } else {
      console.error(`❌ Browser installation failed with code ${code}`);
    }
  });

  installProcess.on('error', (err) => {
    console.error(`❌ Failed to start browser installation: ${err.message}`);
  });
}

// 启动浏览器后台安装（如果需要）
installBrowserInBackground();

// 进程管理 - 防止多个实例同时启动
const LOCK_FILE = '/tmp/playwright-mcp.lock';

function cleanupLocks() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      console.log('✅ Cleaned up stale lock file');
    }
  } catch (err) {
    console.warn(`⚠️  Could not clean locks: ${err.message}`);
  }
}

// 启动时清理旧锁
cleanupLocks();

// 立即启动后端和代理（不等待浏览器安装）

let playwrightProcess = null;
let isStarting = false;
let healthCheckTimer = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 2;

function startPlaywrightBackend() {
  if (playwrightProcess || isStarting) {
    console.log('⚠️  Backend already starting or running, skipping...');
    return;
  }
  
  isStarting = true;
  console.log('🚀 Starting Playwright MCP backend (isolated mode)...');
  
  // Start the actual Playwright MCP server
  playwrightProcess = spawn('node', [
    'cli.js',
    '--headless',
    '--browser', 'chromium',
    '--no-sandbox',
    '--port', BACKEND_PORT,
    '--isolated',                    // 使用临时目录
    '--shared-browser-context',      // 运行期间共享上下文
    '--save-session',                // 保存会话
    '--timeout-action=60000',        // 60秒操作超时
    '--timeout-navigation=60000',    // 60秒导航超时
    '--output-dir=/tmp/playwright-output'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Log backend output for debugging
  playwrightProcess.stdout.on('data', (data) => {
    const message = data.toString().trim();
    console.log(`[Backend] ${message}`);
    // Detect when backend is ready
    if (message.includes('listening') || message.includes('started') || message.includes(BACKEND_PORT)) {
      isBackendReady = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      console.log('Backend server is ready');
    }
  });

  playwrightProcess.stderr.on('data', (data) => {
    const errorMsg = data.toString().trim();
    console.error(`[Backend Error] ${errorMsg}`);
    
    // 检测 ETXTBSY 错误（文件锁冲突）
    if (errorMsg.includes('ETXTBSY') || errorMsg.includes('spawn ETXTBSY')) {
      console.error('❌ ETXTBSY detected - browser executable is busy');
      console.log('🔧 Attempting to clean locks and retry...');
      cleanupLocks();
      
      // 等待 2 秒后重试
      setTimeout(() => {
        console.log('♻️  Locks cleaned, backend should retry automatically');
      }, 2000);
    }
    
    // 检测浏览器缺失错误
    if (errorMsg.includes('Executable doesn\'t exist') || errorMsg.includes('browser') || errorMsg.includes('install')) {
      console.warn('⚠️  Browser appears to be missing. Auto-installation should handle this.');
    }
  });

  playwrightProcess.on('error', (error) => {
    console.error(`Failed to start backend process: ${error.message}`);
    isStarting = false;
    playwrightProcess = null;
  });

  playwrightProcess.on('exit', (code, signal) => {
    console.error(`Backend process exited with code ${code} and signal ${signal}`);
    isStarting = false;
    playwrightProcess = null;
    if (code !== 0 && code !== null) {
      console.error('❌ Backend crashed, will not auto-restart');
    }
  });

  isStarting = false;
  console.log('✅ Backend startup sequence completed');
  
  // 启动健康监控
  startHealthMonitoring();
}

// 立即启动 Playwright 后端
startPlaywrightBackend();

// 健康监控和自动重启
function startHealthMonitoring() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }
  
  healthCheckTimer = setInterval(() => {
    if (!playwrightProcess || !isBackendReady) {
      return; // 后端未运行或未就绪，跳过检查
    }
    
    checkBackendHealth((healthy) => {
      if (healthy) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        console.warn(`⚠️  Backend health check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error('❌ Backend appears to be dead, attempting restart...');
          consecutiveFailures = 0;
          
          // 杀死旧进程
          if (playwrightProcess) {
            playwrightProcess.kill('SIGTERM');
            playwrightProcess = null;
          }
          
          isBackendReady = false;
          cleanupLocks();
          
          // 等待 3 秒后重启
          setTimeout(() => {
            console.log('♻️  Restarting backend...');
            startPlaywrightBackend();
          }, 3000);
        }
      }
    });
  }, 10000); // 每 10 秒检查一次
}


// Health check function
function checkBackendHealth(callback) {
  const req = http.request({
    hostname: 'localhost',
    port: BACKEND_PORT,
    path: '/',
    method: 'GET',
    timeout: 1000
  }, (res) => {
    callback(true);
    req.destroy();
  });

  req.on('error', () => {
    callback(false);
  });

  req.on('timeout', () => {
    callback(false);
    req.destroy();
  });

  req.end();
}

// Wait for backend to be ready
function waitForBackend(callback) {
  if (isBackendReady) {
    callback();
    return;
  }

  console.log('Waiting for backend to start...');
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
        console.log(`Backend ready after ${Date.now() - startTime}ms`);
        callback();
      }
    });
  }, HEALTH_CHECK_INTERVAL);

  startupTimer = setTimeout(() => {
    clearInterval(checkInterval);
    console.error('Backend startup timeout, but continuing anyway');
    callback();
  }, STARTUP_TIMEOUT);
}

// Forward request with retry logic
function forwardRequest(req, res, retryCount = 0) {
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second

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
    // Forward response headers
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });

    res.writeHead(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    console.error(`Proxy request error (attempt ${retryCount + 1}): ${error.message}`);

    if (retryCount < maxRetries && (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET')) {
      // Retry after delay
      setTimeout(() => {
        console.log(`Retrying request (attempt ${retryCount + 2})...`);
        forwardRequest(req, res, retryCount + 1);
      }, retryDelay);
    } else {
      // Send error response
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Backend service unavailable',
          message: error.message,
          code: error.code
        }));
      }
    }
  });

  proxyReq.on('timeout', () => {
    console.error('Proxy request timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Gateway timeout',
        message: 'Backend request timeout'
      }));
    }
  });

  req.pipe(proxyReq);
}

// Create a proxy server that binds to 0.0.0.0
const proxyServer = http.createServer((req, res) => {
  console.log(`→ ${req.method} ${req.url} from ${req.headers.host}`);
  
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health' || req.url === '/healthz') {
    if (isBackendReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', backend: 'ready' }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting', backend: 'not ready' }));
    }
    return;
  }

  // MCP 端点 - 即使后端未就绪也要尝试转发（后端可能已启动但未通过健康检查）
  const isMcpEndpoint = req.url === '/mcp' || req.url.startsWith('/mcp/');
  
  // 非-MCP 请求且后端未就绪时返回 503
  if (!isMcpEndpoint && !isBackendReady) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Service starting',
      message: 'Backend is initializing, please retry in a few seconds'
    }));
    return;
  }

  // Forward the request to the actual server
  forwardRequest(req, res);
});

// 立即启动代理服务器（不等待后端，让 Smithery 扫描器可以连接）
proxyServer.listen(PORT, HOST, () => {
  console.log(`Proxy server listening on http://${HOST}:${PORT}`);
  console.log(`Forwarding requests to http://localhost:${BACKEND_PORT}`);
  console.log('Server ready for connections. Backend is starting in background...');
  
  // 后台等待后端就绪
  waitForBackend(() => {
    console.log('✅ Full service ready - backend and proxy both operational');
  });
});

// Handle process cleanup
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  cleanupLocks();
  if (playwrightProcess) playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  cleanupLocks();
  if (playwrightProcess) playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});

process.on('exit', () => {
  cleanupLocks();
});
