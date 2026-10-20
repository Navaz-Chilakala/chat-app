/** Shown instantly while a page's server data loads (e.g. while the database wakes up). */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-56 rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-96 max-w-full rounded bg-slate-200 dark:bg-slate-800" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-20 rounded-xl bg-slate-200 dark:bg-slate-800" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-slate-200 dark:bg-slate-800" />
    </div>
  );
}
