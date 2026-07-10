import { useState, useEffect, useRef } from 'react';
import { startScan, getDevices, saveDevice, deleteDevice, getProtocols } from '../api/apiService';

export default function TerminalPage({ user, onLogout }) {
    const [scannedDevices, setScannedDevices]     = useState([]);
    const [savedDevices, setSavedDevices]         = useState([]);
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

    // NEW: Allow selecting different speeds for different devices
    const [baudRate, setBaudRate]                 = useState(115200);
    const logRef = useRef(null);
    const [serialPort, setSerialPort] = useState(null);

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

    const loadSavedDevices = async () => {
        try {
            const res = await getDevices();
            setSavedDevices(res.data);
        } catch { }
    };

    const loadProtocols = async () => {
        try {
            const res = await getProtocols();
            setProtocols(res.data);
        } catch { }
    };

    // ── BT Classic Scan ────────────────────────────────────────────────
    const handleScan = async () => {
        setScanning(true);
        setStatus('Scanning for BT Classic devices…');
        setScannedDevices([]);
        addLog('Started BT Classic scan');
        try {
            const res = await startScan();
            const devices = res.data;
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
            setStatus('Scan error');
        } finally {
            setScanning(false);
        }
    };

    // ── UNIVERSAL CONNECT (Works for ANY BT Classic SPP device) ────────
    const handleConnect = async (device) => {
        setStatus(`Connecting to ${device.name}…`);
        addLog(`Connecting to ${device.name} (${device.mac})`);

        try {
            setStatus('Please grant permission in the browser popup...');

            // 1. Browser Security Popup (Mandatory for Chrome)
            const port = await navigator.serial.requestPort();

            // 2. Open port at the user-selected speed (Allows ANY device to connect)
            await port.open({ baudRate: Number(baudRate) });
            setSerialPort(port);

            // 3. Update UI
            setConnectedDevice(device);
            setStatus(`Connected to ${device.name}`);
            addLog(`Hardware connection established at ${baudRate} baud`);

            // Save to Database
            await saveDevice({
                deviceId:   device.mac || 'COM-PORT',
                deviceName: device.name,
                deviceType: 'BT',
            });
            loadSavedDevices();

        } catch (err) {
            setStatus('Connection failed: ' + err.message);
            addLog('Connect ERROR: ' + err.message);
        }
    };

    // ── Disconnect ───────────────────────────────────────────────────
    const handleDisconnect = async () => {
        if (serialPort) {
            try { await serialPort.close(); } catch(e) {}
            setSerialPort(null);
        }
        addLog(`Disconnected from ${connectedDevice?.name}`);
        setConnectedDevice(null);
        setStatus('Disconnected');
        loadSavedDevices();
    };

    const handleDeleteSaved = async (id) => {
        try {
            await deleteDevice(id);
            loadSavedDevices();
        } catch { }
    };

    // ── Send REAL Packet to Hardware ──────────────────────────────────
    const handleSendPacket = async () => {
        if (!connectedDevice || !serialPort) { setPacketStatus('No device connected'); return; }

        const hexString = pbBytes.join(' ');
        setPacketStatus('Sending…');
        addLog('TX: ' + hexString);

        try {
            const dataArray = new Uint8Array(pbBytes.map(hex => parseInt(hex, 16)));
            const writer = serialPort.writable.getWriter();
            await writer.write(dataArray);
            writer.releaseLock();

            setPacketStatus('✔ Packet sent to hardware');
            setLastResponse('Data sent successfully');
        } catch (err) {
            setPacketStatus('Error sending data');
            addLog('TX ERROR: ' + err.message);
        }
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
                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Connection</div>
                    <div style={S.connStatus}>
                        <div style={{ ...S.connDot, background: connectedDevice ? '#43a047' : '#555' }} />
                        <div>
                            <div style={S.connLabel}>{connectedDevice ? 'Connected to' : 'Not Connected'}</div>
                            {connectedDevice && <div style={S.connName}>{connectedDevice.name}</div>}
                        </div>
                    </div>
                </div>

                <div style={S.divider} />

                {/* NEW: Baud Rate Selector to support ANY device */}
                <div style={S.sectionBox}>
                    <div style={S.sectionTitle}>Device Speed (Baud Rate)</div>
                    <select
                        style={S.tpSelect}
                        value={baudRate}
                        onChange={(e) => setBaudRate(e.target.value)}
                        disabled={connectedDevice != null}
                    >
                        <option value="9600">9600 (Standard Modules)</option>
                        <option value="38400">38400</option>
                        <option value="115200">115200 (Thermal Printers)</option>
                    </select>
                </div>

                <div style={S.divider} />

                <div style={S.sectionHeader}>
                    <span style={S.sectionTitle}>Connect New Devices</span>
                    <button style={{ ...S.btnScan, opacity: scanning ? 0.6 : 1 }} onClick={handleScan} disabled={scanning}>
                        {scanning ? 'Scanning…' : 'Scan'}
                    </button>
                </div>
                <div style={S.typeList}>
                    {['classic', 'ble', 'usb'].map(t => (
                        <div key={t} style={{ ...S.typeItem, ...(activeType === t ? S.typeItemActive : {}) }} onClick={() => switchType(t)}>
                            <span style={S.typeIcon}>{typeIcon[t]}</span>
                            <span>{typeLabel[t]}</span>
                        </div>
                    ))}
                </div>
                <div style={S.divider} />
                <div style={{ padding: '10px 14px 4px' }}><div style={S.sectionTitle}>Previously Connected</div></div>
                <div style={S.prevList}>
                    {savedDevices.map(d => (
                        <div key={d.id} style={S.prevItem}>
                            <div style={{ ...S.prevDot, background: '#1565c0' }} />
                            <div style={{ flex: 1 }}>
                                <div style={S.prevName}>{d.deviceName}</div>
                            </div>
                            <button style={S.btnDelete} onClick={() => handleDeleteSaved(d.id)}>×</button>
                        </div>
                    ))}
                </div>
            </aside>

            {/* ── CENTER PANEL ───────────────────────────────────────── */}
            <div style={S.center}>
                <div style={S.topBar}>
                    <div>
                        <span style={S.topTitle}>{connectedDevice ? connectedDevice.name : typeLabel[activeType]}</span>
                        <span style={S.topSub}> — {status}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        {connectedDevice && <span style={S.connBadge}>⇌ Connected</span>}
                        {user && <span style={S.userBadge}>Welcome, {user.username}</span>}
                        <button style={S.btnLogout} onClick={onLogout}>Logout</button>
                        {connectedDevice && <button style={S.btnClose} onClick={handleDisconnect}>Disconnect</button>}
                    </div>
                </div>

                <div style={S.deviceArea}>
                    {scannedDevices.length === 0 ? (
                        <div style={S.placeholder}>
                            <div style={{ fontSize: '3rem' }}>{typeIcon[activeType]}</div>
                            <div style={S.placeholderText}>Click <strong>Scan</strong> to discover nearby devices.</div>
                            <button style={S.btnScanLarge} onClick={handleScan} disabled={scanning}>
                                {scanning ? 'Scanning…' : '🔍 Start Scanning'}
                            </button>
                        </div>
                    ) : (
                        <>
                            <div style={S.gridHeader}>Discovered Devices</div>
                            <div style={S.grid}>
                                {scannedDevices.map(d => {
                                    const isConn = connectedDevice?.id === d.id;
                                    return (
                                        <div key={d.id} style={{ ...S.card, ...(isConn ? S.cardConnected : {}) }}>
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                <div style={S.cardIcon}>{typeIcon['classic']}</div>
                                                <div>
                                                    <div style={S.cardName}>{d.name}</div>
                                                    <div style={S.cardMac}>{d.mac}</div>
                                                </div>
                                            </div>
                                            <button
                                                style={{ ...S.btnConnect, ...(isConn ? S.btnDisconn : {}) }}
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
                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Packet Builder</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                            {['Init (Printer)','Bold ON','Bold OFF','Cut Paper','Print HI'].map(a => (
                                <button key={a} style={S.pbBtn} onClick={() => {
                                    if (a === 'Init (Printer)') setPbBytes(['1B','40']);
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
                                </div>
                            ))}
                        </div>
                    </div>

                    <div style={S.tpSection}>
                        <div style={S.tpLabel}>Packet Status</div>
                        <div style={S.respBox}>{packetStatus}</div>
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
    btnDelete: { background:'none', border:'none', color:'#aaa', cursor:'pointer', fontSize:'1rem', lineHeight:1, padding:'0 2px' },
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
    btnConnect:{ background:'#1565c0', color:'#fff', border:'none', padding:'6px 0', borderRadius:5, cursor:'pointer', fontSize:'0.78rem', fontWeight:600 },
    btnDisconn:{ background:'#c62828' },
    terminal:  { width:320, minWidth:320, background:'#0d0d0d', borderLeft:'1px solid #1a1a1a', overflowY:'auto', display:'flex', flexDirection:'column' },
    tpSection: { padding:'10px 14px 8px', borderBottom:'1px solid #1a1a1a' },
    tpLabel:   { fontSize:'0.68rem', textTransform:'uppercase', letterSpacing:'0.8px', color:'#555', marginBottom:5 },
    tpSelect:  { width:'100%', background:'#1e1e1e', border:'1px solid #333', color:'#e0e0e0', padding:'5px 8px', borderRadius:4, fontSize:'0.8rem' },
    pbBtn:     { background:'#2a2a2a', color:'#ccc', border:'1px solid #444', padding:'4px 8px', borderRadius:4, cursor:'pointer', fontSize:'0.72rem' },
    btnSend:   { width:'100%', background:'#1565c0', color:'#fff', border:'none', padding:8, borderRadius:5, cursor:'pointer', fontSize:'0.82rem', fontWeight:700, marginTop:8 },
    pvHex:     { padding:'5px 7px', borderRadius:4, fontFamily:'monospace', fontSize:'0.78rem', fontWeight:700, color:'#fff' },
    respBox:   { background:'#1a1a1a', border:'1px solid #2a2a2a', borderRadius:5, padding:10, fontSize:'0.78rem', minHeight:44, fontFamily:'monospace' }
};