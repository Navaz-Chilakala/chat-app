"use client";

import { useEffect, useId, useState } from "react";
import { CopyButton } from "./ui";

/** Client-side Mermaid rendering with strict security (no HTML labels, no click handlers). */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.classList.contains("dark") ? "dark" : "default", sequence: { useMaxWidth: true, wrap: true } });
        const { svg } = await mermaid.render(`m${id}`, chart);
        if (alive) setSvg(svg);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chart, id]);
  return (
    <div className="rounded-lg border hairline">
      <div className="flex items-center justify-between gap-2 border-b hairline px-3 py-1.5 text-xs">
        <span className="muted">Mermaid sequence diagram</span>
        <div className="flex gap-1.5">
          <button className="btn !px-2 !py-1 text-xs" onClick={() => setShowSource((s) => !s)}>{showSource ? "Diagram" : "Source"}</button>
          <CopyButton text={chart} label="Copy Mermaid" />
        </div>
      </div>
      {showSource || err ? (
        <pre className="overflow-auto p-3 text-xs">{err ? `Render error: ${err}\n\n` : ""}{chart}</pre>
      ) : svg ? (
        // Mermaid output rendered with securityLevel "strict" (labels are sanitised by Mermaid).
        <div className="overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="muted p-6 text-center text-sm">Rendering…</div>
      )}
    </div>
  );
}
