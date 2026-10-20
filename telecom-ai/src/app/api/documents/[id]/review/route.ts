import { z } from "zod";
import { route, json, requireUser, parseBody, HttpError } from "@/lib/http";
import { documentAccess, hasRole } from "@/lib/auth/access";
import { setReviewStatus } from "@/lib/ingest/service";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ status: z.enum(["approved", "rejected"]) });

export const POST = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const access = await documentAccess(user, id);
  if (!access) throw new HttpError(404, "Document not found");
  if (!user.isAdmin && !hasRole(access.role, "owner")) throw new HttpError(403, "Only workspace owners or admins can review documents");
  const { status } = await parseBody(req, Body);
  await setReviewStatus(id, status, user.id);
  return json({ ok: true });
});
