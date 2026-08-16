'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeVbs } = require('../lib/schedule.js');

if (process.platform !== 'win32') {
  console.log('schedule VBS check skipped: Windows Script Host is only available on Windows');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-vbs-check-'));
try {
  const vbsFile = path.join(root, 'run-sync.vbs');
  const logFile = path.join(root, 'sync.log');
  const cliPath = path.join(root, 'runner.vbs');
  const markerFile = path.join(root, 'runner.started');
  const cscriptPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
  const markerVbsPath = markerFile.replace(/\\/g, '\\\\');
  fs.writeFileSync(cliPath, [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set file = fso.CreateTextFile("' + markerVbsPath + '", True)',
    'file.WriteLine "ok"',
    'file.Close',
  ].join('\r\n'), 'utf8');

  writeVbs(null, { vbsFile, logFile, cliPath, nodePath: cscriptPath, launcherPath: false, all: true });
  const generated = fs.readFileSync(vbsFile, 'utf8');
  if (!generated.includes('--all') || generated.includes('--space-id') || /cmd\.exe/i.test(generated)) {
    throw new Error('scheduled VBS must launch the all-knowledge-base scope with a direct hidden launcher');
  }
  fs.writeFileSync(vbsFile, fs.readFileSync(vbsFile, 'utf8').replace(', 0, False', ', 0, True'), 'utf8');

  let output = '';
  try {
    output = execFileSync(cscriptPath, ['//nologo', vbsFile], { encoding: 'utf8', timeout: 10000 });
  } catch (err) {
    output = String(err.stdout || '') + String(err.stderr || '');
  }

  if (/cannot find the file specified/i.test(output) || !fs.existsSync(markerFile)) {
    throw new Error([
      'generated VBS did not launch the target command',
      output,
      fs.readFileSync(vbsFile, 'utf8'),
      fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '<log missing>',
    ].join('\n'));
  }
  console.log('schedule VBS check passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
