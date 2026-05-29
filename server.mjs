import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const distDir = path.join(root, 'dist');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const maxUploadBytes = 128 * 1024 * 1024;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxUploadBytes) {
        req.destroy(new Error('Clip is too large to transcode.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      outputPath,
    ]);
    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function handleTranscode(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }

  let tempDir = '';
  try {
    const source = await collectRequestBody(req);
    if (source.length === 0) {
      sendText(res, 400, 'Missing clip data.');
      return;
    }

    const contentType = String(req.headers['content-type'] || '');
    const sourceExtension = contentType.includes('mp4') ? 'mp4' : 'webm';
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'stop-at-2-'));
    const inputPath = path.join(tempDir, `input.${sourceExtension}`);
    const outputPath = path.join(tempDir, 'output.mp4');

    await writeFile(inputPath, source);
    await runFfmpeg(inputPath, outputPath);
    const output = await readFile(outputPath);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': output.length,
      'Cache-Control': 'no-store',
    });
    res.end(output);
  } catch (error) {
    console.error(error);
    sendText(res, 500, 'MP4 transcode failed.');
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function serveProductionAsset(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const resolvedPath = path.resolve(distDir, `.${requestedPath}`);
  const safePath = resolvedPath.startsWith(distDir) ? resolvedPath : path.join(distDir, 'index.html');
  const filePath = await stat(safePath)
    .then((fileStat) => (fileStat.isFile() ? safePath : path.join(distDir, 'index.html')))
    .catch(() => path.join(distDir, 'index.html'));
  const extension = path.extname(filePath);

  res.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// Google Drive upload via OAuth2 refresh token
// Required env vars:
//   GOOGLE_OAUTH_CLIENT_ID     — OAuth2 client ID
//   GOOGLE_OAUTH_CLIENT_SECRET — OAuth2 client secret
//   GOOGLE_OAUTH_REFRESH_TOKEN — long-lived refresh token
//   DRIVE_FOLDER_ID            — folder for all submissions
//   DRIVE_WINNER_FOLDER_ID     — folder for exact 2.00 winners (optional; falls back to DRIVE_FOLDER_ID)
// ---------------------------------------------------------------------------

async function getDriveAccessToken() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await res.json();
  if (!data.access_token) console.error('[drive-auth] token error:', JSON.stringify(data));
  return data.access_token || null;
}

async function uploadFileToDrive(accessToken, fileBuffer, filename, mimeType, folderId) {
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const boundary = 'sa2_boundary_x9z';
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const filePart = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const endPart  = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(metaPart), Buffer.from(filePart), fileBuffer, Buffer.from(endPart),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  return res.json();
}

async function driveSearchByName(accessToken, filename, folderIds) {
  const nameClause = `name = '${filename.replace(/'/g, "\\'")}'`;
  const folderClause = folderIds.length
    ? ' and (' + folderIds.map(id => `'${id}' in parents`).join(' or ') + ')'
    : '';
  const q = encodeURIComponent(`${nameClause}${folderClause} and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await res.json();
  return (data.files || []);
}

async function driveDeleteFile(accessToken, fileId) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ---------------------------------------------------------------------------
// repurpose.io webhook — called after a clip has been published to social.
// Deletes the source file from Drive so the folder stays clean.
//
// Setup in repurpose.io: Settings → Notifications → Webhook URL →
//   https://your-domain/api/repurpose-webhook
// Optional: set REPURPOSE_WEBHOOK_SECRET env var + configure it in repurpose.io
// to verify the X-Repurpose-Signature header.
//
// repurpose.io sends different payload shapes depending on plan/version.
// We try several known field paths so this stays resilient to their changes.
// ---------------------------------------------------------------------------
async function handleRepurposeWebhook(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body;
  try {
    const raw = await collectRequestBody(req);

    // Optional webhook secret verification
    const secret = process.env.REPURPOSE_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-repurpose-signature'] || req.headers['x-webhook-secret'] || '';
      if (sig !== secret) {
        sendText(res, 401, 'Invalid webhook signature.');
        return;
      }
    }

    body = JSON.parse(raw.toString());
  } catch {
    sendText(res, 400, 'Invalid JSON body.');
    return;
  }

  // Log full payload for debugging (remove once confirmed working)
  console.log('[repurpose-webhook] payload:', JSON.stringify(body, null, 2));

  // Extract source filename — try every known payload shape repurpose.io uses
  const filename =
    body?.content?.source_file_name ||
    body?.content?.source?.file_name ||
    body?.data?.source?.file_name ||
    body?.data?.title ||
    body?.content?.title ||
    body?.title ||
    body?.file_name ||
    null;

  if (!filename) {
    console.warn('[repurpose-webhook] could not extract filename from payload — not deleting');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted: false, reason: 'filename_not_found_in_payload' }));
    return;
  }

  const folderId       = process.env.DRIVE_FOLDER_ID;
  const winnerFolderId = process.env.DRIVE_WINNER_FOLDER_ID || folderId;
  if (!folderId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted: false, reason: 'drive_not_configured' }));
    return;
  }

  try {
    const accessToken = await getDriveAccessToken();
    if (!accessToken) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: false, reason: 'no_access_token' }));
      return;
    }

    const folderIds = [...new Set([folderId, winnerFolderId].filter(Boolean))];
    const files = await driveSearchByName(accessToken, filename, folderIds);

    if (files.length === 0) {
      console.log(`[repurpose-webhook] file not found in Drive: ${filename}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: false, reason: 'file_not_found', filename }));
      return;
    }

    await Promise.all(files.map(f => driveDeleteFile(accessToken, f.id)));
    console.log(`[repurpose-webhook] deleted ${files.length} file(s): ${filename}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted: true, count: files.length, filename }));
  } catch (err) {
    console.error('[repurpose-webhook]', err);
    // Always 200 — repurpose.io retries on non-2xx, which we don't want
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
}

async function handleDriveUpload(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  const folderId       = process.env.DRIVE_FOLDER_ID;
  const winnerFolderId = process.env.DRIVE_WINNER_FOLDER_ID || folderId;

  if (!folderId) {
    sendText(res, 503, 'Drive upload not configured (missing DRIVE_FOLDER_ID).');
    return;
  }

  try {
    const accessToken = await getDriveAccessToken();
    if (!accessToken) {
      sendText(res, 503, 'Drive upload not configured (missing service account credentials).');
      return;
    }

    const body = await collectRequestBody(req);

    // Parse a simple multipart/form-data with fields: file (binary), meta (JSON)
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) { sendText(res, 400, 'Missing multipart boundary.'); return; }
    const bound = boundaryMatch[1];

    // Split on boundary
    const sep = Buffer.from(`--${bound}`);
    const parts = [];
    let start = body.indexOf(sep) + sep.length + 2; // skip \r\n
    while (start < body.length) {
      const end = body.indexOf(sep, start);
      if (end === -1) break;
      parts.push(body.slice(start, end - 2)); // trim trailing \r\n
      start = end + sep.length + 2;
    }

    let videoBuffer = null;
    let meta = {};
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headerBlock = part.slice(0, headerEnd).toString();
      const content = part.slice(headerEnd + 4);
      const nameMatch = headerBlock.match(/name="([^"]+)"/);
      if (!nameMatch) continue;
      if (nameMatch[1] === 'file') videoBuffer = content;
      if (nameMatch[1] === 'meta') {
        try { meta = JSON.parse(content.toString()); } catch {}
      }
    }

    if (!videoBuffer || videoBuffer.length === 0) {
      sendText(res, 400, 'Missing video file in upload.'); return;
    }

    const isWinner = meta.winner === true;
    const targetFolder = isWinner ? winnerFolderId : folderId;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const email = (meta.email || 'anon').replace(/[^a-z0-9@._-]/gi, '_').slice(0, 40);
    const stopTime = meta.stopTime ? String(Number(meta.stopTime).toFixed(2)) : '?.??';
    // Filenames double as social captions — repurpose.io uses the filename as the post title
    const filename = isWinner
      ? `I stopped the timer at EXACTLY 2.00 - Can you beat it - Try stopat2.com - ${ts}.mp4`
      : `I stopped at ${stopTime} trying to hit 2.00 - Can YOU do better - stopat2.com - ${ts}.mp4`;

    const driveResult = await uploadFileToDrive(accessToken, videoBuffer, filename, 'video/mp4', targetFolder);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fileId: driveResult.id, name: driveResult.name, url: driveResult.webViewLink }));
  } catch (err) {
    console.error('[drive-upload]', err);
    sendText(res, 500, 'Drive upload failed.');
  }
}

let vite;

const server = createHttpServer(async (req, res) => {
  if (req.url?.startsWith('/api/transcode')) {
    await handleTranscode(req, res);
    return;
  }

  if (req.url?.startsWith('/api/drive-upload')) {
    await handleDriveUpload(req, res);
    return;
  }

  if (req.url?.startsWith('/api/repurpose-webhook')) {
    await handleRepurposeWebhook(req, res);
    return;
  }

  // Allow camera + mic on all responses (Railway proxy can strip these otherwise)
  res.setHeader('Permissions-Policy', 'camera=(*), microphone=(*)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

  if (isProduction) {
    await serveProductionAsset(req, res);
    return;
  }

  vite.middlewares(req, res);
});

if (!isProduction) {
  vite = await createViteServer({
    root,
    appType: 'spa',
    server: {
      host,
      hmr: { server },
      middlewareMode: true,
      allowedHosts: true,
    },
  });
}

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`Stop At 2.00 running at http://${displayHost}:${port}/`);
});
