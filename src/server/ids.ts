import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export function projectId(absPath: string): string {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
  const slug =
    path
      .basename(absPath)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "") || "project";
  return `${slug}-${hash}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `tsk_` plus a ULID: 10 characters of milliseconds, then 16 random ones, so ids sort by creation time. */
export function newTaskId(now = Date.now(), random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return `tsk_${time}${rand}`;
}
