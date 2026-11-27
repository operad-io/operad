/**
 * The routes under `/v1/terminal` and the terminal events on `/v1/events`.
 * Everything but reading the list is refused unless the request came over
 * loopback from this machine.
 */

import { isRecord, type PluginHttp, type PluginHttpRequest, type PluginHttpResponse } from "@operad-io/engine";
import { MAX_GROUP_NAME, MAX_SIZE, TerminalError, type TerminalHost } from "./host.ts";

/** What a request from anywhere but this machine is told. */
export const REMOTE_REFUSAL =
  "terminals work only from this Mac: send the request over loopback (127.0.0.1) from the machine operad serve runs on";

function refusal(status: number, kind: string, message: string): PluginHttpResponse {
  return { status, body: { error: { kind, message } } };
}

function text(body: Readonly<Record<string, unknown>>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new TerminalError(400, "args", `${name} must be a string`);
  return value;
}

function size(body: Readonly<Record<string, unknown>>, name: "cols" | "rows"): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SIZE) {
    throw new TerminalError(400, "args", `${name} must be a whole number from 1 to ${MAX_SIZE}`);
  }
  return value;
}

function groupName(body: Readonly<Record<string, unknown>>): string {
  const name = text(body, "name").trim();
  if (name === "" || name.length > MAX_GROUP_NAME) {
    throw new TerminalError(400, "args", `name must have 1 to ${MAX_GROUP_NAME} characters`);
  }
  return name;
}

/** What one POST does with its body. */
type Change = (body: Readonly<Record<string, unknown>>) => Promise<PluginHttpResponse>;

/** The POST a path names, or undefined when it names none. */
function changeAt(host: TerminalHost, path: readonly string[]): Change | undefined {
  const [first, second, third, ...rest] = path;
  if (rest.length > 0) return undefined;
  if (first === undefined) {
    return async (body) => {
      const { group } = body;
      if (group !== undefined && group !== null && typeof group !== "string") {
        throw new TerminalError(400, "args", "group must be a string");
      }
      const terminal = await host.start({
        command: body.command === undefined ? "" : text(body, "command"),
        folder: text(body, "folder"),
        cols: size(body, "cols"),
        rows: size(body, "rows"),
        group: group ?? undefined,
      });
      return { status: 201, body: { terminal } };
    };
  }
  if (first === "groups") {
    if (second === undefined) {
      return async (body) => ({ status: 201, body: { group: await host.createGroup(groupName(body)) } });
    }
    if (third === undefined) {
      return async (body) => ({
        status: 200,
        body: { group: await host.renameGroup(second, groupName(body)) },
      });
    }
    if (third !== "delete") return undefined;
    return async () => {
      await host.deleteGroup(second);
      return { status: 200, body: {} };
    };
  }
  if (third !== undefined) return undefined;
  switch (second) {
    case "input":
      return async (body) => {
        host.input(first, text(body, "data"));
        return { status: 200, body: {} };
      };
    case "resize":
      return async (body) => ({
        status: 200,
        body: { terminal: host.resize(first, size(body, "cols"), size(body, "rows")) },
      });
    case "close":
      return async () => ({ status: 200, body: { terminal: await host.close(first) } });
    case "group":
      return async (body) => {
        const group = body.group === null ? null : text(body, "group");
        return { status: 200, body: { terminal: await host.assign(first, group) } };
      };
    default:
      return undefined;
  }
}

async function answer(host: TerminalHost, request: PluginHttpRequest): Promise<PluginHttpResponse | undefined> {
  if (request.path.length === 0 && request.method === "GET") {
    return { status: 200, body: await host.list() };
  }
  const change = changeAt(host, request.path);
  if (change === undefined) return undefined;
  if (request.method !== "POST") {
    return refusal(405, "method", "this endpoint takes POST");
  }
  // Refused before the body is read: nothing a remote sends is looked at.
  if (!request.local) return refusal(403, "refused", REMOTE_REFUSAL);
  const body = await request.body();
  if (!isRecord(body)) return refusal(400, "args", "the body must be an object");
  return await change(body);
}

export function terminalHttp(host: TerminalHost): PluginHttp {
  return {
    async request(request) {
      try {
        return await answer(host, request);
      } catch (error) {
        if (!(error instanceof TerminalError)) throw error;
        return refusal(error.status, error.kind, error.message);
      }
    },
    stream(request) {
      const ids = request.values.filter((value) => value !== "");
      // A screen shows what was typed and printed: only this machine reads it.
      if (ids.length > 0 && !request.local) return refusal(403, "refused", REMOTE_REFUSAL);
      return { open: (send) => host.open(ids, send) };
    },
  };
}
