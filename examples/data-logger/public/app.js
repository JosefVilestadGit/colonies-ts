/**
 * Data Logger Frontend
 * Uses colonies-ts SDK directly in the browser to communicate with ColonyOS.
 * - spec = desired state (what user wants)
 * - status = actual state (reported by reconciler)
 */

import { ColoniesClient } from './colonies-sdk.js';

let config = {};
let client = null;
let currentDevice = null;
let ws = null;
let wsConnecting = false;
const activityLog = [];

// Activity logging
function logActivity(message, type = 'info') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  activityLog.unshift({ time, message, type });
  if (activityLog.length > 50) activityLog.pop();
  renderActivityLog();
}

function renderActivityLog() {
  const container = document.getElementById('activity-log');
  if (!container) return;

  container.innerHTML = activityLog.slice(0, 15).map(entry => `
    <div class="activity-entry">
      <span class="activity-time">${entry.time}</span>
      <span class="activity-message ${entry.type}">${entry.message}</span>
    </div>
  `).join('') || '<div class="activity-entry"><span class="activity-message">No activity yet</span></div>';
}


// Initialize
window.addEventListener('load', async () => {
  await loadConfig();
  renderActivityLog();
  await loadDevice();
  connectWebSocket();
});

// Handle Safari's Back-Forward Cache
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    console.log('Page restored from bfcache, reconnecting WebSocket');
    if (ws) {
      ws.close();
      ws = null;
    }
    wsConnecting = false;
    connectWebSocket();
  }
});

// WebSocket connection
function connectWebSocket() {
  if (wsConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const wsUrl = config.reconcilerWsUrl;
  if (!wsUrl) {
    console.error('No reconcilerWsUrl in config');
    return;
  }

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  console.log('Connecting to WebSocket:', wsUrl);
  wsConnecting = true;

  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    wsConnecting = false;
    return;
  }

  const timeoutId = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log('WebSocket connection timeout');
      if (isSafari) {
        console.log('Safari detected, reloading page...');
        location.reload();
      }
    }
  }, 1500);

  ws.onopen = () => {
    clearTimeout(timeoutId);
    console.log('WebSocket connected');
    wsConnecting = false;
    updateConnectionStatus(true);
    logActivity('Connected to reconciler', 'success');
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('WebSocket message received:', message);

      if (message.type === 'init') {
        const device = message.devices?.['data-logger-1'];
        if (device) {
          logActivity('Connected - received device state');
          updateDevice(device.spec, device.status);
        }
      } else if (message.type === 'update') {
        logActivity(`State updated: ${message.device}`, 'success');
        updateDevice(message.spec, message.status);
        flashReconcile();
      } else {
        console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      logActivity('Error: ' + error.message, 'error');
    }
  };

  ws.onclose = (event) => {
    clearTimeout(timeoutId);
    console.log('WebSocket closed:', event.code);
    wsConnecting = false;
    updateConnectionStatus(false);
    logActivity('Disconnected from reconciler', 'error');
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    clearTimeout(timeoutId);
    console.error('WebSocket error');
    wsConnecting = false;
  };
}

function updateConnectionStatus(connected) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  if (connected) {
    dot.classList.add('connected');
    dot.classList.remove('error');
    text.textContent = 'Connected';
  } else {
    dot.classList.remove('connected');
    dot.classList.add('error');
    text.textContent = 'Disconnected';
  }
}

async function loadConfig() {
  try {
    console.log('Loading config...');
    const res = await fetch('/api/config');
    config = await res.json();
    console.log('Config loaded:', config);

    client = new ColoniesClient(config.colonies);
    console.log('ColoniesClient created');
  } catch (error) {
    console.error('Failed to load config:', error);
    showNotification('Failed to connect to server', 'error');
  }
}

async function loadDevice() {
  try {
    client.setPrivateKey(config.executorPrvKey || config.colonyPrvKey);
    const blueprints = await client.getBlueprints(config.colonyName, 'DataLogger') || [];

    if (blueprints.length > 0) {
      const bp = blueprints[0];
      updateDevice(bp.spec, bp.status);
    } else {
      renderDefaultState();
    }
  } catch (error) {
    console.error('Failed to load device:', error);
    renderDefaultState();
  }
}

function renderDefaultState() {
  const defaultSpec = {
    name: 'data-logger-1',
    location: 'Server Room A',
    appName: 'DataCollector',
    appVersion: '2.9',
    enabled: true,
    logInterval: 5,
    logFormat: 'json'
  };
  renderDevice(defaultSpec, null);
}

// Update device with new spec and status
function updateDevice(spec, status) {
  const oldSpec = currentDevice?.spec;
  currentDevice = { spec, status };

  // Detect version changes
  const oldVersion = oldSpec?.appVersion;
  const newVersion = spec?.appVersion;
  const actualVersion = status?.appVersion;

  // Log version changes
  if (oldVersion && newVersion && oldVersion !== newVersion) {
    logActivity(`Desired version: v${oldVersion} → v${newVersion}`);
  }

  // Check sync status
  const isSynced = status && newVersion === actualVersion;
  if (isSynced && oldVersion && oldVersion !== newVersion) {
    logActivity(`Deployed v${newVersion} ✓`, 'success');
  } else if (!isSynced && actualVersion && newVersion !== actualVersion) {
    logActivity(`Reconciling: v${actualVersion} → v${newVersion}`, 'reconciling');
  }

  renderDevice(spec, status);
  renderStateComparison(spec, status);
}

// Render the device visualization
function renderDevice(spec, status) {
  if (!spec) return;

  // Update device info
  document.getElementById('device-name').textContent = spec.name || '--';
  document.getElementById('device-location').textContent = spec.location || '--';

  const statusBadge = document.getElementById('device-status');
  const isOnline = spec.enabled;
  statusBadge.textContent = isOnline ? 'Online' : 'Offline';
  statusBadge.className = `info-value status-badge ${isOnline ? 'online' : 'offline'}`;

  renderDataLoggerSVG(spec, status);
}

// Render Data Logger SVG - Professional Version
function renderDataLoggerSVG(spec, status) {
  const container = document.getElementById('device-container');
  const isOnline = spec?.enabled;
  const isLogging = spec?.logInterval > 0;

  // Professional color palette
  const bodyColor = '#1a2028';
  const screenBg = isOnline ? '#0a1018' : '#12161c';
  const screenText = isOnline ? '#22c55e' : '#475569';
  const ledPower = isOnline ? '#22c55e' : '#334155';
  const ledActivity = isLogging ? '#eab308' : '#334155';
  const ledNetwork = isOnline ? '#3b82f6' : '#334155';

  container.innerHTML = `
    <svg class="data-logger-svg" width="360" height="260" viewBox="0 0 360 260">
      <defs>
        <linearGradient id="body-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#242d38"/>
          <stop offset="100%" stop-color="#0f1419"/>
        </linearGradient>
        <linearGradient id="screen-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="${screenBg}"/>
          <stop offset="100%" stop-color="#050810"/>
        </linearGradient>
      </defs>

      <!-- Device body -->
      <rect x="10" y="10" width="340" height="240" rx="8" fill="url(#body-gradient)" stroke="#334155" stroke-width="1"/>

      <!-- Screen area -->
      <rect x="25" y="30" width="240" height="140" rx="4" fill="#000" stroke="#475569" stroke-width="1"/>
      <rect x="28" y="33" width="234" height="134" rx="2" fill="url(#screen-gradient)"/>

      <!-- Screen content -->
      ${isOnline ? `
        <text x="40" y="55" fill="#64748b" font-family="'JetBrains Mono', monospace" font-size="9">SYSTEM STATUS</text>
        <line x1="40" y1="60" x2="250" y2="60" stroke="#334155" stroke-width="1"/>

        <circle cx="45" cy="80" r="4" fill="${ledPower}"/>
        <text x="55" y="84" fill="${screenText}" font-family="'JetBrains Mono', monospace" font-size="12">ONLINE</text>

        <text x="40" y="108" fill="#64748b" font-family="'JetBrains Mono', monospace" font-size="9">APPLICATION</text>
        <text x="40" y="124" fill="${screenText}" font-family="'JetBrains Mono', monospace" font-size="12">${spec.appName || 'App'} v${spec.appVersion || '?'}</text>

        <text x="40" y="148" fill="#64748b" font-family="'JetBrains Mono', monospace" font-size="9">LOGGING</text>
        <text x="40" y="162" fill="${isLogging ? '#22c55e' : '#ef4444'}" font-family="'JetBrains Mono', monospace" font-size="12">
          ${isLogging ? `Recording every ${spec.logInterval || 5}s` : 'Stopped'}
        </text>
        ${isLogging ? `<rect x="200" y="152" width="2" height="12" fill="${screenText}"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>` : ''}
      ` : `
        <text x="145" y="95" text-anchor="middle" fill="#475569" font-family="'Inter', sans-serif" font-size="18" font-weight="600">OFFLINE</text>
        <text x="145" y="115" text-anchor="middle" fill="#334155" font-family="'JetBrains Mono', monospace" font-size="10">Application disabled</text>
      `}

      <!-- LED indicators -->
      <g transform="translate(280, 40)">
        <rect x="0" y="0" width="60" height="120" rx="4" fill="#0f1419" stroke="#334155"/>

        <text x="10" y="22" fill="#64748b" font-family="'Inter', sans-serif" font-size="8">PWR</text>
        <circle cx="48" cy="18" r="5" fill="${ledPower}"/>

        <text x="10" y="52" fill="#64748b" font-family="'Inter', sans-serif" font-size="8">ACT</text>
        <circle cx="48" cy="48" r="5" fill="${ledActivity}">
          ${isLogging ? '<animate attributeName="opacity" values="1;0.3;1" dur="0.5s" repeatCount="indefinite"/>' : ''}
        </circle>

        <text x="10" y="82" fill="#64748b" font-family="'Inter', sans-serif" font-size="8">NET</text>
        <circle cx="48" cy="78" r="5" fill="${ledNetwork}"/>

        <text x="10" y="112" fill="#64748b" font-family="'Inter', sans-serif" font-size="8">ERR</text>
        <circle cx="48" cy="108" r="5" fill="${!isOnline ? '#ef4444' : '#334155'}">
          ${!isOnline ? '<animate attributeName="opacity" values="1;0.3;1" dur="0.5s" repeatCount="indefinite"/>' : ''}
        </circle>
      </g>

      <!-- Ports -->
      <g transform="translate(25, 185)">
        <rect x="0" y="0" width="30" height="12" rx="2" fill="#0f1419" stroke="#475569"/>
        <text x="15" y="24" text-anchor="middle" fill="#64748b" font-family="'Inter', sans-serif" font-size="7">USB</text>

        <rect x="45" y="0" width="35" height="12" rx="2" fill="#0f1419" stroke="#475569"/>
        <text x="62" y="24" text-anchor="middle" fill="#64748b" font-family="'Inter', sans-serif" font-size="7">ETH</text>

        <rect x="95" y="0" width="40" height="12" rx="2" fill="#0f1419" stroke="#475569"/>
        <text x="115" y="24" text-anchor="middle" fill="#64748b" font-family="'Inter', sans-serif" font-size="7">POWER</text>
      </g>

      <!-- Model name -->
      <text x="180" y="235" text-anchor="middle" fill="#64748b" font-family="'Inter', sans-serif" font-size="11" font-weight="600">DATA LOGGER X1</text>
      <text x="180" y="248" text-anchor="middle" fill="#475569" font-family="'JetBrains Mono', monospace" font-size="8">${spec?.name || 'data-logger-1'}</text>
    </svg>
  `;
}



// Render State Comparison
function renderStateComparison(spec, status) {
  const desiredContent = document.getElementById('desired-state-content');
  const actualContent = document.getElementById('actual-state-content');
  const syncArrow = document.getElementById('sync-arrow');

  const desiredVersion = spec?.appVersion;
  const actualVersion = status?.appVersion;
  const isSynced = status && desiredVersion === actualVersion;

  // Update sync indicator
  if (!status) {
    syncArrow.textContent = '?';
    syncArrow.className = '';
  } else if (isSynced) {
    syncArrow.textContent = '=';
    syncArrow.className = 'synced';
  } else {
    syncArrow.textContent = '→';
    syncArrow.className = 'pending';
  }

  desiredContent.innerHTML = renderFlatState(spec);

  if (status) {
    actualContent.innerHTML = renderFlatState(status);

    // Highlight version mismatch
    if (!isSynced) {
      const desiredVersionEl = desiredContent.querySelector('.version-number');
      const actualVersionEl = actualContent.querySelector('.version-number');
      if (desiredVersionEl) desiredVersionEl.classList.add('version-new');
      if (actualVersionEl) actualVersionEl.classList.add('version-old');
    }
  } else {
    actualContent.innerHTML = `<div class="state-item"><span class="state-item-label">Waiting for reconciler...</span></div>`;
  }
}

function renderFlatState(data) {
  if (!data) return '<div class="state-item"><span>No data</span></div>';

  return `
    <div class="state-item version-display">
      <span class="state-item-label">Application</span>
      <span class="state-item-value">${data.appName || '--'}</span>
    </div>
    <div class="state-item version-display highlight">
      <span class="state-item-label">Version</span>
      <span class="state-item-value version-number">v${data.appVersion || '?'}</span>
    </div>
    <div class="state-item">
      <span class="state-item-label">Enabled</span>
      <span class="state-item-value">${data.enabled ? 'Yes' : 'No'}</span>
    </div>
    <div class="state-item">
      <span class="state-item-label">Log Interval</span>
      <span class="state-item-value">${data.logInterval || 0}s</span>
    </div>
  `;
}



// Flash effect on reconciliation
function flashReconcile() {
  const elements = [
    document.getElementById('device-container'),
    document.querySelector('.device-section'),
    document.querySelector('.state-comparison')
  ];

  elements.forEach(el => {
    if (el) {
      el.classList.remove('flash-reconcile');
      // Trigger reflow to restart animation
      void el.offsetWidth;
      el.classList.add('flash-reconcile');
    }
  });
}

// Notification helper
function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications');
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  container.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateX(100%)';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}
