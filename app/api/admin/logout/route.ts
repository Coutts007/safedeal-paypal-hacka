import { clearedCookie } from "@/lib/admin/auth";
import { json } from "@/lib/http";

export async function POST() {
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", clearedCookie);
  return res;
}
