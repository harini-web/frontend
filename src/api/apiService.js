import axios from 'axios';

// Vite proxy forwards /api → http://localhost:8080
const api = axios.create({ baseURL: '/api' });

// ── Bluetooth ──────────────────────────────────────────────────────
// Triggers OS-level BT Classic scan, returns list of "NAME | MAC" strings
export const startScan    = ()           => api.post('/bluetooth/scan');

// Returns all previously saved/paired devices from MySQL
export const getDevices   = ()           => api.get('/bluetooth/devices');

// Save a paired device to MySQL
export const saveDevice   = (device)     => api.post('/bluetooth/save', device);

// Delete a saved device
export const deleteDevice = (id)         => api.delete(`/bluetooth/devices/${id}`);

// ── Users ──────────────────────────────────────────────────────────
export const login        = (creds)      => api.post('/users/login', creds);

// ── Protocols ─────────────────────────────────────────────────────
export const getProtocols = ()           => api.get('/protocols');

// ── Fields ────────────────────────────────────────────────────────
export const getFields    = ()           => api.get('/fields');