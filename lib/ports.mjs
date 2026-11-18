import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function readPlugins(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data?.plugins) ? data.plugins : [];
  } catch {
    return [];
  }
}

function portOf(entry) {
  const port = entry?.options?.port;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function firstPort(entries) {
  for (const entry of entries) {
    const port = portOf(entry);
    if (port !== null) return port;
  }
  return null;
}

function isPackageAt(spec, packageName, packageRoot) {
  if (typeof spec !== "string" || !spec) return false;
  const candidate = isAbsolute(spec) ? spec : resolve(packageRoot, "..", spec);
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    return pkg?.name === packageName;
  } catch {
    return false;
  }
}

// configuredPort is the port plugins.json gives this plugin: an exact spec,
// then a versioned one, then a path whose package.json names it. The page
// host runs on that port; a host magpie moved to another port is not it.
export function configuredPort({ pluginsPath, packageName, packageRoot, fallback = 3488 }) {
  const plugins = readPlugins(pluginsPath);
  let port = firstPort(plugins.filter((entry) => entry?.spec === packageName));
  if (port !== null) return port;
  port = firstPort(
    plugins.filter((entry) => typeof entry?.spec === "string" && entry.spec.startsWith(packageName + "@")),
  );
  if (port !== null) return port;
  port = firstPort(plugins.filter((entry) => isPackageAt(entry?.spec, packageName, packageRoot)));
  return port ?? fallback;
}

// A host magpie moved to another port may be a short-lived one (`magpie
// plugin update`): it waits before taking the tunnel's lock, so the page
// host usually gets there first.
export function startupDelay(optionsPort, configuredPort) {
  return Number(optionsPort) === Number(configuredPort) ? 0 : 30000;
}
