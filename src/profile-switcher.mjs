import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createLogger, safeJsonParse, toErrorMessage } from "./util.mjs";

const PROFILE_STRATEGIES = new Set(["fixed", "round-robin", "random"]);
const RESERVED_PROFILE_FILES = new Set(["profiles.json", "update.json", "profiles.lock"]);

export function normalizeProfileStrategy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (PROFILE_STRATEGIES.has(normalized)) {
    return normalized;
  }
  return "fixed";
}

function isProfileFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0) {
    return false;
  }
  if (!fileName.endsWith(".json")) {
    return false;
  }
  return !RESERVED_PROFILE_FILES.has(fileName);
}

function profileIdFromFileName(fileName) {
  if (!isProfileFileName(fileName)) {
    return "";
  }
  return fileName.slice(0, -".json".length);
}

function labelFromIndexEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const label = entry.label;
  if (typeof label !== "string") {
    return null;
  }
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProfileSelector(selector, profiles) {
  const normalizedSelector = typeof selector === "string" ? selector.trim() : "";
  if (!normalizedSelector) {
    return null;
  }

  const byId = profiles.find((profile) => profile.id === normalizedSelector);
  if (byId) {
    return byId;
  }

  const lowered = normalizedSelector.toLowerCase();
  const byLabel = profiles.find((profile) => profile.label && profile.label.toLowerCase() === lowered);
  return byLabel || null;
}

async function atomicCopyFile(sourcePath, targetPath) {
  const body = await fs.readFile(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, body, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
}

export class ProfileSwitcher {
  constructor({
    enabled = false,
    strategy = "fixed",
    fixedProfile = "",
    profilesDir,
    hostAuthFile,
    stateFile,
    logger
  } = {}) {
    this.enabled = Boolean(enabled);
    this.strategy = normalizeProfileStrategy(strategy);
    this.fixedProfile = typeof fixedProfile === "string" ? fixedProfile.trim() : "";
    this.profilesDir = profilesDir;
    this.hostAuthFile = hostAuthFile;
    this.stateFile = stateFile;
    this.logger = logger || createLogger("profile-switcher");
  }

  async listProfiles() {
    if (!this.profilesDir) {
      return [];
    }

    let labelsById = new Map();
    const indexPath = path.join(this.profilesDir, "profiles.json");
    try {
      const indexBody = await fs.readFile(indexPath, "utf8");
      const index = safeJsonParse(indexBody);
      if (index && typeof index === "object" && index.profiles && typeof index.profiles === "object") {
        labelsById = new Map(
          Object.entries(index.profiles)
            .map(([id, entry]) => [id, labelFromIndexEntry(entry)])
            .filter(([, label]) => typeof label === "string" && label.length > 0)
        );
      }
    } catch {
      // profiles.json is optional.
    }

    let entries = [];
    try {
      entries = await fs.readdir(this.profilesDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const profiles = entries
      .filter((entry) => entry.isFile() && isProfileFileName(entry.name))
      .map((entry) => {
        const id = profileIdFromFileName(entry.name);
        return {
          id,
          label: labelsById.get(id) || null,
          fileName: entry.name,
          filePath: path.join(this.profilesDir, entry.name)
        };
      })
      .filter((profile) => profile.id.length > 0)
      .sort((left, right) => {
        const leftKey = (left.label || left.id).toLowerCase();
        const rightKey = (right.label || right.id).toLowerCase();
        return leftKey.localeCompare(rightKey, undefined, { sensitivity: "base", numeric: true });
      });

    return profiles;
  }

  async _readState() {
    if (!this.stateFile) {
      return {
        roundRobinCursor: 0,
        lastProfileId: null
      };
    }

    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { roundRobinCursor: 0, lastProfileId: null };
      }
      const roundRobinCursor = Number.isInteger(parsed.roundRobinCursor) ? parsed.roundRobinCursor : 0;
      const lastProfileId = typeof parsed.lastProfileId === "string" ? parsed.lastProfileId : null;
      return { roundRobinCursor, lastProfileId };
    } catch {
      return { roundRobinCursor: 0, lastProfileId: null };
    }
  }

  async _writeState(nextState) {
    if (!this.stateFile) {
      return;
    }

    const payload = {
      roundRobinCursor: Number.isInteger(nextState.roundRobinCursor) ? nextState.roundRobinCursor : 0,
      lastProfileId: typeof nextState.lastProfileId === "string" ? nextState.lastProfileId : null,
      updatedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.stateFile, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }

  _chooseProfile(profiles, state) {
    if (profiles.length === 0) {
      return { profile: null, nextCursor: 0 };
    }

    if (this.strategy === "fixed") {
      const selected = this.fixedProfile ? resolveProfileSelector(this.fixedProfile, profiles) : profiles[0];
      return { profile: selected || profiles[0], nextCursor: state.roundRobinCursor || 0 };
    }

    if (this.strategy === "random") {
      const index = crypto.randomInt(0, profiles.length);
      return {
        profile: profiles[index],
        nextCursor: state.roundRobinCursor || 0
      };
    }

    const current = Number.isInteger(state.roundRobinCursor) ? state.roundRobinCursor : 0;
    const index = ((current % profiles.length) + profiles.length) % profiles.length;
    return {
      profile: profiles[index],
      nextCursor: (index + 1) % profiles.length
    };
  }

  async describe({ codexRunning = false } = {}) {
    const profiles = await this.listProfiles();
    const state = await this._readState();
    return {
      enabled: this.enabled,
      strategy: this.strategy,
      fixedProfile: this.fixedProfile || null,
      codexRunning,
      blocked: codexRunning,
      hostAuthFile: this.hostAuthFile || null,
      stateFile: this.stateFile || null,
      profileCount: profiles.length,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label
      })),
      lastProfileId: state.lastProfileId
    };
  }

  async apply({ codexRunning = false, requestedProfile = "" } = {}) {
    if (!this.enabled) {
      return { status: "disabled" };
    }

    if (codexRunning) {
      return {
        status: "blocked",
        reason: "codex_running"
      };
    }

    if (!this.hostAuthFile) {
      return {
        status: "failed",
        reason: "missing_host_auth_file"
      };
    }

    try {
      const profiles = await this.listProfiles();
      if (profiles.length === 0) {
        return {
          status: "no_profiles",
          reason: "profiles_dir_empty"
        };
      }

      const state = await this._readState();
      let selectedProfile = resolveProfileSelector(requestedProfile, profiles);
      let nextCursor = state.roundRobinCursor || 0;

      if (!selectedProfile) {
        const selection = this._chooseProfile(profiles, state);
        selectedProfile = selection.profile;
        nextCursor = selection.nextCursor;
      }

      if (!selectedProfile) {
        return {
          status: "failed",
          reason: "profile_selection_failed"
        };
      }

      await atomicCopyFile(selectedProfile.filePath, this.hostAuthFile);
      await this._writeState({
        roundRobinCursor: nextCursor,
        lastProfileId: selectedProfile.id
      });

      this.logger.info("Switched Codex auth profile", {
        strategy: this.strategy,
        profileId: selectedProfile.id,
        profileLabel: selectedProfile.label || null,
        hostAuthFile: this.hostAuthFile
      });

      return {
        status: "switched",
        profile: {
          id: selectedProfile.id,
          label: selectedProfile.label
        }
      };
    } catch (error) {
      this.logger.warn("Failed to switch Codex auth profile", {
        error: toErrorMessage(error)
      });
      return {
        status: "failed",
        reason: toErrorMessage(error)
      };
    }
  }
}
