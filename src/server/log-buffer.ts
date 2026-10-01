const MAX_LINE_LENGTH = 1000;
// CSI sequences (colors, cursor movement) and OSC sequences (titles, hyperlinks).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Makes a command output line fit for display: drops ANSI escapes, keeps only the last redraw of
 * progress output that rewrites itself with bare `\r` (docker/BuildKit), and caps its length.
 */
export function cleanLogLine(line: string): string {
  const redraws = line.replace(ANSI, "").split("\r");
  const last = redraws.findLast((part) => part.trim()) ?? "";
  if (last.length <= MAX_LINE_LENGTH) return last;
  return `${last.slice(0, MAX_LINE_LENGTH)}… (${last.length - MAX_LINE_LENGTH} more characters)`;
}

export class LogBuffer {
  private buffer: string[] = [];

  constructor(private readonly max = 500) {}

  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
