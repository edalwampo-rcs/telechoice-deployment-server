import { spawn } from "node:child_process";

import { getDeploymentTarget } from "./deployments.js";

const DOCKER_BIN = process.env.DOCKER_BIN || "/opt/homebrew/bin/docker";
const AWS_REGION = process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const AWS_PROFILE = process.env.AWS_PROFILE;
const AWS_BIN = process.env.AWS_BIN || "aws";

function runCommand(command, args = [], onOutput = () => {}, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },

      stdio: [input !== null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    let buffer = "";

    const processOutput = (data) => {
      const output = data.toString();

      buffer += output;

      // Docker uses carriage returns for progress updates.
      const parts = buffer.split(/\r\n|\n|\r/);

      // Keep incomplete output for the next chunk.
      buffer = parts.pop() || "";

      for (const part of parts) {
        const message = part.trim();

        if (message) {
          onOutput(message);
        }
      }
    };

    child.stdout.on("data", (data) => {
      const output = data.toString();

      stdout += output;

      processOutput(data);
    });

    child.stderr.on("data", (data) => {
      const output = data.toString();

      stderr += output;

      processOutput(data);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      // Flush remaining buffered output.
      if (buffer.trim()) {
        onOutput(buffer.trim());
      }

      if (code === 0) {
        resolve(stdout);

        return;
      }

      reject(
        new Error(
          [
            `${command} ${args.join(" ")}`,
            `exited with code ${code}`,
            stderr.trim(),
          ]
            .filter(Boolean)
            .join(": "),
        ),
      );
    });

    if (input !== null) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function docker(args, onOutput = () => {}) {
  return runCommand(DOCKER_BIN, args, onOutput);
}

async function aws(args, onOutput = () => {}) {
  return runCommand(AWS_BIN, args, onOutput);
}

// ============================================================
// Container helpers
// ============================================================

async function containerExists(container) {
  try {
    await docker(["container", "inspect", container]);

    return true;
  } catch {
    return false;
  }
}

async function containerRunning(container) {
  try {
    const output = await docker([
      "inspect",
      "-f",
      "{{.State.Running}}",
      container,
    ]);

    return output.trim() === "true";
  } catch {
    return false;
  }
}

// ============================================================
// Network
// ============================================================

async function ensureNetwork(network, log) {
  try {
    await docker(["network", "inspect", network]);

    log(`[ OK ] Docker network exists: ${network}`);
  } catch {
    log(`[....] Creating Docker network: ${network}`);

    await docker(["network", "create", network]);

    log(`[ OK ] Docker network created`);
  }
}

// ============================================================
// Volumes
// ============================================================

async function ensureVolumes(storage, log) {
  for (const volumeMapping of storage) {
    const volume = volumeMapping.split(":")[0];

    try {
      await docker(["volume", "inspect", volume]);

      log(`[ OK ] Volume exists: ${volume}`);
    } catch {
      log(`[....] Creating volume: ${volume}`);

      await docker(["volume", "create", volume]);

      log(`[ OK ] Volume created: ${volume}`);
    }
  }
}

// ============================================================
// Image
// ============================================================

async function pullImage(image, log) {
  log(`[....] Pulling image: ${image}`);

  await docker(["pull", image], log);

  log(`[ OK ] Image pulled`);
}

// ============================================================
// Container deployment
// ============================================================

async function stopAndRemoveContainer(container, log) {
  if (!(await containerExists(container))) {
    return;
  }

  if (await containerRunning(container)) {
    log(`[STOP] Stopping ${container}`);

    await docker(["stop", container]);

    log(`[ OK ] Container stopped`);
  }

  log(`[ RM ] Removing ${container}`);

  await docker(["rm", container]);

  log(`[ OK ] Container removed`);
}

async function startContainer(target, log) {
  const args = [
    "run",
    "-d",

    "--name",
    target.container,

    "--network",
    target.network,

    "--restart",
    "unless-stopped",
  ];

  // ----------------------------------------------------------
  // Volumes
  // ----------------------------------------------------------

  for (const volume of target.storage) {
    args.push("-v", volume);
  }

  // ----------------------------------------------------------
  // Environment variables
  // ----------------------------------------------------------

  for (const [name, value] of Object.entries(target.environmentVariables)) {
    args.push("-e", `${name}=${value}`);
  }

  // ----------------------------------------------------------
  // Image
  // ----------------------------------------------------------

  args.push(target.image);

  log(`[ RUN ] Starting ${target.container}`);

  await docker(args, log);

  if (!(await containerRunning(target.container))) {
    throw new Error(`Container failed to start: ${target.container}`);
  }

  log(`[ OK ] Container started`);
}

// ============================================================
// Optimize Clear
// ============================================================

async function optimize(target, log) {
  log(`[....] Running optimization`);

  try {
    await docker(
      ["exec", target.container, "php", "artisan", "config:clear"],
      log,
    );

    await docker(
      ["exec", target.container, "php", "artisan", "optimize:clear"],
      log,
    );
  } catch (error) {
    log(`[ WARN ] ${String(error)}`);
  }

  log(`[ OK ] Cleared cached bootstrap files`);
}

// ============================================================
// Migration
// ============================================================

async function migrate(target, log) {
  log(`[....] Running database migration`);

  await docker(
    ["exec", target.container, "php", "artisan", "config:clear"],
    log,
  );

  await docker(
    ["exec", target.container, "php", "artisan", "migrate", "--force"],
    log,
  );

  log(`[ OK ] Database migrated`);
}

// ============================================================
// Deploy
// ============================================================

export async function deploy(
  {
    project,
    environment,
    service,
    force = false,
    migrate: shouldMigrate = false,
    optimize: shouldOptimize = false,
  },
  log = console.log,
) {
  const target = getDeploymentTarget(project, environment, service);

  log("");
  log("============================================================");
  log(" Deployment");
  log("============================================================");
  log(`Project     : ${target.project}`);
  log(`Environment : ${target.environment}`);
  log(`Service     : ${target.service}`);
  log(`Container   : ${target.container}`);
  log(`Image       : ${target.image}`);
  log(`Network     : ${target.network}`);
  log(`Docker      : ${DOCKER_BIN}`);
  log("");

  // ==========================================================
  // Docker
  // ==========================================================

  try {
    log(`[....] Checking Docker executable`);

    await docker(["--version"], log);

    log(`[....] Checking Docker daemon`);

    await docker(["info"], log);

    log(`[ OK ] Docker is available`);
  } catch (error) {
    log(`[ ERR ] Docker check failed`);

    log(`[ ERR ] ${error.message}`);

    throw new Error(`Docker is not available: ${error.message}`);
  }

  // ==========================================================
  // Network
  // ==========================================================
  await ensureNetwork(target.network, log);

  // ==========================================================
  // Volumes
  // ==========================================================
  await ensureVolumes(target.storage, log);

  // ==========================================================
  // ECR
  // ==========================================================
  await loginToEcr(log);

  // ==========================================================
  // Pull image
  // ==========================================================
  await pullImage(target.image, log);

  // ==========================================================
  // Deployment
  // ==========================================================

  const exists = await containerExists(target.container);

  if (!exists) {
    log(`[NEW ] Container does not exist`);
  }

  if (force || !exists) {
    await stopAndRemoveContainer(target.container, log);

    await startContainer(target, log);
  } else {
    log(`[ OK ] Container already exists`);

    log(`[....] Use force=true to redeploy`);
  }

  // ==========================================================
  // Migration
  // ==========================================================

  if (shouldMigrate) {
    await migrate(target, log);
  }

  // ==========================================================
  // Optimization
  // ==========================================================

  if (shouldOptimize) {
    await optimize(target, log);
  }

  log("");

  log("============================================================");

  log("[ OK ] Deployment completed");

  log("============================================================");

  return {
    success: true,
    target,
  };
}

// ============================================================
// Image inspection
// ============================================================

async function getImageId(image) {
  try {
    const output = await docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);

    return output.trim() || null;
  } catch {
    return null;
  }
}

async function getContainerImageId(container) {
  try {
    const output = await docker([
      "container",
      "inspect",
      "--format",
      "{{.Image}}",
      container,
    ]);

    return output.trim() || null;
  } catch {
    return null;
  }
}

// ============================================================
// Check image update
// ============================================================

export async function checkImageUpdate(
  { project, environment, service },
  log = console.log,
) {
  const target = getDeploymentTarget(project, environment, service);

  log("");
  log("============================================================");
  log(" Image Check");
  log("============================================================");

  log(`Project     : ${target.project}`);
  log(`Environment : ${target.environment}`);
  log(`Service     : ${target.service}`);
  log(`Container   : ${target.container}`);
  log(`Image       : ${target.image}`);

  // ----------------------------------------------------------
  // Docker
  // ----------------------------------------------------------

  try {
    await docker(["info"]);
  } catch (error) {
    throw new Error(`Docker is not available: ${error.message}`);
  }

  // ----------------------------------------------------------
  // ECR
  // ----------------------------------------------------------

  const latestDigest = await getEcrImageDigest(target.image, log);

  // ----------------------------------------------------------
  // Container
  // ----------------------------------------------------------

  const exists = await containerExists(target.container);

  if (!exists) {
    log(`[NEW ] Container does not exist`);

    return {
      success: true,

      updateAvailable: true,

      reason: "container_missing",

      containerExists: false,

      project: target.project,

      environment: target.environment,

      service: target.service,

      container: target.container,

      image: target.image,

      currentDigest: null,

      latestDigest,
    };
  }

  // ----------------------------------------------------------
  // Current container digest
  // ----------------------------------------------------------

  const currentDigest = await getImageDigest(target.image);

  log(`[....] Current digest: ${currentDigest || "unknown"}`);

  log(`[....] Latest digest : ${latestDigest}`);

  // ----------------------------------------------------------
  // Compare
  // ----------------------------------------------------------

  const updateAvailable = !currentDigest || currentDigest !== latestDigest;

  if (updateAvailable) {
    log(`[NEW ] New image detected`);
  } else {
    log(`[ OK ] Image is up to date`);
  }

  return {
    success: true,

    updateAvailable,

    reason: updateAvailable ? "digest_changed" : "up_to_date",

    containerExists: true,

    project: target.project,

    environment: target.environment,

    service: target.service,

    container: target.container,

    image: target.image,

    currentDigest,

    latestDigest,
  };
}

async function loginToEcr(log) {
  const registry = `${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com`;

  log(`[....] Authenticating with ECR`);

  const args = ["ecr", "get-login-password", "--region", AWS_REGION];

  if (AWS_PROFILE) {
    args.push("--profile", AWS_PROFILE);
  }

  let password;

  try {
    password = (await aws(args)).trim();
  } catch (error) {
    throw new Error(`AWS ECR authentication failed: ${error.message}`);
  }

  if (!password) {
    throw new Error("AWS ECR authentication returned an empty password");
  }

  try {
    await runCommand(
      DOCKER_BIN,
      ["login", "--username", "AWS", "--password-stdin", registry],
      () => {},
      `${password}\n`,
    );
  } catch (error) {
    throw new Error(`Docker ECR login failed: ${error.message}`);
  }

  log(`[ OK ] ECR authentication successful`);
}

// ============================================================
// ECR Image Digest
// ============================================================

async function getEcrImageDigest(image, log) {
  const repository = image
    .replace(`${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/`, "")
    .replace(/:.+$/, "");

  log(`[....] Checking ECR image: ${repository}:latest`);

  const args = [
    "ecr",
    "describe-images",

    "--repository-name",
    repository,

    "--image-ids",
    "imageTag=latest",

    "--region",
    AWS_REGION,

    "--query",
    "imageDetails[0].imageDigest",

    "--output",
    "text",
  ];

  if (AWS_PROFILE) {
    args.push("--profile", AWS_PROFILE);
  }

  const output = await aws(args);

  const digest = output.trim();

  if (!digest || digest === "None") {
    throw new Error(`Unable to find latest image digest in ECR: ${repository}`);
  }

  log(`[ OK ] ECR digest: ${digest}`);

  return digest;
}

async function getContainerImageDigest(container) {
  try {
    const output = await docker([
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      container,
    ]);

    const repoDigest = output.trim();

    if (!repoDigest) {
      return null;
    }

    const atIndex = repoDigest.lastIndexOf("@");

    if (atIndex === -1) {
      return null;
    }

    return repoDigest.substring(atIndex + 1);
  } catch {
    return null;
  }
}

async function getImageDigest(image) {
  try {
    const output = await docker([
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      image,
    ]);

    const repoDigest = output.trim();

    if (!repoDigest) {
      return null;
    }

    const atIndex = repoDigest.lastIndexOf("@");

    if (atIndex === -1) {
      return null;
    }

    return repoDigest.substring(atIndex + 1);
  } catch {
    return null;
  }
}
