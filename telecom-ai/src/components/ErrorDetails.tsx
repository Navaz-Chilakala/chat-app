"use client";

import { useEffect } from "react";

/** Error view that shows the actual error (message, digest, location) instead of a generic page. */
export function ErrorDetails({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const details = [
    `Message: ${error.message || "(none)"}`,
    `Type: ${error.name}`,
    error.digest ? `Server digest: ${error.digest}` : "Origin: browser (client-side exception)",
    typeof window !== "undefined" ? `URL: ${window.location.href}` : "",
    error.stack ? `Stack:\n${error.stack.split("\n").slice(0, 8).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <main style={{ maxWidth: 760, margin: "60px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>Something went wrong</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>Please copy the details below when reporting this problem.</p>
      <pre style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "rgba(127,127,127,0.12)", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{details}</pre>
      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        {reset && <button onClick={() => reset()} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #888" }}>Try again</button>}
        <a href="/login" style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #888" }}>Go to sign-in</a>
        <a href="/api/health" style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #888" }}>Health check</a>
      </div>
    </main>
  );
}
