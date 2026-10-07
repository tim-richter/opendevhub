import { docsLlms } from "@/lib/source";

export const GET = async () => new Response(await docsLlms.index());

export const getConfig = async () =>
  ({
    render: "static" as const,
  }) as const;
