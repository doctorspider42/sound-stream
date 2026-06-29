// Intentionally minimal. The renderer uses only Web APIs (Web Audio, getUserMedia,
// File API, Blob downloads), so no Node bridge is required. Kept for contextIsolation.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('spiderTec', { version: '1.0.0' });
