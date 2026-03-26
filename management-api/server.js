#!/usr/bin/env node
// =============================================================================
// OpenClaw Management API — None Docker Compose based service management
// Auth: Bearer OPENCLAW_MGMT_API_KEY | Port: 9998 | Systemd: openclaw-mgmt.service
// =============================================================================

const http = require('http');
const { execSync, exec, execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');


const PORT = 9998;
const MGMT_VERSION = '1.0.29';
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
// --- ChatGPT OAuth (OpenAI Codex) PKCE sessions ---
const _oauthSessions = {}; // sessionId → { codeVerifier, clientId, agentId, createdAt }
const OAUTH_SESSION_TTL = 10 * 60 * 1000; // 10 minutes
let _oauthClientCache = null;

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

function toSkillKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function trimLineBlock(lines) {
  const copy = Array.isArray(lines) ? [...lines] : [];
  while (copy.length > 0 && !String(copy[0] || '').trim()) copy.shift();
  while (copy.length > 0 && !String(copy[copy.length - 1] || '').trim()) copy.pop();
  return copy.join('\n').trim();
}

function parseCustomSkillContent(content) {
  const parsed = parseSkillDocument(content);
  const lines = String(parsed.body || '').split(/\r?\n/);
  let cursor = 0;
  let title = '';

  while (cursor < lines.length) {
    const line = lines[cursor].trim();
    if (!line) {
      cursor += 1;
      continue;
    }
    if (line.startsWith('# ')) {
      title = line.replace(/^#\s+/, '').trim();
      cursor += 1;
    }
    break;
  }

  const summaryLines = [];
  while (cursor < lines.length && !lines[cursor].trim().startsWith('## ')) {
    summaryLines.push(lines[cursor]);
    cursor += 1;
  }

  const sections = {};
  let currentSection = null;
  let currentLines = [];
  const flushSection = () => {
    if (!currentSection) return;
    const text = trimLineBlock(currentLines);
    sections[currentSection] = {
      text,
      items: normalizeStringList(text)
    };
  };

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      flushSection();
      currentSection = trimmed.replace(/^##\s+/, '').trim();
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  flushSection();

  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    title: title || parsed.frontmatter.name || '',
    description: parsed.frontmatter.description || '',
    metadata: getSkillOpenClawMetadata(parsed.frontmatter),
    summary: trimLineBlock(summaryLines),
    sections,
    activation: sections['When to Use']?.items || [],
    inputs: sections['Inputs to Collect']?.items || [],
    workflow: sections['Execution Workflow']?.items || [],
    outputs: sections['Expected Output']?.items || [],
    commandExamples: sections['Command Examples']?.items || [],
    configNotes: sections['Configuration Notes']?.items || [],
    safetyNotes: sections['Safety and Guardrails']?.items || [],
    troubleshooting: sections['Troubleshooting']?.items || []
  };
}

function validateCustomSkillContent(content, expectedSkillKey = '') {
  const parsed = parseCustomSkillContent(content);
  const issues = [];
  const skillKey = expectedSkillKey || parsed.frontmatter.name || toSkillKey(parsed.title);

  if (!isValidSkillKey(skillKey)) {
    issues.push('Missing or invalid skill key. Use lowercase letters, numbers, hyphens, or underscores.');
  }
  if (!parsed.title) issues.push('Missing title heading (`# Title`).');
  if (!parsed.summary) issues.push('Missing summary paragraph below the title.');

  const sectionChecks = [
    ['When to Use', parsed.activation],
    ['Inputs to Collect', parsed.inputs],
    ['Execution Workflow', parsed.workflow],
    ['Expected Output', parsed.outputs],
    ['Safety and Guardrails', parsed.safetyNotes],
    ['Troubleshooting', parsed.troubleshooting]
  ];
  const missingSections = [];
  for (const [title, items] of sectionChecks) {
    if (!Array.isArray(items) || items.length === 0) {
      missingSections.push(title);
      issues.push(`Section '${title}' is empty or missing.`);
    }
  }

  return {
    ok: issues.length === 0,
    skillKey,
    issues,
    missingSections,
    parsed
  };
}

function buildCustomSkillResponse(skill, options = {}) {
  const includeContent = options.includeContent !== false;
  const parsed = parseCustomSkillContent(skill.content || '');
  let stats = null;
  try {
    stats = fs.statSync(skill.path);
  } catch {}

  return {
    skillKey: skill.skillKey,
    agentId: skill.agentId,
    title: parsed.title || skill.title,
    description: parsed.description || skill.description,
    source: skill.source,
    path: skill.path,
    directory: skill.directoryName,
    skillDir: skill.skillDir,
    metadata: parsed.metadata,
    frontmatter: parsed.frontmatter,
    summary: parsed.summary,
    sections: parsed.sections,
    activation: parsed.activation,
    inputs: parsed.inputs,
    workflow: parsed.workflow,
    outputs: parsed.outputs,
    commandExamples: parsed.commandExamples,
    configNotes: parsed.configNotes,
    safetyNotes: parsed.safetyNotes,
    troubleshooting: parsed.troubleshooting,
    requiredBins: skill.requiredBins,
    enabled: skill.configEntry?.enabled !== false,
    configEntry: redactSensitiveData(skill.configEntry),
    validation: validateCustomSkillContent(skill.content || '', skill.skillKey),
    createdAt: stats?.birthtime ? stats.birthtime.toISOString() : null,
    updatedAt: stats?.mtime ? stats.mtime.toISOString() : null,
    content: includeContent ? skill.content : undefined
  };
}
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

// --- Terminal command whitelist ---
function parseTerminalCmd(cmdStr) {
  // Block shell injection metacharacters
  if (/[;&|`$(){}\\!'"<>]/.test(cmdStr)) {
    return { valid: false, error: 'Shell metacharacters not allowed' };
  }
  const parts = cmdStr.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { valid: false, error: 'Empty command' };
  const base = parts[0].toLowerCase();

  // docker compose <subcommand> [args...]
  if (base === 'docker' && parts[1] === 'compose') {
    const sub = parts[2];
    const allowed = ['ps', 'logs', 'restart', 'pull', 'up', 'down', 'exec', 'stats', 'images', 'top', 'config', 'ls'];
    if (!sub || !allowed.includes(sub)) {
      return { valid: false, error: 'Allowed docker compose subcommands: ' + allowed.join(', ') };
    }
    const rest = parts.slice(2);
    // Auto-inject -T for exec (no TTY for non-interactive streaming)
    if (sub === 'exec' && !rest.includes('-T') && !rest.includes('-t')) {
      rest.splice(1, 0, '-T');
    }
    return { valid: true, argv: ['docker', 'compose', '-f', COMPOSE_DIR + '/docker-compose.yml', ...rest] };
  }

  // openclaw / claw → docker compose exec -T openclaw node dist/index.js <args>
  if (base === 'openclaw' || base === 'claw') {
    return {
      valid: true,
      argv: ['docker', 'compose', '-f', COMPOSE_DIR + '/docker-compose.yml', 'exec', '-T', 'openclaw', 'node', 'dist/index.js', ...parts.slice(1)]
    };
  }

  // Safe system commands
  const sysMap = {
    'df':       () => ['df', ...(parts.slice(1).length ? parts.slice(1) : ['-h'])],
    'free':     () => ['free', ...(parts.slice(1).length ? parts.slice(1) : ['-h'])],
    'uptime':   () => ['uptime'],
    'date':     () => ['date'],
    'uname':    () => ['uname', '-a'],
    'hostname': () => ['hostname', '-I'],
    'ps':       () => ['ps', 'aux'],
  };
  if (sysMap[base]) return { valid: true, argv: sysMap[base]() };

  return { valid: false, error: 'Command not allowed. Use: docker compose ..., openclaw ..., df, free, uptime, ps, date' };
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
    name: 'OpenAI (API Key)',
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
  'openai-codex': {
    name: 'ChatGPT OAuth (Codex)',
    envKey: null,              // No API key — uses OAuth token from auth-profiles.json
    authProfileProvider: 'openai-codex',
    configTemplate: `${TEMPLATES_DIR}/openai-codex.json`,
    oauthOnly: true,           // Requires ChatGPT OAuth, no API key support
    knownModels: [
      { id: 'openai-codex/gpt-5.4',            name: 'GPT-5.4',          default: true },
      { id: 'openai-codex/gpt-5.4-mini',        name: 'GPT-5.4-Mini' },
      { id: 'openai-codex/gpt-5.3-codex',       name: 'GPT-5.3-Codex' },
      { id: 'openai-codex/gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' },
      { id: 'openai-codex/gpt-5.2-codex',       name: 'GPT-5.2-Codex' },
      { id: 'openai-codex/gpt-5.2',             name: 'GPT-5.2' },
      { id: 'openai-codex/gpt-5.1-codex-max',   name: 'GPT-5.1-Codex-Max' },
      { id: 'openai-codex/gpt-5.1-codex-mini',  name: 'GPT-5.1-Codex-Mini' },
      { id: 'openai-codex/gpt-5.1',             name: 'GPT-5.1' }
    ],
    testFn: () => false  // OAuth token — cannot test with static key
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

// =============================================================================
// ChatGPT OAuth (OpenAI Codex) — PKCE OAuth 2.0 Helpers
// Constants extracted from @mariozechner/pi-ai/dist/utils/oauth/openai-codex.js
// =============================================================================
const OPENAI_OAUTH_CLIENT_ID  = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_TOKEN_URL  = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_AUTH_URL   = 'https://auth.openai.com/oauth/authorize';
const OPENAI_OAUTH_REDIRECT   = 'http://localhost:1455/auth/callback';
const OPENAI_OAUTH_SCOPE      = 'openid profile email offline_access';
const OPENAI_OAUTH_PROFILE    = 'openai-codex'; // provider key used by openclaw

function pkceVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

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

function openclawCli(args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const output = dockerExecArgs(['node', 'dist/index.js', ...args], Math.max(timeoutMs, 15000));
  return options.json ? parseCliJsonOutput(output) : output;
}

function collectNestedValuesByKey(value, keyName, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedValuesByKey(item, keyName, results);
    return results;
  }
  if (!isPlainObject(value)) return results;
  for (const [key, item] of Object.entries(value)) {
    if (key === keyName) results.push(item);
    collectNestedValuesByKey(item, keyName, results);
  }
  return results;
}

function validateZaloConfigInput(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return ['Zalo config patch must be an object'];
  }

  for (const webhookUrl of collectNestedValuesByKey(value, 'webhookUrl')) {
    if (webhookUrl === null || webhookUrl === undefined || webhookUrl === '') continue;
    if (typeof webhookUrl !== 'string' || !/^https:\/\//i.test(webhookUrl.trim())) {
      errors.push('Zalo webhookUrl must use HTTPS');
      break;
    }
  }

  for (const webhookSecret of collectNestedValuesByKey(value, 'webhookSecret')) {
    if (webhookSecret === null || webhookSecret === undefined || webhookSecret === '') continue;
    if (typeof webhookSecret !== 'string' || webhookSecret.length < 8 || webhookSecret.length > 256) {
      errors.push('Zalo webhookSecret must be 8-256 characters');
      break;
    }
  }

  for (const mediaMaxMb of collectNestedValuesByKey(value, 'mediaMaxMb')) {
    if (mediaMaxMb === null || mediaMaxMb === undefined || mediaMaxMb === '') continue;
    const parsed = Number(mediaMaxMb);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push('Zalo mediaMaxMb must be a positive number');
      break;
    }
  }

  const dmPolicies = collectNestedValuesByKey(value, 'dmPolicy');
  for (const dmPolicy of dmPolicies) {
    if (dmPolicy === null || dmPolicy === undefined || dmPolicy === '') continue;
    if (!['pairing', 'allowlist', 'open', 'disabled'].includes(String(dmPolicy))) {
      errors.push('Zalo dmPolicy must be one of: pairing, allowlist, open, disabled');
      break;
    }
  }

  const groupPolicies = collectNestedValuesByKey(value, 'groupPolicy');
  for (const groupPolicy of groupPolicies) {
    if (groupPolicy === null || groupPolicy === undefined || groupPolicy === '') continue;
    if (!['allowlist', 'open', 'disabled'].includes(String(groupPolicy))) {
      errors.push('Zalo groupPolicy must be one of: allowlist, open, disabled');
      break;
    }
  }

  return errors;
}

function buildZaloChannelState() {
  const config = readConfig();
  const channelConfig = deepClone(config?.channels?.zalo || {});
  const envToken = getEnvValue('ZALO_BOT_TOKEN');
  const defaultAccountToken = getValueAtPath(channelConfig, 'accounts.default.botToken');
  const defaultAccountDmPolicy = getValueAtPath(channelConfig, 'accounts.default.dmPolicy');
  const webhookUrls = collectNestedValuesByKey(channelConfig, 'webhookUrl').filter(value => typeof value === 'string' && value.trim());
  const webhookPaths = collectNestedValuesByKey(channelConfig, 'webhookPath').filter(value => typeof value === 'string' && value.trim());
  const accountIds = isPlainObject(channelConfig.accounts) ? Object.keys(channelConfig.accounts) : [];
  const effectiveToken = typeof channelConfig.botToken === 'string'
    ? channelConfig.botToken
    : (defaultAccountToken.exists && typeof defaultAccountToken.value === 'string' ? defaultAccountToken.value : envToken);

  return {
    plugin: {
      required: true,
      package: '@openclaw/zalo',
      enabled: !!config?.plugins?.entries?.zalo?.enabled
    },
    env: {
      botToken: envToken ? sanitizeKey(envToken) : null
    },
    config: redactSensitiveData(channelConfig),
    summary: {
      enabled: !!channelConfig.enabled,
      configured: !!effectiveToken,
      transportMode: webhookUrls.length > 0 ? 'webhook' : 'polling',
      webhookConfigured: webhookUrls.length > 0,
      webhookPaths,
      accountIds,
      defaultDmPolicy: defaultAccountDmPolicy.exists ? defaultAccountDmPolicy.value : (channelConfig.dmPolicy || 'pairing'),
      mediaMaxMb: channelConfig.mediaMaxMb || 5,
      groupSupport: 'marketplace-bot-not-available'
    },
    notes: {
      experimental: true,
      dmPairingDefault: true,
      groupsSupported: false,
      textChunkLimit: 2000,
      streamingBlockedByDefault: true,
      webhookRequiresHttps: true
    }
  };
}
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Decode JWT payload to extract accountId / email (no signature verification needed)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

// Exchange authorization code for tokens using curl
function exchangeOAuthCode(code, codeVerifier) {
  const tmpFile = `/tmp/openclaw-oauth-${crypto.randomBytes(8).toString('hex')}.dat`;
  try {
    const params = [
      `grant_type=authorization_code`,
      `client_id=${encodeURIComponent(OPENAI_OAUTH_CLIENT_ID)}`,
      `code=${encodeURIComponent(code)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
      `redirect_uri=${encodeURIComponent(OPENAI_OAUTH_REDIRECT)}`
    ].join('&');
    fs.writeFileSync(tmpFile, params, 'utf8');
    const result = shell(
      `curl -sf --max-time 30 -X POST '${OPENAI_OAUTH_TOKEN_URL}' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary @${tmpFile}`,
      35000
    );
    return JSON.parse(result);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Store OAuth tokens in auth-profiles.json using openclaw's exact credential format
// Fields: { type, provider, access, refresh, expires (ms), accountId }
// Profile key: "openai-codex:<email|default>"
function storeOAuthTokens(tokens, agentId = 'main') {
  const data = readAgentAuth(agentId);
  data.profiles = data.profiles || {};

  // Extract accountId and email from JWT
  const JWT_CLAIM = 'https://api.openai.com/auth';
  const payload = decodeJwtPayload(tokens.access);
  const accountId = payload?.[JWT_CLAIM]?.chatgpt_account_id || null;
  const email = (typeof payload?.email === 'string' && payload.email.trim()) ? payload.email.trim() : null;

  const profileKey = `${OPENAI_OAUTH_PROFILE}:${email || 'default'}`;

  // Remove any old profile keys for this provider
  for (const k of Object.keys(data.profiles)) {
    if (k.startsWith(`${OPENAI_OAUTH_PROFILE}:`)) delete data.profiles[k];
  }
  // Also remove old incorrect key from previous management API versions
  delete data.profiles['openai:oauth'];

  data.profiles[profileKey] = {
    type: 'oauth',
    provider: OPENAI_OAUTH_PROFILE,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,  // milliseconds (Date.now() + expires_in*1000)
    accountId
  };
  writeAgentAuth(agentId, data);
  return { profileKey, accountId, email };
}

// Refresh token — returns same shape as exchangeOAuthCode for storeOAuthTokens
function refreshOAuthToken(refreshToken) {
  const tmpFile = `/tmp/openclaw-oauth-refresh-${crypto.randomBytes(8).toString('hex')}.dat`;
  try {
    const params = [
      `grant_type=refresh_token`,
      `client_id=${encodeURIComponent(OPENAI_OAUTH_CLIENT_ID)}`,
      `refresh_token=${encodeURIComponent(refreshToken)}`
    ].join('&');
    fs.writeFileSync(tmpFile, params, 'utf8');
    const result = shell(
      `curl -sf --max-time 30 -X POST '${OPENAI_OAUTH_TOKEN_URL}' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary @${tmpFile}`,
      35000
    );
    const raw = JSON.parse(result);
    // Normalize to openclaw's field format
    if (!raw.access_token) return null;
    return {
      access: raw.access_token,
      refresh: raw.refresh_token,
      expires: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : null
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Get stored OAuth profile for an agent (searches for openai-codex:* key)
function getOAuthProfile(agentId = 'main') {
  const data = readAgentAuth(agentId);
  const profiles = data.profiles || {};
  for (const [k, v] of Object.entries(profiles)) {
    if (k.startsWith(`${OPENAI_OAUTH_PROFILE}:`) && v && v.access) return { key: k, ...v };
  }
  return null;
}

// Attempt to refresh tokens for a single agent. Returns 'refreshed' | 'skipped' | 'error'
function tryRefreshAgent(agentId) {
  try {
    const profile = getOAuthProfile(agentId);
    if (!profile || !profile.refresh) return 'skipped';

    const now = Date.now();
    // expires is in milliseconds; refresh if < 10 min remaining or expired
    const needsRefresh = !profile.expires || (profile.expires - now) < 600000;
    if (!needsRefresh) return 'skipped';

    const tokens = refreshOAuthToken(profile.refresh);
    if (!tokens || !tokens.access) return 'error';

    storeOAuthTokens(tokens, agentId);
    const remaining = tokens.expires ? Math.round((tokens.expires - Date.now()) / 1000) : '?';
    console.log(`[OAuth] Refreshed token for agent "${agentId}" (expires in ${remaining}s)`);
    return 'refreshed';
  } catch (e) {
    console.error(`[OAuth] Auto-refresh failed for agent "${agentId}": ${e.message}`);
    return 'error';
  }
}

// Cleanup expired OAuth sessions
function pruneOAuthSessions() {
  const now = Date.now();
  for (const id of Object.keys(_oauthSessions)) {
    if (now - _oauthSessions[id].createdAt > OAUTH_SESSION_TTL) delete _oauthSessions[id];
  }
}

// --- Docker compose helpers ---
function dockerCompose(cmd, timeout = 60000) {
  return shell(`${COMPOSE_CMD} ${cmd}`, timeout);
}

function dockerExec(cmd, timeout = 30000) {
  return shell(`${COMPOSE_CMD} exec -T openclaw ${cmd}`, timeout);
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
  dockerCompose(`restart ${service}`, 60000);
}

// =============================================================================
// On-demand device auto-approve polling (activated by /pair endpoint)
// =============================================================================
let _devicePollUntil = 0;
let _devicePollTimer = null;

function startDevicePoll() {
  if (_devicePollTimer) return;
  console.log('[Devices] Polling activated');
  _devicePollTimer = setInterval(() => {
    if (Date.now() > _devicePollUntil) {
      clearInterval(_devicePollTimer);
      _devicePollTimer = null;
      console.log('[Devices] Polling stopped (timeout)');
      return;
    }
    try {
      const output = execSync(
        'docker exec openclaw node dist/index.js devices list --json 2>&1',
        { encoding: 'utf8', timeout: 15000 }
      );
      const jsonMatch = output.trim().match(/\{[\s\S]*\}$/);
      if (!jsonMatch) return;
      const data = JSON.parse(jsonMatch[0]);
      const pending = (data.pending || []).filter(d => d.requestId);
      for (const d of pending) {
        try {
          execSync(`docker exec openclaw node dist/index.js devices approve ${d.requestId} 2>&1`, { timeout: 15000 });
          console.log(`[Devices] Auto-approved: ${d.deviceId} (${d.requestId})`);
        } catch (e) { console.error(`[Devices] approve failed ${d.requestId}:`, e.message?.slice(0, 200)); }
      }
    } catch {}
  }, 5 * 1000);
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

  // GET /pair — Activate device auto-approve + redirect to gateway dashboard
  if (route(req, 'GET', '/pair')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || '';
    if (!token) return json(res, 400, { ok: false, error: 'Missing token parameter' });
    _devicePollUntil = Date.now() + 60 * 1000;
    if (!_devicePollTimer) startDevicePoll();
    const rawDomain = (getEnvValue('DOMAIN') || '').trim();
    const domain = (rawDomain && rawDomain !== 'localhost' && !/\s/.test(rawDomain)) ? rawDomain.replace(/^https?:\/\//, '') : null;
    const host = domain || getServerIP();
    const proto = domain ? 'https' : 'http';
    res.writeHead(302, { Location: `${proto}://${host}/#token=${encodeURIComponent(token)}` });
    return res.end();
  }

  // GET /login — Serve login page
  if (route(req, 'GET', '/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  // GET /terminal — Serve terminal GUI page (public, auth handled client-side)
  if (route(req, 'GET', '/terminal')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TERMINAL_HTML);
  }

  // GET /api/terminal/stream — SSE streaming terminal (auth via ?token= query param)
  if (route(req, 'GET', '/api/terminal/stream')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const qToken = (url.searchParams.get('token') || '').trim();
    const expected = getMgmtApiKey();
    let authed = false;
    if (qToken && expected && qToken.length === expected.length) {
      try { authed = crypto.timingSafeEqual(Buffer.from(qToken), Buffer.from(expected)); } catch {}
    }
    if (!authed) {
      recordFailedAuth(ip);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ type: 'error', text: 'Unauthorized' }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const cmdStr = (url.searchParams.get('cmd') || '').trim();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (!cmdStr) {
      res.write('data: ' + JSON.stringify({ type: 'error', text: 'Missing cmd parameter' }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const parsed = parseTerminalCmd(cmdStr);
    if (!parsed.valid) {
      res.write('data: ' + JSON.stringify({ type: 'error', text: parsed.error }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const proc = spawn(parsed.argv[0], parsed.argv.slice(1), {
      cwd: COMPOSE_DIR,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    });

    let closed = false;
    req.on('close', () => {
      closed = true;
      try { proc.kill('SIGTERM'); } catch {}
    });

    proc.stdout.on('data', chunk => {
      if (!closed) res.write('data: ' + JSON.stringify({ type: 'stdout', text: chunk.toString() }) + '\n\n');
    });

    proc.stderr.on('data', chunk => {
      if (!closed) res.write('data: ' + JSON.stringify({ type: 'stderr', text: chunk.toString() }) + '\n\n');
    });

    proc.on('error', err => {
      if (!closed) {
        res.write('data: ' + JSON.stringify({ type: 'error', text: err.message }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
        res.end();
      }
    });

    proc.on('exit', (code) => {
      if (!closed) {
        res.write('data: ' + JSON.stringify({ type: 'exit', code: code !== null ? code : 0 }) + '\n\n');
        res.end();
      }
    });

    return;
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
        dashboardUrl: `http://${serverIP}:${PORT}/pair?token=${token}`,
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
        shell(`curl -fsSL 'https://raw.githubusercontent.com/Pho-Tue-SoftWare-Solutions-JSC/vps-openclaw-management/v2/Caddyfile?t=${Date.now()}' -o '${CADDYFILE}'`, 15000);
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
  // POST /api/exec-approvals/requests — Upstream execution approval request
  // =========================================================================
  if (route(req, 'POST', '/api/exec-approvals/requests')) {
    try {
      const body = await parseBody(req);
      const params = {
        ...body,
        twoPhase: body.twoPhase === undefined ? true : body.twoPhase
      };
      const result = gatewayMethod('exec.approval.request', params, { timeoutMs: Number(body.timeoutMs || 120000) || 120000 });
      return json(res, 200, { ok: true, method: 'exec.approval.request', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/exec-approvals/requests/:id — Upstream execution approval wait/poll
  // =========================================================================
  if ((m = route(req, 'GET', '/api/exec-approvals/requests/:id'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const queryParams = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const params = { ...queryParams, id: m.params.id };
      const result = gatewayMethod('exec.approval.waitDecision', params, { timeoutMs: Number(queryParams.timeoutMs || 35000) || 35000 });
      return json(res, 200, { ok: true, method: 'exec.approval.waitDecision', id: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/exec-approvals/requests/:id/decision — Upstream execution approval resolve
  // =========================================================================
  if ((m = route(req, 'POST', '/api/exec-approvals/requests/:id/decision'))) {
    try {
      const body = await parseBody(req);
      const params = { ...body, id: m.params.id };
      const result = gatewayMethod('exec.approval.resolve', params, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'exec.approval.resolve', id: m.params.id, result });
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
  // POST /api/secrets/reload — Upstream secrets reload
  // =========================================================================
  if (route(req, 'POST', '/api/secrets/reload')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('secrets.reload', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'secrets.reload', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/secrets/resolve — Upstream secret target resolution
  // =========================================================================
  if (route(req, 'POST', '/api/secrets/resolve')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('secrets.resolve', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'secrets.resolve', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/system/presence — Upstream system presence snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/system/presence')) {
    try {
      const result = gatewayMethod('system-presence', {}, { timeoutMs: 30000 });
      return json(res, 200, { ok: true, method: 'system-presence', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/talk/config — Upstream talk configuration snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/talk/config')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const params = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('talk.config', params, { timeoutMs: Number(params.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'talk.config', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/talk/speak — Upstream talk speech synthesis
  // =========================================================================
  if (route(req, 'POST', '/api/talk/speak')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('talk.speak', body, { timeoutMs: Number(body.timeoutMs || 120000) || 120000 });
      return json(res, 200, { ok: true, method: 'talk.speak', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/talk/mode — Upstream talk mode toggle
  // =========================================================================
  if (route(req, 'POST', '/api/talk/mode')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('talk.mode', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'talk.mode', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/update/run — Upstream update execution
  // =========================================================================
  if (route(req, 'POST', '/api/update/run')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const result = gatewayMethod('update.run', body, { timeoutMs: Number(body.timeoutMs || 180000) || 180000 });
      return json(res, 200, { ok: true, method: 'update.run', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/send — Upstream outbound send
  // =========================================================================
  if (route(req, 'POST', '/api/send')) {
    try {
      const body = await parseBody(req);
      const params = {
        ...body,
        idempotencyKey: body.idempotencyKey || crypto.randomUUID()
      };
      const result = gatewayMethod('send', params, { timeoutMs: Number(body.timeoutMs || 120000) || 120000 });
      return json(res, 200, {
        ok: true,
        method: 'send',
        idempotencyKey: params.idempotencyKey,
        result
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/agents/identity/resolve — Upstream agent identity resolve
  // =========================================================================
  if (route(req, 'POST', '/api/agents/identity/resolve')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('agent.identity.get', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'agent.identity.get', result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/runtime/agent — Upstream agent run/invoke
  // =========================================================================
  if (route(req, 'POST', '/api/runtime/agent')) {
    try {
      const body = await parseBody(req);
      const params = {
        ...body,
        idempotencyKey: body.idempotencyKey || crypto.randomUUID()
      };
      const result = gatewayMethod('agent', params, {
        timeoutMs: Number(body.timeoutMs || 120000) || 120000,
        expectFinal: body.expectFinal === true
      });
      return json(res, 200, {
        ok: true,
        method: 'agent',
        idempotencyKey: params.idempotencyKey,
        result
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/agent-runs/:runId/wait — Upstream agent run wait
  // =========================================================================
  if ((m = route(req, 'POST', '/api/agent-runs/:runId/wait'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { ...body, runId: m.params.runId };
      const result = gatewayMethod('agent.wait', params, { timeoutMs: Number(body.timeoutMs || 35000) || 35000 });
      return json(res, 200, { ok: true, method: 'agent.wait', runId: m.params.runId, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/system/events — Upstream system event ingest
  // =========================================================================
  if (route(req, 'POST', '/api/system/events')) {
    try {
      const body = await parseBody(req);
      const result = gatewayMethod('system-event', body, { timeoutMs: Number(body.timeoutMs || 30000) || 30000 });
      return json(res, 200, { ok: true, method: 'system-event', result });
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
        const envVal = p.envKey ? getEnvValue(p.envKey) : null;
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
        if (p.oauthOnly) {
          // OAuth-only provider — show OAuth status instead of API key
          const oauthProfile = getOAuthProfile('main');
          apiKeys[id] = oauthProfile ? 'oauth:active' : null;
        } else {
          const envVal = p.envKey ? getEnvValue(p.envKey) : null;
          const profileVal = getAuthProfileApiKey(p.authProfileProvider);
          const val = envVal || profileVal;
          apiKeys[id] = val ? sanitizeKey(val) : null;
        }
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
      // Skip for oauth-only providers (e.g. openai-codex uses OAuth token, not API key)
      if (!providerConfig.oauthOnly) {
        const authProvider = providerConfig.authProfileProvider;
        const existingKey = getEnvValue(providerConfig.envKey);
        if (existingKey) {
          setAuthProfileApiKey(authProvider, existingKey);
        }
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
      tpl.gateway = { mode: 'local', bind: 'lan', auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' }, trustedProxies: ['127.0.0.1', '::1', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16'], controlUi: { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: false } };
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
  // POST /api/channels/zalo/plugin/install — Install Zalo plugin inside OpenClaw
  // =========================================================================
  if (route(req, 'POST', '/api/channels/zalo/plugin/install')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const spec = String(body.spec || '@openclaw/zalo').trim();
      const allowedSpecs = ['@openclaw/zalo', './extensions/zalo'];
      if (!allowedSpecs.includes(spec)) {
        return json(res, 400, { ok: false, error: `Unsupported Zalo plugin spec. Use one of: ${allowedSpecs.join(', ')}` });
      }

      const output = openclawCli(['plugins', 'install', spec], { timeoutMs: Number(body.timeoutMs || 180000) || 180000 });

      const config = readConfig();
      if (!config.plugins) config.plugins = { entries: {} };
      if (!config.plugins.entries) config.plugins.entries = {};
      config.plugins.entries.zalo = { ...(config.plugins.entries.zalo || {}), enabled: true };
      writeConfig(config);

      const restarted = body.restart !== false;
      if (restarted) restartContainer('openclaw');

      return json(res, 200, {
        ok: true,
        channel: 'zalo',
        plugin: spec,
        restarted,
        output,
        state: buildZaloChannelState()
      });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 500, { ok: false, error: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // GET /api/channels/zalo/config — Return local Zalo config snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/channels/zalo/config')) {
    try {
      return json(res, 200, { ok: true, channel: 'zalo', state: buildZaloChannelState() });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PATCH /api/channels/zalo/config — Merge local Zalo config and enable plugin
  // =========================================================================
  if (route(req, 'PATCH', '/api/channels/zalo/config')) {
    try {
      const body = await parseBody(req);
      const patch = isPlainObject(body.patch) ? deepClone(body.patch) : deepClone(body);
      delete patch.patch;
      delete patch.restart;
      delete patch.removeEnvToken;
      delete patch.syncEnvDefaultToken;
      delete patch.timeoutMs;

      const validationErrors = validateZaloConfigInput(patch);
      if (validationErrors.length > 0) {
        return json(res, 400, { ok: false, error: validationErrors[0], errors: validationErrors });
      }

      const config = readConfig();
      if (!config.channels) config.channels = {};
      const current = isPlainObject(config.channels.zalo) ? config.channels.zalo : {};
      const merged = deepMerge(current, patch);

      if (merged.enabled === undefined) merged.enabled = true;
      const defaultDmPolicy = getValueAtPath(merged, 'accounts.default.dmPolicy');
      if (!defaultDmPolicy.exists && !merged.dmPolicy) {
        if (isPlainObject(merged.accounts?.default)) {
          merged.accounts.default.dmPolicy = 'pairing';
        } else {
          merged.dmPolicy = 'pairing';
        }
      }

      const rootTokenPatch = getValueAtPath(patch, 'botToken');
      const defaultTokenPatch = getValueAtPath(patch, 'accounts.default.botToken');
      if (body.removeEnvToken === true) {
        removeEnvValue('ZALO_BOT_TOKEN');
      } else if (rootTokenPatch.exists && typeof rootTokenPatch.value === 'string' && rootTokenPatch.value.trim()) {
        setEnvValue('ZALO_BOT_TOKEN', rootTokenPatch.value.trim());
      } else if (defaultTokenPatch.exists && typeof defaultTokenPatch.value === 'string' && defaultTokenPatch.value.trim() && body.syncEnvDefaultToken !== false) {
        setEnvValue('ZALO_BOT_TOKEN', defaultTokenPatch.value.trim());
      }

      config.channels.zalo = merged;
      if (!config.plugins) config.plugins = { entries: {} };
      if (!config.plugins.entries) config.plugins.entries = {};
      config.plugins.entries.zalo = { ...(config.plugins.entries.zalo || {}), enabled: true };
      writeConfig(config);

      const restarted = body.restart !== false;
      if (restarted) restartContainer('openclaw');

      return json(res, 200, { ok: true, channel: 'zalo', restarted, state: buildZaloChannelState() });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels/zalo/status — Filtered gateway channel status for Zalo
  // =========================================================================
  if (route(req, 'GET', '/api/channels/zalo/status')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const query = normalizeGatewayParams(Object.fromEntries(url.searchParams));
      const result = gatewayMethod('channels.status', { ...query, probe: query.probe === undefined ? true : query.probe }, { timeoutMs: Number(query.timeout || query.timeoutMs || 20000) || 20000 });
      const filtered = isPlainObject(result) && Array.isArray(result.channels)
        ? { ...result, channels: result.channels.filter(item => item && item.channel === 'zalo') }
        : result;
      return json(res, 200, { ok: true, channel: 'zalo', method: 'channels.status', result: filtered });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels/zalo/webhook/config — Local webhook visibility for Zalo
  // =========================================================================
  if (route(req, 'GET', '/api/channels/zalo/webhook/config')) {
    try {
      const state = buildZaloChannelState();
      const config = state.config || {};
      const rootWebhookUrl = getValueAtPath(config, 'webhookUrl');
      const rootWebhookPath = getValueAtPath(config, 'webhookPath');
      const rootWebhookSecret = getValueAtPath(config, 'webhookSecret');
      const defaultWebhookUrl = getValueAtPath(config, 'accounts.default.webhookUrl');
      const defaultWebhookPath = getValueAtPath(config, 'accounts.default.webhookPath');
      const defaultWebhookSecret = getValueAtPath(config, 'accounts.default.webhookSecret');

      return json(res, 200, {
        ok: true,
        channel: 'zalo',
        webhook: {
          mode: state.summary.transportMode,
          configured: state.summary.webhookConfigured,
          root: {
            webhookUrl: rootWebhookUrl.exists ? rootWebhookUrl.value : null,
            webhookPath: rootWebhookPath.exists ? rootWebhookPath.value : null,
            secretConfigured: !!(rootWebhookSecret.exists && rootWebhookSecret.value)
          },
          defaultAccount: {
            webhookUrl: defaultWebhookUrl.exists ? defaultWebhookUrl.value : null,
            webhookPath: defaultWebhookPath.exists ? defaultWebhookPath.value : null,
            secretConfigured: !!(defaultWebhookSecret.exists && defaultWebhookSecret.value)
          },
          constraints: {
            httpsRequired: true,
            secretLength: '8-256 chars',
            pollingAndWebhookMutuallyExclusive: true
          }
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels/zalo/pairings — List pending/approved Zalo pairings
  // =========================================================================
  if (route(req, 'GET', '/api/channels/zalo/pairings')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const account = url.searchParams.get('account');
      const args = ['pairing', 'list', 'zalo'];
      if (account) args.push('--account', account);
      args.push('--json');
      const result = openclawCli(args, { timeoutMs: Number(url.searchParams.get('timeoutMs') || 20000) || 20000, json: true });
      return json(res, 200, { ok: true, channel: 'zalo', method: 'pairing.list', result });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 500, { ok: false, error: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // POST /api/channels/zalo/pairings/approve — Approve a Zalo pairing code
  // =========================================================================
  if (route(req, 'POST', '/api/channels/zalo/pairings/approve')) {
    try {
      const body = await parseBody(req);
      const code = String(body.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'Missing code' });

      const args = ['pairing', 'approve', 'zalo', code];
      if (body.account) args.push('--account', String(body.account));
      if (body.notify === true) args.push('--notify');

      const output = openclawCli(args, { timeoutMs: Number(body.timeoutMs || 20000) || 20000 });
      return json(res, 200, {
        ok: true,
        channel: 'zalo',
        method: 'pairing.approve',
        code,
        result: parseCliJsonOutput(output)
      });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 500, { ok: false, error: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // GET /api/channels/zalo/diagnostics — Consolidated Zalo snapshot
  // =========================================================================
  if (route(req, 'GET', '/api/channels/zalo/diagnostics')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const timeoutMs = Number(url.searchParams.get('timeoutMs') || 20000) || 20000;
      const diagnostics = {
        state: buildZaloChannelState(),
        status: null,
        pairings: null,
        errors: {}
      };

      try {
        const status = gatewayMethod('channels.status', { probe: true }, { timeoutMs });
        diagnostics.status = isPlainObject(status) && Array.isArray(status.channels)
          ? { ...status, channels: status.channels.filter(item => item && item.channel === 'zalo') }
          : status;
      } catch (e) {
        diagnostics.errors.status = e.message;
      }

      try {
        diagnostics.pairings = openclawCli(['pairing', 'list', 'zalo', '--json'], { timeoutMs, json: true });
      } catch (e) {
        diagnostics.errors.pairings = e.stderr ? e.stderr.toString() : e.message;
      }

      return json(res, 200, {
        ok: true,
        channel: 'zalo',
        diagnostics,
        guidance: {
          pluginRequired: true,
          installCommand: 'openclaw plugins install @openclaw/zalo',
          dmPolicyDefault: 'pairing',
          groupsAvailableForMarketplaceBots: false,
          webhookRequiresHttps: true
        }
      });
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
  // POST /api/nodes/:id/invoke-result — Upstream node invoke result callback
  // =========================================================================
  if ((m = route(req, 'POST', '/api/nodes/:id/invoke-result'))) {
    try {
      const body = await parseBody(req);
      const params = { nodeId: m.params.id, ...body };
      const result = gatewayMethod('node.invoke.result', params, {
        timeoutMs: Number(body.timeoutMs || 30000) || 30000
      });
      return json(res, 200, { ok: true, method: 'node.invoke.result', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/:id/events — Upstream node event ingest
  // =========================================================================
  if ((m = route(req, 'POST', '/api/nodes/:id/events'))) {
    try {
      const body = await parseBody(req);
      const params = { nodeId: m.params.id, ...body };
      const result = gatewayMethod('node.event', params, {
        timeoutMs: Number(body.timeoutMs || 30000) || 30000
      });
      return json(res, 200, { ok: true, method: 'node.event', nodeId: m.params.id, result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/nodes/:id/canvas/capability/refresh — Upstream canvas capability refresh
  // =========================================================================
  if ((m = route(req, 'POST', '/api/nodes/:id/canvas/capability/refresh'))) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const params = { nodeId: m.params.id, ...body };
      const result = gatewayMethod('node.canvas.capability.refresh', params, {
        timeoutMs: Number(body.timeoutMs || 30000) || 30000
      });
      return json(res, 200, { ok: true, method: 'node.canvas.capability.refresh', nodeId: m.params.id, result });
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
  // GET /api/skills/custom — List custom workspace skills with rich parsed detail
  // =========================================================================
  if (route(req, 'GET', '/api/skills/custom')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const includeContent = (url.searchParams.get('includeContent') || '').trim().toLowerCase() === 'true';
      const config = readConfig();
      const skills = listSkillsInDirectory(getWorkspaceSkillsDir(config, agentId), 'workspace', config, agentId);
      const customSkills = skills.map(skill => buildCustomSkillResponse(skill, { includeContent }));
      return json(res, 200, {
        ok: true,
        agentId,
        count: customSkills.length,
        skills: customSkills,
        skillKeys: customSkills.map(skill => skill.skillKey)
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/skills/custom/:skillKey — Rich custom skill detail
  // =========================================================================
  if ((m = route(req, 'GET', '/api/skills/custom/:skillKey'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const includeContent = (url.searchParams.get('includeContent') || 'true').trim().toLowerCase() !== 'false';
      const config = readConfig();
      const existing = findWorkspaceSkill(config, agentId, m.params.skillKey);
      if (!existing) {
        return json(res, 404, { ok: false, error: `Workspace skill '${m.params.skillKey}' not found` });
      }
      return json(res, 200, {
        ok: true,
        agentId,
        skill: buildCustomSkillResponse(existing, { includeContent })
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/skills/custom/validate — Validate arbitrary custom skill markdown
  // =========================================================================
  if (route(req, 'POST', '/api/skills/custom/validate')) {
    try {
      const body = await parseBody(req);
      const content = typeof body.content === 'string' ? body.content : '';
      if (!content.trim()) {
        return json(res, 400, { ok: false, error: 'content is required' });
      }
      const expectedSkillKey = (body.skillKey || '').trim();
      const validation = validateCustomSkillContent(content, expectedSkillKey);
      return json(res, validation.ok ? 200 : 422, {
        ok: validation.ok,
        skillKey: validation.skillKey,
        issues: validation.issues,
        missingSections: validation.missingSections,
        parsed: {
          title: validation.parsed.title,
          description: validation.parsed.description,
          summary: validation.parsed.summary,
          metadata: validation.parsed.metadata,
          sections: validation.parsed.sections
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/skills/custom/render — Render detailed custom skill markdown from JSON
  // =========================================================================
  if (route(req, 'POST', '/api/skills/custom/render')) {
    try {
      const body = await parseBody(req);
      const skillKey = toSkillKey(body.skillKey || body.name || body.title || '');
      if (!isValidSkillKey(skillKey)) {
        return json(res, 400, { ok: false, error: 'Invalid skillKey. Provide skillKey, name, or title.' });
      }
      const content = buildCustomSkillMarkdown({ ...body, skillKey });
      const validation = validateCustomSkillContent(content, skillKey);
      return json(res, 200, {
        ok: true,
        skillKey,
        content,
        validation
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/skills/custom/:skillKey — Remove a custom workspace skill
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/skills/custom/:skillKey'))) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const agentId = (url.searchParams.get('agentId') || 'main').trim();
      const config = readConfig();
      const existing = findWorkspaceSkill(config, agentId, m.params.skillKey);
      if (!existing) {
        return json(res, 404, { ok: false, error: `Workspace skill '${m.params.skillKey}' not found` });
      }

      fs.rmSync(existing.skillDir, { recursive: true, force: true });

      return json(res, 200, {
        ok: true,
        agentId,
        skillKey: existing.skillKey,
        deleted: true,
        path: existing.skillDir
      });
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
  // GET /api/devices — List tat ca devices cho agent
  // =========================================================================
  if (route(req, 'GET', '/api/devices')) {
    try {
      const output = dockerExec('node dist/index.js devices list', 15000);
      return json(res, 200, { ok: true, output });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 200, { ok: false, output: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // POST /api/devices/approve/:deviceId — Approve mot device
  // =========================================================================
  if (route(req, 'POST', '/api/devices/approve/')) {
    const deviceId = req.url.replace('/api/devices/approve/', '').split('?')[0].trim();
    if (!deviceId) return json(res, 400, { ok: false, error: 'Missing deviceId' });
    if (!/^[a-f0-9\-]{30,70}$/.test(deviceId)) {
      return json(res, 400, { ok: false, error: 'Invalid deviceId format' });
    }
    try {
      const output = dockerExec(`node dist/index.js devices approve ${deviceId}`, 15000);
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
        'anthropic', 'openai', 'openai-codex', 'google',
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
      // server.js updated successfully = critical part done, restart regardless of template failures
      const serverJsOk = results.find(r => r.file === `${MGMT_API_DIR}/server.js`)?.ok;

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
            liveConfig.gateway.controlUi = { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: false };
            migrated = true;
          } else {
            const ui = liveConfig.gateway.controlUi;
            if (!ui.allowInsecureAuth) { ui.allowInsecureAuth = true; migrated = true; }
            if (!ui.dangerouslyAllowHostHeaderOriginFallback) { ui.dangerouslyAllowHostHeaderOriginFallback = true; migrated = true; }
            if (ui.dangerouslyDisableDeviceAuth === true) { ui.dangerouslyDisableDeviceAuth = false; migrated = true; }
          }
          // Ensure 127.0.0.1 and ::1 in trustedProxies (needed for host network mode)
          const tp = liveConfig.gateway.trustedProxies || [];
          if (!tp.includes('127.0.0.1')) { tp.unshift('127.0.0.1'); migrated = true; }
          if (!tp.includes('::1')) { tp.splice(tp.indexOf('127.0.0.1') + 1, 0, '::1'); migrated = true; }
          liveConfig.gateway.trustedProxies = tp;
          // Ensure allowedOrigins in controlUi includes domain
          const domain = (process.env.DOMAIN || '').replace(/^https?:\/\//, '');
          const ui2 = liveConfig.gateway.controlUi;
          if (ui2) {
            const origins = ui2.allowedOrigins || [];
            const needed = ['http://localhost', 'http://127.0.0.1'];
            if (domain && domain !== 'localhost') {
              needed.unshift(`https://${domain}`, `http://${domain}`);
            }
            for (const o of needed) {
              if (!origins.includes(o)) { origins.push(o); migrated = true; }
            }
            ui2.allowedOrigins = origins;
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
      if (serverJsOk) {
        const msg = allOk ? 'Update complete. Management API restarting...' : 'server.js updated (some templates failed). Management API restarting...';
        json(res, 200, { ok: allOk, message: msg, files: results, compose: composeResult });
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
  // POST /api/config/chatgpt-oauth/start — Bat dau ChatGPT OAuth flow
  // Returns: { sessionId, oauthUrl } — user mo oauthUrl trong browser
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/start')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const agentId = (body.agentId && isValidAgentId(body.agentId)) ? body.agentId : 'main';

      const codeVerifier = pkceVerifier();
      const codeChallenge = pkceChallenge(codeVerifier);
      const state = crypto.randomBytes(16).toString('hex');
      const sessionId = crypto.randomBytes(16).toString('hex');

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: OPENAI_OAUTH_CLIENT_ID,
        redirect_uri: OPENAI_OAUTH_REDIRECT,
        scope: OPENAI_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'pi'
      });
      const oauthUrl = `${OPENAI_OAUTH_AUTH_URL}?${params.toString()}`;

      pruneOAuthSessions();
      _oauthSessions[sessionId] = { codeVerifier, state, agentId, createdAt: Date.now() };

      const codexModels = PROVIDERS['openai-codex'].knownModels;
      return json(res, 200, {
        ok: true,
        sessionId,
        oauthUrl,
        models: codexModels,
        defaultModel: codexModels.find(m => m.default)?.id || codexModels[0].id,
        instructions: 'Open oauthUrl in browser. After login, copy the full redirect URL (localhost:1455/auth/callback?code=...) and POST to /api/config/chatgpt-oauth/complete with { sessionId, redirectUrl, model? }',
        sessionExpiresIn: OAUTH_SESSION_TTL / 1000
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/chatgpt-oauth/complete — Hoan thanh OAuth, luu tokens
  // Body: { sessionId, redirectUrl, model?, switchProvider? }
  // redirectUrl: full localhost:1455/auth/callback?code=...&state=... URL
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/complete')) {
    try {
      const body = await parseBody(req);
      const { sessionId, redirectUrl } = body;

      if (!sessionId) return json(res, 400, { ok: false, error: 'Missing sessionId' });
      if (!redirectUrl) return json(res, 400, { ok: false, error: 'Missing redirectUrl' });

      pruneOAuthSessions();
      const session = _oauthSessions[sessionId];
      if (!session) return json(res, 400, { ok: false, error: 'Session not found or expired. Call /start again.' });

      // Parse authorization code (flexible: full URL, code=... query, or raw code)
      let code, returnedState;
      const trimmed = redirectUrl.trim();
      try {
        // Try full URL first
        const u = new URL(trimmed.startsWith('http') ? trimmed : 'http://localhost/?' + trimmed);
        code = u.searchParams.get('code') || undefined;
        returnedState = u.searchParams.get('state') || undefined;
      } catch {
        // Fallback: raw code
        code = trimmed.includes('#') ? trimmed.split('#')[0] : trimmed;
      }
      if (!code) return json(res, 400, { ok: false, error: 'No "code" found in redirectUrl' });

      // Validate state if present
      if (returnedState && returnedState !== session.state) {
        delete _oauthSessions[sessionId];
        return json(res, 400, { ok: false, error: 'State mismatch — possible CSRF. Start a new session.' });
      }

      // Exchange code for tokens
      let raw;
      try {
        raw = exchangeOAuthCode(code, session.codeVerifier);
      } catch (e) {
        return json(res, 502, { ok: false, error: 'Token exchange failed: ' + e.message });
      }
      if (!raw || !raw.access_token) {
        return json(res, 502, { ok: false, error: 'Token exchange failed: no access_token in response', details: raw });
      }

      // Normalize to openclaw's field format (access/refresh/expires in ms)
      const tokens = {
        access: raw.access_token,
        refresh: raw.refresh_token,
        expires: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : null
      };

      // Store tokens in auth-profiles.json using openclaw's exact format
      const stored = storeOAuthTokens(tokens, session.agentId);
      delete _oauthSessions[sessionId];

      // Switch provider to openai-codex (default: true unless switchProvider=false)
      const shouldSwitch = body.switchProvider !== false;
      let switchedModel = null;
      if (shouldSwitch) {
        try {
          const finalModel = body.model || 'openai-codex/gpt-5.4';
          let config;
          try { config = readConfig(); } catch { config = {}; }
          if (!config.agents) config.agents = { defaults: { model: {}, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
          if (!config.agents.defaults) config.agents.defaults = { model: {}, maxConcurrent: 4, subagents: { maxConcurrent: 8 } };
          if (!config.agents.defaults.model) config.agents.defaults.model = {};
          config.agents.defaults.model.primary = finalModel;
          writeConfig(config);
          restartContainer('openclaw');
          switchedModel = finalModel;
        } catch (e) {
          return json(res, 200, { ok: true, agentId: session.agentId, tokensStored: true, profileKey: stored.profileKey, accountId: stored.accountId, switchedProvider: false, switchError: e.message });
        }
      } else {
        restartContainer('openclaw');
      }

      return json(res, 200, {
        ok: true,
        agentId: session.agentId,
        tokensStored: true,
        profileKey: stored.profileKey,
        accountId: stored.accountId,
        email: stored.email,
        switchedProvider: shouldSwitch,
        model: switchedModel
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/chatgpt-oauth/refresh — Manual refresh token
  // Body: { agentId? }
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/refresh')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const agentId = (body.agentId && isValidAgentId(body.agentId)) ? body.agentId : 'main';

      const profile = getOAuthProfile(agentId);
      if (!profile) return json(res, 404, { ok: false, error: `No OAuth token found for agent "${agentId}". Complete OAuth flow first.` });
      if (!profile.refresh) return json(res, 400, { ok: false, error: 'No refresh token stored. Must re-authenticate via /start + /complete.' });

      const tokens = refreshOAuthToken(profile.refresh);
      if (!tokens || !tokens.access) {
        return json(res, 502, { ok: false, error: 'Refresh failed: no access_token in response' });
      }

      storeOAuthTokens(tokens, agentId);
      restartContainer('openclaw');

      const expiresInMs = tokens.expires ? tokens.expires - Date.now() : null;
      return json(res, 200, {
        ok: true,
        agentId,
        expiresIn: expiresInMs ? Math.round(expiresInMs / 1000) : null,
        expiresAt: tokens.expires || null
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/chatgpt-oauth/status — Xem trang thai OAuth token hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/config/chatgpt-oauth/status')) {
    try {
      const { query } = route(req, 'GET', '/api/config/chatgpt-oauth/status');
      const agentId = (query && query.agentId && isValidAgentId(query.agentId)) ? query.agentId : 'main';
      const profile = getOAuthProfile(agentId);
      pruneOAuthSessions();
      const now = Date.now();
      const expires = profile ? profile.expires : null;
      return json(res, 200, {
        ok: true,
        agentId,
        hasOAuthToken: !!profile,
        profileKey: profile ? profile.key : null,
        accountId: profile ? profile.accountId : null,
        hasRefreshToken: profile ? !!profile.refresh : false,
        expiresAt: expires,
        expiresIn: expires ? Math.max(0, Math.round((expires - now) / 1000)) : null,
        expired: expires ? expires < now : null,
        activeSessions: Object.keys(_oauthSessions).length
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // 404
  // =========================================================================
  json(res, 404, { ok: false, error: 'Not found' });
});

// =============================================================================
// Terminal GUI HTML Page
// =============================================================================
const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OpenClaw Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
#layout{display:flex;flex-direction:column;height:100vh}
#hdr{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0}
.logo{font-size:15px;font-weight:700;color:#58a6ff;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#484f58;flex-shrink:0;transition:background .3s}
.dot.on{background:#3fb950}.dot.off{background:#f85149}
#tw{display:flex;gap:6px;flex:1;min-width:0}
#tok{flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 10px;font-size:13px;outline:none;font-family:monospace}
#tok:focus{border-color:#58a6ff}
.hb{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;white-space:nowrap;transition:background .15s}
.con{background:#238636;color:#fff}.con:hover{background:#2ea043}
.clr{background:#21262d;color:#8b949e;border:1px solid #30363d}.clr:hover{color:#c9d1d9}
#qbar{display:flex;align-items:center;gap:4px;padding:5px 12px;background:#0d1117;border-bottom:1px solid #21262d;flex-shrink:0;overflow-x:auto;white-space:nowrap}
#qbar::-webkit-scrollbar{height:3px}#qbar::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.ql{font-size:11px;color:#484f58;margin-right:4px}
.qb{padding:3px 9px;background:#161b22;border:1px solid #21262d;border-radius:4px;color:#8b949e;font-size:12px;cursor:pointer;transition:all .15s}
.qb:hover{color:#e6edf3;border-color:#58a6ff}
#tw2{flex:1;overflow:hidden;padding:4px 2px 2px}
.xterm-viewport::-webkit-scrollbar{width:6px}
.xterm-viewport::-webkit-scrollbar-thumb{background:#21262d;border-radius:3px}
</style>
</head>
<body>
<div id="layout">
  <div id="hdr">
    <span class="dot" id="dot"></span>
    <span class="logo">\u{1F980} OpenClaw Terminal</span>
    <div id="tw">
      <input type="password" id="tok" placeholder="Management API Key..." autocomplete="off" spellcheck="false">
      <button class="hb con" onclick="doConnect()">Connect</button>
      <button class="hb clr" onclick="doClear()">Clear</button>
    </div>
  </div>
  <div id="qbar">
    <span class="ql">Quick:</span>
    <button class="qb" onclick="q('docker compose ps')">status</button>
    <button class="qb" onclick="q('docker compose logs --tail=80 openclaw')">logs</button>
    <button class="qb" onclick="q('docker compose logs -f openclaw')">logs -f</button>
    <button class="qb" onclick="q('docker compose restart openclaw')">restart</button>
    <button class="qb" onclick="q('docker compose pull openclaw')">pull</button>
    <button class="qb" onclick="q('docker compose up -d')">up -d</button>
    <button class="qb" onclick="q('docker compose down')">down</button>
    <button class="qb" onclick="q('docker compose stats --no-stream openclaw')">stats</button>
    <button class="qb" onclick="q('df -h')">df</button>
    <button class="qb" onclick="q('free -h')">free</button>
    <button class="qb" onclick="q('uptime')">uptime</button>
    <button class="qb" onclick="q('openclaw models scan')">models scan</button>
    <button class="qb" onclick="q('openclaw channels list')">channels</button>
    <button class="qb" onclick="q('openclaw version')">version</button>
  </div>
  <div id="tw2"><div id="terminal"></div></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
var TK='oc_mgmt_token', HK='oc_term_hist';
var term, fit, buf='', hist=[], hidx=-1, running=false, sse=null, tok='', conn=false;
try{hist=JSON.parse(localStorage.getItem(HK)||'[]');}catch(e){}
try{tok=localStorage.getItem(TK)||'';}catch(e){}

function initTerm(){
  term=new Terminal({
    cursorBlink:true,
    fontFamily:'"Cascadia Code","JetBrains Mono","Courier New",monospace',
    fontSize:14,lineHeight:1.3,scrollback:5000,
    theme:{
      background:'#0d1117',foreground:'#c9d1d9',cursor:'#58a6ff',
      selectionBackground:'#264f78',
      black:'#484f58',red:'#f85149',green:'#3fb950',yellow:'#d29922',
      blue:'#58a6ff',magenta:'#bc8cff',cyan:'#76e3ea',white:'#b1bac4',
      brightBlack:'#6e7681',brightRed:'#ff7b72',brightGreen:'#56d364',
      brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
      brightCyan:'#87deea',brightWhite:'#f0f6fc'
    }
  });
  fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();
  window.addEventListener('resize',function(){fit.fit();});
  term.onKey(function(e){handleKey(e.key,e.domEvent);});
}

function handleKey(key,e){
  if(running){
    if(e.ctrlKey&&e.key==='c'){killSSE();term.write('^C\\r\\n');prompt();}
    return;
  }
  if(e.ctrlKey){if(e.key==='l'){term.clear();prompt();}return;}
  if(e.key==='Enter'){
    var cmd=buf.trim();term.write('\\r\\n');buf='';hidx=-1;
    if(cmd){
      if(!hist.length||hist[0]!==cmd){hist.unshift(cmd);if(hist.length>200)hist.pop();try{localStorage.setItem(HK,JSON.stringify(hist));}catch(ex){}}
      execCmd(cmd);
    }else{prompt();}
  }else if(e.key==='Backspace'){
    if(buf.length){buf=buf.slice(0,-1);term.write('\\b \\b');}
  }else if(e.key==='ArrowUp'){
    if(hidx<hist.length-1){hidx++;clearBuf();buf=hist[hidx];term.write(buf);}
  }else if(e.key==='ArrowDown'){
    if(hidx>0){hidx--;clearBuf();buf=hist[hidx];term.write(buf);}
    else if(hidx===0){hidx=-1;clearBuf();}
  }else if(!e.altKey&&!e.metaKey&&key.length===1){buf+=key;term.write(key);}
}

function clearBuf(){if(buf.length)term.write('\\b \\b'.repeat(buf.length));buf='';}
function prompt(){if(conn)term.write('\\x1b[32m$\\x1b[0m ');}

function killSSE(){if(sse){try{sse.close();}catch(e){}sse=null;}running=false;}

function execCmd(cmd){
  if(!conn||!tok){term.write('\\x1b[31mNot connected\\x1b[0m\\r\\n');prompt();return;}
  running=true;
  sse=new EventSource('/api/terminal/stream?cmd='+encodeURIComponent(cmd)+'&token='+encodeURIComponent(tok));
  sse.onmessage=function(ev){
    try{
      var d=JSON.parse(ev.data);
      if(d.type==='stdout')term.write(d.text.replace(/\\n/g,'\\r\\n').replace(/\\r\\r\\n/g,'\\r\\n'));
      else if(d.type==='stderr')term.write('\\x1b[33m'+d.text.replace(/\\n/g,'\\r\\n')+'\\x1b[0m');
      else if(d.type==='error'){term.write('\\x1b[31m'+d.text+'\\x1b[0m\\r\\n');killSSE();prompt();}
      else if(d.type==='exit'){if(d.code)term.write('\\r\\n\\x1b[2m[exit '+d.code+']\\x1b[0m');term.write('\\r\\n');killSSE();prompt();}
    }catch(ex){}
  };
  sse.onerror=function(){term.write('\\r\\n\\x1b[31m[stream error]\\x1b[0m\\r\\n');killSSE();prompt();};
}

function doConnect(){
  var v=document.getElementById('tok').value.trim();
  if(v){tok=v;try{localStorage.setItem(TK,v);}catch(e){}}
  if(!tok){term.write('\\x1b[31mEnter Management API Key\\x1b[0m\\r\\n');return;}
  fetch('/api/status',{headers:{Authorization:'Bearer '+tok}})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.status||d.ok!==false){
        conn=true;
        document.getElementById('dot').className='dot on';
        term.write('\\x1b[32mConnected!\\x1b[0m  (Ctrl+C = cancel, Ctrl+L = clear)\\r\\n\\r\\n');
        prompt();
      }else{
        term.write('\\x1b[31mAuth failed: '+(d.error||'check your key')+'\\x1b[0m\\r\\n');
        document.getElementById('dot').className='dot off';
      }
    }).catch(function(){
      term.write('\\x1b[31mConnection error\\x1b[0m\\r\\n');
      document.getElementById('dot').className='dot off';
    });
}

function doClear(){if(term){term.clear();if(conn)prompt();}}

function q(cmd){
  if(!conn){term.write('\\x1b[33mConnect first (enter API key + click Connect)\\x1b[0m\\r\\n');return;}
  if(running)killSSE();
  clearBuf();
  term.write('\\x1b[32m$\\x1b[0m '+cmd+'\\r\\n');
  execCmd(cmd);
}

window.addEventListener('DOMContentLoaded',function(){
  initTerm();
  if(tok)document.getElementById('tok').placeholder='Key saved \u2014 click Connect';
  term.write('\\x1b[1;34m OpenClaw Terminal\\x1b[0m\\r\\n');
  term.write('\\x1b[2m \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\\x1b[0m\\r\\n');
  term.write('\\x1b[2m Allowed cmds: docker compose ..., openclaw ...\\x1b[0m\\r\\n');
  term.write('\\x1b[2m               df, free, uptime, ps, date\\x1b[0m\\r\\n\\r\\n');
  term.write('\\x1b[2m Enter API key above and click Connect\\x1b[0m\\r\\n\\r\\n');
});
</script>
</body>
</html>`;

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
// =============================================================================
// Auto-refresh OAuth tokens background job (runs every 5 minutes)
// =============================================================================
setInterval(() => {
  try {
    // Collect all known agent IDs from config + scan agents dir
    const agentIds = new Set(['main']);
    try {
      const config = JSON.parse(fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8'));
      for (const a of (config?.agents?.list || [])) {
        if (a.id) agentIds.add(a.id);
      }
    } catch {}
    try {
      for (const d of fs.readdirSync(`${CONFIG_DIR}/agents`)) agentIds.add(d);
    } catch {}

    let anyRefreshed = false;
    for (const agentId of agentIds) {
      const result = tryRefreshAgent(agentId);
      if (result === 'refreshed') anyRefreshed = true;
    }
    if (anyRefreshed) restartContainer('openclaw');
  } catch (e) {
    console.error(`[OAuth] Auto-refresh job error: ${e.message}`);
  }
}, 5 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management API] Running on http://0.0.0.0:${PORT}`);
});