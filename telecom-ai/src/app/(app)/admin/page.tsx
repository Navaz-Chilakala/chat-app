"use client";

import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AdminPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api<{ users: any[] }>("/api/admin/users").then((r) => setUsers(r.users)).catch((e) => setError(e.message));
    api<{ events: any[] }>("/api/admin/audit").then((r) => setAudit(r.events)).catch(() => undefined);
  };
  useEffect(load, []);
  const patch = async (body: Record<string, unknown>) => {
    try {
      await api("/api/admin/users", { method: "PATCH", body });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader title="Administration" subtitle="Users, shared-collection roles and the audit log." />
      <ErrorNote error={error} />
      <Card title="Users">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="muted text-xs"><tr><th className="py-2 pr-3">User</th><th className="pr-3">Commons role</th><th className="pr-3">Admin</th><th className="pr-3">Status</th><th>Joined</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t hairline">
                  <td className="py-2 pr-3"><div className="font-medium">{u.display_name}</div><div className="muted text-xs">{u.email}</div></td>
                  <td className="pr-3">
                    <select className="input !w-auto !py-1 text-xs" value={u.commons_role ?? "viewer"} onChange={(e) => patch({ userId: u.id, commonsRole: e.target.value })}>
                      <option value="viewer">viewer (uploads reviewed)</option>
                      <option value="editor">editor</option>
                      <option value="owner">owner (can review)</option>
                    </select>
                  </td>
                  <td className="pr-3"><input type="checkbox" checked={u.is_admin} onChange={(e) => patch({ userId: u.id, isAdmin: e.target.checked })} /></td>
                  <td className="pr-3">{u.disabled_at ? <button className="btn !py-1 text-xs" onClick={() => patch({ userId: u.id, disabled: false })}>Enable</button> : <button className="btn btn-danger !py-1 text-xs" onClick={() => patch({ userId: u.id, disabled: true })}>Disable</button>}</td>
                  <td className="muted text-xs">{fmtDate(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="mt-4" title="Audit log">
        <ul className="max-h-[520px] space-y-1 overflow-y-auto font-mono text-[11.5px]">
          {audit.map((a) => (
            <li key={a.id}><span className="muted">{fmtDate(a.created_at)}</span> <Badge>{a.action}</Badge> {a.email ?? "system"} {a.target_type ? `${a.target_type}:${String(a.target_id).slice(0, 12)}` : ""} {a.data ? JSON.stringify(a.data).slice(0, 160) : ""}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
