import pkg from "../package.json" with { type: "json" };

/** The operad graph engine. */
export const ENGINE_VERSION: string = pkg.version;

export * from "./flow/index.ts";
export * from "./kernel/index.ts";
export * from "./log/index.ts";
export * from "./plugin/index.ts";
export * from "./config/index.ts";
export * from "./http/index.ts";
export * from "./runner/index.ts";
export * from "./views/index.ts";
export * from "./loop/index.ts";
export * from "./trigger/index.ts";
export * from "./notify/index.ts";
export * from "./markdown.ts";
export * from "./util.ts";
