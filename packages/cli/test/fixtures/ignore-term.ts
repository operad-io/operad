// A stand-in that ignores SIGTERM. It is started as `ignore-term.ts serve`, so
// its command line names `serve` the way a real one does.
process.on("SIGTERM", () => {});
console.log("ready");
setInterval(() => {}, 1_000);
