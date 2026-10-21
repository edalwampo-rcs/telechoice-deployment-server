import config from "./config.js";

export function getProjects() {
  return config.getProjects();
}

export function getEnvironments(project) {
  return config.getEnvironments(project);
}

export function getEnvironment(project, environment) {
  return config.getEnvironment(project, environment);
}

export function getServices(project, environment) {
  const environmentConfig = getEnvironment(project, environment);

  return Object.entries(environmentConfig.services || {}).map(([name]) => name);
}

export function getService(project, environment, service) {
  const environmentConfig = getEnvironment(project, environment);

  const serviceConfig = environmentConfig.services?.[service];

  if (!serviceConfig) {
    throw new Error(
      `Service '${service}' is not available in ${project}/${environment}`,
    );
  }

  return {
    name: service,
    ...serviceConfig,
  };
}

export function getDeploymentTarget(project, environment, service) {
  const environmentConfig = getEnvironment(project, environment);

  const serviceConfig = getService(project, environment, service);

  const registry = environmentConfig.aws.registry;

  const tag = serviceConfig.tag || "latest";

  return {
    project,
    environment,
    service,
    container: serviceConfig.container,
    image: `${registry}/${serviceConfig.image}:${tag}`,
    tag,
    network: environmentConfig.docker.network,
    awsRegion: environmentConfig.aws.region,
    storage: serviceConfig.storage || [],
    environmentVariables: serviceConfig.environment || {},
  };
}
