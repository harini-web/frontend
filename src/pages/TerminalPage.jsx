import { useState, useEffect, useRef, useCallback } from 'react';
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
    // Print "Hello World" and cut
    printHello:  () => [
        ...ESCPOS.init(),
        ...ESCPOS.text('Hello World\n'),
        ...ESCPOS.lineFeed(),
        ...ESCPOS.cutPaper(),
    ],
    // Custom hex string like "8AC604" or "8A C6 04" → byte array
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
            <span style={{ marginRight: 5 }}>📡</span>
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
function TerminalPanel({ tab, onLog, onUpdateConnected }) {
    const [pbBytes, setPbBytes]           = useState([0x02, 0x27, 0x69, 0x01, 0x72, 0x73]);
    const [customHex, setCustomHex]       = useState('');
    const [packetStatus, setPacketStatus] = useState('Waiting for response...');
    const [lastResponse, setLastResponse] = useState('');
    const [protocols, setProtocols]       = useState([]);
    const [protocol, setProtocol]         = useState('');
    const [reading, setReading]           = useState(false);
    const readerRef   = useRef(null);
    const logRef      = useRef(null);

    useEffect(() => {
        getProtocols().then(r => setProtocols(r.data)).catch((err) => {
            console.warn("[DEBUG] Failed to load protocols:", err.message);
        });
    }, []);

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [tab.log]);

    // ── Start continuous read loop ────────────────────────────────────
    useEffect(() => {
        if (!tab.port || !tab.connected || reading) return;

        let active = true;
        setReading(true);
        console.log(`[DEBUG] Initializing readLoop for tab: ${tab.id}`);

        const readLoop = async () => {
            try {
                while (active && tab.port.readable) {
                    console.log(`[DEBUG] Port is readable. Acquiring reader lock...`);
                    readerRef.current = tab.port.readable.getReader();
                    try {
                        while (active) {
                            const { value, done } = await readerRef.current.read();
                            if (done) {
                                console.log("[DEBUG] Reader reported done (Port closed/disconnected). Exiting loop.");
                                active = false; // ✨ CRITICAL FIX: Ensure outer loop breaks too so CPU doesn't freeze
                                break;
                            }
                            if (value && value.length > 0) {
                                console.log(`[DEBUG] RX Raw Uint8Array:`, value);
                                const hex = Array.from(value)
                                    .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
                                    .join(' ');

                                setLastResponse(hex);
                                setPacketStatus('Response received');
                                onLog(tab.id, 'RX: ' + hex);
                            }
                        }
                    } finally {
                        console.log("[DEBUG] Releasing reader lock...");
                        try { readerRef.current?.releaseLock(); } catch {}
                        readerRef.current = null;
                    }
                }
            } catch (e) {
                console.error('[DEBUG] FATAL READ ERROR:', e);
                if (active) onLog(tab.id, 'Read ended: ' + e.message);
            }
            setReading(false);
            console.log("[DEBUG] Exited readLoop completely.");
        };

        readLoop();

        return () => {
            console.log(`[DEBUG] Cleaning up readLoop for tab: ${tab.id}`);
            active = false;
            try { readerRef.current?.cancel(); readerRef.current?.releaseLock(); } catch {}
        };
    }, [tab.id, tab.port, tab.connected]);

    // ── Write bytes to serial port ────────────────────────────────────
    const sendBytes = async (bytes) => {
        console.log(`[DEBUG] Preparing to send bytes:`, bytes);
        if (!tab.port || !tab.connected) {
            console.warn("[DEBUG] Aborted send: No device connected");
            setPacketStatus('❌ No device connected');
            return;
        }

        // ✨ CRITICAL FIX: Removed the `readerRef.current?.cancel()` call.
        // Web Serial is full-duplex. Canceling the reader to write breaks the input stream and triggers the freeze!

        const hexStr = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        setPacketStatus('Sending…');
        onLog(tab.id, 'TX: ' + hexStr);

        try {
            console.log("[DEBUG] Acquiring writer lock...");
            const writer = tab.port.writable.getWriter();
            const dataArray = new Uint8Array(bytes);
            console.log("[DEBUG] Sending Uint8Array:", dataArray);

            await writer.write(dataArray);

            console.log("[DEBUG] Write complete. Releasing lock.");
            writer.releaseLock();
            setPacketStatus('✔ Packet sent — waiting for response');
            onLog(tab.id, 'TX sent OK');
        } catch (err) {
            console.error("[DEBUG] Send failed violently:", err);
            setPacketStatus('❌ Send failed: ' + err.message);
            onLog(tab.id, 'TX ERROR: ' + err.message);
        }
    };

    const handleSendCustomHex = () => {
        if (!customHex.trim()) return;
        const bytes = ESCPOS.fromHex(customHex);
        if (bytes.length === 0) {
            setPacketStatus('❌ Invalid hex input');
            return;
        }
        sendBytes(bytes);
    };

    const handlePreset = (label) => {
        switch (label) {
            case 'Init Printer': {
                const b = ESCPOS.init(); setPbBytes(b); sendBytes(b); break;
            }
            case 'Bold ON':  { const b = ESCPOS.boldOn();   setPbBytes(b); sendBytes(b); break; }
            case 'Bold OFF': { const b = ESCPOS.boldOff();  setPbBytes(b); sendBytes(b); break; }
            case 'Cut Paper':{ const b = ESCPOS.cutPaper(); setPbBytes(b); sendBytes(b); break; }
            case 'Print HI': {
                const b = [
                    ...ESCPOS.init(),
                    ...ESCPOS.text('HI\n'),
                    ...ESCPOS.lineFeed(),
                    ...ESCPOS.cutPaper(),
                ];
                setPbBytes(b); sendBytes(b); break;
            }
            case 'Reset':
                setPbBytes([0x02, 0x27, 0x69, 0x01, 0x72, 0x73]); break;
            default: break;
        }
    };

    const byteToHex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

    const byteColor = (i, total) => {
        if (i === 0)       return '#f9a825'; // STX
        if (i === total-1) return '#c62828'; // ETX
        if (i <= 3)        return '#1565c0'; // CMD
        return '#2e7d32';                    // DATA
    };
    const byteLabel = (i, total) => {
        if (i === 0)       return 'STX';
        if (i === total-1) return 'ETX';
        if (i <= 3)        return 'CMD';
        return 'DATA';
    };

    return (
        <div style={S.terminalLayout}>

            {/* LEFT — builder */}
            <div style={S.termLeft}>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Protocol</div>
                    <select style={S.tpSelect} value={protocol}
                            onChange={e => setProtocol(e.target.value)}>
                        <option value="">Select Protocol</option>
                        {protocols.map(p => (
                            <option key={p.protocolId} value={p.protocolStr}>
                                {p.protocolStr} ({p.protocolType})
                            </option>
                        ))}
                        <option value="custom">Custom</option>
                    </select>
                </div>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Packet Builder</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:10 }}>
                        {pbBytes.map((b, i) => (
                            <span key={i} style={S.pbByte}>{byteToHex(b)}</span>
                        ))}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:10 }}>
                        {['Init Printer','Bold ON','Bold OFF','Cut Paper','Print HI','Reset'].map(a => (
                            <button key={a} style={S.pbBtn} onClick={() => handlePreset(a)}>{a}</button>
                        ))}
                    </div>
                    <button style={S.btnSend} onClick={() => sendBytes(pbBytes)}>
                        ▶ Send Packet
                    </button>
                </div>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Send Custom Hex</div>
                    <div style={{ fontSize:'0.7rem', color:'#555', marginBottom:5 }}>
                        Enter hex bytes e.g: <span style={{color:'#90caf9'}}>8A C6 04</span>
                    </div>
                    <input
                        style={S.hexInput}
                        placeholder="8A C6 04"
                        value={customHex}
                        onChange={e => setCustomHex(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && handleSendCustomHex()}
                    />
                    <button style={{ ...S.btnSend, marginTop:6 }} onClick={handleSendCustomHex}>
                        ▶ Send Hex
                    </button>
                </div>

                <div style={S.tpSection}>
                    <div style={S.tpLabel}>Byte Legend</div>
                    {[['#f9a825','STX – Start'],['#1565c0','CMD – Command'],
                        ['#2e7d32','DATA – Payload'],['#c62828','ETX – End']].map(([c,l]) => (
                        <div key={l} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
                            <div style={{ width:10, height:10, borderRadius:2, background:c, flexShrink:0 }} />
                            <span style={{ fontSize:'0.75rem', color:'#aaa' }}>{l}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* CENTER — visualizer + response */}
            <div style={S.termCenter}>

                <div style={S.vizBox}>
                    <div style={S.tpLabel}>Packet Visualizer</div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginTop:10 }}>
                        {pbBytes.map((b, i) => (
                            <div key={i} style={{ textAlign:'center' }}>
                                <div style={{
                                    ...S.pvHex,
                                    background: byteColor(i, pbBytes.length)
                                }}>{byteToHex(b)}</div>
                                <div style={S.pvType}>{byteLabel(i, pbBytes.length)}</div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={S.respSection}>
                    <div style={S.tpLabel}>Last Response</div>
                    <div style={{
                        ...S.respBox,
                        color: lastResponse ? '#a5d6a7' : '#555',
                        fontSize: '1rem',
                        letterSpacing: '0.1em',
                    }}>
                        {lastResponse || 'Response will appear here'}
                    </div>
                </div>

                <div style={S.respSection}>
                    <div style={S.tpLabel}>Packet Status</div>
                    <div style={{
                        ...S.respBox,
                        color: packetStatus.startsWith('✔') ? '#a5d6a7'
                            : packetStatus.startsWith('❌') ? '#ef9a9a'
                                : '#aaa'
                    }}>
                        {packetStatus}
                    </div>
                </div>
            </div>

            {/* RIGHT — comm log */}
            <div style={S.termRight}>
                <div style={S.clHeader}>
                    <span style={{ ...S.tpLabel, marginBottom:0 }}>Communication Log</span>
                    <button style={S.clClear} onClick={() => {
                        onLog(tab.id, '--- LOG CLEARED ---');
                    }}>Clear</button>
                </div>
                <div style={S.clEntries} ref={logRef}>
                    {tab.log.map((e, i) => (
                        <div key={i} style={S.clEntry}>
                            <span style={{ color:'#444' }}>[{e.ts}]</span>{' '}
                            <span style={{
                                color: e.msg.startsWith('RX') ? '#81c784'
                                    : e.msg.startsWith('TX') ? '#90caf9'
                                        : '#666'
                            }}>{e.msg}</span>
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
    const [activeType, setActiveType]         = useState('classic');
    const [baudRate, setBaudRate]             = useState(115200);
    const [tabs, setTabs]                     = useState([]);
    const [activeTabId, setActiveTabId]       = useState(null);

    useEffect(() => { loadSavedDevices(); }, []);

    const loadSavedDevices = async () => {
        try {
            const r = await getDevices();
            setSavedDevices(r.data);
        } catch (e) {
            console.warn("[DEBUG] Failed to load saved devices", e);
        }
    };

    // ✨ CRITICAL PERFORMANCE FIX: Capping log array at 50 to prevent freezing
    const addLog = useCallback((tabId, msg) => {
        console.log(`[UI LOG | Tab ${tabId}] ${msg}`); // Always log to Developer Console securely
        const ts = new Date().toTimeString().substring(0, 8);
        setTabs(prev => prev.map(t => {
            if (t.id === tabId) {
                const newLogs = [...t.log, { ts, msg }];
                // Capping the array at the 50 most recent logs to stop React from crashing
                return { ...t, log: newLogs.slice(-50) };
            }
            return t;
        }));
    }, []);

    // ── Scan ──────────────────────────────────────────────────────────
    const handleScan = async () => {
        console.log(`[DEBUG] handleScan initiated for activeType: ${activeType}`);
        setScanning(true);
        setScannedDevices([]);
        setStatus('Scanning for BT devices…');
        try {
            const res = await startScan(); // [{name, deviceId, status}]
            console.log("[DEBUG] API startScan response:", res.data);
            const list = (res.data || []).map((d, i) => ({
                id:       `bt-${i}-${(d.deviceId || '').replace(/[^a-z0-9]/gi,'')}`,
                name:     d.name,
                deviceId: d.deviceId,
                status:   d.status,
            }));
            setScannedDevices(list);
            setStatus(list.length > 0 ? `${list.length} device(s) found` : 'No devices found');
        } catch (err) {
            console.error("[DEBUG] handleScan failed:", err);
            setStatus('Scan error — is backend running on port 8080?');
        } finally {
            setScanning(false);
        }
    };

    // ── Connect → new tab ─────────────────────────────────────────────
    const handleConnect = async (device) => {
        console.log(`[DEBUG] handleConnect clicked for device:`, device);
        setStatus(`Connecting to ${device.name}…`);
        try {
            console.log("[DEBUG] Awaiting Web Serial requestPort...");
            const port = await navigator.serial.requestPort();
            console.log(`[DEBUG] Port selected. Opening at baudRate: ${baudRate}...`);
            await port.open({ baudRate: Number(baudRate) });
            console.log("[DEBUG] Hardware Port OPENED successfully");

            const tabId = `tab-${Date.now()}`;
            const newTab = {
                id: tabId,
                device,
                port,
                connected: true,
                log: [{
                    ts: new Date().toTimeString().substring(0, 8),
                    msg: `Connected to ${device.name} at ${baudRate} baud`
                }],
            };

            setTabs(prev => [...prev, newTab]);
            setActiveTabId(tabId);
            setStatus(`Connected to ${device.name}`);

            // Save to MySQL
            try {
                console.log("[DEBUG] Saving connected device to database...");
                await saveDevice({
                    deviceId:   device.deviceId || device.name,
                    deviceName: device.name,
                    deviceType: 'BT',
                });
                loadSavedDevices();
            } catch (err) {
                console.warn("[DEBUG] Failed to save device to DB:", err);
            }

        } catch (err) {
            console.error("[DEBUG] Port connection failed:", err);
            if (err.name !== 'NotFoundError') {
                setStatus('Connect failed: ' + err.message);
            } else {
                setStatus('Cancelled');
            }
        }
    };

    // ── Close tab ─────────────────────────────────────────────────────
    const handleCloseTab = async (tabId) => {
        console.log(`[DEBUG] handleCloseTab for tab ID: ${tabId}`);
        const tab = tabs.find(t => t.id === tabId);
        if (tab?.port) {
            console.log("[DEBUG] Closing native serial port...");
            try { await tab.port.close(); } catch (e) { console.error("[DEBUG] Port close error:", e) }
        }
        const rest = tabs.filter(t => t.id !== tabId);
        setTabs(rest);
        setActiveTabId(rest.length > 0 ? rest[rest.length - 1].id : null);
        setStatus('Disconnected');
    };

    const typeLabel = { classic:'BT Classic', ble:'BLE Device', usb:'USB-UART' };
    const typeIcon  = { classic:'📡', ble:'📶', usb:'🔌' };
    const activeTab = tabs.find(t => t.id === activeTabId);

    return (
        <div style={S.layout}>

            {/* ── SIDEBAR ─────────────────────────────────────────── */}
            <aside style={S.sidebar}>

                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Connection</div>
                    <div style={S.connStatus}>
                        <div style={{
                            ...S.connDot,
                            background: activeTab?.connected ? '#43a047' : '#555'
                        }} />
                        <div>
                            <div style={S.connLabel}>
                                {activeTab?.connected ? 'Connected to' : 'Not Connected'}
                            </div>
                            {activeTab?.connected &&
                                <div style={S.connName}>{activeTab.device.name}</div>
                            }
                        </div>
                    </div>
                </div>

                <div style={S.divider} />

                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Device Speed (Baud Rate)</div>
                    <select style={S.tpSelect} value={baudRate}
                            onChange={e => setBaudRate(e.target.value)}>
                        <option value="9600">9600 (Standard)</option>
                        <option value="38400">38400</option>
                        <option value="115200">115200 (Thermal Printers)</option>
                    </select>
                </div>

                <div style={S.divider} />

                <div style={S.sectionHeader}>
                    <span style={S.sectionTitle}>Connect New Devices</span>
                    <button
                        style={{ ...S.btnScan, opacity: scanning ? 0.6 : 1 }}
                        onClick={handleScan} disabled={scanning}>
                        {scanning ? 'Scanning…' : 'Scan'}
                    </button>
                </div>

                <div style={S.typeList}>
                    {['classic','ble','usb'].map(t => (
                        <div key={t}
                             style={{ ...S.typeItem, ...(activeType === t ? S.typeItemActive : {}) }}
                             onClick={() => {
                                 setActiveType(t);
                                 setScannedDevices([]);
                                 setStatus('Idle');
                             }}>
                            <span style={S.typeIcon}>{typeIcon[t]}</span>
                            <span>{typeLabel[t]}</span>
                        </div>
                    ))}
                </div>

                <div style={S.divider} />

                <div style={{ padding:'10px 14px 4px' }}>
                    <div style={S.sectionTitle}>Previously Connected</div>
                </div>
                <div style={S.prevList}>
                    {savedDevices.length === 0
                        ? <div style={S.emptyText}>No saved devices.</div>
                        : savedDevices.map(d => (
                            <div key={d.id} style={S.prevItem}>
                                <div style={{ ...S.prevDot, background:'#1565c0' }} />
                                <div style={{ flex:1 }}>
                                    <div style={S.prevName}>{d.deviceName}</div>
                                </div>
                                <button style={S.btnDelete} onClick={async () => {
                                    try { await deleteDevice(d.id); loadSavedDevices(); } catch {}
                                }}>×</button>
                            </div>
                        ))
                    }
                </div>
            </aside>

            {/* ── MAIN ─────────────────────────────────────────────── */}
            <div style={S.main}>

                {/* Top bar */}
                <div style={S.topBar}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <span style={S.topTitle}>
                            {activeTab ? activeTab.device.name : typeLabel[activeType]}
                        </span>
                        <span style={S.topSub}>— {status}</span>
                    </div>
                    <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                        {activeTab?.connected &&
                            <span style={S.connBadge}>⇌ Connected</span>}
                        {user &&
                            <span style={S.userBadge}>Welcome, {user.username}</span>}
                        <button style={S.btnLogout} onClick={onLogout}>Logout</button>
                        {activeTab &&
                            <button style={S.btnClose}
                                    onClick={() => handleCloseTab(activeTabId)}>
                                Close Terminal
                            </button>}
                    </div>
                </div>

                {/* Tab Bar — below topbar like Chrome */}
                {tabs.length > 0 && (
                    <div style={S.tabBar}>
                        {tabs.map(t => (
                            <DeviceTab key={t.id} tab={t}
                                       active={t.id === activeTabId}
                                       onClick={() => setActiveTabId(t.id)}
                                       onClose={handleCloseTab}
                            />
                        ))}
                    </div>
                )}

                {/* Content */}
                {activeTab ? (
                    <TerminalPanel
                        key={activeTab.id}
                        tab={activeTab}
                        onLog={addLog}
                        onUpdateConnected={(tabId, val) =>
                            setTabs(prev => prev.map(t =>
                                t.id === tabId ? { ...t, connected: val } : t
                            ))
                        }
                    />
                ) : (
                    <div style={S.deviceArea}>
                        {scannedDevices.length === 0 ? (
                            <div style={S.placeholder}>
                                <div style={{ fontSize:'3rem' }}>{typeIcon[activeType]}</div>
                                <div style={S.placeholderText}>
                                    Click <strong>Scan</strong> to discover paired BT devices on this laptop.
                                </div>
                                <button style={S.btnScanLarge}
                                        onClick={handleScan} disabled={scanning}>
                                    {scanning ? 'Scanning…' : '🔍 Start Scanning'}
                                </button>
                            </div>
                        ) : (
                            <>
                                <div style={S.gridHeader}>
                                    Discovered Devices
                                    <span style={{ color:'#555', fontWeight:400 }}>
                                        {' '}({scannedDevices.length} found)
                                    </span>
                                </div>
                                <div style={S.grid}>
                                    {scannedDevices.map(d => {
                                        const openTab = tabs.find(t =>
                                            t.device.deviceId === d.deviceId);
                                        return (
                                            <div key={d.id} style={S.card}>
                                                <div style={{ display:'flex', gap:10, alignItems:'center' }}>
                                                    <div style={S.cardIcon}>📡</div>
                                                    <div>
                                                        <div style={S.cardName}>{d.name}</div>
                                                        <div style={{
                                                            fontSize:'0.7rem',
                                                            color: d.status === 'OK' ? '#43a047' : '#888',
                                                            marginTop:2
                                                        }}>
                                                            {d.status === 'OK' ? '● Ready' : '○ ' + (d.status || 'Unknown')}
                                                        </div>
                                                    </div>
                                                </div>
                                                <button
                                                    style={{
                                                        ...S.btnConnect,
                                                        ...(openTab ? S.btnDisconn : {})
                                                    }}
                                                    onClick={() => openTab
                                                        ? setActiveTabId(openTab.id)
                                                        : handleConnect(d)
                                                    }
                                                >
                                                    {openTab ? '→ Open Tab' : 'Pair & Connect'}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/* ── Styles ─────────────────────────────────────────────────────────── */
const S = {
    layout:       { display:'flex', height:'100vh', overflow:'hidden', background:'#121212', fontFamily:'Segoe UI,sans-serif' },
    sidebar:      { width:240, minWidth:240, background:'#f5f5f5', display:'flex', flexDirection:'column', overflowY:'auto', borderRight:'1px solid #ddd' },
    sectionBox:   { padding:'14px 14px 8px' },
    sectionTitle: { fontSize:'0.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:8 },
    sectionHeader:{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px 6px' },
    divider:      { height:1, background:'#e0e0e0', margin:'6px 14px' },
    connStatus:   { background:'#fff', borderRadius:8, padding:'10px 12px', border:'1px solid #e0e0e0', display:'flex', alignItems:'center', gap:8 },
    connDot:      { width:10, height:10, borderRadius:'50%', flexShrink:0 },
    connLabel:    { fontWeight:600, color:'#333', fontSize:'0.82rem' },
    connName:     { color:'#1565c0', fontWeight:700, fontSize:'0.82rem' },
    btnScan:      { background:'#1565c0', color:'#fff', border:'none', padding:'5px 13px', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    typeList:     { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:6 },
    typeItem:     { display:'flex', alignItems:'center', gap:10, background:'#fff', border:'1.5px solid #e0e0e0', borderRadius:8, padding:'8px 12px', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, color:'#333' },
    typeItemActive:{ borderColor:'#1565c0', background:'#e3f2fd', color:'#1565c0' },
    typeIcon:     { fontSize:'1.1rem' },
    prevList:     { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:5 },
    prevItem:     { display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid #e0e0e0', borderRadius:7, padding:'7px 10px' },
    prevDot:      { width:8, height:8, borderRadius:'50%', flexShrink:0 },
    prevName:     { fontWeight:600, fontSize:'0.8rem', color:'#333' },
    btnDelete:    { background:'none', border:'none', color:'#aaa', cursor:'pointer', fontSize:'1rem', lineHeight:1, padding:'0 2px' },
    emptyText:    { fontSize:'0.78rem', color:'#aaa', fontStyle:'italic', padding:'4px 0' },
    tpSelect:     { width:'100%', background:'#f8f8f8', border:'1px solid #ddd', color:'#333', padding:'5px 8px', borderRadius:4, fontSize:'0.8rem' },

    main:         { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
    topBar:       { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'#1e1e1e', borderBottom:'1px solid #2a2a2a', minHeight:48, flexShrink:0 },
    topTitle:     { color:'#90caf9', fontWeight:700, fontSize:'0.9rem' },
    topSub:       { color:'#555', fontSize:'0.78rem' },
    connBadge:    { color:'#43a047', fontSize:'0.78rem', fontWeight:600 },
    userBadge:    { color:'#aaa', fontSize:'0.78rem' },
    btnLogout:    { background:'#e53935', color:'#fff', border:'none', padding:'5px 13px', borderRadius:4, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnClose:     { background:'#c62828', color:'#fff', border:'none', padding:'5px 13px', borderRadius:4, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },

    tabBar:       { display:'flex', alignItems:'center', background:'#161616', borderBottom:'2px solid #1565c0', padding:'4px 8px 0', minHeight:40, overflowX:'auto', flexShrink:0 },
    tab:          { display:'flex', alignItems:'center', padding:'0 12px', height:32, borderRadius:'6px 6px 0 0', cursor:'pointer', fontSize:'0.8rem', fontWeight:600, minWidth:130, maxWidth:220, border:'1px solid transparent', borderBottom:'none', marginRight:3, userSelect:'none', gap:4 },
    tabActive:    { background:'#121212', color:'#90caf9', borderColor:'#333' },
    tabInactive:  { background:'#1e1e1e', color:'#666', borderColor:'transparent' },
    tabName:      { flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
    tabClose:     { background:'none', border:'none', color:'#555', cursor:'pointer', fontSize:'1rem', padding:'0', lineHeight:1, marginLeft:4 },

    deviceArea:   { flex:1, overflowY:'auto', display:'flex', flexDirection:'column' },
    placeholder:  { flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, color:'#444' },
    placeholderText:{ fontSize:'0.88rem', textAlign:'center', maxWidth:300, lineHeight:1.6 },
    btnScanLarge: { background:'#1565c0', color:'#fff', border:'none', padding:'10px 28px', borderRadius:6, cursor:'pointer', fontSize:'0.88rem', fontWeight:600 },
    gridHeader:   { padding:'16px 24px 8px', fontSize:'0.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#666' },
    grid:         { padding:'4px 24px 24px', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:14 },
    card:         { background:'#1e1e2e', border:'1.5px solid #2a2a3e', borderRadius:10, padding:16, display:'flex', flexDirection:'column', gap:10 },
    cardIcon:     { width:40, height:40, borderRadius:'50%', background:'#2a2a4e', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.2rem' },
    cardName:     { fontSize:'0.88rem', fontWeight:700, color:'#e0e0e0' },
    btnConnect:   { background:'#1565c0', color:'#fff', border:'none', padding:'7px 0', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnDisconn:   { background:'#2e7d32' },

    terminalLayout:{ flex:1, display:'flex', overflow:'hidden' },
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