import { Link } from "waku";

import { HomeBackground } from "@/components/home-background";
import { Logo3D } from "@/components/logo-3d";

export default function Home() {
  return (
    <div className="relative isolate flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <HomeBackground />
      <Logo3D size={160} className="text-fd-primary" />
      <h1 className="text-3xl font-semibold sm:text-4xl">opendevhub</h1>
      <p className="text-fd-muted-foreground max-w-xl">
        A local dashboard that runs opencode agents inside your projects&apos;
        devcontainers. Watch every session, answer permissions, run tasks in
        parallel worktrees and publish the result as a pull request.
      </p>
      <pre className="bg-fd-card/70 rounded-lg border px-4 py-2 text-sm backdrop-blur-sm">
        <code>npx opendevhub</code>
      </pre>
      <div className="flex gap-3">
        <Link
          to="/docs"
          className="bg-fd-primary text-fd-primary-foreground rounded-lg px-3 py-2 text-sm font-medium"
        >
          Read the docs
        </Link>
        <Link
          to="/docs/getting-started"
          className="bg-fd-background/60 rounded-lg border px-3 py-2 text-sm font-medium backdrop-blur-sm"
        >
          Getting started
        </Link>
      </div>
    </div>
  );
}

export const getConfig = async () => ({
  render: "static",
});
