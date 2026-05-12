const fs = require("fs");
const { spawnSync } = require("child_process");

function main() {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const devDependencyNames = new Set(Object.keys(pkg.devDependencies || {}));
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8"
  });

  let report;
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch (error) {
    process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`npm audit did not return JSON: ${error.message}`);
  }

  const vulnerabilities = Object.values(report.vulnerabilities || {});
  const productionVulnerabilities = vulnerabilities.filter((vulnerability) => {
    return !isDevOnlyVulnerability(vulnerability, devDependencyNames);
  });
  const suppressedDevOnly = vulnerabilities.length - productionVulnerabilities.length;

  if (productionVulnerabilities.length > 0) {
    process.stderr.write(JSON.stringify({
      ok: false,
      productionVulnerabilities: productionVulnerabilities.map((vulnerability) => ({
        name: vulnerability.name,
        severity: vulnerability.severity,
        nodes: vulnerability.nodes
      }))
    }, null, 2));
    process.stderr.write("\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    suppressedDevOnly,
    auditedProductionDependencies: report.metadata && report.metadata.dependencies
      ? report.metadata.dependencies.prod
      : null
  }, null, 2));
  process.stdout.write("\n");
}

function isDevOnlyVulnerability(vulnerability, devDependencyNames) {
  const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
  if (nodes.length === 0) {
    return false;
  }
  return nodes.every((node) => devDependencyNames.has(topLevelPackageName(node)));
}

function topLevelPackageName(nodePath) {
  const parts = String(nodePath).split("/");
  const index = parts.indexOf("node_modules");
  if (index === -1 || index + 1 >= parts.length) {
    return null;
  }
  const name = parts[index + 1];
  if (name && name.startsWith("@") && index + 2 < parts.length) {
    return `${name}/${parts[index + 2]}`;
  }
  return name;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  isDevOnlyVulnerability,
  topLevelPackageName
};
