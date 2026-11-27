import { config } from "./config.js";
import { QoderDaemonManager } from "./daemon.js";
import { createApp } from "./app.js";

async function main() {
  const daemon = new QoderDaemonManager();
  await daemon.ensureDaemon();

  const app = createApp(daemon);
  const server = app.listen(config.port, config.host, () => {
    console.log(`qoder-sdk-proxy listening on http://${config.host}:${config.port}`);
  });

  const shutdown = async () => {
    console.log("Shutting down qoder-sdk-proxy...");
    server.close();
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
