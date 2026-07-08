import { useState } from 'react';
import LoginPage from './pages/LoginPage';
import TerminalPage from './pages/TerminalPage';  // fixed: was TeminalPage

function App() {
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [user, setUser] = useState(null);

    const handleLogin = (userData) => {
        setUser(userData);
        setIsLoggedIn(true);
    };

    return isLoggedIn
        ? <TerminalPage user={user} onLogout={() => { setIsLoggedIn(false); setUser(null); }} />
        : <LoginPage onLogin={handleLogin} />;
}

export default App;