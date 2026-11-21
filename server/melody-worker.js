import { parentPort, workerData } from 'node:worker_threads';
import { analyzeMelody } from '../src/audio/melody-analysis.js';

try { parentPort.postMessage({ analysis: analyzeMelody(workerData.samples, workerData.sampleRate) }); }
catch (error) { parentPort.postMessage({ error: error.message || 'Recording analysis failed.' }); }
