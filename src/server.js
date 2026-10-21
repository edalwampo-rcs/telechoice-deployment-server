import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import {
  createDeployment,
  getDeployment,
  subscribe,
} from "./deployment-manager.js";

import { checkImageUpdate } from "./deployer.js";
import {
  getDeploymentTarget,
  getEnvironments,
  getProjects,
  getService,
  getServices,
} from "./deployments.js";

const fastify = Fastify({
  logger: true,
});

// ============================================================
// Plugins
// ============================================================

await fastify.register(cors, {
  origin: true,
  credentials: true,
});

await fastify.register(websocket);

// ============================================================
// Health
// ============================================================

fastify.get("/api/health", async () => {
  return {
    status: "ok",
  };
});

// ============================================================
// Projects
// ============================================================

fastify.get("/api/projects", async () => {
  const projects = getProjects();

  return projects.map((project) => ({
    id: project,
    name: formatName(project),
  }));
});

// ============================================================
// Environments
// ============================================================

fastify.get("/api/projects/:project/environments", async (request, reply) => {
  const { project } = request.params;

  try {
    return getEnvironments(project);
  } catch (error) {
    reply.code(404);

    return {
      error: error.message,
    };
  }
});

// ============================================================
// Services
// ============================================================

fastify.get(
  "/api/projects/:project/environments/:environment/services",
  async (request, reply) => {
    const { project, environment } = request.params;

    try {
      return getServices(project, environment);
    } catch (error) {
      reply.code(404);

      return {
        error: error.message,
      };
    }
  },
);

// ============================================================
// Service
// ============================================================

fastify.get(
  "/api/projects/:project/environments/:environment/services/:service",
  async (request, reply) => {
    const { project, environment, service } = request.params;

    try {
      return getService(project, environment, service);
    } catch (error) {
      reply.code(404);

      return {
        error: error.message,
      };
    }
  },
);

// ============================================================
// Deployment target preview
// ============================================================

fastify.get(
  "/api/projects/:project/environments/:environment/services/:service/target",
  async (request, reply) => {
    const { project, environment, service } = request.params;

    try {
      return getDeploymentTarget(project, environment, service);
    } catch (error) {
      reply.code(404);

      return {
        error: error.message,
      };
    }
  },
);

// ============================================================
// Deployment
// ============================================================

fastify.post("/api/deploy/run", async (request, reply) => {
  const {
    project,
    environment,
    service,
    force = false,
    migrate = false,
    optimize = false,
  } = request.body || {};

  if (!project) {
    return reply.code(400).send({
      success: false,
      error: "project is required",
    });
  }

  if (!environment) {
    return reply.code(400).send({
      success: false,
      error: "environment is required",
    });
  }

  if (!service) {
    return reply.code(400).send({
      success: false,
      error: "service is required",
    });
  }

  try {
    const deployment = createDeployment({
      project,
      environment,
      service,
      force,
      migrate,
      optimize,
    });

    return reply.code(202).send({
      success: true,
      deploymentId: deployment.id,
      status: deployment.status,
    });
  } catch (error) {
    fastify.log.error(error);

    return reply.code(500).send({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================
// WebSocket
// ============================================================

fastify.get(
  "/ws/deployments/:id",
  {
    websocket: true,
  },
  (socket, request) => {
    const { id } = request.params;

    fastify.log.info(`WebSocket connected: ${id}`);

    const deployment = getDeployment(id);

    if (!deployment) {
      socket.send(
        JSON.stringify({
          type: "deployment.error",
          message: "Deployment not found",
        }),
      );

      socket.close();

      return;
    }

    // --------------------------------------------------------
    // Send current deployment state
    // --------------------------------------------------------

    socket.send(
      JSON.stringify({
        type: "deployment.initial",

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

        logs: deployment.logs || [],
      }),
    );

    // --------------------------------------------------------
    // Subscribe to realtime events
    // --------------------------------------------------------

    const unsubscribe = subscribe(id, (event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    // --------------------------------------------------------
    // Cleanup
    // --------------------------------------------------------

    socket.on("close", () => {
      fastify.log.info(`WebSocket disconnected: ${id}`);

      unsubscribe();
    });

    socket.on("error", (error) => {
      fastify.log.error(error, `WebSocket error: ${id}`);

      unsubscribe();
    });
  },
);

// ============================================================
// Check image update
// ============================================================

fastify.post("/api/deploy/check", async (request, reply) => {
  const { project, environment, service } = request.body || {};

  if (!project) {
    return reply.code(400).send({
      success: false,
      error: "project is required",
    });
  }

  if (!environment) {
    return reply.code(400).send({
      success: false,
      error: "environment is required",
    });
  }

  if (!service) {
    return reply.code(400).send({
      success: false,
      error: "service is required",
    });
  }

  try {
    const result = await checkImageUpdate({
      project,
      environment,
      service,
    });

    return reply.send(result);
  } catch (error) {
    fastify.log.error(error, "Failed to check image update");

    return reply.code(500).send({
      success: false,
      error: error.message,
    });
  }
});

// ============================================================
// Helpers
// ============================================================

function formatName(value) {
  return value
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ============================================================
// Start
// ============================================================

const PORT = Number(process.env.PORT) || 3001;

const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({
    port: PORT,
    host: HOST,
  });

  console.log(`Deployment API running on http://${HOST}:${PORT}`);
} catch (error) {
  fastify.log.error(error);

  process.exit(1);
}
