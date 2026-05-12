const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const BUILD_DIR = path.join(ROOT, "build");

module.exports = {
  BUILD_DIR,
  CONTRACTS_DIR,
  ROOT
};
