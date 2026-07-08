import { useState } from 'react';
import { login } from '../api/apiService';

export default function LoginPage({ onLogin }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError]       = useState('');
    const [loading, setLoading]   = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const res = await login({ username, password });
            onLogin(res.data);  // pass user data up to App
        } catch (err) {
            setError(err.response?.data?.error || 'Login failed. Check credentials.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={styles.page}>
            <div style={styles.card}>
                <div style={styles.icon}>🔵</div>
                <h1 style={styles.title}>Bluetooth Terminal</h1>
                <p style={styles.subtitle}>Sign in to continue</p>

                <form onSubmit={handleSubmit} style={styles.form}>
                    <div style={styles.field}>
                        <label style={styles.label}>Username</label>
                        <input
                            style={styles.input}
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            placeholder="Enter username"
                            required
                            autoFocus
                        />
                    </div>
                    <div style={styles.field}>
                        <label style={styles.label}>Password</label>
                        <input
                            style={styles.input}
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="Enter password"
                            required
                        />
                    </div>

                    {error && <div style={styles.error}>{error}</div>}

                    <button style={styles.btn} type="submit" disabled={loading}>
                        {loading ? 'Signing in…' : 'Sign In'}
                    </button>
                </form>
            </div>
        </div>
    );
}

const styles = {
    page: {
        minHeight: '100vh',
        background: '#0f0f1a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    card: {
        background: '#1a1a2e',
        border: '1px solid #2a2a4e',
        borderRadius: '12px',
        padding: '40px',
        width: '360px',
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    icon:     { fontSize: '2.5rem', marginBottom: '12px' },
    title:    { color: '#90caf9', fontSize: '1.5rem', fontWeight: 700, margin: '0 0 6px' },
    subtitle: { color: '#666', fontSize: '0.88rem', margin: '0 0 28px' },
    form:     { display: 'flex', flexDirection: 'column', gap: '16px' },
    field:    { display: 'flex', flexDirection: 'column', gap: '6px', textAlign: 'left' },
    label:    { color: '#aaa', fontSize: '0.8rem', fontWeight: 600 },
    input: {
        background: '#0f0f1a',
        border: '1px solid #333',
        borderRadius: '6px',
        color: '#e0e0e0',
        padding: '10px 12px',
        fontSize: '0.88rem',
        outline: 'none',
    },
    error: {
        background: '#2a0a0a',
        border: '1px solid #c62828',
        color: '#ef9a9a',
        padding: '8px 12px',
        borderRadius: '6px',
        fontSize: '0.8rem',
    },
    btn: {
        background: '#1565c0',
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        padding: '11px',
        fontSize: '0.9rem',
        fontWeight: 700,
        cursor: 'pointer',
        marginTop: '4px',
    },
};