import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const projectId = (absPath: string): string => {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
  const slug =
    path
      .basename(absPath)
      .normalize("NFKD")
      .replaceAll(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 50)
      .replaceAll(/-+$/gu, "") || "project";
  return `${slug}-${hash}`;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `tsk_` plus a ULID: 10 characters of milliseconds, then 16 random ones, so ids sort by creation time. */
export const newTaskId = (
  now = Date.now(),
  random: (n: number) => Uint8Array = (n) => randomBytes(n)
): string => {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = "";
  for (let i = 0; i < 16; i += 1) {
    rand += CROCKFORD[bytes[i] % 32];
  }
  return `tsk_${time}${rand}`;
};
