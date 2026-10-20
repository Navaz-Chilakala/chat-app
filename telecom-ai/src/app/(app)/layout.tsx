import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { envStatus } from "@/lib/env";
import { Shell } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const status = envStatus();
  if (!status.ok) redirect("/setup");
  const user = await currentUser().catch(() => null);
  if (!user) redirect("/login");
  return <Shell user={user}>{children}</Shell>;
}
