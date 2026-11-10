/** The machine's load, for a reader deciding whether a failure was load. */

import { availableParallelism, loadavg } from "node:os";

/** The 1-minute load average and the number of cores. */
export interface MachineLoad {
  readonly load1: number;
  readonly cores: number;
}

/** Reads the load now. A platform with no load average reports 0. */
export function machineLoad(): MachineLoad {
  const [load1] = loadavg();
  return {
    load1: Math.round((load1 ?? 0) * 100) / 100,
    cores: availableParallelism(),
  };
}
