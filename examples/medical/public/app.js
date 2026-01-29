/**
 * Patient Frontend
 *
 * Sliders set blood pressure and temperature readings.
 * A text field allows the patient to describe symptoms.
 * Changes are sent to the server via REST.
 * Another executor can submit processes to read these values.
 */

let config = {};

// ── Initialization ─────────────────────────────────────────────────────

window.addEventListener('load', async () => {
  await loadConfig();
  setupSliders();
  setupSymptoms();
});

// ── Config ─────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    document.getElementById('connection-status').textContent =
      `Connected to ${config.colonyName} @ ${config.colonies.host}:${config.colonies.port}`;
    document.getElementById('connection-status').classList.add('connected');
  } catch (error) {
    document.getElementById('connection-status').textContent = 'Connection failed';
  }
}

// ── REST updates ───────────────────────────────────────────────────────

function sendUpdate(device, values) {
  fetch(`/api/readings/${device}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  }).catch(err => console.error('Update failed:', err));
}

// ── Blood Pressure Display ─────────────────────────────────────────────

function setBpDisplay(sys, dia, pulse) {
  document.getElementById('bp-sys-display').textContent = sys;
  document.getElementById('bp-dia-display').textContent = dia;
  document.getElementById('bp-pulse-display').textContent = pulse;

  const statusEl = document.getElementById('bp-status');
  const { label, cls } = getBpStatus(sys, dia);
  statusEl.textContent = label;
  statusEl.className = 'bp-status ' + cls;

  const color = getBpColor(cls);
  document.getElementById('bp-sys-display').style.color = color;
  document.getElementById('bp-dia-display').style.color = color;

  const pulseIcon = document.getElementById('pulse-icon');
  pulseIcon.classList.toggle('beating', pulse > 0);
  if (pulse > 0) {
    pulseIcon.style.animationDuration = (60 / pulse) + 's';
  }
}

function getBpStatus(sys, dia) {
  if (sys < 90 || dia < 60) return { label: 'Low', cls: 'low' };
  if (sys <= 120 && dia <= 80) return { label: 'Normal', cls: 'normal' };
  if (sys <= 129 && dia <= 80) return { label: 'Elevated', cls: 'elevated' };
  if (sys <= 139 || dia <= 89) return { label: 'High Stage 1', cls: 'high' };
  if (sys >= 180 || dia >= 120) return { label: 'Critical', cls: 'critical' };
  return { label: 'High Stage 2', cls: 'critical' };
}

function getBpColor(cls) {
  switch (cls) {
    case 'normal': return '#4ade80';
    case 'elevated': return '#fbbf24';
    case 'high': return '#f59e0b';
    case 'critical': return '#ef4444';
    case 'low': return '#60a5fa';
    default: return '#4ade80';
  }
}

// ── Thermometer Display ────────────────────────────────────────────────

function setThermoDisplay(temp) {
  document.getElementById('thermo-temp-display').textContent = temp.toFixed(1);

  const minTemp = 32, maxTemp = 42;
  const clamped = Math.max(minTemp, Math.min(maxTemp, temp));
  const fraction = (clamped - minTemp) / (maxTemp - minTemp);
  const tubeTop = 20, tubeBottom = 200;
  const mercuryTop = tubeBottom - fraction * (tubeBottom - tubeTop);
  const mercuryHeight = tubeBottom - mercuryTop;

  const mercuryEl = document.getElementById('mercury-col');
  if (mercuryEl) {
    mercuryEl.setAttribute('y', mercuryTop);
    mercuryEl.setAttribute('height', mercuryHeight);
  }

  const { label, cls } = getThermoStatus(temp);
  const statusEl = document.getElementById('thermo-status');
  statusEl.textContent = label;
  statusEl.className = 'thermo-status ' + cls;

  const tempEl = document.getElementById('thermo-temp-display');
  tempEl.style.color = getThermoColor(cls);
}

function getThermoStatus(temp) {
  if (temp < 35.0) return { label: 'Hypothermia', cls: 'low' };
  if (temp < 36.1) return { label: 'Below Normal', cls: 'low' };
  if (temp <= 37.2) return { label: 'Normal', cls: 'normal' };
  if (temp <= 38.0) return { label: 'Elevated', cls: 'elevated' };
  if (temp <= 39.0) return { label: 'Fever', cls: 'fever' };
  return { label: 'High Fever', cls: 'high-fever' };
}

function getThermoColor(cls) {
  switch (cls) {
    case 'normal': return '#4ade80';
    case 'low': return '#60a5fa';
    case 'elevated': return '#fbbf24';
    case 'fever': return '#f59e0b';
    case 'high-fever': return '#ef4444';
    default: return '#ef4444';
  }
}

// ── Sliders ────────────────────────────────────────────────────────────

function setupSliders() {
  const sysSlider = document.getElementById('bp-sys-slider');
  const diaSlider = document.getElementById('bp-dia-slider');
  const pulseSlider = document.getElementById('bp-pulse-slider');

  function sendBp() {
    sendUpdate('bloodPressure', {
      systolic: parseInt(sysSlider.value),
      diastolic: parseInt(diaSlider.value),
      pulse: parseInt(pulseSlider.value),
    });
  }

  sysSlider.addEventListener('input', () => {
    document.getElementById('bp-sys-val').textContent = sysSlider.value;
    setBpDisplay(parseInt(sysSlider.value), parseInt(diaSlider.value), parseInt(pulseSlider.value));
  });
  sysSlider.addEventListener('change', sendBp);

  diaSlider.addEventListener('input', () => {
    document.getElementById('bp-dia-val').textContent = diaSlider.value;
    setBpDisplay(parseInt(sysSlider.value), parseInt(diaSlider.value), parseInt(pulseSlider.value));
  });
  diaSlider.addEventListener('change', sendBp);

  pulseSlider.addEventListener('input', () => {
    document.getElementById('bp-pulse-val').textContent = pulseSlider.value;
    setBpDisplay(parseInt(sysSlider.value), parseInt(diaSlider.value), parseInt(pulseSlider.value));
  });
  pulseSlider.addEventListener('change', sendBp);

  const thermoSlider = document.getElementById('thermo-slider');
  thermoSlider.addEventListener('input', () => {
    const temp = parseInt(thermoSlider.value) / 10;
    document.getElementById('thermo-val').textContent = temp.toFixed(1);
    setThermoDisplay(temp);
  });
  thermoSlider.addEventListener('change', () => {
    const temp = parseInt(thermoSlider.value) / 10;
    sendUpdate('thermometer', { temperature: temp });
  });
}

// ── Symptoms ───────────────────────────────────────────────────────────

function setupSymptoms() {
  const el = document.getElementById('symptoms-input');
  let debounceTimer = null;

  el.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      sendUpdate('symptoms', { symptoms: el.value });
    }, 500);
  });
}
