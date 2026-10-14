import { useEffect, useRef, useState } from 'react';
import { SessionExpiredError, api } from './api.js';
import { decryptMessage, encryptMessage } from './crypto.js';

const POLL_MS = 2000;
const MAX_TEXT = 2000;

function formatRemaining(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Chat({ session, onEnd }) {
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState(1);
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const lastId = useRef(0);
  const purgeAt = useRef(session.purgeAt);
  const ended = useRef(false);
  const listRef = useRef(null);

  function finish(message) {
    if (ended.current) return;
    ended.current = true;
    setMessages([]);
    onEnd(message);
  }

  async function poll() {
    try {
      const res = await api.fetchMessages(session.token, lastId.current);
      setOnline(res.online);
      // Server wiped yesterday's chat at midnight UTC; mirror that on screen.
      if (res.purge_at !== purgeAt.current) {
        purgeAt.current = res.purge_at;
        setMessages([]);
      }
      if (res.messages.length) {
        lastId.current = Math.max(lastId.current, res.messages[res.messages.length - 1].id);
        const decoded = await Promise.all(
          res.messages.map(async (m) => ({ id: m.id, ...(await decryptMessage(session.key, m.data)) })),
        );
        const valid = decoded.filter((m) => typeof m.u === 'string' && typeof m.t === 'string');
        // Overlapping polls (timer + right after sending) can return the same rows.
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...valid.filter((m) => !seen.has(m.id))].slice(-200);
        });
      }
      setError('');
    } catch (e) {
      if (e instanceof SessionExpiredError) finish('Your 10-minute session ended. Everything was cleared.');
      else setError('Connection problem, retrying…');
    }
  }

  useEffect(() => {
    poll();
    const pollTimer = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    // Best effort: drop the server-side session when the tab is closed.
    const onPageHide = () => api.leave(session.token, true).catch(() => {});
    window.addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(pollTimer);
      clearInterval(clock);
      window.removeEventListener('pagehide', onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (now >= session.expiresAt) finish('Your 10-minute session ended. Everything was cleared.');
    if (now >= purgeAt.current) setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      const data = await encryptMessage(session.key, { u: session.username, s: session.tag, t, ts: Date.now() });
      await api.send(session.token, data);
      poll();
    } catch (err) {
      if (err instanceof SessionExpiredError) finish('Your 10-minute session ended. Everything was cleared.');
      else setError(err.message);
    }
  }

  async function leave() {
    await api.leave(session.token).catch(() => {});
    finish('You left. Nothing from this session is kept on this device.');
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(session.inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const remaining = session.expiresAt - now;

  return (
    <main className="card chat">
      <header>
        <div>
          <strong>{session.username}</strong>
          <span className="tag">#{session.tag}</span>
          <span className="muted"> · {online} online</span>
        </div>
        <div className={remaining < 60_000 ? 'timer warn' : 'timer'}>{formatRemaining(remaining)}</div>
      </header>

      <div className="actions">
        <button onClick={copyInvite}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        <button className="danger" onClick={leave}>
          Leave &amp; wipe
        </button>
      </div>

      <ul className="messages" ref={listRef}>
        {messages.length === 0 && <li className="muted empty">No messages yet. Share the invite link to start.</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.s === session.tag && m.u === session.username ? 'mine' : ''}>
            <div className="meta">
              {m.u}
              <span className="tag">#{m.s}</span>
              {typeof m.ts === 'number' && (
                <span className="time">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            <div className="text">{m.t}</div>
          </li>
        ))}
      </ul>

      {error && <p className="error">{error}</p>}

      <form className="composer" onSubmit={send}>
        <input
          value={text}
          maxLength={MAX_TEXT}
          autoComplete="off"
          placeholder="Type a message…"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
