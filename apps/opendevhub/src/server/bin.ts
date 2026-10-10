import { suppressSqliteWarning } from "./db/database";

// Before anything loads node:sqlite, which warns that it is experimental.
suppressSqliteWarning();
const { main } = await import("./cli");

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
