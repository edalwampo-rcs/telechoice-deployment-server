import dotenv from "dotenv";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");

const projectsPath = path.join(projectRoot, "config", "projects");

function expandEnvironmentVariables(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
      return process.env[name] ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map(expandEnvironmentVariables);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        expandEnvironmentVariables(child),
      ]),
    );
  }

  return value;
}

function getProjectPath(project) {
  return path.join(projectsPath, project);
}

export function getProjects() {
  if (!fs.existsSync(projectsPath)) {
    return [];
  }

  return fs
    .readdirSync(projectsPath, {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function getEnvironments(project) {
  const projectPath = getProjectPath(project);

  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project not found: ${project}`);
  }

  return fs
    .readdirSync(projectPath)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => path.basename(file, path.extname(file)));
}

export function getEnvironment(project, environment) {
  const projectPath = getProjectPath(project);

  const filepath = path.join(projectPath, `${environment}.yml`);

  if (!fs.existsSync(filepath)) {
    throw new Error(
      `Environment '${environment}' not found for project '${project}'`,
    );
  }

  const contents = fs.readFileSync(filepath, "utf8");

  const parsed = yaml.load(contents);

  return expandEnvironmentVariables(parsed);
}

export const config = {
  port: Number(process.env.PORT || 3001),

  projectsPath,

  getProjects,

  getEnvironments,

  getEnvironment,
};

export default config;
