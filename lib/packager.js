'use strict';

/**
 * Package the current feishu-kb-sync sources into a zip for manual copy to a Skill directory.
 * 只收集发布包需要的目录和文件，不把工作区的 .git、node_modules 或临时文件带入归档。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PACKAGE_ITEMS = ['bin', 'lib', 'scripts', 'test', 'diag-export.js', 'package.json'];
const DEFAULT_OUTPUT_PATH = path.join(process.cwd(), 'feishu-kb-sync.zip');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function normalizeEntryName(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function collectPackageFiles(sourceRoot = path.resolve(__dirname, '..')) {
  const root = path.resolve(sourceRoot);
  const files = [];

  function visit(fullPath, relativePath) {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`发布包不支持符号链接: ${fullPath}`);
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(fullPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        visit(path.join(fullPath, child.name), path.join(relativePath, child.name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`发布包只支持普通文件: ${fullPath}`);
    }
    files.push({
      absolutePath: fullPath,
      relativePath: normalizeEntryName(relativePath),
      stat,
    });
  }

  for (const item of PACKAGE_ITEMS) {
    const fullPath = path.join(root, item);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`发布包缺少必要内容: ${fullPath}`);
    }
    visit(fullPath, item);
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function createLocalHeader(name, method, time, date, crc, compressedSize, size, flags) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30 + nameBuffer.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  nameBuffer.copy(header, 30);
  return header;
}

function createCentralHeader(name, method, time, date, crc, compressedSize, size, flags, offset) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(46 + nameBuffer.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  nameBuffer.copy(header, 46);
  return header;
}

function createEndOfCentralDirectory(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function createZipBuffer(files) {
  if (files.length > 0xffff) throw new Error('发布包文件数量超过 ZIP 格式限制');

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.absolutePath);
    const compressed = zlib.deflateRawSync(data);
    const method = compressed.length < data.length ? 8 : 0;
    const payload = method === 8 ? compressed : data;
    if (data.length > 0xffffffff || payload.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error(`文件过大，无法写入 ZIP: ${file.relativePath}`);
    }

    const { dosTime, dosDate } = dosDateTime(file.stat.mtime);
    const flags = 0x800;
    const checksum = crc32(data);
    const localHeader = createLocalHeader(
      file.relativePath,
      method,
      dosTime,
      dosDate,
      checksum,
      payload.length,
      data.length,
      flags,
    );
    const centralHeader = createCentralHeader(
      file.relativePath,
      method,
      dosTime,
      dosDate,
      checksum,
      payload.length,
      data.length,
      flags,
      offset,
    );

    localParts.push(localHeader, payload);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = createEndOfCentralDirectory(files.length, centralDirectory.length, offset);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function parsePackageArgs(args = []) {
  let outputPath = DEFAULT_OUTPUT_PATH;
  let sourceRoot = path.resolve(__dirname, '..');

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--output' || arg === '-o') {
      outputPath = args[++i];
      if (!outputPath) throw new Error('--output 需要提供 ZIP 输出路径');
      continue;
    }
    if (arg === '--source') {
      sourceRoot = args[++i];
      if (!sourceRoot) throw new Error('--source 需要提供 sync 源码目录');
      continue;
    }
    throw new Error(`未知参数: ${arg}\n用法: feishu-kb-sync package-skill [--output <ZIP路径>] [--source <sync目录>]`);
  }

  return { outputPath: path.resolve(outputPath), sourceRoot: path.resolve(sourceRoot) };
}

function assertOutputDirectory(outputPath) {
  const outputDirectory = path.dirname(outputPath);
  let stat;
  try {
    stat = fs.statSync(outputDirectory);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`输出目录不存在，请先创建目录: ${outputDirectory}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`输出路径的父级不是目录: ${outputDirectory}`);
  }
  return outputDirectory;
}

function packageSkill(args = []) {
  const { outputPath, sourceRoot } = parsePackageArgs(args);
  assertOutputDirectory(outputPath);
  const files = collectPackageFiles(sourceRoot);
  const archive = createZipBuffer(files);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, archive);
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    fs.renameSync(temporaryPath, outputPath);
  } catch (err) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
    throw err;
  }

  const result = {
    outputPath,
    sourceRoot,
    fileCount: files.length,
    size: archive.length,
    entries: files.map((file) => file.relativePath),
  };
  console.log(`已生成 feishu-kb-sync 安装包: ${outputPath}`);
  console.log(`包含 ${result.fileCount} 个文件，共 ${result.size} 字节`);
  return result;
}

module.exports = {
  PACKAGE_ITEMS,
  DEFAULT_OUTPUT_PATH,
  collectPackageFiles,
  createZipBuffer,
  parsePackageArgs,
  packageSkill,
};
