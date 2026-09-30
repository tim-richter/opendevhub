import { createHash } from "node:crypto";
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
