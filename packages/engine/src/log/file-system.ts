/**
 * The filesystem calls the jsonl backend makes, behind one module. Tests
 * substitute this module to control when a read happens relative to another
 * process's append; the backend itself only ever sees real `node:fs`.
 */
export {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
