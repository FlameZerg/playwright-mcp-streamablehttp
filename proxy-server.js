#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8081;
const HOST = '0.0.0.0';
const BACKEND_PORT = 8082;
const STARTUP_TIMEOUT = 30000; // 30 seconds
const HEALTH_CHECK_INTERVAL = 500; // 500ms
const REQUEST_TIMEOUT = 30000; // 30 seconds

let isBackendReady = false;
let startupTimer = null;

console.log(`Starting Playwright MCP server proxy on ${HOST}:${PORT}`);
console.log(`Environment: NODE_ENV=${process.env.NODE_ENV}, PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

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

// 浏览器自动安装功能
function installBrowserIfNeeded(callback) {
  if (checkBrowserInstalled()) {
    callback();
    return;
  }

  console.warn(`⚠️  Browser not found at: ${browsersPath}`);

  if (!autoInstall) {
    console.error('❌ Auto-install is disabled. Please install browser manually.');
    console.error('   Run: npx playwright-core install chromium');
    callback();
    return;
  }

  console.log('🔧 Auto-installing Chromium browser...');
  console.log('   This may take 1-2 minutes on first run.');

  const installProcess = spawn('npx', ['-y', 'playwright-core', 'install', '--no-shell', 'chromium'], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  installProcess.on('exit', (code) => {
    if (code === 0) {
      console.log('✅ Browser installation completed successfully');
      if (checkBrowserInstalled()) {
        callback();
      } else {
        console.error('❌ Browser installation succeeded but browser not found');
        callback();
      }
    } else {
      console.error(`❌ Browser installation failed with code ${code}`);
      console.error('   Continuing anyway, backend will fail if browser is required');
      callback();
    }
  });

  installProcess.on('error', (err) => {
    console.error(`❌ Failed to start browser installation: ${err.message}`);
    callback();
  });
}

// 在启动后端之前检查/安装浏览器
installBrowserIfNeeded(() => {

// Start the actual Playwright MCP server
const playwrightProcess = spawn('node', ['cli.js', '--headless', '--browser', 'chromium', '--no-sandbox', '--port', BACKEND_PORT], {
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
  console.error(`[Backend Error] ${data.toString().trim()}`);
});

playwrightProcess.on('error', (error) => {
  console.error(`Failed to start backend process: ${error.message}`);
  process.exit(1);
});

playwrightProcess.on('exit', (code, signal) => {
  console.error(`Backend process exited with code ${code} and signal ${signal}`);
  if (code !== 0 && code !== null) {
    process.exit(code);
  }
});

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

  // Check if backend is ready before forwarding
  if (!isBackendReady) {
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

  // Wait for backend before starting proxy
  waitForBackend(() => {
    proxyServer.listen(PORT, HOST, () => {
      console.log(`Proxy server listening on http://${HOST}:${PORT}`);
      console.log(`Forwarding requests to http://localhost:${BACKEND_PORT}`);
    });
  });
}); // 结束 installBrowserIfNeeded

// Handle process cleanup
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  playwrightProcess.kill();
  proxyServer.close();
  process.exit(0);
});
