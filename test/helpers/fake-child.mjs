import { EventEmitter } from "node:events";

export class FakeChild extends EventEmitter {
  constructor(pid = Math.floor(Math.random() * 100000) + 1) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
  }
  exit(code = 255) {
    this.emit("exit", code, null);
  }
}
