import { useState } from 'react';
import Landing from './Landing.jsx';
import Chat from './Chat.jsx';

// Pick up an invite secret from the URL fragment once, then strip it from the
// address bar so it isn't left on screen. Nothing is ever written to storage.
function takeSecretFromUrl() {
  const secret = decodeURIComponent(window.location.hash.slice(1));
  if (secret) window.history.replaceState(null, '', window.location.pathname);
  return secret;
}

const initialSecret = takeSecretFromUrl();

export default function App() {
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState('');

  function end(message) {
    setSession(null);
    setNotice(message);
  }

  return session ? (
    <Chat session={session} onEnd={end} />
  ) : (
    <Landing
      initialSecret={initialSecret}
      notice={notice}
      onJoined={(s) => {
        setNotice('');
        setSession(s);
      }}
    />
  );
}
