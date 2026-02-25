import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultTokenFilePath, normalizeAuthMode } from "./auth.mjs";
import { safeJsonParse } from "./util.mjs";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_VALUES = new Set(["0", "false", "no", "off"]);
const PROFILE_STRATEGIES = new Set(["fixed", "round-robin", "random"]);
const LAUNCH_MODES = new Set(["auto", "never"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toCleanString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSY_VALUES.has(normalized)) {
    return false;
  }
  return fallback;
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function expandHome(input) {
  const value = toCleanString(input);
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolvePath(input) {
  const value = expandHome(input);
  return value ? path.resolve(value) : "";
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUTHY_VALUES.has(lowered)) {
      return true;
    }
    if (FALSY_VALUES.has(lowered)) {
      return false;
    }
  }
  return null;
}

export function defaultConfigDir() {
  return path.join(os.homedir(), ".codex-relay");
}

export function defaultConfigFilePath() {
  return path.join(defaultConfigDir(), "config.json");
}

export function defaultProfileStateFilePath() {
  return path.join(defaultConfigDir(), "profile-state.json");
}

export function normalizeProfileStrategy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (PROFILE_STRATEGIES.has(normalized)) {
    return normalized;
  }
  return "fixed";
}

export function normalizeLaunchMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (LAUNCH_MODES.has(normalized)) {
    return normalized;
  }
  return "never";
}

function pickEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return value;
    }
  }
  return undefined;
}

function readConfigPathFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "--config-file") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        return next;
      }
    }
  }
  return null;
}

function buildDefaults() {
  return {
    configFile: defaultConfigFilePath(),
    bind: "127.0.0.1",
    port: 8080,
    tokenFile: defaultTokenFilePath(),
    codexAppPath: "/Applications/Codex.app",
    internalWsPort: 38080,
    autoOpen: false,
    authMode: "off",
    authUsername: "codex",
    authPassword: "",
    authPasswordFile: "",
    launchCodex: "never",
    profileSwitching: false,
    profileStrategy: "fixed",
    profileFixed: "",
    profilesDir: path.join(os.homedir(), ".codex", "profiles"),
    hostAuthFile: path.join(os.homedir(), ".codex", "auth.json"),
    profileStateFile: defaultProfileStateFilePath(),
    globalStatePath: path.join(os.homedir(), ".codex", ".codex-global-state.json")
  };
}

function applyFileConfig(config, rawInput) {
  const root = isPlainObject(rawInput) ? rawInput : {};
  const server = isPlainObject(root.server) ? root.server : {};
  const auth = isPlainObject(root.auth) ? root.auth : {};
  const codex = isPlainObject(root.codex) ? root.codex : {};
  const profiles = isPlainObject(root.profiles) ? root.profiles : {};
  const relay = isPlainObject(root.relay) ? root.relay : {};

  const bind = firstDefined(root.bind, server.bind, relay.bind);
  const port = firstDefined(root.port, server.port, relay.port);
  const tokenFile = firstDefined(root.tokenFile, server.tokenFile, auth.tokenFile, relay.tokenFile);
  const codexAppPath = firstDefined(root.codexAppPath, codex.appPath, relay.codexAppPath);
  const internalWsPort = firstDefined(root.internalWsPort, server.internalWsPort, relay.internalWsPort);
  const autoOpen = firstDefined(root.autoOpen, server.autoOpen, relay.autoOpen);
  const authMode = firstDefined(root.authMode, auth.mode, relay.authMode);
  const authUsername = firstDefined(root.authUsername, auth.username, relay.authUsername);
  const authPassword = firstDefined(root.authPassword, auth.password, relay.authPassword);
  const authPasswordFile = firstDefined(
    root.authPasswordFile,
    auth.passwordFile,
    relay.authPasswordFile
  );
  const launchCodex = firstDefined(root.launchCodex, codex.launch, relay.launchCodex);
  const profileSwitching = firstDefined(
    root.profileSwitching,
    profiles.enabled,
    relay.profileSwitching
  );
  const profileStrategy = firstDefined(root.profileStrategy, profiles.strategy, relay.profileStrategy);
  const profileFixed = firstDefined(root.profileFixed, profiles.fixed, relay.profileFixed);
  const profilesDir = firstDefined(root.profilesDir, profiles.dir, relay.profilesDir);
  const hostAuthFile = firstDefined(root.hostAuthFile, profiles.hostAuthFile, relay.hostAuthFile);
  const profileStateFile = firstDefined(root.profileStateFile, profiles.stateFile, relay.profileStateFile);
  const globalStatePath = firstDefined(root.globalStatePath, profiles.globalStatePath, relay.globalStatePath);

  if (typeof bind === "string") {
    config.bind = bind;
  }
  if (port != null) {
    const numericPort = asNumber(port);
    if (numericPort != null) {
      config.port = numericPort;
    }
  }
  if (typeof tokenFile === "string") {
    config.tokenFile = tokenFile;
  }
  if (typeof codexAppPath === "string") {
    config.codexAppPath = codexAppPath;
  }
  if (internalWsPort != null) {
    const numericInternalWsPort = asNumber(internalWsPort);
    if (numericInternalWsPort != null) {
      config.internalWsPort = numericInternalWsPort;
    }
  }
  if (autoOpen != null) {
    const parsed = asBoolean(autoOpen);
    if (parsed != null) {
      config.autoOpen = parsed;
    }
  }
  if (typeof authMode === "string") {
    config.authMode = authMode;
  }
  if (typeof authUsername === "string") {
    config.authUsername = authUsername;
  }
  if (typeof authPassword === "string") {
    config.authPassword = authPassword;
  }
  if (typeof authPasswordFile === "string") {
    config.authPasswordFile = authPasswordFile;
  }
  if (typeof launchCodex === "string") {
    config.launchCodex = launchCodex;
  }
  if (profileSwitching != null) {
    const parsed = asBoolean(profileSwitching);
    if (parsed != null) {
      config.profileSwitching = parsed;
    }
  }
  if (typeof profileStrategy === "string") {
    config.profileStrategy = profileStrategy;
  }
  if (typeof profileFixed === "string") {
    config.profileFixed = profileFixed;
  }
  if (typeof profilesDir === "string") {
    config.profilesDir = profilesDir;
  }
  if (typeof hostAuthFile === "string") {
    config.hostAuthFile = hostAuthFile;
  }
  if (typeof profileStateFile === "string") {
    config.profileStateFile = profileStateFile;
  }
  if (typeof globalStatePath === "string") {
    config.globalStatePath = globalStatePath;
  }
}

function applyEnvConfig(config, env) {
  const bind = pickEnv(env, ["CODEX_RELAY_BIND", "CODEX_WEBSTRAP_BIND"]);
  const port = pickEnv(env, ["CODEX_RELAY_PORT", "CODEX_WEBSTRAP_PORT"]);
  const tokenFile = pickEnv(env, ["CODEX_RELAY_TOKEN_FILE", "CODEX_WEBSTRAP_TOKEN_FILE"]);
  const codexAppPath = pickEnv(env, ["CODEX_RELAY_CODEX_APP", "CODEX_WEBSTRAP_CODEX_APP"]);
  const internalWsPort = pickEnv(env, ["CODEX_RELAY_INTERNAL_WS_PORT", "CODEX_WEBSTRAP_INTERNAL_WS_PORT"]);
  const autoOpen = pickEnv(env, ["CODEX_RELAY_OPEN", "CODEX_WEBSTRAP_OPEN"]);
  const authMode = pickEnv(env, ["CODEX_RELAY_AUTH_MODE", "CODEX_WEBSTRAP_AUTH_MODE"]);
  const authUsername = pickEnv(env, ["CODEX_RELAY_AUTH_USERNAME"]);
  const authPassword = pickEnv(env, ["CODEX_RELAY_AUTH_PASSWORD"]);
  const authPasswordFile = pickEnv(env, ["CODEX_RELAY_AUTH_PASSWORD_FILE"]);
  const launchCodex = pickEnv(env, ["CODEX_RELAY_LAUNCH_CODEX"]);
  const profileSwitching = pickEnv(env, ["CODEX_RELAY_PROFILE_SWITCHING"]);
  const profileStrategy = pickEnv(env, ["CODEX_RELAY_PROFILE_STRATEGY"]);
  const profileFixed = pickEnv(env, ["CODEX_RELAY_PROFILE_FIXED"]);
  const profilesDir = pickEnv(env, ["CODEX_RELAY_PROFILES_DIR"]);
  const hostAuthFile = pickEnv(env, ["CODEX_RELAY_HOST_AUTH_FILE"]);
  const profileStateFile = pickEnv(env, ["CODEX_RELAY_PROFILE_STATE_FILE"]);
  const globalStatePath = pickEnv(env, ["CODEX_RELAY_GLOBAL_STATE_FILE"]);

  if (bind != null) {
    config.bind = String(bind);
  }
  if (port != null) {
    config.port = Number(port);
  }
  if (tokenFile != null) {
    config.tokenFile = String(tokenFile);
  }
  if (codexAppPath != null) {
    config.codexAppPath = String(codexAppPath);
  }
  if (internalWsPort != null) {
    config.internalWsPort = Number(internalWsPort);
  }
  if (autoOpen != null) {
    config.autoOpen = parseBoolean(autoOpen, config.autoOpen);
  }
  if (authMode != null) {
    config.authMode = String(authMode);
  }
  if (authUsername != null) {
    config.authUsername = String(authUsername);
  }
  if (authPassword != null) {
    config.authPassword = String(authPassword);
  }
  if (authPasswordFile != null) {
    config.authPasswordFile = String(authPasswordFile);
  }
  if (launchCodex != null) {
    config.launchCodex = String(launchCodex);
  }
  if (profileSwitching != null) {
    config.profileSwitching = parseBoolean(profileSwitching, config.profileSwitching);
  }
  if (profileStrategy != null) {
    config.profileStrategy = String(profileStrategy);
  }
  if (profileFixed != null) {
    config.profileFixed = String(profileFixed);
  }
  if (profilesDir != null) {
    config.profilesDir = String(profilesDir);
  }
  if (hostAuthFile != null) {
    config.hostAuthFile = String(hostAuthFile);
  }
  if (profileStateFile != null) {
    config.profileStateFile = String(profileStateFile);
  }
  if (globalStatePath != null) {
    config.globalStatePath = String(globalStatePath);
  }
}

function applyArgvConfig(config, argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        config.port = Number(argv[++i]);
        break;
      case "--bind":
        config.bind = argv[++i];
        break;
      case "--token-file":
        config.tokenFile = argv[++i];
        break;
      case "--codex-app":
        config.codexAppPath = argv[++i];
        break;
      case "--internal-ws-port":
        config.internalWsPort = Number(argv[++i]);
        break;
      case "--open":
        config.autoOpen = true;
        break;
      case "--auth-mode":
        config.authMode = argv[++i];
        break;
      case "--auth-username":
        config.authUsername = argv[++i];
        break;
      case "--auth-password":
        config.authPassword = argv[++i];
        break;
      case "--auth-password-file":
        config.authPasswordFile = argv[++i];
        break;
      case "--launch-codex":
        config.launchCodex = argv[++i];
        break;
      case "--profile-switching":
        config.profileSwitching = true;
        break;
      case "--no-profile-switching":
        config.profileSwitching = false;
        break;
      case "--profile-strategy":
        config.profileStrategy = argv[++i];
        break;
      case "--profile-fixed":
        config.profileFixed = argv[++i];
        break;
      case "--profiles-dir":
        config.profilesDir = argv[++i];
        break;
      case "--host-auth-file":
        config.hostAuthFile = argv[++i];
        break;
      case "--profile-state-file":
        config.profileStateFile = argv[++i];
        break;
      case "--global-state-file":
        config.globalStatePath = argv[++i];
        break;
      default:
        break;
    }
  }
}

function normalizeConfig(config) {
  config.bind = toCleanString(config.bind) || "127.0.0.1";
  config.port = parsePort(config.port, 8080);
  config.internalWsPort = parsePort(config.internalWsPort, 38080);
  config.autoOpen = parseBoolean(config.autoOpen, false);
  config.authMode = normalizeAuthMode(config.authMode);
  config.authUsername = toCleanString(config.authUsername) || "codex";
  config.authPassword = typeof config.authPassword === "string" ? config.authPassword : "";
  config.authPasswordFile = resolvePath(config.authPasswordFile);
  config.launchCodex = normalizeLaunchMode(config.launchCodex);
  config.profileSwitching = parseBoolean(config.profileSwitching, false);
  config.profileStrategy = normalizeProfileStrategy(config.profileStrategy);
  config.profileFixed = typeof config.profileFixed === "string" ? config.profileFixed.trim() : "";
  config.configFile = resolvePath(config.configFile || defaultConfigFilePath());
  config.tokenFile = resolvePath(config.tokenFile || defaultTokenFilePath());
  config.codexAppPath = resolvePath(config.codexAppPath || "/Applications/Codex.app");
  config.profilesDir = resolvePath(config.profilesDir || path.join(os.homedir(), ".codex", "profiles"));
  config.hostAuthFile = resolvePath(config.hostAuthFile || path.join(os.homedir(), ".codex", "auth.json"));
  config.profileStateFile = resolvePath(config.profileStateFile || defaultProfileStateFilePath());
  config.globalStatePath = resolvePath(
    config.globalStatePath || path.join(os.homedir(), ".codex", ".codex-global-state.json")
  );
}

async function readConfigFile(configFilePath) {
  const resolvedPath = resolvePath(configFilePath || defaultConfigFilePath());
  let raw = "";
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") {
      return { path: resolvedPath, data: {}, warnings: [] };
    }
    return {
      path: resolvedPath,
      data: {},
      warnings: [`Failed to read config file ${resolvedPath}: ${error?.message || String(error)}`]
    };
  }

  const parsed = safeJsonParse(raw);
  if (!isPlainObject(parsed)) {
    return {
      path: resolvedPath,
      data: {},
      warnings: [`Ignored invalid config JSON object in ${resolvedPath}.`]
    };
  }

  return {
    path: resolvedPath,
    data: parsed,
    warnings: []
  };
}

export async function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const defaults = buildDefaults();
  const envConfigPath = pickEnv(env, ["CODEX_RELAY_CONFIG", "CODEX_RELAY_CONFIG_FILE"]);
  const argvConfigPath = readConfigPathFromArgv(argv);
  const configPath = resolvePath(firstDefined(argvConfigPath, envConfigPath, defaults.configFile));
  const fileResult = await readConfigFile(configPath);

  const config = {
    ...defaults,
    configFile: configPath
  };
  applyFileConfig(config, fileResult.data);
  applyEnvConfig(config, env);
  applyArgvConfig(config, argv);
  normalizeConfig(config);

  return {
    config,
    warnings: fileResult.warnings
  };
}
