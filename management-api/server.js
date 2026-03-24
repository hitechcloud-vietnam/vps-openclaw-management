#!/usr/bin/env node
// =============================================================================
// OpenClaw Management API — Docker Compose based service management
// Auth: Bearer OPENCLAW_MGMT_API_KEY | Port: 9998 | Systemd: openclaw-mgmt.service
// =============================================================================

const http = require('http');
const { execSync, exec, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9998;
const MGMT_VERSION = '1.0.6';
const GITHUB_REPO = 'Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management';
const COMPOSE_DIR = '/opt/openclaw';
const COMPOSE_CMD = `docker compose -f ${COMPOSE_DIR}/docker-compose.yml`;
const CONFIG_DIR = `${COMPOSE_DIR}/config`;
const ENV_FILE = `${COMPOSE_DIR}/.env`;
const CADDYFILE = `${COMPOSE_DIR}/Caddyfile`;
const TEMPLATES_DIR = '/etc/openclaw/config';
const AUTH_PROFILES_DIR = `${CONFIG_DIR}/agents/main/agent`;
const AUTH_PROFILES_FILE = `${AUTH_PROFILES_DIR}/auth-profiles.json`;
const AGENT_WORKSPACE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
  'memory.md'
];

// --- GitHub version check (cached) ---
let _latestVersionCache = { version: null, checkedAt: 0 };
const VERSION_CHECK_INTERVAL = 60 * 1000; // 1 minute

function getLatestVersion() {
  const now = Date.now();
  if (_latestVersionCache.version && (now - _latestVersionCache.checkedAt) < VERSION_CHECK_INTERVAL) {
    return _latestVersionCache.version;
  }
  try {
    const raw = execSync(
      `curl -sf --max-time 5 "https://api.github.com/repos/${GITHUB_REPO}/contents/version.json" -H "Accept: application/vnd.github.v3.raw" 2>/dev/null`,
      { encoding: 'utf8', timeout: 8000 }
    );
    const data = JSON.parse(raw);
    if (data.version) {
      _latestVersionCache = { version: data.version, checkedAt: now };
      return data.version;
    }
  } catch {}
  return _latestVersionCache.version || null;
}

// --- Login user credentials (stored in .env) ---
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString('hex');
  if (test.length !== hash.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash)); }
  catch { return false; }
}

function getLoginUser() {
  return getEnvValue('OPENCLAW_LOGIN_USER');
}

function getLoginPass() {
  return getEnvValue('OPENCLAW_LOGIN_PASS');
}

const MAX_AUTH_FAILURES = 10;
const BLOCK_DURATION = 15 * 60 * 1000;
const authAttempts = {};

// IP Whitelist — only these IPs can access the Management API
const ALLOWED_IPS = [
  '103.130.216.5',
  '103.130.216.57',
  '103.130.216.58',
  '103.241.42.12',
  '103.241.42.10',
  '103.130.217.10',
  '116.118.2.45',
  '127.0.0.1',       // localhost
  '::1',             // localhost IPv6
];

// =============================================================================
// Helpers
// =============================================================================
function getClientIP(req) {
  return req.socket.remoteAddress.replace('::ffff:', '');
}

function isBlocked(ip) {
  const r = authAttempts[ip];
  if (!r) return false;
  if (r.blockedUntil && Date.now() < r.blockedUntil) return true;
  if (r.blockedUntil && Date.now() >= r.blockedUntil) { delete authAttempts[ip]; return false; }
  return false;
}

function recordFailedAuth(ip) {
  if (!authAttempts[ip]) authAttempts[ip] = { count: 0, blockedUntil: null };
  authAttempts[ip].count++;
  if (authAttempts[ip].count >= MAX_AUTH_FAILURES) {
    authAttempts[ip].blockedUntil = Date.now() + BLOCK_DURATION;
  }
}

function getMgmtApiKey() {
  try {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const m = env.match(/^OPENCLAW_MGMT_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expected = getMgmtApiKey();
  if (!expected) return false;
  const provided = match[1];
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch { return false; }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sanitizeKey(key) {
  if (!key || key.length < 12) return '***';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function getServerIP() {
  try { return execSync("hostname -I | awk '{print $1}'", { stdio: 'pipe' }).toString().trim(); }
  catch { return 'localhost'; }
}

function shell(cmd, timeout = 30000) {
  return execSync(cmd, { timeout, stdio: 'pipe' }).toString().trim();
}

// --- Env file helpers ---
function readEnvFile() {
  return fs.readFileSync(ENV_FILE, 'utf8');
}

function writeEnvFile(content) {
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function getEnvValue(key) {
  const env = readEnvFile();
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

function setEnvValue(key, value) {
  let env = readEnvFile();
  const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  if (regex.test(env)) {
    env = env.replace(regex, `${key}=${value}`);
  } else {
    env = env.trim() + `\n${key}=${value}\n`;
  }
  writeEnvFile(env.trim() + '\n');
}

function removeEnvValue(key) {
  let env = readEnvFile();
  env = env.replace(new RegExp(`^#?\\s*${key}=.*\n?`, 'm'), '');
  writeEnvFile(env.trim() + '\n');
}

function getDomainFromCaddyfile() {
  try {
    const caddy = fs.readFileSync(CADDYFILE, 'utf8');
    for (const rawLine of caddy.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([^\s{][^{]*)\s*\{$/);
      if (!m) continue;
      const firstHost = m[1].split(',')[0].trim();
      if (!firstHost || firstHost.startsWith('{$') || firstHost === 'localhost') return null;
      return firstHost;
    }
  } catch {}
  return null;
}

function getConfiguredDomainRaw() {
  const envDomain = (getEnvValue('DOMAIN') || '').trim();
  if (envDomain && envDomain !== 'localhost') return envDomain;
  return getDomainFromCaddyfile();
}

// --- Config file helpers ---
function readConfig() {
  return JSON.parse(fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(`${CONFIG_DIR}/openclaw.json`, JSON.stringify(config, null, 2), 'utf8');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return deepClone(source);
  if (!isPlainObject(source)) return source;

  const output = isPlainObject(target) ? deepClone(target) : {};
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      output[key] = deepClone(value);
    } else if (isPlainObject(value)) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isSensitiveKeyName(key) {
  return /(token|key|secret|password)/i.test(String(key || ''));
}

function redactSensitiveData(value, parentKey = '') {
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item, parentKey));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && isSensitiveKeyName(key)) {
        out[key] = sanitizeKey(item);
      } else {
        out[key] = redactSensitiveData(item, key);
      }
    }
    return out;
  }
  if (typeof value === 'string' && isSensitiveKeyName(parentKey)) {
    return sanitizeKey(value);
  }
  return value;
}

function getValueAtPath(obj, rawPath) {
  if (!rawPath) return { exists: true, value: obj };
  const parts = String(rawPath).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || !(part in Object(current))) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function setValueAtPath(obj, rawPath, value) {
  const parts = String(rawPath).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (parts.length === 0) return value;

  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (!isPlainObject(current[part]) && !Array.isArray(current[part])) {
      current[part] = /^\d+$/.test(nextPart) ? [] : {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return obj;
}

function deleteValueAtPath(obj, rawPath) {
  const parts = String(rawPath).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  if (parts.length === 0) return false;

  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current === null || current === undefined || !(part in Object(current))) return false;
    current = current[part];
  }

  const last = parts[parts.length - 1];
  if (Array.isArray(current) && /^\d+$/.test(last)) {
    const index = parseInt(last, 10);
    if (index < 0 || index >= current.length) return false;
    current.splice(index, 1);
    return true;
  }
  if (isPlainObject(current) && Object.prototype.hasOwnProperty.call(current, last)) {
    delete current[last];
    return true;
  }
  return false;
}

function flattenConfigSchema(value, prefix = '', output = []) {
  const type = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  if (prefix) {
    const item = { path: prefix, type };
    if (Array.isArray(value)) item.length = value.length;
    if (isPlainObject(value)) item.keys = Object.keys(value);
    if (!Array.isArray(value) && !isPlainObject(value)) item.sample = value;
    output.push(item);
  }

  if (Array.isArray(value) && value.length > 0) {
    flattenConfigSchema(value[0], `${prefix}[]`, output);
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenConfigSchema(child, prefix ? `${prefix}.${key}` : key, output);
    }
  }
  return output;
}

function getConfigSchemaSample() {
  let sample = {};
  try {
    sample = deepMerge(sample, readConfig());
  } catch {}

  for (const provider of Object.values(PROVIDERS)) {
    try {
      const tpl = JSON.parse(fs.readFileSync(provider.configTemplate, 'utf8'));
      sample = deepMerge(sample, tpl);
    } catch {}
  }
  return sample;
}

function normalizeManagedPath(input) {
  if (!input || typeof input !== 'string') return null;
  if (input === '~/.openclaw') return CONFIG_DIR;
  if (input.startsWith('~/.openclaw/')) {
    return `${CONFIG_DIR}/${input.slice('~/.openclaw/'.length)}`;
  }
  return input;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function isValidSkillKey(skillKey) {
  return typeof skillKey === 'string' && /^[a-z0-9][a-z0-9-_]{0,63}$/.test(skillKey);
}

function getAgentById(config, agentId = 'main') {
  const agent = getAgentsList(config).find(item => item.id === agentId);
  if (agent) return agent;
  if (agentId === 'main') {
    return {
      id: 'main',
      default: true,
      name: 'Main Agent',
      workspace: '~/.openclaw/workspace-main',
      agentDir: '~/.openclaw/agents/main/agent'
    };
  }
  return null;
}

function getAgentWorkspaceDir(config, agentId = 'main') {
  const agent = getAgentById(config, agentId);
  const workspace = agent?.workspace || `~/.openclaw/workspace-${agentId}`;
  return normalizeManagedPath(workspace);
}

function isAllowedAgentWorkspaceFile(name) {
  return typeof name === 'string' && AGENT_WORKSPACE_FILES.includes(name);
}

function getAgentWorkspaceFileInfo(workspaceDir, name) {
  const filePath = path.join(workspaceDir, name);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { name, path: filePath, exists: false, missing: true };
    }
    return {
      name,
      path: filePath,
      exists: true,
      missing: false,
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs)
    };
  } catch {
    return { name, path: filePath, exists: false, missing: true };
  }
}

function resolveAgentWorkspaceFile(config, agentId, name) {
  if (!isValidAgentId(agentId)) {
    throw new Error('Invalid agent id');
  }
  const decodedName = decodeURIComponent(String(name || ''));
  if (!isAllowedAgentWorkspaceFile(decodedName)) {
    throw new Error('Unsupported workspace file name');
  }

  const workspaceDir = getAgentWorkspaceDir(config, agentId);
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const filePath = path.resolve(resolvedWorkspaceDir, decodedName);

  if (path.dirname(filePath) !== resolvedWorkspaceDir) {
    throw new Error('Unsafe workspace file path');
  }

  return {
    agentId,
    name: decodedName,
    workspaceDir,
    filePath
  };
}

function getWorkspaceSkillsDir(config, agentId = 'main') {
  return `${getAgentWorkspaceDir(config, agentId)}/skills`;
}

function getManagedSkillsDir() {
  return `${CONFIG_DIR}/skills`;
}

function getExtraSkillDirs(config) {
  const dirs = config?.skills?.load?.extraDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.map(normalizeManagedPath).filter(Boolean);
}

function parseFrontmatterValue(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSkillDocument(content) {
  const text = String(content || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: text.trim() };
  }

  const frontmatter = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = parseFrontmatterValue(value);
  }

  return { frontmatter, body: match[2].trim() };
}

function getSkillOpenClawMetadata(frontmatter) {
  const metadata = frontmatter?.metadata;
  if (!metadata) return {};
  if (isPlainObject(metadata.openclaw)) return metadata.openclaw;
  return isPlainObject(metadata) ? metadata : {};
}

function normalizeStringList(input) {
  if (Array.isArray(input)) return input.map(item => String(item).trim()).filter(Boolean);
  if (typeof input === 'string') {
    return input.split(/\r?\n/).map(item => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  }
  return [];
}

function collectSkillBins(metadata) {
  const bins = new Set();
  const requires = metadata?.requires || {};
  for (const bin of normalizeStringList(requires.bins)) bins.add(bin);
  for (const bin of normalizeStringList(requires.anyBins)) bins.add(bin);
  if (Array.isArray(metadata?.install)) {
    for (const installer of metadata.install) {
      for (const bin of normalizeStringList(installer?.bins)) bins.add(bin);
    }
  }
  return [...bins].sort();
}

function listSkillsInDirectory(rootDir, source, config, agentId = 'main') {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const results = [];

  for (const entry of entries) {
    const skillDir = `${rootDir}/${entry.name}`;
    const skillFile = `${skillDir}/SKILL.md`;
    if (!fs.existsSync(skillFile)) continue;

    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const parsed = parseSkillDocument(raw);
      const metadata = getSkillOpenClawMetadata(parsed.frontmatter);
      const skillKey = parsed.frontmatter.name || entry.name;
      const configEntry = deepClone(config?.skills?.entries?.[skillKey] || {});
      results.push({
        skillKey,
        directoryName: entry.name,
        title: parsed.body.split(/\r?\n/).find(line => line.trim().startsWith('# '))?.replace(/^#\s+/, '').trim() || skillKey,
        description: parsed.frontmatter.description || '',
        source,
        agentId,
        path: skillFile,
        skillDir,
        metadata,
        requiredBins: collectSkillBins(metadata),
        configEntry,
        contentPreview: parsed.body.slice(0, 240).trim(),
        frontmatter: parsed.frontmatter,
        content: raw
      });
    } catch {}
  }

  return results;
}

function listAvailableSkills(config, agentId = 'main') {
  const seen = new Set();
  const skills = [];
  const roots = [
    { source: 'workspace', path: getWorkspaceSkillsDir(config, agentId) },
    { source: 'managed', path: getManagedSkillsDir() },
    ...getExtraSkillDirs(config).map(path => ({ source: 'extra', path }))
  ];

  for (const root of roots) {
    for (const skill of listSkillsInDirectory(root.path, root.source, config, agentId)) {
      if (seen.has(skill.skillKey)) continue;
      seen.add(skill.skillKey);
      skills.push(skill);
    }
  }

  return { roots, skills };
}

function findWorkspaceSkill(config, agentId, skillKey) {
  const skills = listSkillsInDirectory(getWorkspaceSkillsDir(config, agentId), 'workspace', config, agentId);
  return skills.find(skill => skill.skillKey === skillKey || skill.directoryName === skillKey) || null;
}

function escapeYamlScalar(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function buildBulletSection(title, items, fallback = 'Not specified.') {
  const values = normalizeStringList(items);
  const body = values.length > 0 ? values.map(item => `- ${item}`).join('\n') : fallback;
  return `## ${title}\n\n${body}`;
}

function buildCustomSkillMarkdown(input) {
  const skillKey = input.skillKey;
  const title = input.title || skillKey;
  const description = input.description || `Custom workspace skill for ${skillKey}.`;
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const metadataLine = Object.keys(metadata).length > 0 ? `metadata: ${JSON.stringify({ openclaw: metadata })}\n` : '';

  const sections = [
    `# ${title}`,
    '',
    input.summary || `Use this skill when the user request matches the \`${skillKey}\` workflow. Follow the guidance below and keep responses grounded in the available tools, inputs, and safety constraints.`,
    '',
    buildBulletSection('When to Use', input.activation || input.activationTriggers, 'Use when the user explicitly asks for this workflow, asks for equivalent domain actions, or provides matching input data.'),
    '',
    buildBulletSection('Inputs to Collect', input.inputs, 'Collect all required arguments, missing identifiers, target environment details, and any authentication or confirmation requirements before acting.'),
    '',
    buildBulletSection('Execution Workflow', input.workflow || input.instructions, '1. Confirm the goal.\n2. Validate prerequisites.\n3. Run the smallest safe action first.\n4. Summarize the result and next steps.'),
    '',
    buildBulletSection('Expected Output', input.outputs, 'Return a concise result summary, important fields, and any follow-up action the user should take.'),
    '',
    buildBulletSection('Command Examples', input.commandExamples, 'Add slash-command or shell examples here when the workflow is finalized.'),
    '',
    buildBulletSection('Configuration Notes', input.configNotes || input.configHints, 'Document required config keys, environment variables, and optional overrides for this skill.'),
    '',
    buildBulletSection('Safety and Guardrails', input.safetyNotes, 'Do not fabricate results. Validate destructive actions, protect secrets, and ask for confirmation before risky changes.'),
    '',
    buildBulletSection('Troubleshooting', input.troubleshooting, 'If the workflow fails, report the exact step that failed, include the relevant error, and suggest the next safe diagnostic action.')
  ];

  return `---\nname: ${skillKey}\ndescription: \"${escapeYamlScalar(description)}\"\n${metadataLine}---\n\n${sections.join('\n')}`.trim() + '\n';
}

// --- Auth profiles helpers ---
function getAgentAuthDir(agentId) {
  return `${CONFIG_DIR}/agents/${agentId}/agent`;
}

function getAgentAuthFile(agentId) {
  return `${getAgentAuthDir(agentId)}/auth-profiles.json`;
}

function readAgentAuth(agentId) {
  try {
    return JSON.parse(fs.readFileSync(getAgentAuthFile(agentId), 'utf8'));
  } catch {
    return { profiles: {} };
  }
}

function writeAgentAuth(agentId, profiles) {
  const dir = getAgentAuthDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getAgentAuthFile(agentId), JSON.stringify(profiles, null, 2), 'utf8');
}

function setAgentApiKey(agentId, providerName, apiKey) {
  const data = readAgentAuth(agentId);
  data.profiles = data.profiles || {};
  const profileId = `${providerName}:manual`;
  data.profiles[profileId] = {
    type: 'api_key',
    provider: providerName,
    key: apiKey
  };
  writeAgentAuth(agentId, data);
}

function getAgentApiKey(agentId, providerName) {
  const data = readAgentAuth(agentId);
  const profiles = data.profiles || {};
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile && profile.provider === providerName && profile.key) return profile.key;
  }
  return null;
}

function removeAgentApiKey(agentId, providerName) {
  const data = readAgentAuth(agentId);
  if (!data.profiles) return;
  const profileId = `${providerName}:manual`;
  if (data.profiles[profileId]) {
    delete data.profiles[profileId];
    writeAgentAuth(agentId, data);
  }
}

// Backward-compatible wrappers (default to 'main' agent)
function readAuthProfiles(agentId = 'main') {
  return readAgentAuth(agentId);
}

function writeAuthProfiles(profiles, agentId = 'main') {
  writeAgentAuth(agentId, profiles);
}

function setAuthProfileApiKey(providerName, apiKey, agentId = 'main') {
  setAgentApiKey(agentId, providerName, apiKey);
}

function getAuthProfileApiKey(providerName, agentId = 'main') {
  return getAgentApiKey(agentId, providerName);
}

// --- Route matching ---
function route(req, method, path) {
  if (req.method !== method) return null;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pattern = path.replace(/:(\w+)/g, '(?<$1>[^/]+)');
  const match = url.pathname.match(new RegExp(`^${pattern}$`));
  if (!match) return null;
  return { params: match.groups || {}, query: Object.fromEntries(url.searchParams) };
}

// --- Multi-agent helpers ---
function isValidAgentId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id);
}

function getAgentsList(config) {
  const list = config?.agents?.list;
  if (Array.isArray(list) && list.length > 0) return list;
  return [{ id: 'main', default: true, name: 'Main Agent' }];
}

function getDefaultAgentId(config) {
  const list = getAgentsList(config);
  const def = list.find(a => a.default);
  return def ? def.id : (list[0]?.id || 'main');
}

function ensureAgentsList(config) {
  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];
  return config;
}

function getBindings(config) {
  return Array.isArray(config.bindings) ? config.bindings : [];
}

// --- Provider aliases ---
const PROVIDER_ALIASES = { gemini: 'google' };
function resolveProvider(name) { return PROVIDER_ALIASES[name] || name; }

// --- Provider configs ---
// Helper: test API key via Bearer auth + GET /models endpoint
function testBearerModels(url, apiKey) {
  try {
    const r = shell(`curl -s -o /dev/null -w '%{http_code}' '${url}' \
      -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
    return r === '200';
  } catch { return false; }
}

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    authProfileProvider: 'anthropic',
    configTemplate: `${TEMPLATES_DIR}/anthropic.json`,
    knownModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6-20260218', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
    ],
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages \
          -H 'x-api-key: ${apiKey.replace(/'/g, "'\\''")}' \
          -H 'anthropic-version: 2023-06-01' \
          -H 'content-type: application/json' \
          -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    authProfileProvider: 'openai',
    configTemplate: `${TEMPLATES_DIR}/openai.json`,
    knownModels: [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-pro-2026-03-05', name: 'GPT-5.4 Pro' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'o3', name: 'o3' },
      { id: 'o3-pro', name: 'o3 Pro' },
      { id: 'o3-mini', name: 'o3 Mini' },
      { id: 'o4-mini', name: 'o4-mini' }
    ],
    testFn: (apiKey) => testBearerModels('https://api.openai.com/v1/models', apiKey)
  },
  google: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    authProfileProvider: 'google',
    configTemplate: `${TEMPLATES_DIR}/google.json`,
    knownModels: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
      { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite Preview' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' }
    ],
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' \
          "https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.replace(/'/g, "'\\''")}"`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  deepseek: {
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    authProfileProvider: 'deepseek',
    configTemplate: `${TEMPLATES_DIR}/deepseek.json`,
    testFn: (apiKey) => testBearerModels('https://api.deepseek.com/v1/models', apiKey)
  },
  groq: {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    authProfileProvider: 'groq',
    configTemplate: `${TEMPLATES_DIR}/groq.json`,
    testFn: (apiKey) => testBearerModels('https://api.groq.com/openai/v1/models', apiKey)
  },
  together: {
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    authProfileProvider: 'together',
    configTemplate: `${TEMPLATES_DIR}/together.json`,
    testFn: (apiKey) => testBearerModels('https://api.together.xyz/v1/models', apiKey)
  },
  mistral: {
    name: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    authProfileProvider: 'mistral',
    configTemplate: `${TEMPLATES_DIR}/mistral.json`,
    testFn: (apiKey) => testBearerModels('https://api.mistral.ai/v1/models', apiKey)
  },
  xai: {
    name: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    authProfileProvider: 'xai',
    configTemplate: `${TEMPLATES_DIR}/xai.json`,
    testFn: (apiKey) => testBearerModels('https://api.x.ai/v1/models', apiKey)
  },
  cerebras: {
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    authProfileProvider: 'cerebras',
    configTemplate: `${TEMPLATES_DIR}/cerebras.json`,
    testFn: (apiKey) => testBearerModels('https://api.cerebras.ai/v1/models', apiKey)
  },
  sambanova: {
    name: 'SambaNova',
    envKey: 'SAMBANOVA_API_KEY',
    authProfileProvider: 'sambanova',
    configTemplate: `${TEMPLATES_DIR}/sambanova.json`,
    testFn: (apiKey) => testBearerModels('https://api.sambanova.ai/v1/models', apiKey)
  },
  fireworks: {
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    authProfileProvider: 'fireworks',
    configTemplate: `${TEMPLATES_DIR}/fireworks.json`,
    testFn: (apiKey) => testBearerModels('https://api.fireworks.ai/inference/v1/models', apiKey)
  },
  cohere: {
    name: 'Cohere',
    envKey: 'COHERE_API_KEY',
    authProfileProvider: 'cohere',
    configTemplate: `${TEMPLATES_DIR}/cohere.json`,
    testFn: (apiKey) => testBearerModels('https://api.cohere.ai/compatibility/v1/models', apiKey)
  },
  yi: {
    name: 'Yi/01.AI',
    envKey: 'YI_API_KEY',
    authProfileProvider: 'yi',
    configTemplate: `${TEMPLATES_DIR}/yi.json`,
    testFn: (apiKey) => testBearerModels('https://api.01.ai/v1/models', apiKey)
  },
  baichuan: {
    name: 'Baichuan AI',
    envKey: 'BAICHUAN_API_KEY',
    authProfileProvider: 'baichuan',
    configTemplate: `${TEMPLATES_DIR}/baichuan.json`,
    testFn: (apiKey) => testBearerModels('https://api.baichuan-ai.com/v1/models', apiKey)
  },
  stepfun: {
    name: 'Stepfun',
    envKey: 'STEPFUN_API_KEY',
    authProfileProvider: 'stepfun',
    configTemplate: `${TEMPLATES_DIR}/stepfun.json`,
    testFn: (apiKey) => testBearerModels('https://api.stepfun.com/v1/models', apiKey)
  },
  siliconflow: {
    name: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    authProfileProvider: 'siliconflow',
    configTemplate: `${TEMPLATES_DIR}/siliconflow.json`,
    testFn: (apiKey) => testBearerModels('https://api.siliconflow.cn/v1/models', apiKey)
  },
  novita: {
    name: 'Novita AI',
    envKey: 'NOVITA_API_KEY',
    authProfileProvider: 'novita',
    configTemplate: `${TEMPLATES_DIR}/novita.json`,
    testFn: (apiKey) => testBearerModels('https://api.novita.ai/v3/openai/models', apiKey)
  },
  openrouter: {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    authProfileProvider: 'openrouter',
    configTemplate: `${TEMPLATES_DIR}/openrouter.json`,
    testFn: (apiKey) => testBearerModels('https://openrouter.ai/api/v1/models', apiKey)
  },
  minimax: {
    name: 'Minimax',
    envKey: 'MINIMAX_API_KEY',
    authProfileProvider: 'minimax',
    configTemplate: `${TEMPLATES_DIR}/minimax.json`,
    testFn: (apiKey) => testBearerModels('https://api.minimax.io/v1/models', apiKey)
  },
  moonshot: {
    name: 'Moonshot/Kimi',
    envKey: 'MOONSHOT_API_KEY',
    authProfileProvider: 'moonshot',
    configTemplate: `${TEMPLATES_DIR}/moonshot.json`,
    testFn: (apiKey) => testBearerModels('https://api.moonshot.ai/v1/models', apiKey)
  },
  zhipu: {
    name: 'Zhipu/GLM',
    envKey: 'ZHIPU_API_KEY',
    authProfileProvider: 'zhipu',
    configTemplate: `${TEMPLATES_DIR}/zhipu.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' -X POST https://open.bigmodel.cn/api/paas/v4/chat/completions \
          -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' \
          -H 'Content-Type: application/json' \
          -d '{"model":"glm-4.5-flash","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000);
        return r === '200';
      } catch { return false; }
    }
  }
};

const CHANNEL_MAP = {
  telegram: { envKey: 'TELEGRAM_BOT_TOKEN', configKey: 'telegram', tokenField: 'botToken' },
  discord:  { envKey: 'DISCORD_BOT_TOKEN',  configKey: 'discord',  tokenField: 'botToken' },
  slack:    { envKey: 'SLACK_BOT_TOKEN',     configKey: 'slack',    tokenField: 'botToken' },
  zalo:     { envKey: 'ZALO_BOT_TOKEN',      configKey: 'zalo',     tokenField: 'botToken' }
};

// --- Docker compose helpers ---
function dockerCompose(cmd, timeout = 60000) {
  return shell(`${COMPOSE_CMD} ${cmd}`, timeout);
}

function dockerExec(cmd, timeout = 30000) {
  return shell(`${COMPOSE_CMD} exec -T openclaw ${cmd}`, timeout);
}

function dockerExecArgs(args, timeout = 30000) {
  return execFileSync(
    'docker',
    ['compose', '-f', `${COMPOSE_DIR}/docker-compose.yml`, 'exec', '-T', 'openclaw', ...args],
    { timeout, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }
  ).trim();
}

function parseLooseValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'null') return null;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch {}
  }
  return trimmed;
}

function normalizeGatewayParams(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = Array.isArray(value) ? value.map(parseLooseValue) : parseLooseValue(value);
  }
  return out;
}

function parseCliJsonOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return { raw: text };
}

function gatewayMethod(method, params = {}, options = {}) {
  const normalizedParams = normalizeGatewayParams(params);
  const timeoutMs = Number(options.timeoutMs || 30000);
  const execTimeout = Math.max(timeoutMs + 5000, 15000);
  const args = ['node', 'dist/index.js', 'gateway', 'call', method, '--params', JSON.stringify(normalizedParams), '--json'];
  if (options.expectFinal) args.push('--expect-final');
  if (timeoutMs) args.push('--timeout', String(timeoutMs));
  const output = dockerExecArgs(args, execTimeout);
  return parseCliJsonOutput(output);
}

function getContainerStatus() {
  try {
    const out = shell(`docker inspect openclaw --format '{{.State.Status}} {{.State.StartedAt}}' 2>/dev/null`);
    const [status, startedAt] = out.split(' ');
    return { status, startedAt };
  } catch {
    return { status: 'not_found', startedAt: null };
  }
}

function restartContainer(service = 'openclaw') {
  dockerCompose(`up -d ${service}`, 60000);
}

// =============================================================================
// HTTP Server
// =============================================================================
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // IP Whitelist check
  // if (!ALLOWED_IPS.includes(ip)) {
  //   return json(res, 403, { ok: false, error: 'Access denied' });
  // }

  // Rate limit
  if (isBlocked(ip)) {
    return json(res, 429, { ok: false, error: 'Too many failed attempts. Blocked for 15 minutes.' });
  }

  // =========================================================================
  // PUBLIC ROUTES (no Bearer auth required)
  // =========================================================================

  // GET /login — Serve login page
  if (route(req, 'GET', '/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  // POST /api/auth/login — Validate credentials, return gateway token
  if (route(req, 'POST', '/api/auth/login')) {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        return json(res, 400, { ok: false, error: 'Missing username or password' });
      }

      const storedUser = getLoginUser();
      const storedPass = getLoginPass();

      if (!storedUser || !storedPass) {
        return json(res, 503, { ok: false, error: 'Login not configured. Ask admin to create credentials via API.' });
      }

      if (username !== storedUser || !verifyPassword(password, storedPass)) {
        recordFailedAuth(ip);
        return json(res, 401, { ok: false, error: 'Invalid username or password' });
      }

      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      return json(res, 200, { ok: true, token });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PROTECTED ROUTES (Bearer auth required)
  // =========================================================================

  // Auth
  if (!isAuthorized(req)) {
    recordFailedAuth(ip);
    return json(res, 401, { ok: false, error: 'Invalid or missing API key' });
  }

  let m;

  // =========================================================================
  // POST /api/auth/create-user — Tao login credentials (luu vao .env)
  // =========================================================================
  if (route(req, 'POST', '/api/auth/create-user')) {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        return json(res, 400, { ok: false, error: 'Missing username or password' });
      }
      if (username.length < 3 || username.length > 64) {
        return json(res, 400, { ok: false, error: 'Username must be 3-64 characters' });
      }
      if (password.length < 6) {
        return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      }

      // Only allow 1 user — block if already exists
      const existing = getLoginUser();
      if (existing) {
        return json(res, 409, { ok: false, error: `User '${existing}' already exists. Delete first or use change-password.` });
      }

      const hashed = hashPassword(password);
      setEnvValue('OPENCLAW_LOGIN_USER', username);
      setEnvValue('OPENCLAW_LOGIN_PASS', hashed);

      return json(res, 200, { ok: true, username, message: 'Login credentials saved.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/auth/user — Xoa login credentials
  // =========================================================================
  if (route(req, 'DELETE', '/api/auth/user')) {
    try {
      removeEnvValue('OPENCLAW_LOGIN_USER');
      removeEnvValue('OPENCLAW_LOGIN_PASS');
      return json(res, 200, { ok: true, message: 'Login credentials removed.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/auth/user — Xem login user hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/auth/user')) {
    try {
      const username = getLoginUser();
      return json(res, 200, {
        ok: true,
        configured: !!username,
        username: username || null
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/auth/change-password — Doi password
  // =========================================================================
  if (route(req, 'PUT', '/api/auth/change-password')) {
    try {
      const body = await parseBody(req);
      const { password } = body;
      if (!password || password.length < 6) {
        return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      }

      const username = getLoginUser();
      if (!username) {
        return json(res, 400, { ok: false, error: 'No login user configured. Use POST /api/auth/create-user first.' });
      }

      const hashed = hashPassword(password);
      setEnvValue('OPENCLAW_LOGIN_PASS', hashed);

      return json(res, 200, { ok: true, username, message: 'Password changed.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/info — Thong tin service (tuong tu "Thong tin dang nhap" N8N)
  // =========================================================================
  if (route(req, 'GET', '/api/info')) {
    try {
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      const serverIP = getServerIP();
      const { status } = getContainerStatus();
      // Domain from .env; fallback to legacy Caddyfile when .env has no DOMAIN
      const rawDomain = getConfiguredDomainRaw();
      const domain = rawDomain && !/^https?:\/\//.test(rawDomain) ? rawDomain : null;
      const host = rawDomain ? rawDomain.replace(/^https?:\/\//, '') : serverIP;
      const caddyTls = getEnvValue('CADDY_TLS') || '';
      // self-signed = http not applicable; empty CADDY_TLS with domain = Let's Encrypt = https
      const scheme = 'https';

      // Kiem tra DNS domain da tro dung IP chua (dung Cloudflare DoH)
      let dnsStatus = null;
      if (domain && !/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
        try {
          const out = shell(`curl -sf "https://1.1.1.1/dns-query?name=${domain}&type=A" -H "accept: application/dns-json" 2>/dev/null`, 10000);
          const matches = out.match(/"data":\s*"(\d+\.\d+\.\d+\.\d+)"/g) || [];
          const resolvedIPs = matches.map(m => m.match(/(\d+\.\d+\.\d+\.\d+)/)[1]);
          if (resolvedIPs.includes(serverIP)) {
            dnsStatus = 'ok';
          } else {
            dnsStatus = 'not_pointed';
          }
        } catch {
          dnsStatus = 'unknown';
        }
      }

      // SSL status (derived from .env)
      const sslMode = domain
        ? (caddyTls === 'tls internal' ? 'self-signed' : 'letsencrypt')
        : 'none';

      const latestVersion = getLatestVersion();

      return json(res, 200, {
        ok: true,
        domain: domain,
        ip: serverIP,
        dashboardUrl: `${scheme}://${host}/#token=${token}`,
        gatewayToken: token,
        mgmtApiKey: sanitizeKey(getMgmtApiKey()),
        status,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        mgmtVersion: MGMT_VERSION,
        latestMgmtVersion: latestVersion || MGMT_VERSION,
        mgmtUpdateAvailable: latestVersion ? latestVersion !== MGMT_VERSION : false,
        ssl: sslMode,
        dnsStatus,
        ...(dnsStatus === 'not_pointed' ? { dnsWarning: `DNS for ${domain} does not point to ${serverIP}. Update your A record to enable Let's Encrypt SSL.` } : {})
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/status — Trang thai container
  // =========================================================================
  if (route(req, 'GET', '/api/status')) {
    try {
      const { status, startedAt } = getContainerStatus();

      // Caddy status
      let caddyStatus = 'not_found';
      try {
        caddyStatus = shell("docker inspect caddy --format '{{.State.Status}}' 2>/dev/null");
      } catch {}

      return json(res, 200, {
        ok: true,
        openclaw: { status, startedAt },
        caddy: { status: caddyStatus },
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        gatewayPort: getEnvValue('OPENCLAW_GATEWAY_PORT') || '18789'
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/domain — Xem domain config
  // =========================================================================
  if (route(req, 'GET', '/api/domain')) {
    try {
      const domain = getConfiguredDomainRaw() || null;
      const caddyTls = getEnvValue('CADDY_TLS') || '';
      const isIP = domain && /^https?:\/\//.test(domain);
      const isDomain = domain && !isIP && domain !== 'localhost';

      return json(res, 200, {
        ok: true,
        domain: isDomain ? domain : null,
        ip: getServerIP(),
        ssl: isDomain && !caddyTls,  // real domain + no explicit TLS = auto Let's Encrypt
        selfSignedSSL: caddyTls === 'tls internal',
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/domain — Doi domain + SSL
  // =========================================================================
  if (route(req, 'PUT', '/api/domain')) {
    try {
      const body = await parseBody(req);
      const domain = (body.domain || '').trim().toLowerCase();
      const email = (body.email || '').trim();

      if (!domain) return json(res, 400, { ok: false, error: 'Missing domain' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        return json(res, 400, { ok: false, error: 'Invalid domain format' });
      }

      // DNS check (Cloudflare DoH)
      const serverIP = getServerIP();
      let resolvedIPs = [];
      try {
        const out = shell(`curl -sf "https://1.1.1.1/dns-query?name=${domain}&type=A" -H "accept: application/dns-json" 2>/dev/null`, 10000);
        const matches = (out || '').match(/"data":\s*"(\d+\.\d+\.\d+\.\d+)"/g) || [];
        resolvedIPs = matches.map(m => m.match(/(\d+\.\d+\.\d+\.\d+)/)[1]);
      } catch {}

      if (resolvedIPs.length === 0) {
        return json(res, 400, { ok: false, error: `Cannot resolve DNS for ${domain}. Point A record to ${serverIP}.` });
      }
      if (!resolvedIPs.includes(serverIP)) {
        return json(res, 400, { ok: false, error: `DNS for ${domain} resolves to ${resolvedIPs.join(', ')} — does not match server IP (${serverIP}).` });
      }

      // Update .env with new domain (Caddy auto Let's Encrypt for real domains)
      setEnvValue('DOMAIN', domain);
      setEnvValue('CADDY_TLS', '');

      // Download latest Caddyfile template from repo
      try {
        shell(`curl -fsSL 'https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main/Caddyfile?t=${Date.now()}' -o '${CADDYFILE}'`, 15000);
      } catch (dlErr) {
        return json(res, 500, { ok: false, error: 'Failed to download Caddyfile: ' + dlErr.message });
      }

      // Restart Caddy container
      try {
        dockerCompose('restart caddy', 30000);
        // Wait and check
        execSync('sleep 3');
        const caddyStatus = shell("docker inspect caddy --format '{{.State.Status}}' 2>/dev/null");
        if (caddyStatus === 'running') {
          return json(res, 200, { ok: true, domain });
        }
      } catch {}

      // Rollback: revert domain to IP in .env
      setEnvValue('DOMAIN', `http://${serverIP}`);
      setEnvValue('CADDY_TLS', '');
      try { dockerCompose('restart caddy', 15000); } catch {}
      return json(res, 500, { ok: false, error: 'Caddy failed to start with this domain. Rolled back to IP config.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/version — Version info
  // =========================================================================
  if (route(req, 'GET', '/api/version')) {
    try {
      let currentImage = 'unknown';
      try {
        currentImage = shell("docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null");
      } catch {}

      let currentDigest = 'unknown';
      try {
        currentDigest = shell("docker inspect openclaw --format '{{.Image}}' 2>/dev/null");
      } catch {}

      return json(res, 200, {
        ok: true,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        image: currentImage,
        digest: currentDigest
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/upgrade — Pull latest image + recreate
  // =========================================================================
  if (route(req, 'POST', '/api/upgrade')) {
    try {
      exec(`cd ${COMPOSE_DIR} && ${COMPOSE_CMD} pull openclaw && ${COMPOSE_CMD} up -d openclaw`,
        { timeout: 300000 }, (err, stdout, stderr) => {
          console.log('[MGMT] Upgrade completed:', err ? 'FAILED' : 'OK');
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
        });
      return json(res, 202, { ok: true, message: 'Upgrade started. Check /api/status for progress.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/restart — Restart container
  // =========================================================================
  if (route(req, 'POST', '/api/restart')) {
    try {
      restartContainer('openclaw');
      execSync('sleep 2');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/stop — Stop container
  // =========================================================================
  if (route(req, 'POST', '/api/stop')) {
    try {
      dockerCompose('stop openclaw');
      return json(res, 200, { ok: true, message: 'OpenClaw stopped.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/start — Start container
  // =========================================================================
  if (route(req, 'POST', '/api/start')) {
    try {
      dockerCompose('start openclaw');
      execSync('sleep 2');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/rebuild — Down + Up (full recreate)
  // =========================================================================
  if (route(req, 'POST', '/api/rebuild')) {
    try {
      dockerCompose('down', 60000);
      dockerCompose('up -d', 120000);
      execSync('sleep 3');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/reset — Xoa data + config, tao lai tu dau
  // =========================================================================
  if (route(req, 'POST', '/api/reset')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const confirm = body.confirm;
      if (confirm !== 'RESET') {
        return json(res, 400, { ok: false, error: 'Send {"confirm":"RESET"} to confirm destructive action.' });
      }

      // Down all containers + remove volumes
      dockerCompose('down -v', 60000);

      // Keep .env but reset config and data
      try { execSync(`rm -rf ${CONFIG_DIR}/openclaw.json ${COMPOSE_DIR}/data`); } catch {}
      try { execSync(`mkdir -p ${CONFIG_DIR} ${COMPOSE_DIR}/data`); } catch {}

      // Copy default config
      try { execSync(`cp ${TEMPLATES_DIR}/anthropic.json ${CONFIG_DIR}/openclaw.json`); } catch {}

      // Replace gateway token in config
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      if (token) {
        try {
          let config = readConfig();
          config.gateway.auth.token = token;
          writeConfig(config);
        } catch {}
      }

      // Bring everything back up
      dockerCompose('up -d', 120000);
      execSync('sleep 3');
      const { status } = getContainerStatus();

      return json(res, 200, { ok: status === 'running', status, message: 'Reset complete. Config reverted to defaults.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/logs — Container logs
  // =========================================================================
  if (route(req, 'GET', '/api/logs')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines')) || 100, 1), 1000);
      const service = url.searchParams.get('service') || 'openclaw';

      const allowed = ['openclaw', 'caddy'];
      if (!allowed.includes(service)) {
        return json(res, 400, { ok: false, error: 'Invalid service. Allowed: ' + allowed.join(', ') });
      }

      const logs = dockerCompose(`logs --tail=${lines} --no-color ${service}`, 15000);
      return json(res, 200, { ok: true, service, lines, logs });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/health — Upstream health snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/health')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('health', params, { timeoutMs: Number(params.timeoutMs || params.timeout || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'health', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/gateway/status — Upstream status summary
  // =========================================================================
  if (route(req, 'GET', '/api/gateway/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('status', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/gateway/identity — Upstream gateway device identity
  // =========================================================================
  if (route(req, 'GET', '/api/gateway/identity')) {
    try {
      const result = gatewayMethod('gateway.identity.get', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'gateway.identity.get', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/heartbeat/last — Upstream last heartbeat event
  // =========================================================================
  if (route(req, 'GET', '/api/heartbeat/last')) {
    try {
      const result = gatewayMethod('last-heartbeat', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'last-heartbeat', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/heartbeat/enabled — Enable/disable upstream heartbeats
  // =========================================================================
  if (route(req, 'PUT', '/api/heartbeat/enabled')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('set-heartbeats', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'set-heartbeats', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/logs/tail — Upstream rolling log tail
  // =========================================================================
  if (route(req, 'GET', '/api/logs/tail')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('logs.tail', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'logs.tail', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/doctor/memory-status/upstream — Upstream memory doctor probe
  // =========================================================================
  if (route(req, 'GET', '/api/doctor/memory-status/upstream')) {
    try {
      const result = gatewayMethod('doctor.memory.status', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'doctor.memory.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/tts/status — Upstream TTS status
  // =========================================================================
  if (route(req, 'GET', '/api/tts/status')) {
    try {
      const result = gatewayMethod('tts.status', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'tts.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/tts/providers — Upstream TTS providers
  // =========================================================================
  if (route(req, 'GET', '/api/tts/providers')) {
    try {
      const result = gatewayMethod('tts.providers', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'tts.providers', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/tts/enable — Enable upstream TTS
  // =========================================================================
  if (route(req, 'POST', '/api/tts/enable')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('tts.enable', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'tts.enable', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/tts/disable — Disable upstream TTS
  // =========================================================================
  if (route(req, 'POST', '/api/tts/disable')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('tts.disable', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'tts.disable', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/tts/convert — Upstream text-to-speech conversion
  // =========================================================================
  if (route(req, 'POST', '/api/tts/convert')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('tts.convert', body, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'tts.convert', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/tts/provider — Upstream TTS provider selection
  // =========================================================================
  if (route(req, 'PUT', '/api/tts/provider')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('tts.setProvider', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'tts.setProvider', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/voicewake — Upstream voice wake triggers
  // =========================================================================
  if (route(req, 'GET', '/api/voicewake')) {
    try {
      const result = gatewayMethod('voicewake.get', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'voicewake.get', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/voicewake — Upstream voice wake trigger update
  // =========================================================================
  if (route(req, 'PUT', '/api/voicewake')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('voicewake.set', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'voicewake.set', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/wake — Upstream wake/cron poke
  // =========================================================================
  if (route(req, 'POST', '/api/wake')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('wake', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'wake', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/cron — Upstream cron list
  // =========================================================================
  if (route(req, 'GET', '/api/cron')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('cron.list', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'cron.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/cron/status — Upstream cron status
  // =========================================================================
  if (route(req, 'GET', '/api/cron/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('cron.status', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'cron.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/cron — Upstream cron create
  // =========================================================================
  if (route(req, 'POST', '/api/cron')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('cron.add', body, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'cron.add', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PATCH /api/cron/:id — Upstream cron update
  // =========================================================================
  if ((m = route(req, 'PATCH', '/api/cron/:id'))) {
    try {
      const body = await parseBody(req);
      const params = { id: m.params.id, ...body, patch: body.patch || body };
      const result = gatewayMethod('cron.update', params, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'cron.update', id: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/cron/:id — Upstream cron remove
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/cron/:id'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, id: m.params.id };
      const result = gatewayMethod('cron.remove', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'cron.remove', id: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/cron/:id/run — Upstream cron run enqueue
  // =========================================================================
  if ((m = route(req, 'POST', '/api/cron/:id/run'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, id: m.params.id };
      const result = gatewayMethod('cron.run', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'cron.run', id: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/cron/runs — Upstream cron run history
  // =========================================================================
  if (route(req, 'GET', '/api/cron/runs')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('cron.runs', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'cron.runs', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/devices/pairing — Upstream paired/pending devices
  // =========================================================================
  if (route(req, 'GET', '/api/devices/pairing')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('device.pair.list', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.pair.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/devices/pairing/approve — Upstream device pairing approve
  // =========================================================================
  if (route(req, 'POST', '/api/devices/pairing/approve')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('device.pair.approve', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.pair.approve', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/devices/pairing/reject — Upstream device pairing reject
  // =========================================================================
  if (route(req, 'POST', '/api/devices/pairing/reject')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('device.pair.reject', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.pair.reject', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/devices/:id/pairing — Upstream paired device removal
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/devices/:id/pairing'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, deviceId: m.params.id };
      const result = gatewayMethod('device.pair.remove', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.pair.remove', deviceId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/devices/:id/tokens/rotate — Upstream device token rotate
  // =========================================================================
  if ((m = route(req, 'POST', '/api/devices/:id/tokens/rotate'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, deviceId: m.params.id };
      const result = gatewayMethod('device.token.rotate', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.token.rotate', deviceId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/devices/:id/tokens/revoke — Upstream device token revoke
  // =========================================================================
  if ((m = route(req, 'POST', '/api/devices/:id/tokens/revoke'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, deviceId: m.params.id };
      const result = gatewayMethod('device.token.revoke', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'device.token.revoke', deviceId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/wizard/start — Upstream wizard start
  // =========================================================================
  if (route(req, 'POST', '/api/wizard/start')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('wizard.start', body, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'wizard.start', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/wizard/next — Upstream wizard advance/answer
  // =========================================================================
  if (route(req, 'POST', '/api/wizard/next')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('wizard.next', body, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'wizard.next', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/wizard/cancel — Upstream wizard cancel
  // =========================================================================
  if (route(req, 'POST', '/api/wizard/cancel')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('wizard.cancel', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'wizard.cancel', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/wizard/status — Upstream wizard status lookup
  // =========================================================================
  if (route(req, 'POST', '/api/wizard/status')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('wizard.status', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'wizard.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/wizard/:sessionId — Upstream wizard status lookup
  // =========================================================================
  if ((m = route(req, 'GET', '/api/wizard/:sessionId'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const queryParams = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const params = { ...queryParams, sessionId: m.params.sessionId };
      const result = gatewayMethod('wizard.status', params, { timeoutMs: Number(queryParams.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'wizard.status', sessionId: m.params.sessionId, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/exec-approvals — Upstream execution approvals file
  // =========================================================================
  if (route(req, 'GET', '/api/exec-approvals')) {
    try {
      const result = gatewayMethod('exec.approvals.get', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'exec.approvals.get', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/exec-approvals — Upstream execution approvals file update
  // =========================================================================
  if (route(req, 'PUT', '/api/exec-approvals')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('exec.approvals.set', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'exec.approvals.set', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/nodes/:id/exec-approvals — Upstream node execution approvals
  // =========================================================================
  if ((m = route(req, 'GET', '/api/nodes/:id/exec-approvals'))) {
    try {
      const result = gatewayMethod('exec.approvals.node.get', { nodeId: m.params.id }, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'exec.approvals.node.get', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/nodes/:id/exec-approvals — Upstream node execution approvals update
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/nodes/:id/exec-approvals'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, nodeId: m.params.id };
      const result = gatewayMethod('exec.approvals.node.set', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'exec.approvals.node.set', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/browser/request — Upstream browser request bridge
  // =========================================================================
  if (route(req, 'POST', '/api/browser/request')) {
    try {
      const body = await parseBody(req);
      const method = typeof body.method === 'string' ? body.method.trim().toUpperCase() : '';
      if (!method || !['GET', 'POST', 'DELETE'].includes(method)) {
        return json(res, 400, { ok: false, error: 'method must be GET, POST, or DELETE' });
      }
      if (!body.path || typeof body.path !== 'string') {
        return json(res, 400, { ok: false, error: 'path is required' });
      }
      const params = { ...body, method };
      const result = gatewayMethod('browser.request', params, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'browser.request', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/chat/:sessionKey/history — Upstream chat history snapshot
  // =========================================================================
  if ((m = route(req, 'GET', '/api/chat/:sessionKey/history'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const queryParams = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const params = { ...queryParams, sessionKey: m.params.sessionKey };
      const result = gatewayMethod('chat.history', params, { timeoutMs: Number(queryParams.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'chat.history', sessionKey: m.params.sessionKey, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/chat/send — Upstream chat send
  // =========================================================================
  if (route(req, 'POST', '/api/chat/send')) {
    try {
      const body = await parseBody(req);
      const params = {
        ...body,
        idempotencyKey: body.idempotencyKey || crypto.randomUUID()
      };
      const result = gatewayMethod('chat.send', params, { timeoutMs: Number(body.timeoutMs || 120000) || 120000 });
      return json(res, 200, {
        ok: true,
        method: 'chat.send',
        sessionKey: params.sessionKey,
        idempotencyKey: params.idempotencyKey,
        result
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/chat/:sessionKey/abort — Upstream chat abort
  // =========================================================================
  if ((m = route(req, 'POST', '/api/chat/:sessionKey/abort'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, sessionKey: m.params.sessionKey };
      const result = gatewayMethod('chat.abort', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'chat.abort', sessionKey: m.params.sessionKey, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/providers — List tat ca providers (built-in + custom)
  // =========================================================================
  if (route(req, 'GET', '/api/providers')) {
    try {
      const config = readConfig();
      const currentModel = config.agents?.defaults?.model?.primary || '';
      const currentProvider = currentModel.split('/')[0];

      const providers = [];

      // Built-in providers
      for (const [id, p] of Object.entries(PROVIDERS)) {
        const envVal = getEnvValue(p.envKey);
        const profileVal = getAuthProfileApiKey(p.authProfileProvider);
        const val = envVal || profileVal;

        // Read models from template config
        let tplModels = [];
        let defaultModel = null;
        try {
          const tpl = JSON.parse(fs.readFileSync(p.configTemplate, 'utf8'));
          defaultModel = tpl.agents?.defaults?.model?.primary || null;
          const tplProviders = tpl.models?.providers || {};
          for (const prov of Object.values(tplProviders)) {
            if (Array.isArray(prov.models)) tplModels = prov.models;
          }
        } catch {}

        // Merge: template models + knownModels (deduplicate by id)
        const knownModels = p.knownModels || [];
        const seen = new Set();
        const models = [];
        for (const m of [...tplModels, ...knownModels]) {
          if (!seen.has(m.id)) { seen.add(m.id); models.push(m); }
        }

        providers.push({
          id,
          name: p.name,
          type: 'built-in',
          active: currentProvider === id || currentProvider === resolveProvider(id),
          defaultModel,
          models,
          apiKey: val ? sanitizeKey(val) : null
        });
      }

      // Custom providers (from template files)
      try {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const name = file.replace('.json', '');
          if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
          try {
            const tpl = JSON.parse(fs.readFileSync(`${TEMPLATES_DIR}/${file}`, 'utf8'));
            const provKey = Object.keys(tpl.models?.providers || {})[0];
            if (!provKey) continue;
            const p = tpl.models.providers[provKey];
            const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
            const envVal = getEnvValue(envKey);
            const profileVal = getAuthProfileApiKey(name);
            const val = envVal || profileVal;
            providers.push({
              id: name,
              name: name,
              type: 'custom',
              active: currentProvider === name,
              defaultModel: tpl.agents?.defaults?.model?.primary || null,
              baseUrl: p.baseUrl,
              api: p.api,
              models: p.models || [],
              apiKey: val ? sanitizeKey(val) : null
            });
          } catch {}
        }
      } catch {}

      return json(res, 200, { ok: true, activeModel: currentModel, providers });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config — Xem config hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/config')) {
    try {
      const config = readConfig();
      const model = config.agents?.defaults?.model?.primary || 'unknown';
      const providerName = model.split('/')[0];

      const apiKeys = {};
      for (const [id, p] of Object.entries(PROVIDERS)) {
        const envVal = getEnvValue(p.envKey);
        const profileVal = getAuthProfileApiKey(p.authProfileProvider);
        const val = envVal || profileVal;
        apiKeys[id] = val ? sanitizeKey(val) : null;
      }

      // Include custom providers (from template files)
      try {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const name = file.replace('.json', '');
          if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
          const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
          const envVal = getEnvValue(envKey);
          const profileVal = getAuthProfileApiKey(name);
          const val = envVal || profileVal;
          apiKeys[name] = val ? sanitizeKey(val) : null;
        }
      } catch {}

      const agentsList = getAgentsList(config);

      return json(res, 200, {
        ok: true,
        provider: providerName,
        model,
        apiKeys,
        agents: agentsList.map(a => ({ id: a.id, name: a.name || a.id, default: !!a.default, model: a.model || null })),
        bindings: getBindings(config),
        config: {
          agents: config.agents,
          channels: config.channels ? Object.fromEntries(
            Object.entries(config.channels).map(([k, v]) => [k, { ...v, botToken: v.botToken ? '***' : undefined }])
          ) : undefined,
          plugins: config.plugins,
          gateway: { ...config.gateway, auth: { token: '***' } },
          browser: config.browser
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/schema — Flattened config schema/sample overview
  // =========================================================================
  if (route(req, 'GET', '/api/config/schema')) {
    try {
      const schemaSample = getConfigSchemaSample();
      const flattened = flattenConfigSchema(schemaSample);
      return json(res, 200, {
        ok: true,
        count: flattened.length,
        schema: flattened,
        roots: Object.keys(schemaSample || {})
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/schema/lookup?path=... — Lookup config value/schema path
  // =========================================================================
  if (route(req, 'GET', '/api/config/schema/lookup')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = (url.searchParams.get('path') || '').trim();
      if (!path) {
        return json(res, 400, { ok: false, error: 'Missing query parameter: path' });
      }

      const config = readConfig();
      const live = getValueAtPath(config, path);
      const schema = getValueAtPath(getConfigSchemaSample(), path);

      return json(res, 200, {
        ok: true,
        path,
        existsInConfig: live.exists,
        existsInSchema: schema.exists,
        value: live.exists ? redactSensitiveData(live.value, path.split('.').slice(-1)[0]) : null,
        schemaValue: schema.exists ? redactSensitiveData(schema.value, path.split('.').slice(-1)[0]) : null,
        type: live.exists ? (Array.isArray(live.value) ? 'array' : typeof live.value) : (schema.exists ? (Array.isArray(schema.value) ? 'array' : typeof schema.value) : null)
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PATCH /api/config — Deep-merge patch into openclaw.json
  // =========================================================================
  if (route(req, 'PATCH', '/api/config')) {
    try {
      const body = await parseBody(req);
      const patch = body.patch && isPlainObject(body.patch) ? body.patch : body;
      if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
        return json(res, 400, { ok: false, error: 'Missing patch object' });
      }

      const config = readConfig();
      const merged = deepMerge(config, patch);

      if (merged.gateway?.auth?.token === '***') {
        merged.gateway.auth.token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || config.gateway?.auth?.token || '';
      }

      writeConfig(merged);
      if (body.restart !== false) restartContainer('openclaw');

      return json(res, 200, {
        ok: true,
        restarted: body.restart !== false,
        updatedKeys: Object.keys(patch),
        config: redactSensitiveData(merged)
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/raw — Set/delete a value by dot path
  // =========================================================================
  if (route(req, 'PUT', '/api/config/raw')) {
    try {
      const body = await parseBody(req);
      const path = (body.path || '').trim();
      if (!path) return json(res, 400, { ok: false, error: 'Missing path' });

      const config = readConfig();
      const before = getValueAtPath(config, path);
      let changed = false;

      if (body.remove === true) {
        changed = deleteValueAtPath(config, path);
        if (!changed) return json(res, 404, { ok: false, error: `Path not found: ${path}` });
      } else if (body.value === undefined) {
        return json(res, 400, { ok: false, error: 'Missing value or set remove=true' });
      } else {
        setValueAtPath(config, path, body.value);
        changed = true;
      }

      writeConfig(config);
      if (body.restart !== false) restartContainer('openclaw');

      return json(res, 200, {
        ok: true,
        path,
        restarted: body.restart !== false,
        previousValue: before.exists ? redactSensitiveData(before.value, path.split('.').slice(-1)[0]) : null,
        currentValue: body.remove === true ? null : redactSensitiveData(getValueAtPath(config, path).value, path.split('.').slice(-1)[0])
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/apply — Persist config and optionally restart services
  // =========================================================================
  if (route(req, 'POST', '/api/config/apply')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const restartTarget = body.restartTarget || 'openclaw';
      const allowedTargets = ['openclaw', 'caddy', 'all', 'none'];
      if (!allowedTargets.includes(restartTarget)) {
        return json(res, 400, { ok: false, error: `Invalid restartTarget. Use: ${allowedTargets.join(', ')}` });
      }

      if (restartTarget === 'openclaw') restartContainer('openclaw');
      if (restartTarget === 'caddy') dockerCompose('restart caddy', 30000);
      if (restartTarget === 'all') dockerCompose('up -d --remove-orphans', 120000);

      return json(res, 200, {
        ok: true,
        applied: true,
        restartTarget,
        message: restartTarget === 'none' ? 'Configuration persisted without restart.' : `Configuration applied and ${restartTarget} restart triggered.`
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/file — Raw config file with basic metadata
  // =========================================================================
  if (route(req, 'GET', '/api/config/file')) {
    try {
      const content = readEnvFile ? fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8') : fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8');
      const stats = fs.statSync(`${CONFIG_DIR}/openclaw.json`);
      return json(res, 200, {
        ok: true,
        path: `${CONFIG_DIR}/openclaw.json`,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        content
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/provider — Doi provider + model
  // =========================================================================
  if (route(req, 'PUT', '/api/config/provider')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, model } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];

      // Check if it's a custom provider (from template file)
      let config;
      try { config = readConfig(); } catch { config = {}; }
      const customTplPath = `${TEMPLATES_DIR}/${provider}.json`;
      const hasCustomTemplate = !providerConfig && fs.existsSync(customTplPath);

      if (!providerConfig && !hasCustomTemplate) {
        // List available: built-in + custom from template files
        let customNames = [];
        try {
          customNames = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).filter(n => !PROVIDERS[n] && !PROVIDERS[resolveProvider(n)]);
        } catch {}
        const all = [...Object.keys(PROVIDERS), ...customNames];
        return json(res, 400, { ok: false, error: 'Invalid provider. Use: ' + all.join(', ') });
      }

      // --- Custom provider: load template and switch ---
      if (!providerConfig && hasCustomTemplate) {
        if (!model) return json(res, 400, { ok: false, error: 'Missing model. Use format: provider/model-id' });

        const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
        const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';

        config.agents = customTpl.agents || config.agents;
        config.agents.defaults.model.primary = model.includes('/') ? model : `${provider}/${model}`;

        // Merge custom provider's models.providers into active config
        if (customTpl.models?.providers) {
          if (!config.models) config.models = { mode: 'merge', providers: {} };
          if (!config.models.providers) config.models.providers = {};
          config.models.mode = 'merge';
          Object.assign(config.models.providers, customTpl.models.providers);
        }

        config.gateway = { ...(customTpl.gateway || {}), ...(config.gateway || {}) };
        config.gateway.auth = { token };
        if (!config.browser) config.browser = customTpl.browser;

        writeConfig(config);
        restartContainer('openclaw');
        return json(res, 200, { ok: true, provider, model: config.agents.defaults.model.primary });
      }

      // --- Built-in provider ---
      const templatePath = providerConfig.configTemplate;
      if (!fs.existsSync(templatePath)) {
        return json(res, 500, { ok: false, error: `Template config not found: ${templatePath}` });
      }

      const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';

      // Update model from template or body
      if (!config.agents) config.agents = template.agents;
      // Normalize model prefix (e.g. gemini/model → google/model)
      let finalModel = model || template.agents.defaults.model.primary;
      if (finalModel && finalModel.includes('/')) {
        const [prefix, ...rest] = finalModel.split('/');
        finalModel = `${resolveProvider(prefix)}/${rest.join('/')}`;
      }
      config.agents.defaults.model.primary = finalModel;

      // Merge gateway: keep existing settings, ensure auth token is correct
      config.gateway = { ...template.gateway, ...(config.gateway || {}) };
      config.gateway.auth = { token };
      // Deep merge controlUi from template (ensure new required fields are always present)
      config.gateway.controlUi = { ...template.gateway.controlUi, ...(config.gateway.controlUi || {}) };

      // Preserve browser from template if not set
      if (!config.browser) config.browser = template.browser;

      // Copy models section from template
      // Custom providers are stored in template files, no need to preserve in active config
      if (template.models) {
        config.models = template.models;
      } else {
        delete config.models;
      }

      // Write auth-profiles.json if there's an API key in env for this provider
      const authProvider = providerConfig.authProfileProvider;
      const existingKey = getEnvValue(providerConfig.envKey);
      if (existingKey) {
        setAuthProfileApiKey(authProvider, existingKey);
      }

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, model: config.agents.defaults.model.primary });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/api-key — Doi API key
  // =========================================================================
  if (route(req, 'PUT', '/api/config/api-key')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, apiKey, agentId } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!apiKey) return json(res, 400, { ok: false, error: 'Missing apiKey' });
      if (agentId && !isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });

      const targetAgent = agentId || 'main';

      // 1. Set env var (as fallback) — only for default/main agent
      if (!agentId || agentId === 'main') {
        setEnvValue(providerConfig.envKey, apiKey);
      }

      // 2. Write auth-profiles.json for the target agent
      setAuthProfileApiKey(providerConfig.authProfileProvider, apiKey, targetAgent);

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, agentId: targetAgent, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/config/api-key — Xoa API key
  // =========================================================================
  if (route(req, 'DELETE', '/api/config/api-key')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, agentId } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (agentId && !isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });

      const targetAgent = agentId || 'main';

      // 1. Remove from auth-profiles.json
      removeAgentApiKey(targetAgent, providerConfig.authProfileProvider);

      // 2. Remove env var (only for default/main agent)
      if (!agentId || agentId === 'main') {
        removeEnvValue(providerConfig.envKey);
      }

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, agentId: targetAgent, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/test-key — Test API key
  // =========================================================================
  if (route(req, 'POST', '/api/config/test-key')) {
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[resolveProvider(body.provider)];
      if (!provider) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const ok = provider.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key invalid or expired' });
    } catch { return json(res, 500, { ok: false, error: 'Error testing API key' }); }
  }

  // =========================================================================
  // POST /api/config/custom-provider — Tao custom provider moi (tao template file)
  // =========================================================================
  if (route(req, 'POST', '/api/config/custom-provider')) {
    try {
      const body = await parseBody(req);
      const { baseUrl, model, modelName, apiKey, api } = body;

      if (!baseUrl || !model || !apiKey) {
        return json(res, 400, { ok: false, error: 'Missing required fields: baseUrl, model, apiKey' });
      }

      const parts = model.split('/');
      if (parts.length < 2) {
        return json(res, 400, { ok: false, error: 'Model must be in format "provider/model-id"' });
      }
      const providerName = parts[0];
      const modelId = parts.slice(1).join('/');

      if (!/^[a-z][a-z0-9-]{0,31}$/.test(providerName)) {
        return json(res, 400, { ok: false, error: 'Invalid provider name. Use lowercase letters, numbers, hyphens.' });
      }

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider. Use PUT /api/config/provider instead.` });
      }

      try { new URL(baseUrl); } catch {
        return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
      }

      const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;

      // Create or update template file
      let tpl = {};
      try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}

      // Build template like built-in config
      tpl.agents = { defaults: { model: { primary: model }, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
      if (!tpl.models) tpl.models = { mode: 'merge', providers: {} };
      tpl.models.mode = 'merge';
      if (!tpl.models.providers[providerName]) {
        tpl.models.providers[providerName] = {
          baseUrl,
          apiKey: `\${${envKey}}`,
          api: api || 'openai-completions',
          models: [{ id: modelId, name: modelName || modelId }]
        };
      } else {
        const p = tpl.models.providers[providerName];
        p.baseUrl = baseUrl;
        if (api) p.api = api;
        if (!p.models) p.models = [];
        if (!p.models.find(m => m.id === modelId)) {
          p.models.push({ id: modelId, name: modelName || modelId });
        }
      }
      tpl.gateway = { mode: 'local', bind: 'lan', auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' }, trustedProxies: ['172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16'], controlUi: { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: true } };
      tpl.browser = { headless: true, defaultProfile: 'openclaw', noSandbox: true };

      fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');

      // Save API key
      setEnvValue(envKey, apiKey);
      setAuthProfileApiKey(providerName, apiKey);

      // Switch to this provider (load template into active config)
      const config = readConfig();
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      config.agents = tpl.agents;
      config.models = JSON.parse(JSON.stringify(tpl.models));
      config.models.providers[providerName].apiKey = `\${${envKey}}`;
      config.gateway = { ...tpl.gateway, ...(config.gateway || {}) };
      config.gateway.auth = { token };
      if (!config.browser) config.browser = tpl.browser;
      writeConfig(config);

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider: providerName, model, baseUrl, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/custom-providers — List custom providers (from template files)
  // =========================================================================
  if (route(req, 'GET', '/api/config/custom-providers')) {
    try {
      const customProviders = {};
      const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace('.json', '');
        if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
        try {
          const tpl = JSON.parse(fs.readFileSync(`${TEMPLATES_DIR}/${file}`, 'utf8'));
          const provKey = Object.keys(tpl.models?.providers || {})[0];
          if (!provKey) continue;
          const p = tpl.models.providers[provKey];
          const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
          const keyVal = getEnvValue(envKey) || getAuthProfileApiKey(name);
          customProviders[name] = {
            baseUrl: p.baseUrl,
            api: p.api,
            models: p.models || [],
            apiKey: keyVal ? sanitizeKey(keyVal) : null
          };
        } catch {}
      }

      const config = readConfig();
      const currentModel = config.agents?.defaults?.model?.primary || '';
      const currentProvider = currentModel.split('/')[0];

      return json(res, 200, { ok: true, providers: customProviders, activeProvider: currentProvider, activeModel: currentModel });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/custom-provider/:provider — Update custom provider (template file)
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/config/custom-provider/:provider'))) {
    try {
      const providerName = m.params.provider;
      const body = await parseBody(req);

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider.` });
      }

      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      let tpl;
      try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      const provKey = Object.keys(tpl.models?.providers || {})[0];
      if (!provKey) return json(res, 404, { ok: false, error: `Custom provider "${providerName}" has no config` });
      const p = tpl.models.providers[provKey];

      if (body.baseUrl) {
        try { new URL(body.baseUrl); } catch {
          return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
        }
        p.baseUrl = body.baseUrl;
      }
      if (body.api) p.api = body.api;

      if (body.model) {
        const modelId = body.model.includes('/') ? body.model.split('/').slice(1).join('/') : body.model;
        if (!p.models) p.models = [];
        if (!p.models.find(m => m.id === modelId)) {
          p.models.push({ id: modelId, name: body.modelName || modelId });
        }
      }

      if (body.apiKey) {
        const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        setEnvValue(envKey, body.apiKey);
        setAuthProfileApiKey(providerName, body.apiKey);
      }

      fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');

      // Also update active config if this provider is currently in use
      try {
        const config = readConfig();
        if (config.models?.providers?.[providerName]) {
          config.models.providers[providerName] = { ...p };
          writeConfig(config);
          restartContainer('openclaw');
        }
      } catch {}

      return json(res, 200, { ok: true, provider: providerName, config: { baseUrl: p.baseUrl, api: p.api, models: p.models } });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/config/custom-provider/:provider — Xoa custom provider
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/config/custom-provider/:provider'))) {
    try {
      const providerName = m.params.provider;

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider. Cannot delete.` });
      }

      // Check template file exists
      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(tplPath)) {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      // Delete template file
      fs.unlinkSync(tplPath);

      // Remove from active config if present
      let config;
      try { config = readConfig(); } catch { config = {}; }

      if (config.models?.providers?.[providerName]) {
        delete config.models.providers[providerName];
        if (Object.keys(config.models.providers).length === 0) {
          delete config.models;
        }
      }

      // If current model uses this provider, fallback to anthropic
      const currentModel = config.agents?.defaults?.model?.primary || '';
      if (currentModel.startsWith(providerName + '/')) {
        config.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-20250514';
      }

      writeConfig(config);

      // Remove env var + auth profile
      const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      try { removeEnvValue(envKey); } catch {}
      try { removeAgentApiKey('main', providerName); } catch {}

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider: providerName, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/providers/:provider/models — Them model vao provider
  // =========================================================================
  if ((m = route(req, 'POST', '/api/providers/:provider/models'))) {
    try {
      const body = await parseBody(req);
      const providerName = m.params.provider;
      const { id: modelId, name: modelName } = body;

      if (!modelId) return json(res, 400, { ok: false, error: 'Missing model id' });

      const config = readConfig();

      // For built-in providers: add to template config file
      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        const resolved = PROVIDERS[providerName] ? providerName : resolveProvider(providerName);
        const p = PROVIDERS[resolved];
        const tplPath = p.configTemplate;
        let tpl = {};
        try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}
        // Find models array in template (models.providers.<key>.models or knownModels)
        const provKey = Object.keys(tpl.models?.providers || {})[0];
        const modelsList = provKey ? tpl.models.providers[provKey].models : null;
        if (!modelsList) {
          // No models in template — add models section
          if (!tpl.models) tpl.models = { mode: 'merge', providers: {} };
          if (!tpl.models.providers) tpl.models.providers = {};
          if (!tpl.models.providers[resolved]) tpl.models.providers[resolved] = { models: [] };
          tpl.models.providers[resolved].models = [{ id: modelId, name: modelName || modelId }];
        } else {
          if (modelsList.find(m => m.id === modelId)) {
            return json(res, 409, { ok: false, error: `Model "${modelId}" already exists` });
          }
          modelsList.push({ id: modelId, name: modelName || modelId });
        }
        fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');
        return json(res, 200, { ok: true, provider: resolved, model: { id: modelId, name: modelName || modelId } });
      }

      // For custom providers: add to template file
      const customTplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(customTplPath)) {
        return json(res, 404, { ok: false, error: `Provider "${providerName}" not found` });
      }
      const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
      const provKey = Object.keys(customTpl.models?.providers || {})[0];
      if (!provKey) return json(res, 404, { ok: false, error: `Provider "${providerName}" has no config` });
      const customProv = customTpl.models.providers[provKey];
      if (!customProv.models) customProv.models = [];
      if (customProv.models.find(m => m.id === modelId)) {
        return json(res, 409, { ok: false, error: `Model "${modelId}" already exists` });
      }
      customProv.models.push({ id: modelId, name: modelName || modelId });
      fs.writeFileSync(customTplPath, JSON.stringify(customTpl, null, 2), 'utf8');

      // Also update active config if provider is in use
      if (config.models?.providers?.[providerName]) {
        if (!config.models.providers[providerName].models) config.models.providers[providerName].models = [];
        config.models.providers[providerName].models.push({ id: modelId, name: modelName || modelId });
        writeConfig(config);
      }

      return json(res, 200, { ok: true, provider: providerName, model: { id: modelId, name: modelName || modelId } });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/providers/:provider/models/:modelId — Xoa model khoi provider
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/providers/:provider/models/:modelId'))) {
    try {
      const providerName = m.params.provider;
      const modelId = decodeURIComponent(m.params.modelId);

      const config = readConfig();

      // For built-in providers: remove from template config file
      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        const resolved = PROVIDERS[providerName] ? providerName : resolveProvider(providerName);
        const p = PROVIDERS[resolved];
        const tplPath = p.configTemplate;
        let tpl = {};
        try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}
        const provKey = Object.keys(tpl.models?.providers || {})[0];
        const modelsList = provKey ? tpl.models.providers[provKey].models : null;
        if (!modelsList) return json(res, 404, { ok: false, error: 'No models found for this provider' });
        const idx = modelsList.findIndex(m => m.id === modelId);
        if (idx === -1) return json(res, 404, { ok: false, error: 'Model not found' });
        modelsList.splice(idx, 1);
        fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');
        return json(res, 200, { ok: true, provider: resolved, removedModel: modelId });
      }

      // For custom providers: remove from template file
      const customTplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(customTplPath)) return json(res, 404, { ok: false, error: `Provider "${providerName}" not found` });
      const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
      const cProvKey = Object.keys(customTpl.models?.providers || {})[0];
      if (!cProvKey) return json(res, 404, { ok: false, error: 'No models found for this provider' });
      const cModels = customTpl.models.providers[cProvKey].models;
      if (!cModels) return json(res, 404, { ok: false, error: 'Model not found' });
      const idx = cModels.findIndex(m => m.id === modelId);
      if (idx === -1) return json(res, 404, { ok: false, error: 'Model not found' });
      cModels.splice(idx, 1);
      fs.writeFileSync(customTplPath, JSON.stringify(customTpl, null, 2), 'utf8');

      // Also update active config if provider is in use
      if (config.models?.providers?.[providerName]?.models) {
        const aIdx = config.models.providers[providerName].models.findIndex(m => m.id === modelId);
        if (aIdx !== -1) {
          config.models.providers[providerName].models.splice(aIdx, 1);
          writeConfig(config);
        }
      }

      return json(res, 200, { ok: true, provider: providerName, removedModel: modelId });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels — List kenh nhan tin
  // =========================================================================
  if (route(req, 'GET', '/api/channels')) {
    try {
      let configChannels = {};
      try { configChannels = readConfig().channels || {}; } catch {}

      const channels = {};
      for (const [name, ch] of Object.entries(CHANNEL_MAP)) {
        const configCh = configChannels[ch.configKey] || {};
        const envVal = getEnvValue(ch.envKey);
        const tokenVal = configCh[ch.tokenField] || envVal;
        channels[name] = {
          configured: !!(tokenVal && configCh.enabled),
          enabled: !!configCh.enabled,
          token: tokenVal ? sanitizeKey(tokenVal) : null
        };
      }
      return json(res, 200, { ok: true, channels });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels/status — Upstream gateway channel status snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/channels/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('channels.status', params, { timeoutMs: Number(params.timeout || 20000) || 20000 });
      return json(res, 200, { ok: true, method: 'channels.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/channels/logout — Upstream gateway logout for channel/account
  // =========================================================================
  if (route(req, 'POST', '/api/channels/logout')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('channels.logout', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'channels.logout', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/channels/:channel/logout — Convenience wrapper with channel path
  // =========================================================================
  if ((m = route(req, 'POST', '/api/channels/:channel/logout'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, channel: m.params.channel };
      const result = gatewayMethod('channels.logout', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'channels.logout', channel: m.params.channel, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/channels/:channel — Them/sua token kenh
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/channels/:channel'))) {
    try {
      const body = await parseBody(req);
      const channel = m.params.channel;

      const chConfig = CHANNEL_MAP[channel];
      if (!chConfig) {
        return json(res, 400, { ok: false, error: 'Invalid channel. Use: telegram, discord, slack, zalo' });
      }
      if (!body.token) return json(res, 400, { ok: false, error: 'Missing token' });

      // 1. Set env var (as fallback)
      setEnvValue(chConfig.envKey, body.token);
      if (channel === 'slack' && body.appToken) {
        setEnvValue('SLACK_APP_TOKEN', body.appToken);
      }

      // 2. Write channel config in openclaw.json
      const config = readConfig();
      if (!config.channels) config.channels = {};
      config.channels[chConfig.configKey] = {
        enabled: true,
        [chConfig.tokenField]: body.token,
        dmPolicy: body.dmPolicy || 'open',
        allowFrom: ['*']
      };

      // 3. Enable plugin if needed (telegram is built-in, others need plugin)
      if (['zalo', 'discord', 'slack'].includes(channel)) {
        if (!config.plugins) config.plugins = { entries: {} };
        if (!config.plugins.entries) config.plugins.entries = {};
        config.plugins.entries[channel] = { enabled: true };
      }

      writeConfig(config);
      restartContainer('openclaw');
      return json(res, 200, { ok: true, channel, token: sanitizeKey(body.token) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/channels/:channel — Xoa kenh
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/channels/:channel'))) {
    try {
      const channel = m.params.channel;
      const chConfig = CHANNEL_MAP[channel];
      if (!chConfig) return json(res, 400, { ok: false, error: 'Invalid channel' });

      // 1. Remove env var
      removeEnvValue(chConfig.envKey);
      if (channel === 'slack') removeEnvValue('SLACK_APP_TOKEN');

      // 2. Remove channel config from openclaw.json
      try {
        const config = readConfig();
        if (config.channels && config.channels[chConfig.configKey]) {
          delete config.channels[chConfig.configKey];
        }
        if (config.plugins?.entries?.[channel]) {
          delete config.plugins.entries[channel];
        }
        writeConfig(config);
      } catch {}

      restartContainer('openclaw');
      return json(res, 200, { ok: true, channel, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/models — Upstream model catalog
  // =========================================================================
  if (route(req, 'GET', '/api/models')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('models.list', params, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'models.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/tools/catalog — Upstream tool catalog
  // =========================================================================
  if (route(req, 'GET', '/api/tools/catalog')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('tools.catalog', params, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'tools.catalog', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/usage/status — Upstream usage/provider status
  // =========================================================================
  if (route(req, 'GET', '/api/usage/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('usage.status', params, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'usage.status', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/usage/cost — Upstream usage cost summary
  // =========================================================================
  if (route(req, 'GET', '/api/usage/cost')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('usage.cost', params, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'usage.cost', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/skills/install — Upstream skill install wrapper
  // =========================================================================
  if (route(req, 'POST', '/api/skills/install')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('skills.install', body, { timeoutMs: Number(body.timeoutMs || 120000) || 120000, expectFinal: body.expectFinal === true });
      return json(res, 200, { ok: true, method: 'skills.install', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/sessions — Upstream session listing
  // =========================================================================
  if (route(req, 'GET', '/api/sessions')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('sessions.list', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'sessions.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/sessions/:key/preview — Upstream session preview
  // =========================================================================
  if ((m = route(req, 'GET', '/api/sessions/:key/preview'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams({ ...Object.fromEntries(url.searchParams), key: m.params.key });
      const result = gatewayMethod('sessions.preview', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'sessions.preview', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/sessions — Upstream session creation
  // =========================================================================
  if (route(req, 'POST', '/api/sessions')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('sessions.create', body, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'sessions.create', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/sessions/:key/send — Upstream session send
  // =========================================================================
  if ((m = route(req, 'POST', '/api/sessions/:key/send'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.send', params, {
        timeoutMs: Number(body.timeoutMs || 120000) || 120000,
        expectFinal: body.expectFinal === true
      });
      return json(res, 200, { ok: true, method: 'sessions.send', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/sessions/:key/abort — Upstream session abort
  // =========================================================================
  if ((m = route(req, 'POST', '/api/sessions/:key/abort'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.abort', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'sessions.abort', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PATCH /api/sessions/:key — Upstream session patch
  // =========================================================================
  if ((m = route(req, 'PATCH', '/api/sessions/:key'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.patch', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'sessions.patch', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/sessions/:key/reset — Upstream session reset
  // =========================================================================
  if ((m = route(req, 'POST', '/api/sessions/:key/reset'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.reset', params, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'sessions.reset', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/sessions/:key — Upstream session delete
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/sessions/:key'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.delete', params, { timeoutMs: Number(body.timeoutMs || 60000) || 60000 });
      return json(res, 200, { ok: true, method: 'sessions.delete', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/sessions/:key/compact — Upstream session compaction
  // =========================================================================
  if ((m = route(req, 'POST', '/api/sessions/:key/compact'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, key: m.params.key };
      const result = gatewayMethod('sessions.compact', params, { timeoutMs: Number(body.timeoutMs || 120000) || 120000 });
      return json(res, 200, { ok: true, method: 'sessions.compact', key: m.params.key, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/nodes/pairing — Upstream node pairing snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/nodes/pairing')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('node.pair.list', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pair.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pairing/request — Upstream node pairing request
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pairing/request')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('node.pair.request', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pair.request', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pairing/approve — Upstream node pairing approve
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pairing/approve')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pair.approve', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pair.approve', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pairing/reject — Upstream node pairing reject
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pairing/reject')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pair.reject', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pair.reject', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pairing/verify — Upstream node pairing verify
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pairing/verify')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pair.verify', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pair.verify', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pending/drain — Upstream pending node queue drain
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pending/drain')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('node.pending.drain', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pending.drain', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pending/enqueue — Upstream pending node queue enqueue
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pending/enqueue')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pending.enqueue', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pending.enqueue', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pending/pull — Upstream pending node queue pull
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pending/pull')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pending.pull', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pending.pull', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/pending/ack — Upstream pending node queue ack
  // =========================================================================
  if (route(req, 'POST', '/api/nodes/pending/ack')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('node.pending.ack', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.pending.ack', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/nodes — Upstream node list
  // =========================================================================
  if (route(req, 'GET', '/api/nodes')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('node.list', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.list', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/nodes/:id — Upstream node describe
  // =========================================================================
  if ((m = route(req, 'GET', '/api/nodes/:id'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams({ ...Object.fromEntries(url.searchParams), nodeId: m.params.id });
      const result = gatewayMethod('node.describe', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.describe', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/nodes/:id/rename — Upstream node rename
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/nodes/:id/rename'))) {
    try {
      const body = await parseBody(req);
      const params = { nodeId: m.params.id, ...body };
      if (!params.displayName && params.name) params.displayName = params.name;
      const result = gatewayMethod('node.rename', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'node.rename', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/:id/invoke — Upstream node invoke
  // =========================================================================
  if ((m = route(req, 'POST', '/api/nodes/:id/invoke'))) {
    try {
      const body = await parseBody(req);
      const params = { nodeId: m.params.id, ...body };
      const result = gatewayMethod('node.invoke', params, {
        timeoutMs: Number(body.timeoutMs || body.invokeTimeout || 60000) || 60000,
        expectFinal: body.expectFinal === true
      });
      return json(res, 200, { ok: true, method: 'node.invoke', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/skills — List available skills across workspace/managed roots
  // =========================================================================
  if (route(req, 'GET', '/api/skills')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      if (agentId !== 'main' && !isValidAgentId(agentId)) {
        return json(res, 400, { ok: false, error: 'Invalid agentId' });
      }

      const config = readConfig();
      const result = listAvailableSkills(config, agentId);
      return json(res, 200, {
        ok: true,
        agentId,
        roots: result.roots,
        count: result.skills.length,
        skills: result.skills.map(skill => ({
          skillKey: skill.skillKey,
          title: skill.title,
          description: skill.description,
          source: skill.source,
          path: skill.path,
          directory: skill.directoryName,
          requiredBins: skill.requiredBins,
          enabled: skill.configEntry?.enabled !== false,
          configEntry: redactSensitiveData(skill.configEntry),
          metadata: skill.metadata
        }))
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/skills/status — Skill status summary for an agent
  // =========================================================================
  if (route(req, 'GET', '/api/skills/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const config = readConfig();
      const result = listAvailableSkills(config, agentId);
      const skillsConfig = config.skills || {};
      return json(res, 200, {
        ok: true,
        agentId,
        workspaceSkillsDir: getWorkspaceSkillsDir(config, agentId),
        managedSkillsDir: getManagedSkillsDir(),
        extraDirs: getExtraSkillDirs(config),
        allowBundled: skillsConfig.allowBundled || null,
        watch: skillsConfig.load?.watch !== false,
        watchDebounceMs: skillsConfig.load?.watchDebounceMs || 250,
        install: skillsConfig.install || { preferBrew: true, nodeManager: 'npm' },
        totalSkills: result.skills.length,
        enabledSkills: result.skills.filter(skill => skill.configEntry?.enabled !== false).length,
        disabledSkills: result.skills.filter(skill => skill.configEntry?.enabled === false).map(skill => skill.skillKey)
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/skills/bins — Aggregate required binaries from discovered skills
  // =========================================================================
  if (route(req, 'GET', '/api/skills/bins')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const config = readConfig();
      const result = listAvailableSkills(config, agentId);
      const bins = [...new Set(result.skills.flatMap(skill => skill.requiredBins))].sort();
      return json(res, 200, { ok: true, agentId, bins, count: bins.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/skills/:skillKey — Detailed skill document and metadata
  // =========================================================================
  if ((m = route(req, 'GET', '/api/skills/:skillKey'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const skillKey = m.params.skillKey;
      const config = readConfig();
      const result = listAvailableSkills(config, agentId);
      const skill = result.skills.find(item => item.skillKey === skillKey || item.directoryName === skillKey);
      if (!skill) return json(res, 404, { ok: false, error: `Skill '${skillKey}' not found` });

      return json(res, 200, {
        ok: true,
        agentId,
        skill: {
          skillKey: skill.skillKey,
          title: skill.title,
          description: skill.description,
          source: skill.source,
          path: skill.path,
          directory: skill.directoryName,
          metadata: skill.metadata,
          frontmatter: skill.frontmatter,
          requiredBins: skill.requiredBins,
          configEntry: redactSensitiveData(skill.configEntry),
          content: skill.content
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/skills/update — Update skills config entry in openclaw.json
  // =========================================================================
  if (route(req, 'POST', '/api/skills/update')) {
    try {
      const body = await parseBody(req);
      const skillKey = (body.skillKey || '').trim();
      if (!isValidSkillKey(skillKey)) {
        return json(res, 400, { ok: false, error: 'Invalid skillKey' });
      }

      const config = readConfig();
      if (!config.skills) config.skills = {};
      if (!config.skills.entries) config.skills.entries = {};

      const current = isPlainObject(config.skills.entries[skillKey]) ? deepClone(config.skills.entries[skillKey]) : {};
      if (typeof body.enabled === 'boolean') current.enabled = body.enabled;
      if (body.apiKey !== undefined) {
        if (body.apiKey) current.apiKey = body.apiKey;
        else delete current.apiKey;
      }
      if (isPlainObject(body.env)) {
        const nextEnv = isPlainObject(current.env) ? current.env : {};
        for (const [key, value] of Object.entries(body.env)) {
          if (!value) delete nextEnv[key];
          else nextEnv[key] = String(value);
        }
        current.env = nextEnv;
      }
      if (isPlainObject(body.config)) {
        current.config = deepMerge(current.config || {}, body.config);
      }

      config.skills.entries[skillKey] = current;
      writeConfig(config);
      if (body.restart !== false) restartContainer('openclaw');

      return json(res, 200, {
        ok: true,
        skillKey,
        restarted: body.restart !== false,
        config: redactSensitiveData(current)
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/skills/custom — Create a detailed custom workspace skill
  // =========================================================================
  if (route(req, 'POST', '/api/skills/custom')) {
    try {
      const body = await parseBody(req);
      const agentId = (body.agentId || 'main').trim();
      const skillKey = (body.skillKey || body.name || '').trim();
      if (!isValidSkillKey(skillKey)) {
        return json(res, 400, { ok: false, error: 'Invalid skillKey. Use lowercase letters, numbers, hyphens, or underscores.' });
      }

      const config = readConfig();
      const skillsDir = ensureDirectory(getWorkspaceSkillsDir(config, agentId));
      const skillDir = `${skillsDir}/${skillKey}`;
      const skillFile = `${skillDir}/SKILL.md`;
      if (fs.existsSync(skillFile)) {
        return json(res, 409, { ok: false, error: `Skill '${skillKey}' already exists` });
      }

      ensureDirectory(skillDir);
      const content = buildCustomSkillMarkdown({ ...body, skillKey });
      fs.writeFileSync(skillFile, content, 'utf8');

      return json(res, 201, {
        ok: true,
        agentId,
        skillKey,
        path: skillFile,
        created: true,
        message: 'Custom skill created successfully.',
        content
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/skills/custom/:skillKey — Update an existing workspace skill
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/skills/custom/:skillKey'))) {
    try {
      const body = await parseBody(req);
      const agentId = (body.agentId || 'main').trim();
      const skillKey = m.params.skillKey;
      const config = readConfig();
      const existing = findWorkspaceSkill(config, agentId, skillKey);
      if (!existing) {
        return json(res, 404, { ok: false, error: `Workspace skill '${skillKey}' not found` });
      }

      const parsed = parseSkillDocument(existing.content);
      const nextContent = buildCustomSkillMarkdown({
        skillKey: parsed.frontmatter.name || existing.skillKey,
        title: body.title || existing.title,
        description: body.description || parsed.frontmatter.description || existing.description,
        summary: body.summary,
        metadata: isPlainObject(body.metadata) ? body.metadata : existing.metadata,
        activation: body.activation,
        inputs: body.inputs,
        workflow: body.workflow,
        outputs: body.outputs,
        commandExamples: body.commandExamples,
        configNotes: body.configNotes,
        safetyNotes: body.safetyNotes,
        troubleshooting: body.troubleshooting
      });

      fs.writeFileSync(existing.path, nextContent, 'utf8');
      return json(res, 200, { ok: true, agentId, skillKey, updated: true, path: existing.path, content: nextContent });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/doctor/memory-status — Basic embedding readiness summary
  // =========================================================================
  if (route(req, 'GET', '/api/doctor/memory-status')) {
    try {
      const config = readConfig();
      const defaultAgentId = getDefaultAgentId(config);
      const model = config.agents?.defaults?.model?.primary || null;
      const provider = model ? model.split('/')[0] : null;
      let hasApiKey = false;
      if (provider && PROVIDERS[provider]) {
        const p = PROVIDERS[provider];
        hasApiKey = !!(getEnvValue(p.envKey) || getAuthProfileApiKey(p.authProfileProvider, defaultAgentId));
      }

      return json(res, 200, {
        ok: true,
        agentId: defaultAgentId,
        provider,
        embedding: {
          ok: hasApiKey,
          error: hasApiKey ? null : 'No provider API key detected for the default agent.'
        },
        note: 'This endpoint provides a management-layer readiness check based on current config and credentials.'
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/env — Xem env vars (masked)
  // =========================================================================
  if (route(req, 'GET', '/api/env')) {
    try {
      const env = readEnvFile();
      const result = {};
      const sensitiveKeys = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD'];

      for (const line of env.split('\n')) {
        if (line.startsWith('#') || !line.includes('=')) continue;
        const eqIndex = line.indexOf('=');
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        if (!key) continue;
        const isSensitive = sensitiveKeys.some(s => key.toUpperCase().includes(s));
        result[key] = isSensitive ? sanitizeKey(value) : value;
      }

      return json(res, 200, { ok: true, env: result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/env/:key — Set env var
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/env/:key'))) {
    try {
      const body = await parseBody(req);
      const key = m.params.key;

      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        return json(res, 400, { ok: false, error: 'Invalid env key format. Use UPPER_SNAKE_CASE.' });
      }
      if (key === 'OPENCLAW_MGMT_API_KEY') {
        return json(res, 403, { ok: false, error: 'Cannot modify management API key via this endpoint' });
      }
      if (body.value === undefined || body.value === null) {
        return json(res, 400, { ok: false, error: 'Missing value' });
      }

      setEnvValue(key, body.value);

      // Sync gateway token to openclaw.json + recreate Caddy (env_file only read on create)
      if (key === 'OPENCLAW_GATEWAY_TOKEN') {
        try {
          let config = readConfig();
          if (!config.gateway) config.gateway = {};
          if (!config.gateway.auth) config.gateway.auth = {};
          config.gateway.auth.token = body.value;
          writeConfig(config);
        } catch {}
        dockerCompose('up -d --force-recreate caddy', 60000);
      }

      restartContainer('openclaw');
      return json(res, 200, { ok: true, key, applied: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/env/:key — Xoa env var
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/env/:key'))) {
    try {
      const key = m.params.key;
      const protectedKeys = ['OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_MGMT_API_KEY', 'OPENCLAW_VERSION', 'OPENCLAW_GATEWAY_PORT'];
      if (protectedKeys.includes(key)) {
        return json(res, 403, { ok: false, error: 'Cannot remove protected environment variable' });
      }
      removeEnvValue(key);
      restartContainer('openclaw');
      return json(res, 200, { ok: true, key, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/system — System info
  // =========================================================================
  if (route(req, 'GET', '/api/system')) {
    try {
      let disk = [];
      try {
        disk = shell("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'").split(' ');
      } catch {}

      let osInfo = '';
      try { osInfo = shell('lsb_release -ds 2>/dev/null || head -1 /etc/os-release'); } catch {}

      return json(res, 200, {
        ok: true,
        hostname: os.hostname(),
        ip: getServerIP(),
        os: osInfo,
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        memory: {
          total: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
          free: Math.round(os.freemem() / 1024 / 1024) + 'MB',
          used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024) + 'MB'
        },
        disk: {
          total: disk[0] || 'unknown',
          used: disk[1] || 'unknown',
          available: disk[2] || 'unknown',
          usagePercent: disk[3] || 'unknown'
        },
        nodeVersion: process.version,
        dockerVersion: (() => { try { return shell('docker --version'); } catch { return 'unknown'; } })()
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/cli — CLI Proxy (chay lenh CLI trong container)
  // =========================================================================
  if (route(req, 'POST', '/api/cli')) {
    try {
      const body = await parseBody(req);
      const command = (body.command || '').trim();
      if (!command) return json(res, 400, { ok: false, error: 'Missing command' });

      // Sanitize: chi cho phep lenh an toan
      if (/[;&|`$(){}]/.test(command)) {
        return json(res, 400, { ok: false, error: 'Command contains disallowed characters' });
      }

      const output = dockerExec(`node dist/index.js ${command}`, 60000);
      return json(res, 200, { ok: true, output });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 200, { ok: false, output: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // POST /api/self-update — Tu dong cap nhat Management API + docker-compose + config templates
  // =========================================================================
  if (route(req, 'POST', '/api/self-update')) {
    try {
      const REPO_RAW = 'https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/main';
      const MGMT_API_DIR = '/opt/openclaw-mgmt';

      // --- Pre-download migration: extract DOMAIN from old Caddyfile before overwriting ---
      try {
        if (!getEnvValue('DOMAIN')) {
          const oldCaddy = fs.readFileSync(CADDYFILE, 'utf8');
          const dm = oldCaddy.match(/^(\S+)\s*\{/m);
          if (dm && !dm[1].startsWith('{')) {
            setEnvValue('DOMAIN', dm[1]);
            if (oldCaddy.includes('tls internal')) {
              setEnvValue('CADDY_TLS', 'tls internal');
            } else {
              setEnvValue('CADDY_TLS', '');
            }
          }
        }
      } catch {}

      const configTemplates = [
        'anthropic', 'openai', 'google',
        'deepseek', 'groq', 'together', 'mistral', 'xai',
        'cerebras', 'sambanova', 'fireworks', 'cohere',
        'yi', 'baichuan', 'stepfun', 'siliconflow', 'novita', 'openrouter',
        'minimax', 'moonshot', 'zhipu'
      ];
      const files = [
        { url: `${REPO_RAW}/management-api/server.js`, dest: `${MGMT_API_DIR}/server.js` },
        { url: `${REPO_RAW}/docker-compose.yml`, dest: `${COMPOSE_DIR}/docker-compose.yml` },
        { url: `${REPO_RAW}/Caddyfile`, dest: `${COMPOSE_DIR}/Caddyfile` },
        ...configTemplates.map(t => ({ url: `${REPO_RAW}/config/${t}.json`, dest: `${TEMPLATES_DIR}/${t}.json` }))
      ];

      const cacheBust = Date.now();
      const results = [];
      for (const f of files) {
        try {
          shell(`curl -fsSL -H 'Cache-Control: no-cache' '${f.url}?t=${cacheBust}' -o '${f.dest}'`, 30000);
          results.push({ file: f.dest, ok: true });
        } catch (e) {
          results.push({ file: f.dest, ok: false, error: e.message });
        }
      }

      const allOk = results.every(r => r.ok);

      // --- Migrate .env: ensure NODE_OPTIONS is set (80% of system RAM) ---
      try {
        if (!getEnvValue('NODE_OPTIONS')) {
          const heapSize = Math.round(os.totalmem() / 1024 / 1024 * 0.8);
          setEnvValue('NODE_OPTIONS', `--max-old-space-size=${heapSize}`);
        }
      } catch {}

      // --- Migrate existing openclaw.json: ensure required gateway settings ---
      try {
        const liveConfig = readConfig();
        let migrated = false;
        if (liveConfig.gateway) {
          if (!liveConfig.gateway.controlUi) {
            liveConfig.gateway.controlUi = { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: true };
            migrated = true;
          } else {
            const ui = liveConfig.gateway.controlUi;
            if (!ui.allowInsecureAuth) { ui.allowInsecureAuth = true; migrated = true; }
            if (!ui.dangerouslyAllowHostHeaderOriginFallback) { ui.dangerouslyAllowHostHeaderOriginFallback = true; migrated = true; }
            if (!ui.dangerouslyDisableDeviceAuth) { ui.dangerouslyDisableDeviceAuth = true; migrated = true; }
          }
        }
        if (migrated) writeConfig(liveConfig);
      } catch {}

      // Apply docker-compose changes
      // (config migration changes mounted volume, gateway only reads config at startup)
      let composeResult = null;
      try {
        composeResult = dockerCompose('up -d --remove-orphans', 120000);
      } catch (e) {
        composeResult = (composeResult || '') + ' ' + e.message;
      }

      // Restart management API service (systemd sẽ tự start lại với code mới)
      // Dùng exec async để response kịp trả về trước khi process bị kill
      if (allOk) {
        json(res, 200, { ok: true, message: 'Update complete. Management API restarting...', files: results, compose: composeResult });
        setTimeout(() => {
          try { execSync('systemctl restart openclaw-mgmt', { timeout: 10000 }); } catch {}
        }, 500);
        return;
      }

      return json(res, 200, { ok: false, message: 'Some files failed to update', files: results });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id/api-key — Masked API keys cho agent cu the
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id/api-key'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const apiKeys = {};
      for (const [pid, p] of Object.entries(PROVIDERS)) {
        const key = getAgentApiKey(agentId, p.authProfileProvider);
        apiKeys[pid] = key ? sanitizeKey(key) : null;
      }

      return json(res, 200, { ok: true, agentId, apiKeys });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id/api-key — Set API key cho agent cu the
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id/api-key'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req);
      const { provider, apiKey } = body;

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!apiKey) return json(res, 400, { ok: false, error: 'Missing apiKey' });

      // Validate agent exists (main always exists)
      if (agentId !== 'main') {
        const config = readConfig();
        const list = getAgentsList(config);
        if (!list.find(a => a.id === agentId))
          return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });
      }

      setAgentApiKey(agentId, providerConfig.authProfileProvider, apiKey);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, agentId, provider, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id/default — Set agent lam default
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id/default'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const config = readConfig();
      ensureAgentsList(config);

      const idx = config.agents.list.findIndex(a => a.id === agentId);
      if (idx === -1) return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      config.agents.list.forEach(a => { delete a.default; });
      config.agents.list[idx].default = true;

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, defaultAgent: agentId });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id — Chi tiet agent
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const config = readConfig();
      const list = getAgentsList(config);
      const agent = list.find(a => a.id === agentId);

      if (!agent && agentId !== 'main')
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      const effectiveAgent = agent || { id: 'main', default: true, name: 'Main Agent' };

      const apiKeys = {};
      for (const [pid, p] of Object.entries(PROVIDERS)) {
        const key = getAgentApiKey(agentId, p.authProfileProvider);
        apiKeys[pid] = key ? sanitizeKey(key) : null;
      }

      return json(res, 200, {
        ok: true,
        agent: {
          ...effectiveAgent,
          default: effectiveAgent.id === getDefaultAgentId(config),
          apiKeys,
          hasAuthProfiles: fs.existsSync(getAgentAuthFile(agentId))
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id/files — List supported workspace files
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id/files'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const config = readConfig();
      const agent = getAgentById(config, agentId);
      if (!agent) return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      const workspaceDir = getAgentWorkspaceDir(config, agentId);
      const files = AGENT_WORKSPACE_FILES.map(name => getAgentWorkspaceFileInfo(workspaceDir, name));

      return json(res, 200, {
        ok: true,
        agentId,
        workspace: workspaceDir,
        files,
        count: files.length
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id/files/:name — Get workspace file content
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id/files/:name'))) {
    try {
      const agentId = m.params.id;
      const config = readConfig();
      const agent = getAgentById(config, agentId);
      if (!agent) return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      let resolved;
      try {
        resolved = resolveAgentWorkspaceFile(config, agentId, m.params.name);
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }

      const info = getAgentWorkspaceFileInfo(resolved.workspaceDir, resolved.name);
      if (!info.exists) {
        return json(res, 404, {
          ok: false,
          error: `Workspace file '${resolved.name}' not found`,
          agentId,
          workspace: resolved.workspaceDir,
          file: info
        });
      }

      const content = fs.readFileSync(resolved.filePath, 'utf8');
      return json(res, 200, {
        ok: true,
        agentId,
        workspace: resolved.workspaceDir,
        file: {
          ...info,
          content
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id/files/:name — Create/update workspace file content
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id/files/:name'))) {
    try {
      const agentId = m.params.id;
      const config = readConfig();
      const agent = getAgentById(config, agentId);
      if (!agent) return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      let resolved;
      try {
        resolved = resolveAgentWorkspaceFile(config, agentId, m.params.name);
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }

      const body = await parseBody(req);
      if (typeof body.content !== 'string') {
        return json(res, 400, { ok: false, error: 'Missing content string' });
      }

      fs.mkdirSync(resolved.workspaceDir, { recursive: true });
      fs.writeFileSync(resolved.filePath, body.content, 'utf8');

      const info = getAgentWorkspaceFileInfo(resolved.workspaceDir, resolved.name);
      return json(res, 200, {
        ok: true,
        agentId,
        workspace: resolved.workspaceDir,
        file: info,
        updated: true
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id — Update agent config
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req);
      const config = readConfig();
      ensureAgentsList(config);

      let agentIdx = config.agents.list.findIndex(a => a.id === agentId);
      if (agentIdx === -1) {
        // If updating "main" and no list exists yet, create it
        if (agentId === 'main' && config.agents.list.length === 0) {
          config.agents.list.push({ id: 'main', default: true });
          agentIdx = 0;
        } else {
          return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });
        }
      }

      const agent = config.agents.list[agentIdx];
      const updatable = ['name', 'model', 'workspace', 'agentDir'];
      for (const field of updatable) {
        if (body[field] !== undefined) {
          if (body[field] === null) delete agent[field];
          else agent[field] = body[field];
        }
      }

      config.agents.list[agentIdx] = agent;
      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, agent });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/agents/:id — Xoa agent
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req).catch(() => ({}));
      const config = readConfig();
      ensureAgentsList(config);

      const list = config.agents.list;
      if (list.length <= 1)
        return json(res, 400, { ok: false, error: 'Cannot delete the last agent' });

      const idx = list.findIndex(a => a.id === agentId);
      if (idx === -1)
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      if (list[idx].default)
        return json(res, 400, { ok: false, error: 'Cannot delete default agent. Set another agent as default first.' });

      config.agents.list.splice(idx, 1);

      // Remove bindings for this agent
      if (Array.isArray(config.bindings)) {
        config.bindings = config.bindings.filter(b => b.agentId !== agentId);
      }

      writeConfig(config);

      // Delete data only if explicitly requested
      if (body.deleteData === true) {
        const agentDir = `${CONFIG_DIR}/agents/${agentId}`;
        if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
      }

      restartContainer('openclaw');

      return json(res, 200, { ok: true, id: agentId, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents — List tat ca agents
  // =========================================================================
  if (route(req, 'GET', '/api/agents')) {
    try {
      const config = readConfig();
      const list = getAgentsList(config);
      const defaultId = getDefaultAgentId(config);

      const agents = list.map(agent => {
        const hasAuth = fs.existsSync(getAgentAuthFile(agent.id));
        const authData = hasAuth ? readAgentAuth(agent.id) : { profiles: {} };
        const profileCount = Object.keys(authData.profiles || {}).length;
        return {
          id: agent.id,
          name: agent.name || agent.id,
          default: agent.id === defaultId,
          model: agent.model || null,
          hasAuthProfiles: hasAuth,
          apiKeyCount: profileCount
        };
      });

      return json(res, 200, { ok: true, agents, count: agents.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/agents — Tao agent moi
  // =========================================================================
  if (route(req, 'POST', '/api/agents')) {
    try {
      const body = await parseBody(req);
      const { id, name, model } = body;

      if (!id) return json(res, 400, { ok: false, error: 'Missing agent id' });
      if (!isValidAgentId(id))
        return json(res, 400, { ok: false, error: 'Agent id must match /^[a-z][a-z0-9-]{0,31}$/' });

      const config = readConfig();
      ensureAgentsList(config);

      // If list is empty (fresh install), add "main" as first agent
      if (config.agents.list.length === 0) {
        config.agents.list.push({ id: 'main', default: true, name: 'Main Agent',
          workspace: '~/.openclaw/workspace-main', agentDir: '~/.openclaw/agents/main/agent' });
      }

      if (config.agents.list.find(a => a.id === id))
        return json(res, 409, { ok: false, error: `Agent '${id}' already exists` });

      if (body.default) {
        config.agents.list.forEach(a => { delete a.default; });
      }

      const newAgent = { id };
      if (name) newAgent.name = name;
      if (model) newAgent.model = model;
      if (body.default) newAgent.default = true;
      newAgent.workspace = body.workspace || `~/.openclaw/workspace-${id}`;
      newAgent.agentDir = body.agentDir || `~/.openclaw/agents/${id}/agent`;

      config.agents.list.push(newAgent);

      // Create host directory structure
      const hostDir = getAgentAuthDir(id);
      fs.mkdirSync(hostDir, { recursive: true });
      writeAgentAuth(id, { profiles: {} });

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 201, { ok: true, agent: newAgent });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/bindings — List routing bindings
  // =========================================================================
  if (route(req, 'GET', '/api/bindings')) {
    try {
      const config = readConfig();
      const bindings = getBindings(config);
      return json(res, 200, { ok: true, bindings, count: bindings.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/bindings — Tao binding moi
  // =========================================================================
  if (route(req, 'POST', '/api/bindings')) {
    try {
      const body = await parseBody(req);
      const { agentId, match } = body;

      if (!agentId) return json(res, 400, { ok: false, error: 'Missing agentId' });
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });
      if (!match || typeof match !== 'object')
        return json(res, 400, { ok: false, error: 'Missing or invalid match object' });
      if (!match.channel)
        return json(res, 400, { ok: false, error: 'match.channel is required' });

      const config = readConfig();
      const list = getAgentsList(config);
      if (!list.find(a => a.id === agentId))
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      if (!Array.isArray(config.bindings)) config.bindings = [];

      const newBinding = { agentId, match };
      config.bindings.push(newBinding);

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 201, { ok: true, binding: newBinding, index: config.bindings.length - 1 });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/bindings/:index — Update binding
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/bindings/:index'))) {
    try {
      const index = parseInt(m.params.index);
      const body = await parseBody(req);

      const config = readConfig();
      if (!Array.isArray(config.bindings) || index < 0 || index >= config.bindings.length)
        return json(res, 404, { ok: false, error: `Binding at index ${index} not found` });

      if (body.agentId) {
        if (!isValidAgentId(body.agentId))
          return json(res, 400, { ok: false, error: 'Invalid agentId' });
        const list = getAgentsList(config);
        if (!list.find(a => a.id === body.agentId))
          return json(res, 404, { ok: false, error: `Agent '${body.agentId}' not found` });
        config.bindings[index].agentId = body.agentId;
      }

      if (body.match && typeof body.match === 'object') {
        if (!body.match.channel)
          return json(res, 400, { ok: false, error: 'match.channel is required' });
        config.bindings[index].match = body.match;
      }

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, index, binding: config.bindings[index] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/bindings/:index — Xoa binding
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/bindings/:index'))) {
    try {
      const index = parseInt(m.params.index);
      const config = readConfig();

      if (!Array.isArray(config.bindings) || index < 0 || index >= config.bindings.length)
        return json(res, 404, { ok: false, error: `Binding at index ${index} not found` });

      const removed = config.bindings.splice(index, 1)[0];

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, index, removed, remaining: config.bindings.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // 404
  // =========================================================================
  json(res, 404, { ok: false, error: 'Not found' });
});

// =============================================================================
// Login HTML Page
// =============================================================================
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0}
.card{background:#1e293b;border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,.4)}
.logo{text-align:center;margin-bottom:32px}
.logo h1{font-size:24px;font-weight:700;color:#f8fafc}
.logo p{font-size:14px;color:#94a3b8;margin-top:4px}
.logo .credit{font-size:12px;color:#64748b;margin-top:6px}
.form-group{margin-bottom:20px}
.form-group label{display:block;font-size:13px;font-weight:500;color:#94a3b8;margin-bottom:6px}
.form-group input{width:100%;padding:12px 16px;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#f8fafc;font-size:15px;outline:none;transition:border-color .2s}
.form-group input:focus{border-color:#3b82f6}
.btn{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}
.btn:hover{background:#2563eb}
.btn:disabled{opacity:.5;cursor:not-allowed}
.error{background:#7f1d1d;color:#fca5a5;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}

.copyright{text-align:center;margin-top:12px}
.copyright p{font-size:14px;color:#94a3b8;margin-top:4px}
.copyright .credit{font-size:12px;color:#64748b;margin-top:6px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>\u{1F980} OpenClaw</h1>
    <p>Sign in to continue</p>
    
  </div>
  <div class="error" id="error"></div>
  <form id="loginForm">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn" id="submitBtn">Sign in</button>
  </form>
 <div class="copyright">
  <p class="credit">Make with ❤️ by Pho Tue SoftWare Solutions JSC</p>
</div>
</div>

<script>
const form = document.getElementById('loginForm');
const errorEl = document.getElementById('error');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });
    const data = await res.json();

    if (data.ok && data.token) {
      window.location.href = '/#token=' + data.token;
    } else {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Sign in';
});
</script>
</body>
</html>`;

// --- Startup migration: ensure NODE_OPTIONS in .env (80% of system RAM) ---
try {
  if (!getEnvValue('NODE_OPTIONS')) {
    const heapSize = Math.round(os.totalmem() / 1024 / 1024 * 0.8);
    setEnvValue('NODE_OPTIONS', `--max-old-space-size=${heapSize}`);
    console.log(`[Migration] Set NODE_OPTIONS=--max-old-space-size=${heapSize}`);
    try { dockerCompose('up -d openclaw', 60000); } catch {}
  }
} catch {}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management API] Running on http://0.0.0.0:${PORT}`);
});
