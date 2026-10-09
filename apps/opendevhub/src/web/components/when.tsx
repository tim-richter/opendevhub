import { useNow } from "../dashboard-context";
import { relativeTime } from "../derive";

/** A moment shown as "5 min ago", with the full date on hover. Takes epoch ms or an ISO string. */
export const When = ({
  at,
  className,
}: {
  at: number | string;
  className?: string;
}) => {
  const now = useNow();
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return (
    <time
      className={className}
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
    >
      {relativeTime(date.getTime(), now)}
    </time>
  );
};
