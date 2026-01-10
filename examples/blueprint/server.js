/**
 * Home Automation Web Server
 *
 * - Serves the web UI and bundled SDK
 * - Provides configuration endpoint for browser SDK
 * - Proxies WebSocket to reconciler (avoids cross-port issues in Safari)
 *
 * The browser uses colonies-ts SDK directly to talk to ColonyOS.
 * Real-time updates are proxied through this server to the reconciler.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration from environment
const config = {
  port: parseInt(process.env.WEB_PORT || '3000', 10),
  reconcilerWsPort: parseInt(process.env.RECONCILER_WS_PORT || '46701', 10),
  colonies: {
    host: process.env.COLONIES_SERVER_HOST || 'localhost',
    port: parseInt(process.env.COLONIES_SERVER_PORT || '50080', 10),
    tls: (process.env.COLONIES_TLS ?? 'false') === 'true',
  },
  colonyName: process.env.COLONIES_COLONY_NAME || 'dev',
  // For demo purposes, we pass keys to the browser
  // In production, use proper authentication (OAuth, sessions, etc.)
  colonyPrvKey: process.env.COLONIES_COLONY_PRVKEY,
  executorPrvKey: process.env.COLONIES_PRVKEY,
};

// Validate required environment variables
if (!config.colonyPrvKey) {
  console.error('Error: COLONIES_COLONY_PRVKEY environment variable is required');
  console.error('Run: source /path/to/colonies/docker-compose.env');
  process.exit(1);
}

const app = express();

// Disable caching and keep-alive to prevent Safari issues
app.use((req, res, next) => {
  res.set('Connection', 'close');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(join(__dirname, 'public')));

// API: Get configuration for browser SDK
// NOTE: In production, don't expose private keys like this!
// Use proper authentication and server-side operations for sensitive actions.
app.get('/api/config', (req, res) => {
  // Use the host the browser used to reach this server (for remote access)
  const browserHost = req.get('host')?.split(':')[0] || 'localhost';
  const browserPort = req.get('host')?.split(':')[1] || config.port;

  // If colonies.host is localhost, use the browser's host instead
  const coloniesHost = config.colonies.host === 'localhost' ? browserHost : config.colonies.host;

  res.json({
    colonies: {
      host: coloniesHost,
      port: config.colonies.port,
      tls: config.colonies.tls,
    },
    colonyName: config.colonyName,
    colonyPrvKey: config.colonyPrvKey,
    executorPrvKey: config.executorPrvKey,
    // WebSocket proxied through same port (fixes Safari cross-port issues)
    reconcilerWsUrl: `ws://${browserHost}:${browserPort}/ws`,
  });
});

// Create HTTP server for Express + WebSocket
const server = createServer(app);

// WebSocket proxy server
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs, req) => {
  const userAgent = req.headers['user-agent'] || 'unknown';
  const origin = req.headers['origin'] || 'no-origin';
  const isSafari = userAgent.includes('Safari') && !userAgent.includes('Chrome');
  console.log(`Browser WebSocket connected from ${req.socket.remoteAddress}`);
  console.log(`  User-Agent: ${isSafari ? 'Safari' : 'Chrome/Other'}`);
  console.log(`  Origin: ${origin}`);

  // For Safari: wait to let its first (phantom) connection fully close
  const setupConnection = () => {
    if (clientWs.readyState !== WebSocket.OPEN) {
      console.log('  Browser disconnected before setup, skipping');
      return;
    }

    // Connect to reconciler
    const reconcilerUrl = `ws://localhost:${config.reconcilerWsPort}`;
    const reconcilerWs = new WebSocket(reconcilerUrl);

  // Keepalive ping to prevent connection timeout
  const pingInterval = setInterval(() => {
    if (reconcilerWs.readyState === WebSocket.OPEN) {
      reconcilerWs.ping();
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.ping();
    }
  }, 15000);

  reconcilerWs.on('open', () => {
    console.log('Connected to reconciler, proxying messages');
  });

  // Forward messages from reconciler to browser
  reconcilerWs.on('message', (data) => {
    // Convert Buffer to string for browser compatibility
    const message = data.toString();
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(message);
    }
  });

  // Forward messages from browser to reconciler (if needed)
  clientWs.on('message', (data) => {
    if (reconcilerWs.readyState === WebSocket.OPEN) {
      reconcilerWs.send(data);
    }
  });

  // Handle browser disconnect
  clientWs.on('close', (code, reason) => {
    console.log(`Browser disconnected: ${code} ${reason}`);
    clearInterval(pingInterval);
    reconcilerWs.close();
  });

  // Handle reconciler disconnect
  reconcilerWs.on('close', (code, reason) => {
    console.log(`Reconciler disconnected: ${code} ${reason}`);
    clearInterval(pingInterval);
    clientWs.close();
  });

  // Handle errors
  clientWs.on('error', (err) => {
    console.error('Browser WebSocket error:', err.message);
    reconcilerWs.close();
  });

  reconcilerWs.on('error', (err) => {
    console.error('Reconciler WebSocket error:', err.message);
    clientWs.close();
  });
  }; // end setupConnection

  // Safari needs delay to let phantom connections close
  if (isSafari) {
    setTimeout(setupConnection, 200);
  } else {
    setupConnection();
  }
});

// Start server
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Home Automation Web UI running at http://0.0.0.0:${config.port}`);
  console.log(`WebSocket proxy at ws://0.0.0.0:${config.port}/ws -> localhost:${config.reconcilerWsPort}`);
  console.log(`ColonyOS server: ${config.colonies.host}:${config.colonies.port}`);
  console.log(`Colony: ${config.colonyName}`);
});
