import { route, json, requireUser } from "@/lib/http";
import { userWorkspaces } from "@/lib/auth/access";

export const GET = route(async () => {
  const user = await requireUser();
  return json({ user, workspaces: await userWorkspaces(user.id) });
});
