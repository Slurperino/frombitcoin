const { Command } = require("commander");
const {
  createLogger
} = require("./lib/service-runtime");
const {
  loadDonReleaseAdapterConfig,
  startDonReleaseAdapterServer
} = require("./lib/don-release-adapter");

async function main() {
  const program = new Command();

  program.requiredOption("--config <path>", "DON release adapter JSON config");
  program.parse(process.argv);

  const options = program.opts();
  const config = loadDonReleaseAdapterConfig(options.config);
  const logger = createLogger({ service: config.serviceName, role: "don-release-adapter" });
  const { server } = startDonReleaseAdapterServer({ config, logger });

  const stop = () => {
    logger.info("shutdown_requested");
    server.close(() => {
      logger.info("service_stopped");
      process.exit(0);
    });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
