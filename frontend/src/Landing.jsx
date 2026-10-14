import { useState } from 'react';
import { api } from './api.js';
import { MIN_PASSPHRASE_LENGTH, deriveRoom, newRoomSecret, parseRoomInput, randomHex } from './crypto.js';

const MAX_USERNAME = 24;

export default function Landing({ initialSecret, notice, onJoined }) {
  const [username, setUsername] = useState('');
  const [roomInput, setRoomInput] = useState(initialSecret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function enter(secret) {
    const name = username.trim();
    if (!name) return setError('Pick a username for this session.');
    if (secret.length < MIN_PASSPHRASE_LENGTH) {
      return setError(`Room passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    }
    setBusy(true);
    setError('');
    try {
      const { key, roomId } = await deriveRoom(secret);
      const res = await api.join(roomId);
      onJoined({
        username: name,
        // Random per-session tag shown next to the name, so two people can't
        // pass as each other just by picking the same username.
        tag: randomHex(2),
        key,
        token: res.token,
        expiresAt: res.expires_at,
        purgeAt: res.purge_at,
        inviteLink: `${window.location.origin}${window.location.pathname}#${encodeURIComponent(secret)}`,
      });
    } catch (e) {
      setError(e.message || 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <main className="card landing">
      <h1>Ephemeral Chat</h1>
      <p className="muted">
        Pick a name, chat for 10 minutes, then it's gone. Messages are end-to-end encrypted in your
        browser and wiped from the server every day.
      </p>

      {notice && <p className="notice">{notice}</p>}

      <label>
        Username (this session only)
        <input
          value={username}
          maxLength={MAX_USERNAME}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. ghost"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>

      <button className="primary" disabled={busy} onClick={() => enter(newRoomSecret())}>
        Create a new private room
      </button>

      <div className="divider">or join one</div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          enter(parseRoomInput(roomInput));
        }}
      >
        <label>
          Invite link or room passphrase
          <input
            value={roomInput}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste link or type a shared passphrase"
            onChange={(e) => setRoomInput(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !roomInput.trim()}>
          {busy ? 'Joining…' : 'Join room'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
