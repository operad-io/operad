/**
 * A fast look at the processes below one process, for macOS. The system
 * withholds the environment of Apple's own binaries, so a loop a shell left in
 * the background cannot be found by the marker; it has to be seen while it
 * still has a parent, and a shell that starts it may end a few milliseconds
 * later. A kqueue watches each process below the step for `fork` and `exit`;
 * the kernel keeps what happened until it is read, so a reader that comes every
 * couple of milliseconds misses nothing, and each fork is followed at once by a
 * look at the children of the process that forked.
 *
 * `bun:ffi` reaches the two system calls; no package is added. On a system
 * without them `createProcessWatch` answers `undefined` and the table poll of
 * `step-reap.ts` is all there is.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

/** What the system says about one process. */
export interface WatchedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly uid: number;
  /** Start time in whole seconds since the epoch. */
  readonly startSec: number;
}

/** What happened to the processes that are watched since the last `drain`. */
export interface WatchEvents {
  /** Processes that forked: look at their children. */
  readonly forked: readonly number[];
  /** Processes that ended. */
  readonly exited: readonly number[];
}

export interface ProcessWatch {
  /** Starts watching a process for fork and exit; false when it is gone. */
  watch(pid: number): boolean;
  /** The live children of a process. */
  children(pid: number): readonly number[];
  info(pid: number): WatchedProcess | undefined;
  drain(): WatchEvents;
  close(): void;
}

const EVFILT_PROC = -5;
const EV_ADD = 0x1;
const EV_CLEAR = 0x20;
const NOTE_EXIT = 0x80000000;
const NOTE_FORK = 0x40000000;
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
const EVENT_SIZE = 32;
const MAX_EVENTS = 256;

type Symbols = {
  kqueue(): number;
  kevent(kq: number, changes: unknown, nchanges: number, events: unknown, nevents: number, timeout: unknown): number;
  close(fd: number): number;
  proc_listchildpids(pid: number, buffer: unknown, size: number): number;
  proc_pidinfo(pid: number, flavor: number, arg: bigint, buffer: unknown, size: number): number;
};

/** A watch on this system, or `undefined` when it has none. */
export function createProcessWatch(): ProcessWatch | undefined {
  if (process.platform !== "darwin") return undefined;
  let symbols: Symbols;
  try {
    symbols = dlopen("libc.dylib", {
      kqueue: { args: [], returns: FFIType.i32 },
      kevent: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    }).symbols as unknown as Symbols;
  } catch {
    return undefined;
  }
  const queue = symbols.kqueue();
  if (queue < 0) return undefined;

  const change = new DataView(new ArrayBuffer(EVENT_SIZE));
  const events = new ArrayBuffer(EVENT_SIZE * MAX_EVENTS);
  const eventView = new DataView(events);
  const noWait = new Uint8Array(16);
  const nothing = new Uint8Array(EVENT_SIZE);
  const kids = new Int32Array(1024);
  const bsd = new Uint8Array(BSDINFO_SIZE);
  const bsdView = new DataView(bsd.buffer);
  let open = true;

  return {
    watch(pid) {
      if (!open) return false;
      change.setBigUint64(0, BigInt(pid), true);
      change.setInt16(8, EVFILT_PROC, true);
      change.setUint16(10, EV_ADD | EV_CLEAR, true);
      change.setUint32(12, (NOTE_FORK | NOTE_EXIT) >>> 0, true);
      change.setBigInt64(16, 0n, true);
      change.setBigUint64(24, 0n, true);
      return (
        symbols.kevent(queue, ptr(new Uint8Array(change.buffer)), 1, ptr(nothing), 0, ptr(noWait)) >= 0
      );
    },
    children(pid) {
      if (!open) return [];
      const count = symbols.proc_listchildpids(pid, ptr(kids), kids.byteLength);
      return count <= 0 ? [] : Array.from(kids.slice(0, count));
    },
    info(pid) {
      if (!open) return undefined;
      const got = symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(bsd), BSDINFO_SIZE);
      if (got !== BSDINFO_SIZE) return undefined;
      return {
        pid: bsdView.getUint32(12, true),
        ppid: bsdView.getUint32(16, true),
        uid: bsdView.getUint32(20, true),
        pgid: bsdView.getUint32(100, true),
        startSec: Number(bsdView.getBigUint64(120, true)),
      };
    },
    drain() {
      const forked: number[] = [];
      const exited: number[] = [];
      if (!open) return { forked, exited };
      for (;;) {
        const count = symbols.kevent(queue, null, 0, ptr(new Uint8Array(events)), MAX_EVENTS, ptr(noWait));
        if (count <= 0) break;
        for (let index = 0; index < count; index += 1) {
          const at = index * EVENT_SIZE;
          const pid = Number(eventView.getBigUint64(at, true));
          const flags = eventView.getUint32(at + 12, true);
          if ((flags & NOTE_FORK) !== 0) forked.push(pid);
          if ((flags & NOTE_EXIT) !== 0) exited.push(pid);
        }
        if (count < MAX_EVENTS) break;
      }
      return { forked, exited };
    },
    close() {
      if (!open) return;
      open = false;
      symbols.close(queue);
    },
  };
}
