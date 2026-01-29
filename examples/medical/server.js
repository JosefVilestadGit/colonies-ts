/**
 * Medical Toolsexecutor
 *
 * A combined web server + toolsexecutor that:
 * 1. Serves the patient UI (blood pressure monitor, thermometer, symptoms)
 * 2. Registers as a toolsexecutor with ColonyOS
 * 3. Registers tool functions (tool_read_blood_pressure, tool_read_temperature, tool_read_symptoms)
 * 4. Maintains current readings and symptoms in memory (set via UI)
 * 5. Handles assigned tool processes and returns JSON results
 *
 * Usage: npm start
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ColoniesClient, Crypto } from 'colonies-ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration from environment
const config = {
  port: parseInt(process.env.WEB_PORT || '3000', 10),
  colonies: {
    host: process.env.COLONIES_SERVER_HOST || 'localhost',
    port: parseInt(process.env.COLONIES_SERVER_PORT || '50080', 10),
    tls: (process.env.COLONIES_TLS ?? 'false') === 'true',
  },
  colonyName: process.env.COLONIES_COLONY_NAME || 'dev',
  colonyPrvKey: process.env.COLONIES_COLONY_PRVKEY,
  executorName: 'medical',
  locationName: 'hospital',
};

if (!config.colonyPrvKey) {
  console.error('Error: COLONIES_COLONY_PRVKEY environment variable is required');
  console.error('Run: source /path/to/colonies/docker-compose.env');
  process.exit(1);
}

const client = new ColoniesClient(config.colonies);
const crypto = new Crypto();

const EXECUTOR_TYPE = 'toolsexecutor';

// ── In-memory readings ─────────────────────────────────────────────────
const readings = {
  bloodPressure: { systolic: 120, diastolic: 80, pulse: 72 },
  thermometer: { temperature: 36.6 },
  symptoms: '',
};

// ── Express app ────────────────────────────────────────────────────────
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  const browserHost = req.get('host')?.split(':')[0] || 'localhost';

  res.json({
    colonies: {
      host: config.colonies.host === 'localhost' ? browserHost : config.colonies.host,
      port: config.colonies.port,
      tls: config.colonies.tls,
    },
    colonyName: config.colonyName,
    colonyPrvKey: config.colonyPrvKey,
  });
});

// REST endpoints for UI to update readings
app.post('/api/readings/bloodPressure', (req, res) => {
  Object.assign(readings.bloodPressure, req.body);
  console.log('Blood pressure updated:', readings.bloodPressure);
  res.json(readings.bloodPressure);
});

app.post('/api/readings/thermometer', (req, res) => {
  Object.assign(readings.thermometer, req.body);
  console.log('Temperature updated:', readings.thermometer);
  res.json(readings.thermometer);
});

app.post('/api/readings/symptoms', (req, res) => {
  readings.symptoms = req.body.symptoms || '';
  console.log('Symptoms updated:', readings.symptoms);
  res.json({ symptoms: readings.symptoms });
});

// ── Tool definitions ─────────────────────────────────────────────────
const tools = [
  {
    funcname: 'tool_read_blood_pressure',
    description: 'Read the current blood pressure, including systolic, diastolic, and pulse values',
    args: [],
  },
  {
    funcname: 'tool_read_temperature',
    description: 'Read the current body temperature in degrees Celsius',
    args: [],
  },
  {
    funcname: 'tool_read_symptoms',
    description: 'Read the current patient-reported symptoms',
    args: [],
  },
];

// ── Executor registration ──────────────────────────────────────────────
let executorPrvKey = null;

async function registerExecutor() {
  const executorName = config.executorName;

  // Generate a fresh key pair for this executor
  executorPrvKey = crypto.generatePrivateKey();
  const executorId = crypto.id(executorPrvKey);
  console.log('Generated executor key, id:', executorId);

  client.setPrivateKey(config.colonyPrvKey);
  try {
    // Remove old registration if it exists
    try {
      await client.getExecutor(config.colonyName, executorName);
      await client.removeExecutor(config.colonyName, executorName);
      console.log('Removed old executor registration');
    } catch {
      // didn't exist
    }

    await client.addExecutor({
      executorname: executorName,
      executortype: EXECUTOR_TYPE,
      colonyname: config.colonyName,
      executorId: executorId,
      location: { long: 0, lat: 0, description: 'hospital' },
      locationname: 'hospital',
    });
    await client.approveExecutor(config.colonyName, executorName);
    console.log(`Executor registered and approved: ${executorName} (type: ${EXECUTOR_TYPE})`);
  } catch (error) {
    console.error('Failed to register executor:', error.message);
    process.exit(1);
  }

  // Register tool functions
  client.setPrivateKey(executorPrvKey);
  for (const tool of tools) {
    try {
      await client.addFunction({
        executorname: executorName,
        executortype: EXECUTOR_TYPE,
        colonyname: config.colonyName,
        funcname: tool.funcname,
        description: tool.description,
        args: tool.args,
      });
      console.log(`  Registered function: ${tool.funcname}`);
    } catch (err) {
      console.warn(`  Failed to register ${tool.funcname} (may already exist):`, err.message);
    }
  }
}

// ── Tool handlers ──────────────────────────────────────────────────────
function handleReadBloodPressure() {
  const bp = { ...readings.bloodPressure, timestamp: new Date().toISOString() };
  return JSON.stringify(bp);
}

function handleReadTemperature() {
  const temp = { ...readings.thermometer, timestamp: new Date().toISOString() };
  return JSON.stringify(temp);
}

function handleReadSymptoms() {
  return JSON.stringify({
    symptoms: readings.symptoms,
    timestamp: new Date().toISOString(),
  });
}

// ── Process loop ───────────────────────────────────────────────────────
async function processLoop() {
  console.log('\nListening for medical tool processes...\n');

  while (true) {
    try {
      client.setPrivateKey(executorPrvKey);
      const proc = await client.assign(config.colonyName, 10, executorPrvKey);

      if (proc) {
        const funcname = proc.spec?.funcname;
        console.log(`Assigned process: ${proc.processid} func=${funcname}`);

        if (!funcname?.startsWith('tool_')) {
          console.log(`  Skipping non-tool function: ${funcname}`);
          await client.failProcess(proc.processid, ['Not a tool function']);
          continue;
        }

        try {
          let result;

          switch (funcname) {
            case 'tool_read_blood_pressure':
              result = handleReadBloodPressure();
              console.log('  Returned blood pressure:', result);
              break;

            case 'tool_read_temperature':
              result = handleReadTemperature();
              console.log('  Returned temperature:', result);
              break;

            case 'tool_read_symptoms':
              result = handleReadSymptoms();
              console.log('  Returned symptoms:', result);
              break;

            default:
              console.log(`  Unknown tool function: ${funcname}`);
              await client.failProcess(proc.processid, [`Unknown tool: ${funcname}`]);
              continue;
          }

          // Set output attribute so the result can be read from the completed process
          await client.addAttribute({
            targetid: proc.processid,
            targetcolonyname: config.colonyName,
            targetprocessgraphid: proc.processgraphid || '',
            attributetype: 1, // output
            key: 'result',
            value: result,
          });

          await client.closeProcess(proc.processid, [result]);

        } catch (err) {
          console.error(`  Process error: ${err.message}`);
          try {
            await client.failProcess(proc.processid, [err.message]);
          } catch {}
        }
      }
    } catch (error) {
      const isExpected = error.message.includes('timeout') || error.message.includes('No process available');
      if (!isExpected) {
        console.error('Process loop error:', error.message);
      }
    }
  }
}

// ── Start ──────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(50));
  console.log('Medical Toolsexecutor');
  console.log('='.repeat(50));
  console.log(`Colony: ${config.colonyName}`);
  console.log(`Server: ${config.colonies.host}:${config.colonies.port}`);
  console.log(`Executor: ${config.executorName} (type: ${EXECUTOR_TYPE})`);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Web UI running at http://0.0.0.0:${config.port}`);
  });

  await registerExecutor();
  await processLoop();
}

main().catch(error => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
