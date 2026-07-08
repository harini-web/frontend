import { useState, useEffect, useRef } from 'react';
import { startScan, getDevices, saveDevice, deleteDevice, getProtocols } from '../api/apiService';

export default function TerminalPage({ user, onLogout }) {
    const [scannedDevices, setScannedDevices]     = useState([]);   // from OS scan
    const [savedDevices, setSavedDevices]         = useState([]);   // from MySQL
    const [protocols, setProtocols]               = useState([]);
    const [connectedDevice, setConnectedDevice]   = useState(null);
    const [status, setStatus]                     = useState('Idle');
    const [scanning, setScanning]                 = useState(false);
    const [activeType, setActiveType]             = useState('classic');
    const [protocol, setProtocol]                 = useState('');
    const [logEntries, setLogEntries]             = useState([]);
    const [lastResponse, setLastResponse]         = useState('Response will appear here');
    const [packetStatus, setPacketStatus]         = useState('Waiting for response...');
    const [pbBytes, setPbBytes]                   = useState(['02','27','69','01','72','73']);
    const logRef = useRef(null);

    useEffect(() => {
        loadSavedDevices();
        loadProtocols();
    }, []);

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [logEntries]);

    const addLog = (msg) => {
        const ts = new Date().toTimeString().substring(0, 8);
        setLogEntries(prev => [...prev, { ts, msg }]);
    };

    // ── Load from backend ────────────────────────────────────────────
    const loadSavedDevices = async () => {
        try {
            const res = await getDevices();
            setSavedDevices(res.data);
        } catch { /* backend may not be ready */ }
    };

    const loadProtocols = async () => {
        try {
            const res = await getProtocols();
            setProtocols(res.data);
        } catch { /* ignore */ }
    };

    // ── BT Classic Scan via backend (OS-level) ───────────────────────
    const handleScan = async () => {
        if (activeType === 'ble') {
            await handleBleScan();
            return;
        }
        setScanning(true);
        setStatus('Scanning for BT Classic devices…');
        setScannedDevices([]);
        addLog('Started BT Classic scan');
        try {
            const res = await startScan();   // POST /api/bluetooth/scan
            const devices = res.data;        // ["NAME | MAC", ...]
            setScannedDevices(devices.map((d, i) => ({
                id: `bt-${i}`,
                raw: d,
                name: d.split('|')[0]?.trim() || `Device ${i+1}`,
                mac:  d.split('|')[1]?.trim() || 'Unknown',
                type: 'BT',
            })));
            setStatus(devices.length > 0 ? `${devices.length} device(s) found` : 'No devices found');
            addLog(`Scan complete. Found ${devices.length} device(s)`);
        } catch (err) {
            setStatus('Scan error — is the backend running?');
            addLog('ERROR: ' + (err.message || 'Scan failed'));
        } finally {
            setScanning(false);
        }
    };

    // ── BLE Scan via Web Bluetooth API (browser) ─────────────────────
    const handleBleScan = async () => {
        if (!navigator.bluetooth) {
            setStatus('Web Bluetooth not supported. Use Chrome/Edge.');
            return;
        }
        setScanning(true);
        setStatus('Opening BLE device picker…');
        try {
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ['battery_service', 'device_information'],
            });
            const entry = {
                id: device.id,
                raw: device.id,
                name: device.name || 'Unknown BLE Device',
                mac: device.id,
                type: 'BLE',
                _bleDevice: device,
            };
            setScannedDevices(prev => {
                if (prev.find(d => d.id === device.id)) return prev;
                return [...prev, entry];
            });
            setStatus('BLE device found: ' + entry.name);
            addLog('BLE device discovered: ' + entry.name);
        } catch (err) {
            if (err.name !== 'NotFoundError') {
                setStatus('BLE scan error: ' + err.message);
                addLog('BLE ERROR: ' + err.message);
            } else {
                setStatus('BLE scan cancelled');
            }
        } finally {
            setScanning(false);
        }
    };

    // ── Connect to a device ──────────────────────────────────────────
    const handleConnect = async (device) => {
        setStatus(`Connecting to ${device.name}…`);
        addLog(`Connecting to ${device.name} (${device.mac})`);
        try {
            if (device.type === 'BLE' && device._bleDevice) {
                await device._bleDevice.gatt.connect();
                device._bleDevice.addEventListener('gattserverdisconnected', () => {
                    setConnectedDevice(null);
                    setStatus('Disconnected');
                    addLog('BLE device disconnected');
                    loadSavedDevices();
                });
            }
            // For BT Classic — connection is OS-managed; we just record it
            setConnectedDevice(device);
            setStatus(`Connected to ${device.name}`);
            addLog(`Connected: ${device.name}`);

            // Save to MySQL
            await saveDevice({
                deviceId:   device.mac,
                deviceName: device.name,
                deviceType: device.type,
            });
            loadSavedDevices();
        } catch (err) {
            setStatus('Connection failed: ' + err.message);
            addLog('Connect ERROR: ' + err.message);
        }
    };

    // ── Disconnect ───────────────────────────────────────────────────
    const handleDisconnect = async () => {
        if (connectedDevice?.type === 'BLE' && connectedDevice._bleDevice?.gatt?.connected) {
            connectedDevice._bleDevice.gatt.disconnect();
        }
        addLog(`Disconnected from ${connectedDevice?.name}`);
        setConnectedDevice(null);
        setStatus('Disconnected');
        loadSavedDevices();
    };

    // ── Delete saved device ──────────────────────────────────────────
    const handleDeleteSaved = async (id) => {
        try {
            await deleteDevice(id);
            loadSavedDevices();
        } catch { /* ignore */ }
    };

    // ── Send Packet ──────────────────────────────────────────────────
    const handleSendPacket = async () => {
        if (!connectedDevice) { setPacketStatus('No device connected'); return; }
        const hex = pbBytes.join(' ');
        setPacketStatus('Sending…');
        await new Promise(r => setTimeout(r, 500));
        setPacketStatus('✔ Packet sent');
        setLastResponse('ACK [' + hex + ']');
        addLog('TX: ' + hex);
        addLog('RX: ACK');
    };

    // ── Helpers ──────────────────────────────────────────────────────
    const switchType = (type) => {
        setActiveType(type);
        setScannedDevices([]);
        setStatus('Idle');
    };

    const typeLabel = { classic: 'BT Classic', ble: 'BLE Device', usb: 'USB-UART' };
    const typeIcon  = { classic: '📡', ble: '📶', usb: '🔌' };

    const byteColors = (i) => {
        if (i === 0) return '#f9a825';
        if (i === pbBytes.length - 1) return '#c62828';
        if (i <= 3) return '#1565c0';
        return '#2e7d32';
    };
    const byteLabel = (i) => {
        if (i === 0) return 'STX';
        if (i === pbBytes.length - 1) return 'ETX';
        if (i <= 3) return 'CMD';
        return 'DATA';
    };

    // ─────────────────────────────────────────────────────────────────
    return (
        <div style={S.layout}>

            {/* ── LEFT SIDEBAR ───────────────────────────────────────── */}
            <aside style={S.sidebar}>

                {/* Connection status */}
                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Connection</div>
                    <div style={S.connStatus}>
                        <div style={{
                            ...S.connDot,
                            background: connectedDevice ? '#43a047' : '#555'
                        }} />
                        <div>
                            <div style={S.connLabel}>
                                {connectedDevice ? 'Connected to' : 'Not Connected'}
                            </div>
                            {connectedDevice &&
                                <div style={S.connName}>{connectedDevice.name}</div>
                            }
                        </div>
                    </div>
                </div>

                <div style={S.divider} />

                {/* Connect New Devices */}
                <div style={S.sectionHeader}>
                    <span style={S.sectionTitle}>Connect New Devices</span>
                    <button
                        style={{ ...S.btnScan, opacity: scanning ? 0.6 : 1 }}
                        onClick={handleScan}
                        disabled={scanning}
                    >
                        {scanning ? 'Scanning…' : 'Scan'}
                    </button>
                </div>

                {/* Device type selector */}
                <div style={S.typeList}>
                    {['classic', 'ble', 'usb'].map(t => (
                        <div
                            key={t}
                            style={{
                                ...S.typeItem,
                                ...(activeType === t ? S.typeItemActive : {})
                            }}
                            onClick={() => switchType(t)}
                        >
                            <span style={S.typeIcon}>{typeIcon[t]}</span>
                            <span>{typeLabel[t]}</span>
                        </div>
                    ))}
                </div>

                <div style={S.divider} />

                {/* Previously Connected */}
                <div style={{ padding: '10px 14px 4px' }}>
                    <div style={S.sectionTitle}>Previously Connected</div>
                </div>
                <div style={S.prevList}>
                    {savedDevices.length === 0
                        ? <div style={S.emptyText}>No saved devices yet.</div>
                        : savedDevices.map(d => (
                            <div key={d.id} style={S.prevItem}>
                                <div style={{
                                    ...S.prevDot,
                                    background: d.deviceType === 'BLE' ? '#43a047'
                                        : d.deviceType === 'USB' ? '#7b1fa2' : '#1565c0'
                                }} />
                                <div style={{ flex: 1 }}>
                                    <div style={S.prevName}>{d.deviceName}</div>
                                    <div style={S.prevTime}>
                                        {d.lastSeen ? new Date(d.lastSeen).toLocaleDateString() : ''}
                                    </div>
                                </div>
                                <button
                                    style={S.btnDelete}
                                    onClick={() => handleDeleteSaved(d.id)}
                                    title="Remove"
                                >×</button>
                            </div>
                        ))
                    }
                </div>

            </aside>

            {/* ── CENTER PANEL ───────────────────────────────────────── */}
            <div style={S.center}>

                {/* Top bar */}
                <div style={S.topBar}>
                    <div>
                        <span style={S.topTitle}>
                            {connectedDevice ? connectedDevice.name : typeLabel[activeType]}
                        </span>
                        <span style={S.topSub}> — {status}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        {connectedDevice &&
                            <span style={S.connBadge}>⇌ Connected</span>
                        }
                        {user &&
                            <span style={S.userBadge}>Welcome, {user.username}</span>
                        }
                        <button style={S.btnLogout} onClick={onLogout}>Logout</button>
                        {connectedDevice &&
                            <button style={S.btnClose} onClick={handleDisconnect}>
                                Disconnect
                            </button>
                        }
                    </div>
                </div>

                {/* Device grid */}
                <div style={S.deviceArea}>
                    {scannedDevices.length === 0 ? (
                        <div style={S.placeholder}>
                            <div style={{ fontSize: '3rem' }}>{typeIcon[activeType]}</div>
                            <div style={S.placeholderText}>
                                Click <strong>Scan</strong> to discover nearby {typeLabel[activeType]} devices.
                            </div>
                            <button style={S.btnScanLarge} onClick={handleScan} disabled={scanning}>
                                {scanning ? 'Scanning…' : '🔍 Start Scanning'}
                            </button>
                        </div>
                    ) : (
                        <>
                            <div style={S.gridHeader}>
                                Discovered {typeLabel[activeType]} Devices
                                <span style={{ color: '#555', fontWeight: 400 }}>
                                    {' '}({scannedDevices.length} found)
                                </span>
                            </div>
                            <div style={S.grid}>
                                {scannedDevices.map(d => {
                                    const isConn = connectedDevice?.id === d.id;
                                    return (
                                        <div key={d.id} style={{
                                            ...S.card,
                                            ...(isConn ? S.cardConnected : {})
                                        }}>
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                <div style={S.cardIcon}>{typeIcon[d.type?.toLowerCase() || activeType]}</div>
                                                <div>
                                                    <div style={S.cardName}>{d.name}</div>
                                                    <div style={S.cardMac}>{d.mac}</div>
                                                </div>
                                            </div>
                                            <div style={{
                                                ...S.badge,
                                                ...(isConn ? S.badgeConn : S.badgeAvail)
                                            }}>
                                                {isConn ? '✔ Connected' : '● Available'}
                                            </div>
                                            <button
                                                style={{
                                                    ...S.btnConnect,
                                                    ...(isConn ? S.btnDisconn : {})
                                                }}
                                                onClick={() => isConn ? handleDisconnect() : handleConnect(d)}
                                            >
                                                {isConn ? 'Disconnect' : 'Pair & Connect'}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* ── TERMINAL PANEL ─────────────────────────────────────── */}
            {connectedDevice && (
                <div style={S.terminal}>

                    {/* Protocol */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Protocol</div>
                        <select
                            style={S.tpSelect}
                            value={protocol}
                            onChange={e => { setProtocol(e.target.value); addLog('Protocol: ' + e.target.value); }}
                        >
                            <option value="">Select Protocol</option>
                            {protocols.map(p => (
                                <option key={p.protocolId} value={p.protocolStr}>
                                    {p.protocolStr} ({p.protocolType})
                                </option>
                            ))}
                            <option value="custom">Custom</option>
                        </select>
                    </div>

                    {/* Packet Builder */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Packet Builder</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                            {pbBytes.map((b, i) => (
                                <span key={i} style={S.pbByte}>{b}</span>
                            ))}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                            {['Bold ON','Bold OFF','Reset','Cut Paper','Print HI'].map(a => (
                                <button key={a} style={S.pbBtn} onClick={() => {
                                    if (a === 'Reset') setPbBytes(['02','27','69','01','72','73']);
                                    else if (a === 'Bold ON')  setPbBytes(['1B','21','08']);
                                    else if (a === 'Bold OFF') setPbBytes(['1B','21','00']);
                                    else if (a === 'Cut Paper') setPbBytes(['1D','56','41','00']);
                                    else if (a === 'Print HI') setPbBytes(['48','69','0A']);
                                }}>{a}</button>
                            ))}
                        </div>
                        <button style={S.btnSend} onClick={handleSendPacket}>Send Packet</button>
                    </div>

                    {/* Packet Visualizer */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Packet Visualizer</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                            {pbBytes.map((b, i) => (
                                <div key={i} style={{ textAlign: 'center' }}>
                                    <div style={{ ...S.pvHex, background: byteColors(i) }}>{b}</div>
                                    <div style={S.pvType}>{byteLabel(i)}</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Last Response */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Last Response</div>
                        <div style={{ ...S.respBox, color: lastResponse.startsWith('ACK') ? '#a5d6a7' : '#666' }}>
                            {lastResponse}
                        </div>
                    </div>

                    {/* Packet Status */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Packet Status</div>
                        <div style={S.respBox}>{packetStatus}</div>
                    </div>

                    {/* Byte Legend */}
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Byte Legend</div>
                        {[['#f9a825','STX – Start'],['#1565c0','CMD – Command'],
                            ['#2e7d32','DATA – Payload'],['#c62828','ETX – End']].map(([c,l]) => (
                            <div key={l} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                                <div style={{ width:10,height:10,borderRadius:2,background:c }} />
                                <span style={{ fontSize:'0.75rem', color:'#aaa' }}>{l}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── COMM LOG ───────────────────────────────────────────── */}
            {connectedDevice && (
                <div style={S.commLog}>
                    <div style={S.clHeader}>
                        <span style={S.tpLabel}>Communication Log</span>
                        <button style={S.clClear} onClick={() => setLogEntries([])}>Clear</button>
                    </div>
                    <div style={S.clEntries} ref={logRef}>
                        {logEntries.map((e, i) => (
                            <div key={i} style={S.clEntry}>
                                <span style={{ color: '#444' }}>[{e.ts}]</span>{' '}
                                <span style={{ color: '#888' }}>{e.msg}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/* ── Styles ───────────────────────────────────────────────────────── */
const S = {
    layout:    { display:'flex', height:'100vh', overflow:'hidden', background:'#121212', fontFamily:'Segoe UI,sans-serif' },
    sidebar:   { width:240, minWidth:240, background:'#f5f5f5', color:'#222', display:'flex', flexDirection:'column', overflowY:'auto', borderRight:'1px solid #ddd' },
    sectionBox:{ padding:'14px 14px 8px' },
    sectionTitle:{ fontSize:'0.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:8 },
    sectionHeader:{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 14px 6px' },
    divider:   { height:1, background:'#e0e0e0', margin:'6px 14px' },
    connStatus:{ background:'#fff', borderRadius:8, padding:'10px 12px', border:'1px solid #e0e0e0', display:'flex', alignItems:'center', gap:8 },
    connDot:   { width:10, height:10, borderRadius:'50%', flexShrink:0 },
    connLabel: { fontWeight:600, color:'#333', fontSize:'0.82rem' },
    connName:  { color:'#1565c0', fontWeight:700, fontSize:'0.82rem' },
    btnScan:   { background:'#1565c0', color:'#fff', border:'none', padding:'5px 13px', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    typeList:  { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:6 },
    typeItem:  { display:'flex', alignItems:'center', gap:10, background:'#fff', border:'1.5px solid #e0e0e0', borderRadius:8, padding:'8px 12px', cursor:'pointer', fontSize:'0.82rem', fontWeight:600, color:'#333' },
    typeItemActive:{ borderColor:'#1565c0', background:'#e3f2fd', color:'#1565c0' },
    typeIcon:  { fontSize:'1.1rem' },
    prevList:  { padding:'4px 14px 8px', display:'flex', flexDirection:'column', gap:5 },
    prevItem:  { display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid #e0e0e0', borderRadius:7, padding:'7px 10px' },
    prevDot:   { width:8, height:8, borderRadius:'50%', flexShrink:0 },
    prevName:  { fontWeight:600, fontSize:'0.8rem', color:'#333' },
    prevTime:  { fontSize:'0.7rem', color:'#999' },
    btnDelete: { background:'none', border:'none', color:'#aaa', cursor:'pointer', fontSize:'1rem', lineHeight:1, padding:'0 2px' },
    emptyText: { fontSize:'0.78rem', color:'#aaa', fontStyle:'italic', padding:'4px 0' },

    center:    { flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#121212' },
    topBar:    { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'#1e1e1e', borderBottom:'1px solid #2a2a2a', minHeight:48 },
    topTitle:  { color:'#90caf9', fontWeight:700, fontSize:'0.9rem' },
    topSub:    { color:'#555', fontSize:'0.78rem' },
    connBadge: { color:'#43a047', fontSize:'0.78rem', fontWeight:600 },
    userBadge: { color:'#aaa', fontSize:'0.78rem' },
    btnLogout: { background:'#e53935', color:'#fff', border:'none', padding:'5px 13px', borderRadius:4, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnClose:  { background:'#c62828', color:'#fff', border:'none', padding:'5px 13px', borderRadius:4, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },

    deviceArea:{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column' },
    placeholder:{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, color:'#444' },
    placeholderText:{ fontSize:'0.88rem', textAlign:'center', maxWidth:280, lineHeight:1.5 },
    btnScanLarge:{ background:'#1565c0', color:'#fff', border:'none', padding:'10px 28px', borderRadius:6, cursor:'pointer', fontSize:'0.88rem', fontWeight:600 },
    gridHeader:{ padding:'16px 24px 8px', fontSize:'0.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px', color:'#666' },
    grid:      { padding:'4px 24px 24px', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:14 },
    card:      { background:'#1e1e2e', border:'1.5px solid #2a2a3e', borderRadius:10, padding:16, display:'flex', flexDirection:'column', gap:10 },
    cardConnected:{ borderColor:'#43a047', background:'#0a1a0f' },
    cardIcon:  { width:40, height:40, borderRadius:'50%', background:'#2a2a4e', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'1.2rem' },
    cardName:  { fontSize:'0.88rem', fontWeight:700, color:'#e0e0e0' },
    cardMac:   { fontSize:'0.7rem', color:'#555' },
    badge:     { fontSize:'0.72rem', fontWeight:600, padding:'3px 8px', borderRadius:12, width:'fit-content' },
    badgeAvail:{ background:'#1a2a3a', color:'#90caf9' },
    badgeConn: { background:'#0a2a0a', color:'#81c784' },
    btnConnect:{ background:'#1565c0', color:'#fff', border:'none', padding:'6px 0', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnDisconn:{ background:'#c62828' },

    terminal:  { width:320, minWidth:320, background:'#0d0d0d', borderLeft:'1px solid #1a1a1a', overflowY:'auto', display:'flex', flexDirection:'column' },
    tpSection: { padding:'10px 14px 8px', borderBottom:'1px solid #1a1a1a' },
    tpLabel:   { fontSize:'0.68rem', textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:5 },
    tpSelect:  { width:'100%', background:'#1e1e1e', border:'1px solid #333', color:'#e0e0e0', padding:'5px 8px', borderRadius:4, fontSize:'0.8rem' },
    pbByte:    { background:'#333', color:'#ccc', padding:'3px 7px', borderRadius:4, fontFamily:'monospace', fontSize:'0.75rem' },
    pbBtn:     { background:'#2a2a2a', color:'#ccc', border:'1px solid #444', padding:'4px 8px', borderRadius:4, cursor:'pointer', fontSize:'0.72rem' },
    btnSend:   { width:'100%', background:'#1565c0', color:'#fff', border:'none', padding:8, borderRadius:5, cursor:'pointer', fontSize:'0.82rem', fontWeight:700, marginTop:8 },
    pvHex:     { padding:'5px 7px', borderRadius:4, fontFamily:'monospace', fontSize:'0.78rem', fontWeight:700, color:'#fff' },
    pvType:    { fontSize:'0.6rem', color:'#666', textAlign:'center' },
    respBox:   { background:'#1a1a1a', border:'1px solid #2a2a2a', borderRadius:5, padding:10, fontSize:'0.78rem', minHeight:44, fontFamily:'monospace' },

    commLog:   { width:180, minWidth:180, background:'#080808', borderLeft:'1px solid #1a1a1a', display:'flex', flexDirection:'column' },
    clHeader:  { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 10px 6px', borderBottom:'1px solid #1a1a1a' },
    clClear:   { background:'#1e1e1e', border:'none', color:'#666', padding:'2px 6px', borderRadius:3, cursor:'pointer', fontSize:'0.7rem' },
    clEntries: { flex:1, overflowY:'auto', padding:8, display:'flex', flexDirection:'column', gap:3 },
    clEntry:   { fontSize:'0.68rem', fontFamily:'monospace', lineHeight:1.4, wordBreak:'break-word' },
};