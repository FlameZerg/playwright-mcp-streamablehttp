#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8081;
const HOST = '0.0.0.0';

console.log(`Starting Playwright MCP server proxy on ${HOST}:${PORT}`);

// Start the actual Playwright MCP server
const playwrightProcess = spawn('node', ['cli.js', '--headless', '--browser', 'chromium', '--no-sandbox', '--port', '8082'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

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

  // Forward the request to the actual server
  const proxyHeaders = { ...req.headers };
  proxyHeaders.host = 'localhost:8082';
  
  const proxyReq = http.request({
    hostname: 'localhost',
    port: 8082,
    path: req.url,
    method: req.method,
    headers: proxyHeaders
  }, (proxyRes) => {
    // Forward response headers
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });
    
    res.writeHead(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  req.pipe(proxyReq);
});

proxyServer.listen(PORT, HOST, () => {
  console.log(`Proxy server listening on http://${HOST}:${PORT}`);
  console.log(`Forwarding requests to http://localhost:8082`);
});

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
