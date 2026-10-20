"use client";

/** Render a pipe-delimited markdown table as an HTML table without injecting HTML. */
export function MarkdownTable({ markdown }: { markdown: string }) {
  const rows = markdown
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim()));
  const body = rows.filter((r) => !r.every((c) => /^:?-{3,}:?$/.test(c)));
  if (!body.length) return <pre className="text-xs whitespace-pre-wrap">{markdown}</pre>;
  const [head, ...rest] = body;
  return (
    <div className="overflow-x-auto rounded-lg border hairline">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-slate-50 dark:bg-slate-800/60">
          <tr>{head!.map((h, i) => <th key={i} className="px-2.5 py-1.5 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rest.map((r, i) => (
            <tr key={i} className="border-t hairline align-top">
              {r.map((c, j) => <td key={j} className="px-2.5 py-1.5">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
