import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import type { ProjectView, SessionSummary } from "../../../shared/types";
import { fetchSessionDetail, sendComposerMessage } from "../../api";
import type { Checkout } from "../checkouts/checkouts";
import { Conversation } from "./conversation";
import type { PanelId } from "./side-panel";

/** How often a working conversation is read again, so its replies show up as they come. */
const WORKING_REFRESH_MS = 2000;

/** A session's transcript, turns, usage and subagents; shown at once on a return visit, then read again. */
const sessionDetailQuery = (
  projectId: string,
  sessionId: string,
  working = false
) =>
  queryOptions({
    queryFn: () => fetchSessionDetail(projectId, sessionId),
    queryKey: ["session", projectId, sessionId],
    refetchInterval: working ? WORKING_REFRESH_MS : false,
    staleTime: 0,
  });

/**
 * One conversation: its transcript, a composer to message it, its usage and its turns with what each changed.
 * `showTask` adds a chip linking to the task it belongs to, for a conversation shown on another task's page. It fills
 * the height it is given, so its parent must bound it.
 */
export const SessionView = ({
  view,
  checkout,
  session,
  showTask = false,
  changes = false,
  terminal = false,
  runtime = false,
  initialPanel,
  composerLabel,
  onStarted,
  chips,
  actions,
}: {
  view: ProjectView;
  checkout: Checkout;
  session: SessionSummary;
  showTask?: boolean;
  /** Offers the checkout's changes in a side panel. */
  changes?: boolean;
  /** Offers the checkout's terminal in a side panel. */
  terminal?: boolean;
  /** Offers the checkout runtime in a side panel. */
  runtime?: boolean;
  initialPanel?: PanelId;
  /** Names whom the composer writes to, e.g. "To V2 · feat/oauth-b"; chats leave it out. */
  composerLabel?: string;
  /** A conversation the composer's `/new` started in this checkout, with its chat. */
  onStarted?: (sessionId: string, chat?: string) => void;
  /** More chips for the header. */
  chips?: ReactNode;
  /** More buttons for the header's end. */
  actions?: ReactNode;
}) => {
  const projectId = view.project.id;
  const queryClient = useQueryClient();
  const working = session.status !== "idle";
  const { data: detail, error } = useQuery(
    sessionDetailQuery(projectId, session.id, working)
  );

  // While idle, the snapshot's summary changes only when the session does; read the detail again each time.
  const version = `${session.updatedAt}:${session.status}`;
  const shownVersion = useRef(version);
  useEffect(() => {
    if (version !== shownVersion.current) {
      shownVersion.current = version;
      void queryClient.invalidateQueries({
        queryKey: sessionDetailQuery(projectId, session.id).queryKey,
      });
    }
  }, [version, queryClient, projectId, session.id]);

  return (
    <Conversation
      view={view}
      checkout={checkout}
      session={session}
      detail={detail}
      error={error?.message}
      showTask={showTask}
      changes={changes}
      terminal={terminal}
      runtime={runtime}
      initialPanel={initialPanel}
      composerLabel={composerLabel}
      chips={chips}
      actions={actions}
      onSend={async (message) => {
        const result = await sendComposerMessage(
          projectId,
          session.id,
          message
        );
        if (result.kind === "new") {
          onStarted?.(result.sessionId, result.chat);
        } else {
          // Shows the message at once instead of at the next refresh.
          void queryClient.invalidateQueries({
            queryKey: sessionDetailQuery(projectId, session.id).queryKey,
          });
        }
        return result;
      }}
    />
  );
};
