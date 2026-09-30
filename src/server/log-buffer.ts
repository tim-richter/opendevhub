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
