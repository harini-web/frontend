import React, { useState, useEffect, useRef, useCallback } from 'react';

// Restoring your actual API imports!
// Ensure your '../api/apiService' file exists and is correctly routed.
import { startScan, getDevices, saveDevice, deleteDevice, getProtocols } from '../api/apiService';

// ─── ESC/POS helper — builds correct byte arrays for thermal printer ─────────
const ESC = 0x1B;
const GS  = 0x1D;

const ESCPOS = {
    init:        () => [ESC, 0x40],
    boldOn:      () => [ESC, 0x21, 0x08],
    boldOff:     () => [ESC, 0x21, 0x00],
    cutPaper:    () => [GS,  0x56, 0x41, 0x00],
    lineFeed:    () => [0x0A],
    text:        (str) => [...new TextEncoder().encode(str)],
    // ✨ FIX: Added mandatory double Line Feeds (\n) so the printer actually prints and pushes paper
    printHello:  () => [
        ...[ESC, 0x40], // Force init
        ...new TextEncoder().encode('Hello World\n\n'), // Double Line feed forces print
        ...[0x0A, 0x0A],
        ...[GS, 0x56, 0x41, 0x00], // Cut
    ],
    // Automatically wraps normal text in Init and Line Feeds to guarantee a physical print
    formatTextToPrint: (str) => [
        ...[ESC, 0x40],
        ...new TextEncoder().encode(str + '\n\n'),
        ...[0x0A, 0x0A]
    ],
    fromHex:     (hexStr) => {
        const clean = hexStr.replace(/\s+/g, '');
        const arr = [];
        for (let i = 0; i < clean.length; i += 2) {
            const byte = parseInt(clean.substring(i, i + 2), 16);
            if (!isNaN(byte)) arr.push(byte);
        }
        return arr;
    },
};

// ─── Chrome-style Tab ────────────────────────────────────────────────────────
function DeviceTab({ tab, active, onClick, onClose }) {
    return (
        <div onClick={onClick} style={{ ...S.tab, ...(active ? S.tabActive : S.tabInactive) }}>
            <span style={{ marginRight: 5 }}>
                {tab.type === 'ble' || tab.type === 'universal' ? '📶' : '📡'}
            </span>
            <span style={S.tabName}>{tab.device.name}</span>
            <span style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginLeft: 5,
                background: tab.connected ? '#43a047' : '#666', display: 'inline-block'
            }} />
            <button
                style={S.tabClose}
                onClick={e => { e.stopPropagation(); onClose(tab.id); }}
            >×</button>
        </div>
    );
}

// ─── Terminal Panel — one per tab ────────────────────────────────────────────
function TerminalPanel({ tab, onLog }) {
    const [pbBytes, setPbBytes]           = useState([0x02, 0x27, 0x69, 0x01, 0x72, 0x73]);
    const [customHex, setCustomHex]       = useState('');
    const [customText, setCustomText]     = useState('');
    const [packetStatus, setPacketStatus] = useState('Waiting for response...');
    const [lastResponse, setLastResponse] = useState('');
    const [protocols, setProtocols]       = useState([]);
    const [protocol, setProtocol]         = useState('');
    const [reading, setReading]           = useState(false);
    const readerRef   = useRef(null);
    const logRef      = useRef(null);

    useEffect(() => {
        getProtocols().then(r => setProtocols(r.data)).catch(() => {});
    }, []);

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [tab.log]);

    // ── Start continuous read loop (Real Hardware RX) ──
    useEffect(() => {
        if (!tab.connected || reading) return;
        let active = true;
        setReading(true);

        if ((tab.type === 'classic' || tab.type === 'usb') && tab.port) {
            const readLoop = async () => {
                try {
                    while (active && tab.port.readable) {
                        readerRef.current = tab.port.readable.getReader();
                        try {
                            while (active) {
                                const { value, done } = await readerRef.current.read();
                                if (done) { active = false; break; }
                                if (value && value.length > 0) {
                                    const hex = Array.from(value)
                                        .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                                    setLastResponse(hex);
                                    setPacketStatus('✔ Real Response received');
                                    onLog(tab.id, 'RX: ' + hex);
                                }
                            }
                        } finally {
                            try { readerRef.current?.releaseLock(); } catch {}
                            readerRef.current = null;
                        }
                    }
                } catch (e) {
                    if (active) onLog(tab.id, 'Read ended: ' + e.message);
                }
                setReading(false);
            };
            readLoop();
        }
        else if ((tab.type === 'ble' || tab.type === 'universal') && tab.characteristic) {
            const handleBleRx = (event) => {
                const value = event.target.value;
                const uint8 = new Uint8Array(value.buffer);
                const hex = Array.from(uint8)
                    .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                setLastResponse(hex);
                setPacketStatus('✔ Real Response received');
                onLog(tab.id, 'RX: ' + hex);
            };

            tab.characteristic.startNotifications()
                .then(() => tab.characteristic.addEventListener('characteristicvaluechanged', handleBleRx))
                .catch(err => onLog(tab.id, 'RX Notification Setup Error: ' + err.message));

            return () => {
                active = false;
                if (tab.characteristic) {
                    tab.characteristic.removeEventListener('characteristicvaluechanged', handleBleRx);
                    tab.characteristic.stopNotifications().catch(() => {});
                }
            };
        } else {
            setReading(false);
        }

        return () => {
            active = false;
            try { readerRef.current?.cancel(); readerRef.current?.releaseLock(); } catch {}
        };
    }, [tab.id, tab.port, tab.characteristic, tab.connected, tab.type, reading, onLog]);

    // ── Real Data Sending (TX) to Hardware ──
    const sendBytes = async (bytes) => {
        if (!tab.connected) {
            setPacketStatus('❌ No device connected'); return;
        }
        if (!tab.port && !tab.characteristic) {
            setPacketStatus('❌ Connected, but this is a media/audio device (No Data Channel)'); return;
        }

        const hexStr = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        setPacketStatus('Sending Raw Data to Hardware…');
        onLog(tab.id, 'TX: ' + hexStr);

        const dataArray = new Uint8Array(bytes);

        try {
            if ((tab.type === 'classic' || tab.type === 'usb') && tab.port) {
                const writer = tab.port.writable.getWriter();
                await writer.write(dataArray);
                writer.releaseLock();
            } else if ((tab.type === 'ble' || tab.type === 'universal') && tab.characteristic) {
                await tab.characteristic.writeValue(dataArray);
            }
            setPacketStatus('✔ Packet sent to device — awaiting hardware response');
            onLog(tab.id, 'TX sent OK');
        } catch (err) {
            setPacketStatus('❌ Real Send failed: ' + err.message);
            onLog(tab.id, 'TX ERROR: ' + err.message);
        }
    };

    const handleSendCustomHex = () => {
        if (!customHex.trim()) return;
        const bytes = ESCPOS.fromHex(customHex);
        if (bytes.length === 0) return setPacketStatus('❌ Invalid hex input format');
        sendBytes(bytes);
    };

    const handleSendCustomText = () => {
        if (!customText.trim()) return;
        const bytes = ESCPOS.formatTextToPrint(customText);
        setPbBytes(bytes); // Show in visualizer
        sendBytes(bytes);
    };

    const handlePreset = (label) => {
        let b = [];
        switch (label) {
            case 'Init Printer': b = ESCPOS.init(); break;
            case 'Bold ON':      b = ESCPOS.boldOn(); break;
            case 'Bold OFF':     b = ESCPOS.boldOff(); break;
            case 'Cut Paper':    b = ESCPOS.cutPaper(); break;
            case 'Print HI':     b = ESCPOS.printHello(); break;
            case 'Reset':        b = [0x02, 0x27, 0x69, 0x01, 0x72, 0x73]; break;
            default: break;
        }
        setPbBytes(b); sendBytes(b);
    };

    const byteToHex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
    const byteColor = (i, total) => i === 0 ? '#f9a825' : i === total-1 ? '#c62828' : i <= 3 ? '#1565c0' : '#2e7d32';
    const byteLabel = (i, total) => i === 0 ? 'STX' : i === total-1 ? 'ETX' : i <= 3 ? 'CMD' : 'DATA';

    return (
        <div style={S.terminalLayout}>
            {/* LEFT — builder */}
            <div style={S.termLeft}>
                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Protocol</div>
                    <select style={S.tpSelect} value={protocol} onChange={e => setProtocol(e.target.value)}>
                        <option value="">Select Protocol</option>
                        {protocols.map(p => <option key={p.protocolId} value={p.protocolStr}>{p.protocolStr}</option>)}
                    </select>
                </div>
                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Packet Builder</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:10 }}>
                        {pbBytes.map((b, i) => (<span key={i} style={S.pbByte}>{byteToHex(b)}</span>))}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:10 }}>
                        {['Init Printer','Bold ON','Bold OFF','Cut Paper','Print HI','Reset'].map(a => (
                            <button key={a} style={S.pbBtn} onClick={() => handlePreset(a)}>{a}</button>
                        ))}
                    </div>
                    <button style={S.btnSend} onClick={() => sendBytes(pbBytes)}>▶ Send Packet</button>
                </div>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Force Text Print</div>
                    <div style={{ fontSize:'0.7rem', color:'#888', marginBottom:6 }}>Auto-adds Init and Line Feeds (\n)</div>
                    <input style={S.hexInput} placeholder="Type text to print..." value={customText}
                           onChange={e => setCustomText(e.target.value)}
                           onKeyDown={e => e.key === 'Enter' && handleSendCustomText()} />
                    <button style={{ ...S.btnSend, marginTop:6, background:'#2e7d32' }} onClick={handleSendCustomText}>▶ Print Text</button>
                </div>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Send Raw Hex Bytes</div>
                    <div style={{ fontSize:'0.7rem', color:'#888', marginBottom:6 }}>e.g. 8A C6 04 (Remember 0A for LF!)</div>
                    <input style={S.hexInput} placeholder="8A C6 04" value={customHex}
                           onChange={e => setCustomHex(e.target.value.toUpperCase())}
                           onKeyDown={e => e.key === 'Enter' && handleSendCustomHex()} />
                    <button style={{ ...S.btnSend, marginTop:6 }} onClick={handleSendCustomHex}>▶ Send Raw Hex</button>
                </div>
            </div>

            {/* CENTER — visualizer + response */}
            <div style={S.termCenter}>
                <div style={S.vizBox}>
                    <div style={S.tpLabel}>Live Packet Visualizer</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:10 }}>
                        {pbBytes.map((b, i) => (
                            <div key={i} style={{ textAlign:'center' }}>
                                <div style={{ ...S.pvHex, background: byteColor(i, pbBytes.length) }}>{byteToHex(b)}</div>
                                <div style={S.pvType}>{byteLabel(i, pbBytes.length)}</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div style={S.respSection}>
                    <div style={S.tpLabel}>Last Hardware Response</div>
                    <div style={{ ...S.respBox, color: lastResponse ? '#a5d6a7' : '#555' }}>
                        {lastResponse || 'No response data received yet'}
                    </div>
                </div>
                <div style={S.respSection}>
                    <div style={S.tpLabel}>Connection & Packet Status</div>
                    <div style={{ ...S.respBox, color: packetStatus.startsWith('✔') ? '#a5d6a7' : packetStatus.startsWith('❌') ? '#ef9a9a' : '#aaa' }}>
                        {packetStatus}
                    </div>
                </div>
            </div>

            {/* RIGHT — comm log */}
            <div style={S.termRight}>
                <div style={S.clHeader}>
                    <span style={{ ...S.tpLabel, marginBottom:0 }}>Live Comm Log</span>
                    <button style={S.clClear} onClick={() => onLog(tab.id, '--- LOG CLEARED ---')}>Clear</button>
                </div>
                <div style={S.clEntries} ref={logRef}>
                    {tab.log.map((e, i) => (
                        <div key={i} style={S.clEntry}>
                            <span style={{ color:'#444' }}>[{e.ts}]</span>{' '}
                            <span style={{ color: e.msg.startsWith('RX') ? '#81c784' : e.msg.startsWith('TX') ? '#90caf9' : '#666' }}>{e.msg}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function TerminalPage({ user, onLogout }) {
    const [scannedDevices, setScannedDevices] = useState([]);
    const [savedDevices, setSavedDevices]     = useState([]);
    const [status, setStatus]                 = useState('Idle');
    const [scanning, setScanning]             = useState(false);

    // Ordered as requested
    const [activeType, setActiveType]         = useState('classic');
    const [baudRate, setBaudRate]             = useState(115200);
    const [tabs, setTabs]                     = useState([]);
    const [activeTabId, setActiveTabId]       = useState('home');

    useEffect(() => { loadSavedDevices(); }, []);

    const loadSavedDevices = async () => {
        try { const r = await getDevices(); setSavedDevices(r.data); }
        catch (e) { console.warn("Failed to load saved devices"); }
    };

    const addLog = useCallback((tabId, msg) => {
        const ts = new Date().toTimeString().substring(0, 8);
        setTabs(prev => prev.map(t => {
            if (t.id === tabId) return { ...t, log: [...t.log, { ts, msg }].slice(-50) };
            return t;
        }));
    }, []);

    // ── Main Scan Hub ──
    const handleScan = async () => {
        // Only pure BLE bypasses the UI grid completely.
        if (activeType === 'ble') return handleBleConnect();

        // ✨ FIX: BT Classic AND Universal now BOTH hit the Spring Boot backend
        // to populate the native UI grid with Headsets, Speakers, Printers, etc!
        setScanning(true);
        setScannedDevices([]);
        setStatus('Fetching paired devices from Operating System…');

        try {
            const res = await startScan();
            const list = (res.data || []).map((d, i) => ({
                id: `bt-${i}-${(d.deviceId || '').replace(/[^a-z0-9]/gi,'')}`,
                name: d.name, deviceId: d.deviceId, status: d.status,
            }));
            setScannedDevices(list);
            setStatus(list.length > 0 ? `${list.length} device(s) found and listed below` : 'No devices found');
        } catch (err) {
            setStatus('Scan error — is Spring Boot backend running?');
        } finally {
            setScanning(false);
        }
    };

    // ✨ BT CLASSIC (UNIVERSAL) CONNECTION HANDLER
    const handleUniversalBtConnect = async (targetDevice) => {
        setStatus(`Attempting connection to ${targetDevice.name}...`);

        const tabId = `tab-uni-${Date.now()}`;
        let characteristic = null;
        let connectionMsg = `Paired with ${targetDevice.name}.`;

        try {
            // Step 1: Attempt to connect via Web Bluetooth for data-capable devices
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ name: targetDevice.name }],
                optionalServices: [
                    '00001101-0000-1000-8000-00805f9b34fb', // SPP fallback
                    '000018f0-0000-1000-8000-00805f9b34fb', // Printers
                    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Thermal Printers
                    '00001800-0000-1000-8000-00805f9b34fb'  // Generic Access
                ]
            });

            setStatus(`Connecting data streams to ${device.name}...`);

            try {
                const server = await device.gatt.connect();
                const services = await server.getPrimaryServices();
                for (const service of services) {
                    const chars = await service.getCharacteristics();
                    const writeChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                    if (writeChar) {
                        characteristic = writeChar;
                        connectionMsg = `Universal BT Connected: ${device.name} (Data Channel Open)`;
                        break;
                    }
                }
                if (!characteristic) connectionMsg = `Paired with ${device.name} (Media/Audio Device - Real-time hex data disabled)`;
            } catch (gattErr) {
                console.warn("GATT Connection skipped:", gattErr);
                connectionMsg = `Paired with ${device.name}. Note: Media/Audio devices like headsets do not accept raw hex data.`;
            }
        } catch (err) {
            // Step 2: Fallback for Headsets and Classic-Only Devices
            // Browsers block direct pairing to headsets. We handle it via the OS and open the tab visually.
            console.warn("Web Bluetooth pairing failed/skipped (Typical for Headsets):", err);
            connectionMsg = `[OS MANAGED] Connected to ${targetDevice.name}.\nNote: Headsets and Media devices are routed by Windows. Browsers do not support sending raw text/hex data to audio devices.`;
        }

        // Always open the tab for the user's dashboard experience
        setTabs(prev => [...prev, {
            id: tabId, type: 'universal', device: { name: targetDevice.name, deviceId: targetDevice.deviceId },
            characteristic, connected: true,
            log: [{ ts: new Date().toTimeString().substring(0, 8), msg: connectionMsg }]
        }]);

        setActiveTabId(tabId);
        setStatus(`Successfully routed ${targetDevice.name}`);
        try { await saveDevice({ deviceId: targetDevice.deviceId || targetDevice.name, deviceName: targetDevice.name, deviceType: 'UNI_BT' }); loadSavedDevices(); } catch {}
    };

    // ✨ BLE (GATT) CONNECTION HANDLER
    const handleBleConnect = async () => {
        setStatus(`Awaiting secure BLE selection...`);
        try {
            // BLE handles scanning entirely through the popup since Windows doesn't aggressively pair BLE natively
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', '00001800-0000-1000-8000-00805f9b34fb']
            });

            setStatus(`Connecting to GATT Server on ${device.name}...`);
            const server = await device.gatt.connect();

            let characteristic = null;
            try {
                const service = await server.getPrimaryService('e7810a71-73ae-499d-8c15-faa9aef0c3f2');
                characteristic = await service.getCharacteristic('bef8d6c9-9c21-4c9e-b632-bd58c1009f9f');
            } catch(e) { console.warn("Failed to find exact BLE characteristics", e); }

            const tabId = `tab-ble-${Date.now()}`;
            setTabs(prev => [...prev, {
                id: tabId, type: 'ble', device: { name: device.name, deviceId: device.id },
                characteristic, connected: true,
                log: [{ ts: new Date().toTimeString().substring(0, 8), msg: `BLE Connected to ${device.name}` }]
            }]);

            setActiveTabId(tabId);
            setStatus(`Connected via BLE`);
            try { await saveDevice({ deviceId: device.id || device.name, deviceName: device.name, deviceType: 'BLE' }); loadSavedDevices(); } catch {}
        } catch (err) {
            setStatus('BLE Connect failed or Cancelled');
        }
    };

    // ✨ COM PORT (BT CLASSIC) CONNECTION HANDLER
    const handleClassicConnect = async (targetDevice) => {
        setStatus(`Select the COM Port assigned to ${targetDevice.name}…`);
        try {
            const port = await navigator.serial.requestPort();
            await port.open({ baudRate: Number(baudRate) });

            const tabId = `tab-classic-${Date.now()}`;
            setTabs(prev => [...prev, {
                id: tabId, type: 'classic', device: targetDevice,
                port, connected: true,
                log: [{ ts: new Date().toTimeString().substring(0, 8), msg: `Serial Connected via COM to ${targetDevice.name}` }]
            }]);

            setActiveTabId(tabId);
            setStatus(`Connected to ${targetDevice.name}`);
            try { await saveDevice({ deviceId: targetDevice.deviceId || targetDevice.name, deviceName: targetDevice.name, deviceType: 'BT Classic' }); loadSavedDevices(); } catch {}
        } catch (err) {
            setStatus('COM selection cancelled');
        }
    };

    const handleCloseTab = async (tabId) => {
        const tab = tabs.find(t => t.id === tabId);
        if ((tab?.type === 'classic' || tab?.type === 'usb') && tab?.port) {
            try { await tab.port.close(); } catch (e) {}
        } else if ((tab?.type === 'ble' || tab?.type === 'universal') && tab?.characteristic) {
            try { tab.characteristic.service.device.gatt.disconnect(); } catch (e) {}
        }
        const rest = tabs.filter(t => t.id !== tabId);
        setTabs(rest);
        setActiveTabId(rest.length > 0 ? rest[rest.length - 1].id : 'home');
        setStatus('Disconnected');
    };

    // REORDERED AS REQUESTED
    const activeTypesMap = ['classic', 'universal', 'ble', 'usb'];
    const typeLabel = { classic:'BT Classic (COM)', universal:'BT Classic (Universal)', ble:'BLE (GATT)', usb:'USB-UART' };
    const typeIcon  = { classic:'📡', universal:'🎧', ble:'📶', usb:'🔌' };
    const activeTab = tabs.find(t => t.id === activeTabId);

    return (
        <div style={S.layout}>
            {/* ── SIDEBAR ─────────────────────────────────────────── */}
            <aside style={S.sidebar}>
                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Global Dashboard</div>
                    <div style={S.connStatus}>
                        <div style={{ ...S.connDot, background: tabs.length > 0 ? '#43a047' : '#555' }} />
                        <div>
                            <div style={S.connLabel}>{tabs.length > 0 ? `${tabs.length} Device(s) Active` : 'No Connections'}</div>
                        </div>
                    </div>
                </div>
                <div style={S.divider} />

                {/* Hide Baud rate for completely wireless non-COM modes */}
                {activeType !== 'ble' && activeType !== 'universal' && (
                    <>
                        <div style={S.sectionBox}>
                            <div style={S.sectionTitle}>Default Baud Rate</div>
                            <select style={S.tpSelect} value={baudRate} onChange={e => setBaudRate(e.target.value)}>
                                <option value="9600">9600</option>
                                <option value="115200">115200</option>
                            </select>
                        </div>
                        <div style={S.divider} />
                    </>
                )}

                <div style={S.typeList}>
                    <div style={S.sectionTitle}>Discovery Profile Mode</div>
                    {/* Rendered in exact order requested */}
                    {activeTypesMap.map(t => (
                        <div key={t} style={{ ...S.typeItem, ...(activeType === t ? S.typeItemActive : {}) }}
                             onClick={() => { setActiveType(t); setScannedDevices([]); setStatus('Idle'); setActiveTabId('home'); }}>
                            <span style={S.typeIcon}>{typeIcon[t]}</span><span>{typeLabel[t]}</span>
                        </div>
                    ))}
                </div>

                <div style={S.divider} />
                <div style={{ padding:'10px 14px 4px' }}><div style={S.sectionTitle}>Saved Records</div></div>
                <div style={S.prevList}>
                    {savedDevices.map(d => (
                        <div key={d.id} style={S.prevItem}>
                            <div style={{ ...S.prevDot, background:'#1565c0' }} />
                            <div style={{ flex:1 }}><div style={S.prevName}>{d.deviceName}</div></div>
                            <button style={S.btnDelete} onClick={async () => { try { await deleteDevice(d.id); loadSavedDevices(); } catch {} }}>×</button>
                        </div>
                    ))}
                </div>
            </aside>

            {/* ── MAIN ─────────────────────────────────────────────── */}
            <div style={S.main}>
                <div style={S.topBar}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={S.topTitle}>{activeTab ? activeTab.device.name : 'Device Hub Connection Manager'}</span>
                        <span style={S.topSub}>— {status}</span>
                    </div>
                    <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                        {user && <span style={S.userBadge}>Operator: {user.username}</span>}
                        <button style={S.btnLogout} onClick={onLogout}>Logout</button>
                    </div>
                </div>

                {/* THE SYSTEM TAB BAR */}
                <div style={S.tabBar}>
                    <div
                        onClick={() => setActiveTabId('home')}
                        style={{ ...S.tab, ...(activeTabId === 'home' ? S.tabActive : S.tabInactive), padding: '0 16px' }}
                    >
                        <span style={{ marginRight: 5 }}>🏠</span>
                        <span style={S.tabName}>Scan & Pair Hub</span>
                    </div>

                    {tabs.map(t => (
                        <DeviceTab key={t.id} tab={t} active={t.id === activeTabId}
                                   onClick={() => setActiveTabId(t.id)} onClose={handleCloseTab} />
                    ))}
                </div>

                {/* ── INTERACTIVE DISCOVERY WINDOW ── */}
                <div style={{ display: activeTabId === 'home' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>
                    <div style={S.deviceArea}>
                        {activeType === 'ble' ? (
                            <div style={S.placeholder}>
                                <div style={{ fontSize:'3rem' }}>{typeIcon[activeType]}</div>
                                <div style={S.placeholderText}>
                                    BLE devices are not aggressively paired by Windows OS. Use the secure Web Bluetooth chooser to connect directly.
                                </div>
                                <button style={S.btnScanLarge} onClick={handleScan} disabled={scanning}>
                                    {scanning ? 'Running OS Scan…' : '🔍 Display BLE Picker'}
                                </button>
                            </div>
                        ) : scannedDevices.length === 0 ? (
                            <div style={S.placeholder}>
                                <div style={{ fontSize:'3rem' }}>{typeIcon[activeType]}</div>
                                <div style={S.placeholderText}>
                                    {activeType === 'universal'
                                        ? "Trigger a scan to fetch ALL Bluetooth devices (Headphones, Printers, etc.) from your OS into this interface."
                                        : "Trigger a scan to locate components configured over COM lines."}
                                </div>
                                <button style={S.btnScanLarge} onClick={handleScan} disabled={scanning}>
                                    {scanning ? 'Running OS Scan…' : '🔍 Scan Bluetooth Hardware'}
                                </button>
                            </div>
                        ) : (
                            <>
                                <div style={S.gridHeader}>Discovered Native Devices <span style={{ color:'#555', fontWeight:400 }}>({scannedDevices.length} identified)</span></div>
                                <div style={S.grid}>
                                    {scannedDevices.map(d => {
                                        const openTab = tabs.find(t => t.device.deviceId === d.deviceId);
                                        return (
                                            <div key={d.id} style={S.card}>
                                                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                                                    <div style={S.cardIcon}>📡</div>
                                                    <div>
                                                        <div style={S.cardName}>{d.name}</div>
                                                        <div style={{ fontSize:'0.7rem', color: d.status === 'OK' ? '#43a047' : '#888', marginTop:2 }}>
                                                            {d.status === 'OK' ? '● Linked' : '○ Available'}
                                                        </div>
                                                    </div>
                                                </div>
                                                <button style={{ ...S.btnConnect, ...(openTab ? S.btnDisconn : {}) }}
                                                        onClick={() => {
                                                            if (openTab) setActiveTabId(openTab.id);
                                                            else if (activeType === 'classic') handleClassicConnect(d);
                                                            else if (activeType === 'ble') handleBleConnect();
                                                            else handleUniversalBtConnect(d);
                                                        }}>
                                                    {openTab ? '→ Return to View' : 'Initialize Connection'}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* ── PERSISTENT RUNNING TERMINALS ── */}
                {tabs.map(tab => (
                    <div key={tab.id} style={{ display: activeTabId === tab.id ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
                        <TerminalPanel tab={tab} onLog={addLog} />
                    </div>
                ))}

            </div>
        </div>
    );
}

/* ── UI Core Theme Styles ── */
const S = {
    layout:       { display:'flex', height:'100vh', overflow:'hidden', background:'#121212', fontFamily:'Segoe UI,sans-serif' },
    sidebar:      { width:240, minWidth:240, background:'#f5f5f5', display:'flex', flexDirection:'column', overflowY:'auto', borderRight:'1px solid #ddd' },
    sectionBox:   { padding:'14px 14px 8px' },
    sectionTitle: { fontSize:'0.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:8 },
    divider:      { height:1, background:'#e0e0e0', margin:'6px 14px' },
    connStatus:   { background:'#fff', borderRadius:8, padding:'10px 12px', border:'1px solid #e0e0e0', display:'flex', alignItems:'center', gap:8 },
    connDot:      { width:10, height:10, borderRadius:'50%', flexShrink:0 },
    connLabel:    { fontWeight:600, color:'#333', fontSize:'0.82rem' },
    typeList:     { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:6 },
    typeItem:     { display:'flex', alignItems:'center', gap:10, background:'#fff', border:'1.5px solid #e0e0e0', borderRadius:8, padding:'8px 12px', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, color:'#333' },
    typeItemActive:{ borderColor:'#1565c0', background:'#e3f2fd', color:'#1565c0' },
    typeIcon:     { fontSize:'1.1rem' },
    prevList:     { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:5 },
    prevItem:     { display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid #e0e0e0', borderRadius:7, padding:'7px 10px' },
    prevDot:      { width:8, height:8, borderRadius:'50%', flexShrink:0 },
    prevName:     { fontWeight:600, fontSize:'0.8rem', color:'#333' },
    btnDelete:    { background:'none', border:'none', color:'#aaa', cursor:'pointer', fontSize:'1rem', lineHeight:1, padding:'0 2px' },
    tpSelect:     { width:'100%', background:'#f8f8f8', border:'1px solid #ddd', color:'#333', padding:'5px 8px', borderRadius:4, fontSize:'0.8rem' },

    main:         { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
    topBar:       { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'#1e1e1e', borderBottom:'1px solid #2a2a2a', minHeight:48, flexShrink:0 },
    topTitle:     { color:'#90caf9', fontWeight:700, fontSize:'0.9rem' },
    topSub:       { color:'#555', fontSize:'0.78rem' },
    userBadge:    { color:'#aaa', fontSize:'0.78rem' },
    btnLogout:    { background:'#e53935', color:'#fff', border:'none', padding:'5px 13px', borderRadius:4, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },

    tabBar:       { display:'flex', alignItems:'center', background:'#161616', borderBottom:'2px solid #1565c0', padding:'4px 8px 0', minHeight:40, overflowX:'auto', flexShrink:0 },
    tab:          { display:'flex', alignItems:'center', padding:'0 12px', height:32, borderRadius:'6px 6px 0 0', cursor:'pointer', fontSize:'0.8rem', fontWeight:600, minWidth:130, maxWidth:220, border:'1px solid transparent', borderBottom:'none', marginRight:3, userSelect:'none', gap:4 },
    tabActive:    { background:'#121212', color:'#90caf9', borderColor:'#333' },
    tabInactive:  { background:'#1e1e1e', color:'#666', borderColor:'transparent' },
    tabName:      { flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
    tabClose:     { background:'none', border:'none', color:'#555', cursor:'pointer', fontSize:'1rem', padding:'0', lineHeight:1, marginLeft:4 },

    deviceArea:   { flex:1, overflowY:'auto', display:'flex', flexDirection:'column' },
    placeholder:  { flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, color:'#444', padding: '20px' },
    placeholderText:{ fontSize:'0.88rem', textAlign:'center', maxWidth:400, lineHeight:1.6 },
    btnScanLarge: { background:'#1565c0', color:'#fff', border:'none', padding:'10px 28px', borderRadius:6, cursor:'pointer', fontSize:'0.88rem', fontWeight:600 },
    gridHeader:   { padding:'16px 24px 8px', fontSize:'0.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#666' },
    grid:         { padding:'4px 24px 24px', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:14 },
    card:         { background:'#1e1e2e', border:'1.5px solid #2a2a3e', borderRadius:10, padding:16, display:'flex', flexDirection:'column', gap:10 },
    cardIcon:     { width:40, height:40, borderRadius:'50%', background:'#2a2a4e', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.2rem' },
    cardName:     { fontSize:'0.88rem', fontWeight:700, color:'#e0e0e0' },
    btnConnect:   { background:'#1565c0', color:'#fff', border:'none', padding:'7px 0', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnDisconn:   { background:'#2e7d32' },

    terminalLayout:{ flex:1, display:'flex', overflow:'hidden', width: '100%' },
    termLeft:     { width:260, minWidth:260, background:'#0d0d0d', borderRight:'1px solid #1a1a1a', overflowY:'auto', flexShrink:0 },
    termCenter:   { flex:1, overflowY:'auto', background:'#121212', padding:20, display:'flex', flexDirection:'column', gap:14 },
    termRight:    { width:200, minWidth:200, background:'#080808', borderLeft:'1px solid #1a1a1a', display:'flex', flexDirection:'column', flexShrink:0 },
    tpSection:    { padding:'12px 14px', borderBottom:'1px solid #1a1a1a' },
    tpLabel:      { fontSize:'0.68rem', textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:6 },
    pbByte:       { background:'#252525', color:'#90caf9', padding:'3px 7px', borderRadius:4, fontFamily:'monospace', fontSize:'0.75rem', letterSpacing:'0.05em' },
    pbBtn:        { background:'#1e1e1e', color:'#ccc', border:'1px solid #333', padding:'5px 9px', borderRadius:4, cursor:'pointer', fontSize:'0.72rem' },
    btnSend:      { width:'100%', background:'#1565c0', color:'#fff', border:'none', padding:'9px 0', borderRadius:5, cursor:'pointer', fontSize:'0.82rem', fontWeight:700 },
    hexInput:     { width:'100%', background:'#111', border:'1px solid #333', color:'#90caf9', padding:'8px 10px', borderRadius:4, fontSize:'0.88rem', fontFamily:'monospace', letterSpacing:'0.1em', boxSizing:'border-box' },
    vizBox:       { background:'#0d0d1a', border:'1px solid #1a1a3e', borderRadius:8, padding:16 },
    pvHex:        { padding:'7px 9px', borderRadius:4, fontFamily:'monospace', fontSize:'0.85rem', fontWeight:700, color:'#fff', marginBottom:3, minWidth:36, textAlign:'center' },
    pvType:       { fontSize:'0.6rem', color:'#555', textAlign:'center' },
    respSection:  { background:'#0d0d0d', border:'1px solid #1a1a1a', borderRadius:8, padding:16 },
    respBox:      { fontFamily:'monospace', fontSize:'0.9rem', minHeight:36, marginTop:6, letterSpacing:'0.1em' },
    clHeader:     { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 10px 6px', borderBottom:'1px solid #111' },
    clClear:      { background:'#111', border:'none', color:'#555', padding:'2px 6px', borderRadius:3, cursor:'pointer', fontSize:'0.7rem' },
    clEntries:    { flex:1, overflowY:'auto', padding:8, display:'flex', flexDirection:'column', gap:3 },
    clEntry:      { fontSize:'0.68rem', fontFamily:'monospace', lineHeight:1.5, wordBreak:'break-all' },
};