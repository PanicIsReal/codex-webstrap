import { spawn } from "bun-pty";

function toErrorMessage(error) {
  if (!error) {
    return "unknown_error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function send(payload) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Ignore JSON serialization/output failures.
  }
}

function parseConfig(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toDimension(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

const config = parseConfig(process.env.CODEX_WEBSTRAP_BUN_PTY_CONFIG || "");
if (!config || typeof config.file !== "string" || config.file.length === 0) {
  send({ type: "error", message: "Invalid bun-pty config." });
  process.exit(2);
}

let terminal;
try {
  terminal = spawn(
    config.file,
    Array.isArray(config.args) ? config.args.filter((entry) => typeof entry === "string") : [],
    {
      name: typeof config.term === "string" && config.term.length > 0 ? config.term : "xterm-256color",
      cols: toDimension(config.cols, 120),
      rows: toDimension(config.rows, 30),
      cwd: typeof config.cwd === "string" && config.cwd.length > 0 ? config.cwd : process.cwd(),
      env: config.env && typeof config.env === "object" ? config.env : process.env
    }
  );
} catch (error) {
  send({
    type: "error",
    message: `Failed to start bun-pty terminal: ${toErrorMessage(error)}`
  });
  process.exit(1);
}

let exiting = false;
const requestExit = (code = 0) => {
  if (exiting) {
    return;
  }
  exiting = true;
  process.exit(code);
};

terminal.onData((data) => {
  send({
    type: "data",
    data
  });
});

terminal.onExit((exit) => {
  send({
    type: "exit",
    exitCode: typeof exit?.exitCode === "number" ? exit.exitCode : null,
    signal: exit?.signal ?? null
  });
  requestExit(0);
});

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;

  for (;;) {
    const newlineAt = inputBuffer.indexOf("\n");
    if (newlineAt < 0) {
      break;
    }

    const line = inputBuffer.slice(0, newlineAt);
    inputBuffer = inputBuffer.slice(newlineAt + 1);

    if (line.trim().length === 0) {
      continue;
    }

    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }

    try {
      if (command?.type === "write") {
        terminal.write(typeof command.data === "string" ? command.data : "");
        continue;
      }

      if (command?.type === "resize") {
        terminal.resize(toDimension(command.cols, 120), toDimension(command.rows, 30));
        continue;
      }

      if (command?.type === "close") {
        terminal.kill("SIGTERM");
        requestExit(0);
      }
    } catch (error) {
      send({
        type: "error",
        message: toErrorMessage(error)
      });
    }
  }
});

process.on("SIGTERM", () => {
  try {
    terminal.kill("SIGTERM");
  } catch {
    // Ignore.
  }
  requestExit(0);
});

process.on("SIGINT", () => {
  try {
    terminal.kill("SIGTERM");
  } catch {
    // Ignore.
  }
  requestExit(0);
});
