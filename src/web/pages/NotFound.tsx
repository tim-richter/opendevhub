import { Link } from "react-router";

export function NotFound({ what = "Page" }: { what?: string }) {
  return (
    <div className="empty">
      <h2>{what} not found</h2>
      <p className="muted">It may have been removed, or the roots were rescanned.</p>
      <Link className="button" to="/">
        Back to overview
      </Link>
    </div>
  );
}
