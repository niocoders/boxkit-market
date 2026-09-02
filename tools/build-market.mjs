#!/usr/bin/env node
/**
 * Build the standalone BoxKit plugin market.
 *
 * Source: plugins/<directory>/
 * Output: site/index.html, site/manifest.json, site/plugins/*.bkx, site/logo/*
 * .bkx files are stored ZIP archives with a fixed DOS timestamp so their
 * bytes, and therefore sha256 values, are reproducible.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const SITE_DIR = path.join(ROOT, "site");
const FIXED_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME = 0;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const FEATURE_CODE = /^[A-Za-z0-9_-]+$/;
const PERMISSIONS = new Set(["clipboard", "db", "notify", "network", "shell", "screen", "window"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafePluginPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function resolvePluginPath(dir, value) {
  const normalized = value.replaceAll("\\", "/");
  const target = path.resolve(dir, normalized);
  const relative = path.relative(dir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function requireString(value, label, errors, { min = 0, max = Infinity } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    errors.push(`${label}: 需为 ${min ? `${min}-` : ""}${Number.isFinite(max) ? max : "不限"} 字符字符串`);
    return false;
  }
  return true;
}

function validateOptionalString(raw, key, errors, max) {
  if (raw[key] !== undefined) requireString(raw[key], key, errors, { min: 1, max });
}

function slugFromPluginName(pluginName) {
  let slug = pluginName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug.length < 2 || !/^[a-z0-9]/.test(slug)) {
    const hash = Array.from(pluginName).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
    slug = `plugin-${hash.toString(36)}`;
  }
  return slug;
}

/** Normalize only the fields consumed by the market; plugin.json stays byte-for-byte in .bkx. */
function normalizeManifest(raw, dirName) {
  const manifest = structuredClone(raw);
  const pluginName = typeof manifest.pluginName === "string" ? manifest.pluginName.trim() : "";
  if (pluginName && typeof manifest.name !== "string") {
    manifest.name = slugFromPluginName(pluginName);
    manifest.displayName = manifest.displayName ?? pluginName;
  }
  manifest.name = manifest.name === undefined ? dirName : manifest.name;
  manifest.displayName = manifest.displayName === undefined ? (manifest.pluginName === undefined ? dirName : manifest.pluginName) : manifest.displayName;
  manifest.main = manifest.main === undefined ? "index.html" : manifest.main;
  if (Array.isArray(manifest.features)) {
    manifest.features = manifest.features.map((feature) => {
      if (!isObject(feature) || !Array.isArray(feature.cmds)) return feature;
      return {
        ...feature,
        cmds: feature.cmds.map((command) => {
          if (!isObject(command) || command.type !== "regex") return command;
          if (command.minLength === undefined && command.minNum !== undefined) {
            return { ...command, minLength: command.minNum };
          }
          return command;
        }),
      };
    });
  }
  return manifest;
}

function validateCommand(command, label, errors) {
  if (typeof command === "string") {
    if (!command.trim()) errors.push(`${label}: 关键字不能为空`);
    return;
  }
  if (!isObject(command)) {
    errors.push(`${label}: 需为字符串或对象`);
    return;
  }
  if (command.type !== undefined) requireString(command.type, `${label}.type`, errors, { min: 1, max: 32 });
  for (const key of ["match", "explain", "label"]) {
    if (command[key] !== undefined) requireString(command[key], `${label}.${key}`, errors, { min: 1, max: 500 });
  }
  for (const key of ["minLength", "minNum"]) {
    if (command[key] !== undefined && (!Number.isInteger(command[key]) || command[key] < 1 || command[key] > 200)) {
      errors.push(`${label}.${key}: 需为 1-200 的整数`);
    }
  }
  if (command.fileType !== undefined && (!Array.isArray(command.fileType) || command.fileType.some((value) => typeof value !== "string"))) {
    errors.push(`${label}.fileType: 需为字符串数组`);
  }
  if (command.maxLength !== undefined && (!Number.isInteger(command.maxLength) || command.maxLength < 1 || command.maxLength > 10000)) {
    errors.push(`${label}.maxLength: 需为 1-10000 的整数`);
  }
}

function validateFeature(feature, index, errors) {
  const label = `features[${index}]`;
  if (!isObject(feature)) {
    errors.push(`${label}: 需为对象`);
    return;
  }
  if (!requireString(feature.code, `${label}.code`, errors, { min: 1, max: 128 }) || !FEATURE_CODE.test(feature.code)) {
    errors.push(`${label}.code: 仅允许字母、数字、下划线和中划线`);
  }
  requireString(feature.explain, `${label}.explain`, errors, { min: 1, max: 500 });
  if (!Array.isArray(feature.cmds) || feature.cmds.length === 0) {
    errors.push(`${label}.cmds: 不能为空数组`);
  } else {
    feature.cmds.forEach((command, commandIndex) => validateCommand(command, `${label}.cmds[${commandIndex}]`, errors));
  }
  if (feature.platform !== undefined && !validPlatform(feature.platform)) errors.push(`${label}.platform: 需为字符串或字符串数组`);
  if (feature.icon !== undefined) requireString(feature.icon, `${label}.icon`, errors, { min: 1, max: 500 });
  for (const key of ["mainHide", "mainPush"]) {
    if (feature[key] !== undefined && typeof feature[key] !== "boolean") errors.push(`${label}.${key}: 需为布尔值`);
  }
}

function validPlatform(value) {
  return typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function validateManifest(manifest, dirName, dir, errors) {
  if (!SAFE_NAME.test(manifest.name ?? "") || (manifest.name ?? "").length < 2 || (manifest.name ?? "").length > 64) {
    errors.push(`${dirName}: name 需为 2-64 位小写字母/数字/中划线`);
  }
  if (manifest.pluginName !== undefined) requireString(manifest.pluginName, `${dirName}.pluginName`, errors, { min: 1, max: 128 });
  requireString(manifest.displayName, `${dirName}.displayName`, errors, { min: 1, max: 64 });
  if (!SEMVER.test(manifest.version ?? "")) errors.push(`${dirName}: version 需符合 semver，如 1.0.0`);
  validateOptionalString(manifest, "description", errors, 500);
  validateOptionalString(manifest, "author", errors, 128);
  validateOptionalString(manifest, "minHostVersion", errors, 128);
  if (manifest.homepage !== undefined) requireString(manifest.homepage, `${dirName}.homepage`, errors, { min: 1, max: 2048 });
  if (manifest.platform !== undefined && !validPlatform(manifest.platform)) errors.push(`${dirName}.platform: 需为字符串或字符串数组`);
  if (manifest.pluginSetting !== undefined && !isObject(manifest.pluginSetting)) errors.push(`${dirName}.pluginSetting: 需为对象`);

  if (manifest.permissions === undefined) {
    manifest.permissions = [];
  }
  if (!Array.isArray(manifest.permissions)) {
    errors.push(`${dirName}.permissions: 需为数组`);
  } else {
    for (const permission of manifest.permissions) {
      if (typeof permission !== "string" || !PERMISSIONS.has(permission)) errors.push(`${dirName}: 不支持的权限 ${String(permission)}`);
    }
  }
  if (!Array.isArray(manifest.features) || manifest.features.length === 0) {
    errors.push(`${dirName}: features 不能为空数组`);
  } else {
    manifest.features.forEach((feature, index) => validateFeature(feature, index, errors));
  }

  for (const key of ["main", "preload", "logo"]) {
    if (manifest[key] === undefined && key !== "main") continue;
    if (!isSafePluginPath(manifest[key])) {
      errors.push(`${dirName}.${key}: 需为插件目录内的安全相对路径`);
      continue;
    }
    const target = resolvePluginPath(dir, manifest[key]);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      errors.push(`${dirName}: ${key} 文件 ${manifest[key]} 不存在或不是普通文件`);
    }
  }
}

function walkFiles(dir, current = dir, output = []) {
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(current, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`插件包含不允许的符号链接: ${path.relative(dir, full)}`);
    if (entry.isDirectory()) walkFiles(dir, full, output);
    else if (entry.isFile()) output.push({ rel: path.relative(dir, full).split(path.sep).join("/"), full });
    else throw new Error(`插件包含非普通文件: ${path.relative(dir, full)}`);
  }
  return output;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    let current = (value ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit++) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    value = (value >>> 8) ^ current;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.rel, "utf8");
    const data = fs.readFileSync(file.full);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function listPluginEntries() {
  if (!fs.existsSync(PLUGINS_DIR)) throw new Error("plugins/ 目录不存在");
  const errors = [];
  const entries = [];
  const seenIds = new Set();
  const rootEntries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of rootEntries) {
    if (entry.name.startsWith(".")) continue;
    const dir = path.join(PLUGINS_DIR, entry.name);
    if (!entry.isDirectory() || fs.lstatSync(dir).isSymbolicLink()) {
      errors.push(`${entry.name}: plugins/ 下只能放插件目录`);
      continue;
    }
    const manifestPath = path.join(dir, "plugin.json");
    if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
      errors.push(`${entry.name}: 缺少普通文件 plugin.json`);
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`${entry.name}: plugin.json 解析失败（${error.message}）`);
      continue;
    }
    if (!isObject(raw)) {
      errors.push(`${entry.name}: plugin.json 根值需为对象`);
      continue;
    }
    const manifest = normalizeManifest(raw, entry.name);
    const manifestErrors = [];
    validateManifest(manifest, entry.name, dir, manifestErrors);
    if (manifestErrors.length) {
      for (const error of manifestErrors) errors.push(error);
      continue;
    }
    if (seenIds.has(manifest.name)) {
      errors.push(`${entry.name}: 归一化后的 name ${manifest.name} 重复`);
      continue;
    }
    seenIds.add(manifest.name);
    entries.push({ dir, manifest, bkxRel: `plugins/${manifest.name}-${manifest.version}.bkx` });
  }
  if (errors.length) {
    console.error(`[build-market] 校验失败，共 ${errors.length} 处：`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return [];
  }
  if (!entries.length) {
    console.error("[build-market] plugins/ 下没有可用插件");
    process.exitCode = 1;
  }
  return entries;
}

function build() {
  const entries = listPluginEntries();
  if (!entries.length) return;
  fs.rmSync(path.join(SITE_DIR, "manifest.json"), { force: true });
  fs.rmSync(path.join(SITE_DIR, "plugins"), { recursive: true, force: true });
  fs.rmSync(path.join(SITE_DIR, "logo"), { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE_DIR, "plugins"), { recursive: true });

  const manifestEntries = [];
  for (const { dir, manifest, bkxRel } of entries) {
    let files;
    try {
      files = walkFiles(dir);
    } catch (error) {
      console.error(`[build-market] ${path.basename(dir)}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const zip = buildZip(files);
    const bkxPath = path.join(SITE_DIR, ...bkxRel.split("/"));
    fs.writeFileSync(bkxPath, zip);

    let logoRel;
    if (manifest.logo) {
      const extension = path.extname(manifest.logo) || ".svg";
      logoRel = `logo/${manifest.name}${extension.toLowerCase()}`;
      fs.mkdirSync(path.join(SITE_DIR, "logo"), { recursive: true });
      fs.copyFileSync(resolvePluginPath(dir, manifest.logo), path.join(SITE_DIR, ...logoRel.split("/")));
    }

    const keywords = manifest.features.flatMap((feature) => feature.cmds).filter((command) => typeof command === "string");
    manifestEntries.push({
      pluginId: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version,
      description: manifest.description || undefined,
      author: manifest.author || undefined,
      logoUrl: logoRel,
      fileUrl: bkxRel,
      fileSize: zip.length,
      sha256: crypto.createHash("sha256").update(zip).digest("hex"),
      keywords,
    });
    console.log(`[build-market] ${manifest.name} v${manifest.version} -> ${bkxRel} (${files.length} files, ${zip.length}B)`);
  }

  manifestEntries.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const updatedAt = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : new Date().toISOString();
  const manifest = { updatedAt, plugins: manifestEntries };
  fs.writeFileSync(path.join(SITE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[build-market] site/manifest.json 完成，共 ${manifestEntries.length} 个插件`);
}

build();
