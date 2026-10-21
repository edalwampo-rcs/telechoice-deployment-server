import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import { deploy } from "./deployer.js";

const deployments = new Map();

const emitter = new EventEmitter();

export function createDeployment(options) {
  const id = crypto.randomUUID();

  const deployment = {
    id,
    ...options,
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    error: null,
  };

  deployments.set(id, deployment);

  runDeployment(deployment);

  return deployment;
}

async function runDeployment(deployment) {
  updateDeployment(deployment, "deployment.started", {
    status: "running",
    message: "Deployment started",
  });

  try {
    await deploy(deployment, (message) => {
      addLog(deployment, message);
    });

    updateDeployment(deployment, "deployment.completed", {
      status: "completed",
      message: "Deployment completed successfully",
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    updateDeployment(deployment, "deployment.failed", {
      status: "failed",
      message: error.message,
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
  }
}

function addLog(deployment, message) {
  const log = {
    timestamp: new Date().toISOString(),
    message,
  };

  deployment.logs.push(log);

  // Don't allow memory to grow forever.
  if (deployment.logs.length > 5000) {
    deployment.logs.shift();
  }

  emitter.emit("deployment", deployment.id, {
    type: "deployment.log",
    deploymentId: deployment.id,
    ...log,
  });
}

function updateDeployment(deployment, type, changes) {
  Object.assign(deployment, changes);

  emitter.emit("deployment", deployment.id, {
    type,
    deploymentId: deployment.id,
    deployment: {
      id: deployment.id,
      project: deployment.project,
      environment: deployment.environment,
      service: deployment.service,
      status: deployment.status,
      startedAt: deployment.startedAt,
      finishedAt: deployment.finishedAt,
      error: deployment.error,
    },
  });
}

export function getDeployment(id) {
  return deployments.get(id);
}

export function subscribe(deploymentId, callback) {
  const handler = (id, event) => {
    if (id === deploymentId) {
      callback(event);
    }
  };

  emitter.on("deployment", handler);

  return () => {
    emitter.off("deployment", handler);
  };
}
