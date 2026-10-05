import { Link } from 'waku';
import { Logo } from '@/components/logo';

export default function Home() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-16 gap-6">
      <Logo size={72} className="text-fd-primary" />
      <h1 className="font-semibold text-3xl sm:text-4xl">opendevhub</h1>
      <p className="max-w-xl text-fd-muted-foreground">
        A local dashboard that runs opencode agents inside your projects&apos; devcontainers. Watch every
        session, answer permissions, run tasks in parallel worktrees and publish the result as a pull request.
      </p>
      <pre className="rounded-lg border bg-fd-card px-4 py-2 text-sm">
        <code>npx opendevhub --root ~/code</code>
      </pre>
      <div className="flex gap-3">
        <Link
          to="/docs"
          className="px-3 py-2 rounded-lg bg-fd-primary text-fd-primary-foreground font-medium text-sm"
        >
          Read the docs
        </Link>
        <Link
          to="/docs/getting-started"
          className="px-3 py-2 rounded-lg border font-medium text-sm"
        >
          Getting started
        </Link>
      </div>
    </div>
  );
}

export async function getConfig() {
  return {
    render: 'static',
  };
}
