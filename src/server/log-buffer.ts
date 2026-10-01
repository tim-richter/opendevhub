/** Build tools can emit multi-KB progress lines; cap them so the log stays cheap to ship and render. */
export const MAX_LINE_CHARS = 2000;

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "… (truncated)" : line;
}

export class LogBuffer {
  private buffer: string[] = [];

  constructor(private readonly max = 500) {}

  push(line: string): void {
    this.buffer.push(clip(line));
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
