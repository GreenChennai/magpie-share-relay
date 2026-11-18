import os from "node:os";
import { join } from "node:path";

// configPaths follows magpie's own rule: XDG_CONFIG_HOME/magpie when set,
// else ~/.config/magpie. The plugin's files live in share-relay under it.
export function configPaths(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : join(os.homedir(), ".config");
  const configDir = join(base, "magpie");
  const dataDir = join(configDir, "share-relay");
  return {
    configDir,
    dataDir,
    configPath: join(dataDir, "config.json"),
    backupPath: join(dataDir, "config.json.bak"),
    keyPath: join(dataDir, "id_ed25519"),
    pubKeyPath: join(dataDir, "id_ed25519.pub"),
    knownHostsPath: join(dataDir, "known_hosts"),
    lockPath: join(dataDir, "relay.lock"),
    logPath: join(dataDir, "relay.log.jsonl"),
  };
}
