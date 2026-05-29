import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Download,
  Flame,
  Play,
  RefreshCw,
  Send,
  Settings,
  Trophy,
  Video,
} from 'lucide-react';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type Stage = 'HOME' | 'PERMISSION' | 'READY' | 'COUNTDOWN' | 'PLAYING' | 'REVEAL' | 'ENDCARD' | 'SUBMIT';
type LeadField = 'email' | 'phone' | 'instagram';

type LeadInfo = {
  email: string;
  phone: string;
  instagram: string;
};

type SponsorBranding = {
  overlayText: string;
  sponsorLogoUrl: string;
  campaignBadge: string; // editable badge text above the headline
  // Brand skin — drives the page background treatment
  accentHex: string;
  bgImageUrl: string;
};

type Result = {
  rawTime: number;
  displayTime: number;
  difference: number;
  headline: string;
  detail: string;
  tier: 'winner' | 'near' | 'miss';
  qualified: boolean;
  qualifyReason: string;
};

type OverlayState = {
  stage: Stage;
  timeLeft: number;
  countdown: number | null;
  result: Result | null;
};

const START_TIME = 5;
const TARGET_TIME = 2;
const PRE_ROLL_MS = 3000;
const POST_REACTION_MS = 4200;
const END_CARD_MS = 2400;
const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const TOP_OVERLAY_TITLE = 'STOP AT 2.00';
const END_CARD_HEADLINE = 'CAN YOU BEAT THE CLOCK?';
const END_CARD_CTA = 'TRY NOW AT:';
const BRANDING_STORAGE_KEY = 'stop-at-two-sponsor-branding';
const DEFAULT_SPONSOR_BRANDING: SponsorBranding = {
  overlayText: 'STOPAT2.COM',
  sponsorLogoUrl: '/splitflask-logo.png',
  campaignBadge: 'Win A FREE Splitflask',
  accentHex: '#e31837',
  bgImageUrl: '/splitflask-logo.png',
};

const PERSONAL_BEST_KEY = 'stop-at-two-personal-best';

function loadPersonalBest(): number | null {
  try {
    const stored = localStorage.getItem(PERSONAL_BEST_KEY);
    if (!stored) return null;
    const val = parseFloat(stored);
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

function savePersonalBest(difference: number): number {
  try {
    const current = loadPersonalBest();
    const next = current === null ? difference : Math.min(current, difference);
    localStorage.setItem(PERSONAL_BEST_KEY, String(next));
    return next;
  } catch {
    return difference;
  }
}

type LeaderboardEntry = {
  displayTime: number;
  difference: number;
  headline: string;
  createdAt: string;
};

const LEADERBOARD_KEY = 'stop-at-two-leaderboard';

function loadLeaderboard(): LeaderboardEntry[] {
  try {
    const stored = localStorage.getItem(LEADERBOARD_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as LeaderboardEntry[];
  } catch {
    return [];
  }
}

function pushLeaderboard(entry: LeaderboardEntry): LeaderboardEntry[] {
  try {
    const current = loadLeaderboard();
    const next = [entry, ...current]
      .sort((a, b) => a.difference - b.difference)
      .slice(0, 10);
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadLeaderboard();
  }
}

const PLAY_COUNT_KEY = 'stop-at-two-play-count';

function loadPlayCount(): number {
  try {
    return parseInt(localStorage.getItem(PLAY_COUNT_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function incrementPlayCount(): number {
  try {
    const next = loadPlayCount() + 1;
    localStorage.setItem(PLAY_COUNT_KEY, String(next));
    return next;
  } catch {
    return loadPlayCount() + 1;
  }
}

function isPngLogoUrl(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:image/png')) return true;
  return trimmed.split(/[?#]/)[0].endsWith('.png');
}

function loadSponsorBranding(): SponsorBranding {
  try {
    const stored = localStorage.getItem(BRANDING_STORAGE_KEY);
    if (!stored) return DEFAULT_SPONSOR_BRANDING;
    const parsed = JSON.parse(stored) as Partial<SponsorBranding>;
    const sponsorLogoUrl = parsed.sponsorLogoUrl?.trim() || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl;
    const overlayText = parsed.overlayText?.trim();
    return {
      overlayText: overlayText && overlayText !== 'SPLITFLASK.COM'
        ? overlayText
        : DEFAULT_SPONSOR_BRANDING.overlayText,
      sponsorLogoUrl: isPngLogoUrl(sponsorLogoUrl)
        ? sponsorLogoUrl
        : DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl,
      campaignBadge: parsed.campaignBadge?.trim() || DEFAULT_SPONSOR_BRANDING.campaignBadge,
      accentHex: parsed.accentHex?.trim() || DEFAULT_SPONSOR_BRANDING.accentHex,
      bgImageUrl: parsed.bgImageUrl?.trim() || DEFAULT_SPONSOR_BRANDING.bgImageUrl,
    };
  } catch {
    return DEFAULT_SPONSOR_BRANDING;
  }
}

function getRecorderMimeType() {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
    'video/mp4;codecs="avc1.64001F,mp4a.40.2"',
    'video/mp4;codecs="h264,aac"',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function getRequiredLeadField(leadInfo: LeadInfo, playsCompleted: number): LeadField | null {
  if (!leadInfo.email.trim()) return 'email';
  if (playsCompleted >= 1 && !leadInfo.phone.trim()) return 'phone';
  if (playsCompleted >= 2 && !leadInfo.instagram.trim()) return 'instagram';
  return null;
}

async function uploadToDrive(blob: Blob, meta: { winner: boolean; stopTime: number; email: string }) {
  try {
    const form = new FormData();
    form.append('file', blob, 'clip.mp4');
    form.append('meta', JSON.stringify(meta));
    const res = await fetch('/api/drive-upload', { method: 'POST', body: form });
    if (!res.ok) return null;
    return (await res.json()) as { ok: boolean; fileId?: string; url?: string };
  } catch {
    return null;
  }
}

async function transcodeToMp4(blob: Blob) {
  if (blob.type.includes('mp4')) return blob;

  try {
    const response = await fetch('/api/transcode', {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
      },
      body: blob,
    });
    if (!response.ok) return blob;

    const mp4Blob = await response.blob();
    return mp4Blob.type.includes('mp4') ? mp4Blob : new Blob([mp4Blob], { type: 'video/mp4' });
  } catch {
    return blob;
  }
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPhone(phone: string) {
  return phone.replace(/\D/g, '').length >= 7;
}

function isValidInstagram(instagram: string) {
  return instagram.trim().replace(/^@/, '').length >= 2;
}

function pickResultCopy(displayTime: number, difference: number, isWinner: boolean, tooEarly: boolean) {
  if (isWinner) {
    const winnerLines = ['WINNER', 'NAILED IT', 'FREE FLASK ENERGY', '2.00 LEGEND', 'PERFECT STOP', 'GOAT BEHAVIOR', 'ABSOLUTELY COOKED'];
    return {
      headline: winnerLines[Math.floor(Math.random() * winnerLines.length)],
      detail: 'EXACT HIT',
    };
  }

  if (difference <= 0.03) {
    const nearLines = [
      `${displayTime.toFixed(2)} 😭`,
      'SO CLOSE',
      'HEARTBREAK',
      'PAINFULLY CLOSE',
      'AGONIZING',
      'ROBBERY',
      'CRUEL',
      'CLOSE ENOUGH TO CRY',
      'NOT EVEN CLOSE (IT WAS CLOSE)',
    ];
    return {
      headline: nearLines[Math.floor(Math.random() * nearLines.length)],
      detail: 'THE TIMER HAD ONE JOB',
    };
  }

  if (difference <= 0.12) {
    const chokeLines = [
      'YOU CHOKED',
      'BUTTON BETRAYAL',
      'PANIC CLICK',
      'SKILL ISSUE',
      'THE FLASK SAID NO',
      'ALMOST FAMOUS',
      'CHOKED AT THE LINE',
      'YOUR THUMB QUIT',
      'FINGERS GAVE UP',
      'ALMOST DOESN\'T COUNT',
    ];
    return {
      headline: chokeLines[Math.floor(Math.random() * chokeLines.length)],
      detail: tooEarly ? 'JUMPED THE GUN' : 'BLINKED LATE',
    };
  }

  const earlyLines = ['TOO EARLY', 'JUMPY MUCH?', 'SLOW DOWN SPEEDY', 'PREMATURE SLAM', 'TRIGGER HAPPY', 'RELAX. BREATHE.', 'ZEN FIRST', 'CALM YOUR THUMBS', 'WAIT FOR IT...'];
  const lateLines = ['TOO LATE', 'NAP DETECTED', 'BUTTON SLEPT', 'MISSED THE BUS', 'WERE YOU ASLEEP?', 'NEXT TIME, MAYBE', 'SNOOZE BUTTON ENERGY', 'SLOW AND... STILL WRONG', 'DELAYED REACTION'];

  const directionLines = tooEarly ? earlyLines : lateLines;

  return {
    headline: directionLines[Math.floor(Math.random() * directionLines.length)],
    detail: `${difference.toFixed(2)} SECONDS OFF`,
  };
}

function coverVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) {
  const videoWidth = video.videoWidth || 1280;
  const videoHeight = video.videoHeight || 720;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const drawWidth = videoWidth * scale;
  const drawHeight = videoHeight * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;

  ctx.save();
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, x, y, drawWidth, drawHeight);
  ctx.restore();
}

function drawPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxFontSize: number,
  minFontSize: number,
  fontFamily: string,
  color: string,
) {
  let fontSize = maxFontSize;

  while (fontSize > minFontSize) {
    ctx.font = `900 ${fontSize}px ${fontFamily}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    fontSize -= 4;
  }

  ctx.font = `900 ${Math.max(fontSize, minFontSize)}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawTimerPip(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayState,
  peakVolume: number,
) {
  const x = 596;
  const y = 1502;
  const width = 420;
  const height = 214;
  const radius = 34;
  const timerValue = overlay.result?.displayTime ?? overlay.timeLeft;
  const timerText = timerValue.toFixed(2);

  ctx.save();
  ctx.shadowColor = 'rgba(227,24,55,0.72)';
  ctx.shadowBlur = 28;
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  drawPill(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.lineWidth = 7;
  ctx.strokeStyle = overlay.stage === 'REVEAL' ? '#ffffff' : '#e31837';
  ctx.stroke();

  ctx.fillStyle = 'rgba(227,24,55,0.16)';
  drawPill(ctx, x + 18, y + 18, width - 36, height - 36, 24);
  ctx.fill();

  ctx.font = '900 24px "JetBrains Mono", monospace';
  ctx.fillStyle = '#ff9aa8';
  ctx.fillText('STOP AT 2.00', x + 34, y + 48);

  ctx.font = '900 94px "JetBrains Mono", monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(timerText, x + 32, y + 145);

  ctx.font = '900 20px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.68)';
  ctx.fillText('LIVE TIMER', x + 34, y + 190);

  ctx.restore();
}

function drawVolumeMeter(ctx: CanvasRenderingContext2D, peakVolume: number, x: number, y: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  drawPill(ctx, x - 18, y - 64, 244, 92, 18);
  ctx.fill();

  ctx.font = '900 18px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.fillText('AUDIO', x, y - 34);

  ctx.fillStyle = peakVolume > 0.18 ? '#e31837' : 'rgba(255,255,255,0.46)';
  for (let i = 0; i < 10; i += 1) {
    const level = Math.min(1, peakVolume * 4);
    const barHeight = 10 + Math.max(0, level * 64 - i * 5);
    ctx.fillRect(x + i * 19, y - barHeight, 11, barHeight);
  }
  ctx.restore();
}

function drawSponsorOverlay(
  ctx: CanvasRenderingContext2D,
  branding: SponsorBranding,
  logoImage: HTMLImageElement | null,
  peakVolume: number,
) {
  const overlayText = branding.overlayText.trim() || DEFAULT_SPONSOR_BRANDING.overlayText;

  ctx.font = '900 38px Anton, Impact, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(TOP_OVERLAY_TITLE, 58, 92);

  ctx.font = '700 25px "JetBrains Mono", monospace';
  ctx.fillStyle = '#e31837';
  ctx.fillText(DEFAULT_SPONSOR_BRANDING.overlayText.toUpperCase(), 58, 130);

  drawVolumeMeter(ctx, peakVolume, 58, 1566);

  if (logoImage?.complete && logoImage.naturalWidth > 0 && logoImage.naturalHeight > 0) {
    const maxWidth = 404;
    const maxHeight = 78;
    const scale = Math.min(maxWidth / logoImage.naturalWidth, maxHeight / logoImage.naturalHeight);
    const width = logoImage.naturalWidth * scale;
    const height = logoImage.naturalHeight * scale;
    const x = 58;
    const y = 1614;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    drawPill(ctx, x - 18, y - 16, width + 36, height + 32, 18);
    ctx.fill();
    ctx.drawImage(logoImage, x, y, width, height);
    ctx.restore();
  }
}

function drawEndCardOverlay(
  ctx: CanvasRenderingContext2D,
  branding: SponsorBranding,
  logoImage: HTMLImageElement | null,
  result: Result | null,
) {
  const overlayText = DEFAULT_SPONSOR_BRANDING.overlayText.toUpperCase();

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.93)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  const glow = ctx.createRadialGradient(540, 760, 80, 540, 900, 760);
  glow.addColorStop(0, 'rgba(227,24,55,0.46)');
  glow.addColorStop(0.42, 'rgba(227,24,55,0.16)');
  glow.addColorStop(1, 'rgba(227,24,55,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.fillStyle = 'rgba(227,24,55,0.13)';
  for (let y = 0; y < CANVAS_HEIGHT; y += 18) {
    ctx.fillRect(0, y, CANVAS_WIDTH, 5);
  }

  ctx.textAlign = 'center';
  ctx.shadowColor = '#e31837';
  ctx.shadowBlur = 36;
  drawFittedText(
    ctx,
    END_CARD_HEADLINE,
    CANVAS_WIDTH / 2,
    760,
    930,
    118,
    58,
    'Anton, Impact, sans-serif',
    '#ffffff',
  );

  ctx.shadowBlur = 0;
  drawFittedText(
    ctx,
    END_CARD_CTA,
    CANVAS_WIDTH / 2,
    910,
    900,
    72,
    38,
    'Anton, Impact, sans-serif',
    '#ffb3bd',
  );

  drawFittedText(
    ctx,
    overlayText,
    CANVAS_WIDTH / 2,
    1038,
    900,
    84,
    42,
    '"JetBrains Mono", monospace',
    '#e31837',
  );

  if (result) {
    ctx.font = '900 30px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    ctx.fillText(`LAST TRY: ${result.displayTime.toFixed(2)}`, CANVAS_WIDTH / 2, 1140);
  }

  if (logoImage?.complete && logoImage.naturalWidth > 0 && logoImage.naturalHeight > 0) {
    const maxWidth = 760;
    const maxHeight = 150;
    const scale = Math.min(maxWidth / logoImage.naturalWidth, maxHeight / logoImage.naturalHeight);
    const width = logoImage.naturalWidth * scale;
    const height = logoImage.naturalHeight * scale;
    ctx.drawImage(logoImage, (CANVAS_WIDTH - width) / 2, 1238, width, height);
  }

  ctx.font = '900 30px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText(TOP_OVERLAY_TITLE, CANVAS_WIDTH / 2, 1460);
  ctx.restore();
}

function drawComposedFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement | null,
  overlay: OverlayState,
  peakVolume: number,
  branding: SponsorBranding,
  logoImage: HTMLImageElement | null,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (video && video.readyState >= 2) {
    coverVideo(ctx, video, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  const vignette = ctx.createRadialGradient(540, 860, 120, 540, 960, 1040);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.64)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  ctx.fillStyle = 'rgba(227,24,55,0.11)';
  for (let y = 0; y < CANVAS_HEIGHT; y += 8) {
    ctx.fillRect(0, y, CANVAS_WIDTH, 2);
  }

  drawSponsorOverlay(ctx, branding, logoImage, peakVolume);

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  drawPill(ctx, 804, 48, 214, 66, 16);
  ctx.fill();
  ctx.fillStyle = '#e31837';
  ctx.fillRect(833, 72, 18, 18);
  ctx.font = '900 25px "JetBrains Mono", monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('REC', 870, 93);

  ctx.font = '900 22px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.fillText((branding.overlayText || DEFAULT_SPONSOR_BRANDING.overlayText).toUpperCase(), 58, 1736);

  drawTimerPip(ctx, overlay, peakVolume);

  if (overlay.stage === 'COUNTDOWN' && overlay.countdown) {
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.font = '900 520px Anton, Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#e31837';
    ctx.shadowBlur = 44;
    ctx.fillText(String(overlay.countdown), CANVAS_WIDTH / 2, 1090);
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
    drawSponsorOverlay(ctx, branding, logoImage, peakVolume);
    drawTimerPip(ctx, overlay, peakVolume);
  }

  if (overlay.stage === 'REVEAL' && overlay.result) {
    ctx.fillStyle = 'rgba(0,0,0,0.56)';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.textAlign = 'center';
    drawFittedText(
      ctx,
      overlay.result.headline,
      CANVAS_WIDTH / 2,
      822,
      930,
      128,
      66,
      'Anton, Impact, sans-serif',
      overlay.result.tier === 'winner' ? '#ffffff' : '#e31837',
    );
    drawFittedText(
      ctx,
      overlay.result.displayTime.toFixed(2),
      CANVAS_WIDTH / 2,
      1068,
      860,
      214,
      124,
      '"JetBrains Mono", monospace',
      '#ffffff',
    );
    drawFittedText(
      ctx,
      overlay.result.detail,
      CANVAS_WIDTH / 2,
      1150,
      850,
      42,
      28,
      'Anton, Impact, sans-serif',
      '#ffb3bd',
    );
    ctx.textAlign = 'left';
    drawSponsorOverlay(ctx, branding, logoImage, peakVolume);
    drawTimerPip(ctx, overlay, peakVolume);
  }

  if (overlay.stage === 'ENDCARD') {
    drawEndCardOverlay(ctx, branding, logoImage, overlay.result);
  }
}

function makeResult(rawTime: number, peakVolume: number): Result {
  const displayTime = Number(rawTime.toFixed(2));
  const difference = Number(Math.abs(displayTime - TARGET_TIME).toFixed(2));
  const isWinner = displayTime === TARGET_TIME;
  const isNear = difference <= 0.25;
  const loudReaction = peakVolume >= 0.18;
  const tooEarly = displayTime > TARGET_TIME;
  const copy = pickResultCopy(displayTime, difference, isWinner, tooEarly);

  return {
    rawTime,
    displayTime,
    difference,
    headline: copy.headline,
    detail: copy.detail,
    tier: isWinner ? 'winner' : isNear ? 'near' : 'miss',
    qualified: isWinner || isNear || loudReaction,
    qualifyReason: isWinner
      ? 'Winner clip'
      : isNear
        ? 'Near miss auto-qualified'
        : loudReaction
          ? 'Loud reaction auto-qualified'
          : 'Needs manual review',
  };
}

// ---------------------------------------------------------------------------
// Confetti — canvas-based particle burst for winner celebration.
// Mounts once, animates for ~4s, then unmounts via onDone callback.
// ---------------------------------------------------------------------------
type ConfettiParticle = {
  x: number; y: number; vx: number; vy: number;
  color: string; size: number; spin: number; spinSpeed: number; gravity: number;
};

function ConfettiCanvas({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const COLORS = ['#e31837','#ff5c72','#ffffff','#ffd700','#ff9f00','#00d4aa','#7c3aed','#f97316'];
    const count = 220;
    const cx = canvas.width / 2;

    const particles: ConfettiParticle[] = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 8 + Math.random() * 18;
      return {
        x: cx, y: canvas.height * 0.45,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 12,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        size: 6 + Math.random() * 9,
        spin: Math.random() * Math.PI * 2,
        spinSpeed: (Math.random() - 0.5) * 0.28,
        gravity: 0.38 + Math.random() * 0.18,
      };
    });

    let frame = 0;
    let raf: number;
    const MAX_FRAMES = 240;

    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = 0;
      for (const p of particles) {
        p.vy += p.gravity;
        p.vx *= 0.993;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.spinSpeed;
        if (p.y < canvas.height + 40) alive++;
        const alpha = Math.max(0, 1 - frame / MAX_FRAMES);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      frame++;
      if (frame < MAX_FRAMES && alive > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        onDone();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-[100]"
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// BrandBackground — full-bleed skin behind the game UI.
// Swap branding props to re-theme for any sponsor: their accent color bleeds
// as a radial glow, their logo tiles as a ghost watermark at low opacity.
// Architecture hook: load a brand config from ?brand=slug or /slug path and
// pass it down to App → SponsorBranding → here. No other code needs to change.
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

function BrandBackground({ branding }: { branding: SponsorBranding }) {
  const rgb = hexToRgb(branding.accentHex || DEFAULT_SPONSOR_BRANDING.accentHex);
  const logoSrc = branding.bgImageUrl || branding.sponsorLogoUrl;

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* Accent glow — top-right ignition point + bottom-left echo */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `
          radial-gradient(ellipse 90% 55% at 82% -5%, rgba(${rgb},0.26) 0%, transparent 55%),
          radial-gradient(ellipse 70% 45% at 15% 108%, rgba(${rgb},0.16) 0%, transparent 50%),
          linear-gradient(180deg, #0d0102 0%, #000 55%)
        `,
      }} />

      {/* Ghost watermarks — 3 logo instances, large + faded, rotated for energy */}
      {logoSrc && <>
        <img src={logoSrc} alt="" draggable={false}
          style={{ position:'absolute', right:'-6%', top:'-4%', width:'42%', maxWidth:480,
            transform:'rotate(-14deg)', opacity:0.12, filter:'blur(0.5px) grayscale(0.15)',
            objectFit:'contain', userSelect:'none' }} />
        <img src={logoSrc} alt="" draggable={false}
          style={{ position:'absolute', left:'-8%', bottom:'-5%', width:'50%', maxWidth:560,
            transform:'rotate(11deg)', opacity:0.09, filter:'blur(1px) grayscale(0.2)',
            objectFit:'contain', userSelect:'none' }} />
        <img src={logoSrc} alt="" draggable={false}
          style={{ position:'absolute', left:'50%', top:'52%', width:'55%', maxWidth:620,
            transform:'translate(-50%,-50%) rotate(-3deg)', opacity:0.055,
            filter:'blur(2px) grayscale(0.3)', objectFit:'contain', userSelect:'none' }} />
      </>}

      {/* Dot grid for depth — brand-colored */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `radial-gradient(circle, rgba(${rgb},0.22) 1px, transparent 1px)`,
        backgroundSize: '44px 44px',
        opacity: 0.42,
        maskImage: 'radial-gradient(ellipse 80% 80% at 50% 50%, black 30%, transparent 100%)',
        WebkitMaskImage: 'radial-gradient(ellipse 80% 80% at 50% 50%, black 30%, transparent 100%)',
      }} />
    </div>
  );
}

export default function App() {
  const [stage, setStage] = useState<Stage>('HOME');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [consent, setConsent] = useState(false);
  const [leadInfo, setLeadInfo] = useState<LeadInfo>({ email: '', phone: '', instagram: '' });
  const [playsCompleted, setPlaysCompleted] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(START_TIME);
  const [result, setResult] = useState<Result | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipBlob, setClipBlob] = useState<Blob | null>(null);
  const [leadStatus, setLeadStatus] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [isCaptureReady, setIsCaptureReady] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [sponsorBranding, setSponsorBranding] = useState<SponsorBranding>(() => loadSponsorBranding());
  const [brandingError, setBrandingError] = useState('');
  const [stopFlashSeq, setStopFlashSeq] = useState<number | null>(null);
  const [personalBest, setPersonalBest] = useState<number | null>(() => loadPersonalBest());
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => loadLeaderboard());
  const [playCount, setPlayCount] = useState(() => loadPlayCount());
  const [showConfetti, setShowConfetti] = useState(false);
  const [driveStatus, setDriveStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sponsorLogoRef = useRef<HTMLImageElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const composedStreamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const roundTimeoutsRef = useRef<number[]>([]);
  const finalizeTimeoutRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const driftRateRef = useRef(1);
  const stageRef = useRef<Stage>('HOME');
  const timeLeftRef = useRef(START_TIME);
  const countdownRef = useRef<number | null>(null);
  const resultRef = useRef<Result | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const leadInfoRef = useRef<LeadInfo>({ email: '', phone: '', instagram: '' });
  const playsCompletedRef = useRef(0);
  const sponsorBrandingRef = useRef<SponsorBranding>(DEFAULT_SPONSOR_BRANDING);
  const clipUrlRef = useRef<string | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recorderGenerationRef = useRef(0);
  const pendingFinalizationRef = useRef(false);
  const mimeTypeRef = useRef('');
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSamplesRef = useRef<Uint8Array | null>(null);
  const peakVolumeRef = useRef(0);
  const sessionPeakVolumeRef = useRef(0);
  const adminTapRef = useRef<{ count: number; timer: number | null }>({ count: 0, timer: null });
  const lastTensionTickRef = useRef(0);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  useEffect(() => {
    timeLeftRef.current = timeLeft;
  }, [timeLeft]);

  useEffect(() => {
    countdownRef.current = countdown;
  }, [countdown]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    leadInfoRef.current = leadInfo;
  }, [leadInfo]);

  useEffect(() => {
    playsCompletedRef.current = playsCompleted;
  }, [playsCompleted]);

  useEffect(() => {
    sponsorBrandingRef.current = sponsorBranding;
    try {
      localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(sponsorBranding));
    } catch {
      // Branding edits are best-effort in local admin mode.
    }
  }, [sponsorBranding]);

  useEffect(() => {
    const logo = new Image();
    logo.crossOrigin = 'anonymous';
    logo.onload = () => {
      sponsorLogoRef.current = logo;
    };
    logo.onerror = () => {
      sponsorLogoRef.current = null;
    };
    logo.src = sponsorBranding.sponsorLogoUrl || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl;
  }, [sponsorBranding.sponsorLogoUrl]);

  useEffect(() => {
    clipUrlRef.current = clipUrl;
  }, [clipUrl]);

  useEffect(() => {
    if (!clipUrl || !playbackVideoRef.current) return;
    const video = playbackVideoRef.current;
    video.currentTime = 0;
    video.muted = true;
    void video.play().catch(() => {
      // Browser autoplay policy can still block in some contexts; controls remain available.
    });
  }, [clipUrl]);

  const statusLabel = useMemo(() => {
    if (stage === 'HOME') return 'CHALLENGE ACTIVE';
    if (stage === 'PERMISSION') return stream ? 'LEAD REQUIRED' : 'CAMERA REQUIRED';
    if (stage === 'READY') return 'CAMERA READY';
    if (stage === 'COUNTDOWN') return 'COUNTDOWN';
    if (stage === 'PLAYING') return 'LIVE CHALLENGE';
    if (stage === 'REVEAL') return 'REACTION CAPTURE';
    if (stage === 'ENDCARD') return 'ENDING CARD';
    return 'CLIP READY';
  }, [stage, stream]);

  const activeLeadField = useMemo<LeadField | null>(() => {
    if (!leadInfo.email.trim()) return 'email';
    if (playsCompleted === 0 && !consent) return 'email';
    // Keep showing email gate until camera is actually granted — prevents the form from
    // reactively vanishing the moment email+consent are filled (before button is clicked)
    if (playsCompleted === 0 && !stream) return 'email';
    if (playsCompleted >= 1 && !leadInfo.phone.trim()) return 'phone';
    if (playsCompleted >= 2 && !leadInfo.instagram.trim()) return 'instagram';
    return null;
  }, [consent, leadInfo, playsCompleted, stream]);

  const canPassLeadGate = useMemo(() => {
    if (activeLeadField === 'email') return isValidEmail(leadInfo.email) && consent;
    if (activeLeadField === 'phone') return isValidPhone(leadInfo.phone);
    if (activeLeadField === 'instagram') return isValidInstagram(leadInfo.instagram);
    return stream ? true : isValidEmail(leadInfo.email) && consent;
  }, [activeLeadField, consent, leadInfo.email, leadInfo.instagram, leadInfo.phone, stream]);

  const gateCopy = useMemo(() => {
    if (activeLeadField === 'phone') {
      return {
        title: 'UNLOCK ROUND 2',
        body: 'Enter your phone number to play again.',
        label: 'Phone Number',
        placeholder: '(555) 123-4567',
        inputType: 'tel',
        button: 'Continue',
      };
    }

    if (activeLeadField === 'instagram') {
      return {
        title: 'UNLOCK UNLIMITED',
        body: 'Enter your Instagram handle. After this, you can keep playing.',
        label: 'Instagram',
        placeholder: '@username',
        inputType: 'text',
        button: 'Continue',
      };
    }

    if (!activeLeadField) {
      return {
        title: stream ? 'READY TO PLAY' : 'CAMERA ON',
        body: stream
          ? 'Your required info is in. Continue to the challenge.'
          : 'Approve camera access to continue.',
        label: '',
        placeholder: '',
        inputType: 'text',
        button: stream ? 'Continue' : 'Allow Camera',
      };
    }

    return {
      title: 'JOIN THE CHALLENGE',
      body: 'Enter your email, approve consent, then allow camera access. Recording starts only when you hit START.',
      label: 'Email',
      placeholder: 'you@example.com',
      inputType: 'email',
      button: stream ? 'Continue' : 'Allow Camera',
    };
  }, [activeLeadField, stream]);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      cancelAnimationFrame(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearRoundTimeouts = useCallback(() => {
    roundTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    roundTimeoutsRef.current = [];
  }, []);

  const scheduleRoundTimeout = useCallback((callback: () => void, delay: number) => {
    const timeoutId = window.setTimeout(() => {
      roundTimeoutsRef.current = roundTimeoutsRef.current.filter((id) => id !== timeoutId);
      callback();
    }, delay);
    roundTimeoutsRef.current.push(timeoutId);
    return timeoutId;
  }, []);

  const cancelFinalize = useCallback(() => {
    if (finalizeTimeoutRef.current !== null) {
      window.clearTimeout(finalizeTimeoutRef.current);
      finalizeTimeoutRef.current = null;
    }
    pendingFinalizationRef.current = false;
  }, []);

  const publishRecordedClip = useCallback(async () => {
    const chunks = recordedChunksRef.current;
    let finalBlob: Blob | null = null;

    if (chunks.length > 0) {
      const sourceBlob = new Blob(chunks, { type: mimeTypeRef.current || 'video/webm' });
      const blob = await transcodeToMp4(sourceBlob);
      mimeTypeRef.current = blob.type || mimeTypeRef.current;
      if (clipUrlRef.current) {
        URL.revokeObjectURL(clipUrlRef.current);
      }
      const nextUrl = URL.createObjectURL(blob);
      clipUrlRef.current = nextUrl;
      setClipBlob(blob);
      setClipUrl(nextUrl);
      finalBlob = blob;
    }

    if (resultRef.current) {
      const nextBest = savePersonalBest(resultRef.current.difference);
      setPersonalBest(nextBest);
    }

    if (resultRef.current) {
      const entry: LeaderboardEntry = {
        displayTime: resultRef.current.displayTime,
        difference: resultRef.current.difference,
        headline: resultRef.current.headline,
        createdAt: new Date().toISOString(),
      };
      const nextBoard = pushLeaderboard(entry);
      setLeaderboard(nextBoard);
    }

    const nextCount = incrementPlayCount();
    setPlayCount(nextCount);

    // Winner celebration
    const isWinner = resultRef.current?.tier === 'winner';
    if (isWinner) {
      setShowConfetti(true);
    }

    // Drive upload (fire-and-forget — doesn't block the UI)
    if (finalBlob && resultRef.current) {
      const result = resultRef.current;
      setDriveStatus('uploading');
      void uploadToDrive(finalBlob, {
        winner: isWinner,
        stopTime: result.displayTime,
        email: leadInfoRef.current.email,
      }).then((res) => {
        setDriveStatus(res?.ok ? 'done' : 'error');
      });
    }

    setPlaysCompleted((current) => current + 1);
    setStage('SUBMIT');
    setIsComposing(false);
  }, []);

  const startClipRecorder = useCallback(() => {
    const composedStream = composedStreamRef.current;
    if (!composedStream || typeof MediaRecorder === 'undefined') return;

    pendingFinalizationRef.current = false;
    recorderGenerationRef.current += 1;
    const generation = recorderGenerationRef.current;
    recordedChunksRef.current = [];

    const previousRecorder = mediaRecorderRef.current;
    if (previousRecorder?.state === 'recording') {
      previousRecorder.stop();
    }

    const mimeType = getRecorderMimeType();
    mimeTypeRef.current = mimeType;
    const recorder = new MediaRecorder(composedStream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (generation === recorderGenerationRef.current && event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      if (generation === recorderGenerationRef.current) {
        if (pendingFinalizationRef.current) {
          pendingFinalizationRef.current = false;
          void publishRecordedClip();
          return;
        }
        setIsComposing(false);
      }
    };
    recorder.start(250);
    setIsComposing(true);
  }, [publishRecordedClip]);

  const playCue = useCallback((kind: 'tick' | 'start' | 'impact' | 'win') => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const audioContext = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = audioContext;
    if (audioContext.state === 'suspended') {
      void audioContext.resume();
    }

    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = kind === 'impact' ? 'sawtooth' : 'square';
    oscillator.frequency.setValueAtTime(
      kind === 'tick' ? 440 : kind === 'start' ? 220 : kind === 'win' ? 880 : 96,
      now,
    );
    if (kind === 'impact') {
      oscillator.frequency.exponentialRampToValueAtTime(48, now + 0.22);
    }

    gain.gain.setValueAtTime(kind === 'impact' ? 0.18 : 0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'impact' ? 0.28 : 0.12));
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + (kind === 'impact' ? 0.3 : 0.14));
  }, []);

  const playTensionTick = useCallback((timeLeft: number) => {
    if (timeLeft > 3.0 || timeLeft < 1.8) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const audioContext = audioContextRef.current || new AudioContextClass();
    audioContextRef.current = audioContext;
    if (audioContext.state === 'suspended') void audioContext.resume();

    const proximity = Math.max(0, Math.min(1, 1 - Math.abs(timeLeft - TARGET_TIME) / 1.0));
    const freq = 600 + proximity * 900;
    const volume = 0.04 + proximity * 0.10;

    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + 0.07);
  }, []);

  const sampleVolume = useCallback(() => {
    const analyser = analyserRef.current;
    const samples = audioSamplesRef.current;
    if (!analyser || !samples) return 0;

    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    peakVolumeRef.current = Math.max(peakVolumeRef.current * 0.94, rms);
    if (['COUNTDOWN', 'PLAYING', 'REVEAL'].includes(stageRef.current)) {
      sessionPeakVolumeRef.current = Math.max(sessionPeakVolumeRef.current, rms);
    }
    return peakVolumeRef.current;
  }, []);

  const finalizeClip = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    pendingFinalizationRef.current = true;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }

    pendingFinalizationRef.current = false;
    void publishRecordedClip();
  }, [publishRecordedClip]);

  const showEndCardThenFinalize = useCallback(() => {
    finalizeTimeoutRef.current = null;
    setStage('ENDCARD');
    finalizeTimeoutRef.current = window.setTimeout(() => {
      finalizeTimeoutRef.current = null;
      finalizeClip();
    }, END_CARD_MS);
  }, [finalizeClip]);

  const stopGame = useCallback(
    (forcedTime?: number) => {
      if (stageRef.current !== 'PLAYING') return;

      stopTimer();
      const stoppedTime = forcedTime ?? timeLeftRef.current;
      const nextResult = makeResult(stoppedTime, sessionPeakVolumeRef.current);
      setResult(nextResult);
      setTimeLeft(stoppedTime);
      setStage('REVEAL');
      playCue(nextResult.tier === 'winner' ? 'win' : 'impact');

      finalizeTimeoutRef.current = window.setTimeout(showEndCardThenFinalize, POST_REACTION_MS);
    },
    [playCue, showEndCardThenFinalize, stopTimer],
  );

  const runTimer = useCallback(
    (now: number) => {
      const elapsed = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;

      const driftedElapsed = elapsed * driftRateRef.current;
      const nextTime = Math.max(0, timeLeftRef.current - driftedElapsed);
      timeLeftRef.current = nextTime;
      setTimeLeft(nextTime);

      if (nextTime <= 0) {
        stopGame(0);
        return;
      }

      // Tension ticks: frequency increases near 2.00
      if (nextTime <= 3.0 && nextTime >= 1.8) {
        const proximity = Math.max(0, Math.min(1, 1 - Math.abs(nextTime - TARGET_TIME) / 1.0));
        const tickInterval = 0.38 - proximity * 0.26;
        if (now - lastTensionTickRef.current > tickInterval * 1000) {
          lastTensionTickRef.current = now;
          playTensionTick(nextTime);
        }
      }

      timerRef.current = requestAnimationFrame(runTimer);
    },
    [playTensionTick, stopGame],
  );

  const startChallenge = useCallback(() => {
    if (!stream || !composedStreamRef.current || stageRef.current !== 'READY') return;

    const requiredField = getRequiredLeadField(leadInfoRef.current, playsCompletedRef.current);
    if (requiredField) {
      setStage('PERMISSION');
      return;
    }

    clearRoundTimeouts();
    cancelFinalize();
    if (clipUrl) {
      URL.revokeObjectURL(clipUrl);
      clipUrlRef.current = null;
    }
    setClipUrl(null);
    setClipBlob(null);
    setLeadStatus('');
    setResult(null);
    setTimeLeft(START_TIME);
    timeLeftRef.current = START_TIME;
    sessionPeakVolumeRef.current = 0;
    lastTensionTickRef.current = 0;
    driftRateRef.current = 1 + (Math.random() * 0.024 - 0.012);
    startClipRecorder();
    setStage('COUNTDOWN');
    setCountdown(3);
    playCue('tick');

    const sequence = [2, 1];
    sequence.forEach((value, index) => {
      scheduleRoundTimeout(() => {
        setCountdown(value);
        playCue('tick');
      }, (index + 1) * 1000);
    });

    scheduleRoundTimeout(() => {
      setCountdown(null);
      setStage('PLAYING');
      playCue('start');
      lastTickRef.current = performance.now();
      timerRef.current = requestAnimationFrame(runTimer);
    }, PRE_ROLL_MS);
  }, [
    cancelFinalize,
    clearRoundTimeouts,
    clipUrl,
    playCue,
    runTimer,
    scheduleRoundTimeout,
    startClipRecorder,
    stream,
  ]);

  const requestCamera = useCallback(async () => {
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera recording is not supported in this browser.');
      }

      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });

      setIsCaptureReady(false);
      setStream(nextStream);
      setStage('READY');
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : 'Camera permission was denied.');
    }
  }, []);

  const handleLeadGateSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canPassLeadGate) return;

    if (!stream) {
      await requestCamera();
      return;
    }

    setStage('READY');
  };

  useEffect(() => {
    if (!stream || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    video.srcObject = stream;
    void video.play();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && stream.getAudioTracks().length > 0) {
      const audioContext = audioContextRef.current || new AudioContextClass();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      audioSamplesRef.current = new Uint8Array(analyser.frequencyBinCount);
    }

    const canvas = canvasRef.current;
    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      setCameraError('This browser cannot compose and record clips. Try the latest Chrome, Edge, or Safari.');
      setStage('PERMISSION');
      return;
    }

    const composedStream = canvas.captureStream(30);
    stream.getAudioTracks().forEach((track) => composedStream.addTrack(track));
    composedStreamRef.current = composedStream;
    setIsCaptureReady(true);

    const paint = () => {
      const volume = sampleVolume();
      drawComposedFrame(canvas, video, {
        stage: stageRef.current,
        timeLeft: timeLeftRef.current,
        countdown: countdownRef.current,
        result: resultRef.current,
      }, volume, sponsorBrandingRef.current, sponsorLogoRef.current);
      animationRef.current = requestAnimationFrame(paint);
    };
    paint();

    // Re-play video if the browser paused it (e.g. page was backgrounded)
    const handleVisibilityChange = () => {
      if (!document.hidden && video.paused) {
        void video.play();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Re-request camera if the track is ended unexpectedly (browser inactivity kill)
    const handleTrackEnded = () => {
      if (!document.hidden) {
        void requestCamera();
      }
    };
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', handleTrackEnded);
    });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stream.getVideoTracks().forEach((track) => {
        track.removeEventListener('ended', handleTrackEnded);
      });
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      const recorder = mediaRecorderRef.current;
      recorderGenerationRef.current += 1;
      if (recorder?.state === 'recording') {
        recorder.stop();
      }
      composedStream.getTracks().forEach((track) => track.stop());
      composedStreamRef.current = null;
      setIsCaptureReady(false);
      setIsComposing(false);
    };
  }, [sampleVolume, stream, requestCamera]);

  useEffect(() => {
    return () => {
      clearRoundTimeouts();
      cancelFinalize();
      stopTimer();
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      recorderGenerationRef.current += 1;
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      composedStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (clipUrlRef.current) {
        URL.revokeObjectURL(clipUrlRef.current);
      }
    };
  }, [cancelFinalize, clearRoundTimeouts, stopTimer]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entry = {
      email: leadInfo.email,
      phone: leadInfo.phone,
      instagram: leadInfo.instagram,
      result,
      clipSize: clipBlob?.size ?? 0,
      createdAt: new Date().toISOString(),
    };
    const existing = JSON.parse(localStorage.getItem('stop-at-two-submissions') || '[]') as unknown[];
    localStorage.setItem('stop-at-two-submissions', JSON.stringify([entry, ...existing].slice(0, 50)));
    setLeadStatus('Entry saved! Your clip is ready to download and share.');
  };

  const resetRound = () => {
    const nextRequiredField = getRequiredLeadField(leadInfoRef.current, playsCompletedRef.current);
    cancelFinalize();
    clearRoundTimeouts();
    stopTimer();
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    setClipUrl(null);
    setClipBlob(null);
    setResult(null);
    setCountdown(null);
    setTimeLeft(START_TIME);
    timeLeftRef.current = START_TIME;
    setLeadStatus('');
    setDriveStatus('idle');
    if (!streamRef.current) {
      setStage('HOME');
      return;
    }
    setStage(nextRequiredField ? 'PERMISSION' : 'READY');
  };

  const handleShareToSocial = useCallback(async (platform: 'instagram' | 'tiktok') => {
    if (!clipBlob || !result) return;
    const filename = `stop-at-2-${result.displayTime.toFixed(2)}.mp4`;
    const shareText = `I stopped at ${result.displayTime.toFixed(2)} trying to hit exactly 2.00 seconds. Can you beat it? stopat2.com`;
    const file = new File([clipBlob], filename, { type: clipBlob.type || 'video/mp4' });

    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Stop At 2.00', text: shareText });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }

    // Fallback: download file then open platform
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    window.open(
      platform === 'tiktok' ? 'https://www.tiktok.com/upload' : 'https://www.instagram.com',
      '_blank',
    );
  }, [clipBlob, result]);

  const handleShareToTwitter = useCallback(() => {
    if (!result) return;
    const text = encodeURIComponent(
      `I stopped at ${result.displayTime.toFixed(2)} trying to hit exactly 2.00 seconds. Can you beat it?`
    );
    const url = encodeURIComponent('https://stopat2.com');
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank');
  }, [result]);

  const handleAdminSecretTap = () => {
    adminTapRef.current.count += 1;
    if (adminTapRef.current.timer !== null) {
      window.clearTimeout(adminTapRef.current.timer);
    }
    adminTapRef.current.timer = window.setTimeout(() => {
      adminTapRef.current.count = 0;
      adminTapRef.current.timer = null;
    }, 800);
    if (adminTapRef.current.count >= 3) {
      adminTapRef.current.count = 0;
      setIsAdminOpen((open) => !open);
    }
  };

  return (
    <main className="min-h-dvh overflow-hidden bg-black text-white">
      <BrandBackground branding={sponsorBranding} />
      <div className="scanline pointer-events-none" />

      {/* Confetti burst — mounts on winner, self-destructs after animation */}
      {showConfetti && <ConfettiCanvas onDone={() => setShowConfetti(false)} />}

      {/* Winner celebration overlay — shown during REVEAL for exact 2.00 hits */}
      {stage === 'REVEAL' && result?.tier === 'winner' && (
        <div className="pointer-events-none fixed inset-0 z-[90] flex flex-col items-center justify-end pb-[12vh]" aria-hidden="true">
          <div style={{ animation: 'result-slam 420ms cubic-bezier(.18,.9,.24,1.2) both' }}
            className="flex flex-col items-center gap-3 text-center">
            <p className="font-display text-[clamp(2rem,8vw,3.5rem)] leading-none text-yellow-300"
              style={{ textShadow: '0 0 40px rgba(255,215,0,0.9), 0 0 80px rgba(255,215,0,0.5)' }}>
              EXACT HIT
            </p>
            <p className="font-mono text-sm uppercase tracking-[0.3em] text-white/70">
              You stopped at exactly 2.00
            </p>
            <div className="mt-2 flex gap-3 text-3xl" aria-hidden>🏆🎉🔥</div>
          </div>
        </div>
      )}

      <header className="fixed left-0 top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-black/80 px-4 backdrop-blur md:px-8">
        <button
          type="button"
          onClick={resetRound}
          className="flex cursor-pointer items-center gap-3 text-left"
          aria-label="Go to Stop At 2.00 home"
        >
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0 drop-shadow-[0_0_10px_rgba(227,24,55,0.6)]">
            <circle cx="18" cy="18" r="17" fill="#dc2626" stroke="rgba(255,150,150,0.3)" strokeWidth="1"/>
            {Array.from({ length: 60 }).map((_, i) => {
              const angle = (i / 60) * Math.PI * 2 - Math.PI / 2;
              const isMajor = i % 5 === 0;
              const r1 = isMajor ? 12.5 : 14;
              const r2 = 16;
              return (
                <line
                  key={i}
                  x1={18 + Math.cos(angle) * r1}
                  y1={18 + Math.sin(angle) * r1}
                  x2={18 + Math.cos(angle) * r2}
                  y2={18 + Math.sin(angle) * r2}
                  stroke={isMajor ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)'}
                  strokeWidth={isMajor ? 1.4 : 0.7}
                  strokeLinecap="round"
                />
              );
            })}
            {/* Flame icon centered — Lucide flame path scaled to 14×14 at center */}
            <g transform="translate(11, 11) scale(0.583)">
              <path
                d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
                fill="white"
                stroke="none"
              />
            </g>
          </svg>
          <span>
            <span className="block font-display text-2xl leading-none text-white">{TOP_OVERLAY_TITLE}</span>
            <img
              src={sponsorBranding.sponsorLogoUrl || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl}
              alt="Splitflask"
              className="mt-0.5 block h-4 w-auto object-contain"
            />
          </span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70">
            <span className="font-black text-white">{playCount.toLocaleString()}</span>
            <span>plays</span>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 sm:flex">
            <span className={`h-2 w-2 rounded-full ${isCaptureReady ? 'dot-ready bg-emerald-400' : 'bg-red-500 shadow-[0_0_12px_#e31837]'}`} />
            {statusLabel}
          </div>
          <button
            type="button"
            onClick={handleAdminSecretTap}
            className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-white/20 hover:text-white/40 transition-colors"
            aria-label="Settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </header>

      {isAdminOpen && (
        <section className="fixed right-4 top-20 z-[70] w-[min(92vw,420px)] rounded-lg border border-white/10 bg-black/95 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.58)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-3xl uppercase leading-none text-white">Sponsor Overlay</h2>
              <p className="mt-1 text-sm text-white/54">
                These settings update the live preview and baked-in recording overlay.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsAdminOpen(false)}
              className="h-9 rounded-lg border border-white/10 px-3 font-mono text-xs uppercase text-white/64"
            >
              Close
            </button>
          </div>
          <div className="mt-5 grid gap-4">
            <label className="grid gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">Campaign Badge Text</span>
              <input
                value={sponsorBranding.campaignBadge}
                onChange={(event) => {
                  setSponsorBranding((current) => ({ ...current, campaignBadge: event.target.value }));
                }}
                className="h-12 rounded-lg border border-white/15 bg-black px-4 text-base text-white outline-none focus:border-red-400"
                placeholder="Win A FREE Splitflask"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">Overlay Text</span>
              <input
                value={sponsorBranding.overlayText}
                onChange={(event) => {
                  setSponsorBranding((current) => ({
                    ...current,
                    overlayText: event.target.value,
                  }));
                }}
                className="h-12 rounded-lg border border-white/15 bg-black px-4 text-base text-white outline-none focus:border-red-400"
                placeholder="STOPAT2.COM"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">PNG Logo URL</span>
              <input
                value={sponsorBranding.sponsorLogoUrl}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue && !isPngLogoUrl(nextValue)) {
                    setBrandingError('Logo must be a PNG file path or PNG data URL.');
                    return;
                  }
                  setBrandingError('');
                  setSponsorBranding((current) => ({
                    ...current,
                    sponsorLogoUrl: nextValue || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl,
                  }));
                }}
                className="h-12 rounded-lg border border-white/15 bg-black px-4 text-base text-white outline-none focus:border-red-400"
                placeholder="/splitflask-logo.png"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">Brand Accent Color</span>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={sponsorBranding.accentHex || DEFAULT_SPONSOR_BRANDING.accentHex}
                  onChange={(event) => {
                    setSponsorBranding((current) => ({ ...current, accentHex: event.target.value }));
                  }}
                  className="h-12 w-14 cursor-pointer rounded-lg border border-white/15 bg-black p-1"
                />
                <input
                  value={sponsorBranding.accentHex || DEFAULT_SPONSOR_BRANDING.accentHex}
                  onChange={(event) => {
                    setSponsorBranding((current) => ({ ...current, accentHex: event.target.value }));
                  }}
                  className="h-12 flex-1 rounded-lg border border-white/15 bg-black px-4 font-mono text-base text-white outline-none focus:border-red-400"
                  placeholder="#e31837"
                />
              </div>
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">Background Watermark URL</span>
              <input
                value={sponsorBranding.bgImageUrl || ''}
                onChange={(event) => {
                  setSponsorBranding((current) => ({ ...current, bgImageUrl: event.target.value.trim() }));
                }}
                className="h-12 rounded-lg border border-white/15 bg-black px-4 text-base text-white outline-none focus:border-red-400"
                placeholder="/brand-logo.png"
              />
            </label>
            {brandingError && (
              <p className="rounded-lg border border-red-500/40 bg-red-950/60 p-3 text-sm text-red-100">
                {brandingError}
              </p>
            )}
            <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/50">Preview</p>
              <img
                src={sponsorBranding.sponsorLogoUrl || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl}
                alt="Sponsor logo preview"
                className="mt-2 max-h-16 max-w-full bg-black object-contain"
              />
              <p className="mt-2 font-mono text-sm uppercase text-red-300">
                {(sponsorBranding.overlayText || DEFAULT_SPONSOR_BRANDING.overlayText).toUpperCase()}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setBrandingError('');
                setSponsorBranding(DEFAULT_SPONSOR_BRANDING);
              }}
              className="h-12 rounded-lg border border-white/15 bg-white/[0.06] font-display text-xl uppercase text-white"
            >
              Reset Defaults
            </button>
          </div>
        </section>
      )}

      <section className="relative z-10 grid min-h-dvh grid-cols-1 items-start justify-center gap-6 px-4 pb-8 pt-20 sm:items-center sm:gap-8 sm:pt-24 lg:grid-cols-[minmax(300px,560px)_minmax(360px,520px)] lg:px-8">
        <div className={`social-frame relative overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-[0_30px_80px_rgba(0,0,0,0.5)] ${['READY','COUNTDOWN','PLAYING','REVEAL','ENDCARD','SUBMIT'].includes(stage) ? 'order-1 lg:order-1' : 'order-2 lg:order-1'}`}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 h-full w-full scale-x-[-1] object-cover opacity-90"
          />
          {!stream && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[linear-gradient(135deg,#1b1b1f,#050505)] p-8 text-center">
              <Camera className="mb-5 text-red-400" size={56} />
              <p className="max-w-md font-display text-5xl leading-none">YOUR REACTION IS THE WHOLE GAME</p>
              <p className="mt-4 max-w-sm text-base text-white/62">
                Each attempt records the visible three second countdown, game, and reaction.
              </p>
            </div>
          )}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[length:100%_6px] opacity-30" />
          <div className="absolute left-5 top-5 px-3 py-2">
            <p className="font-display text-2xl leading-none text-white">{TOP_OVERLAY_TITLE}</p>
            <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-red-300">
              {DEFAULT_SPONSOR_BRANDING.overlayText.toUpperCase()}
            </p>
          </div>
          <div className="absolute right-5 top-5 flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white">
            <span className={`h-2.5 w-2.5 rounded-full ${isComposing ? 'bg-red-500 shadow-[0_0_12px_#e31837]' : isCaptureReady ? 'dot-ready bg-emerald-400' : 'bg-white/30'}`} />
            {isComposing ? 'REC' : isCaptureReady ? 'READY' : 'WAITING'}
          </div>
          <div className="absolute bottom-5 left-5 flex max-w-[48%] flex-col items-start gap-1.5">
            <img
              src={sponsorBranding.sponsorLogoUrl || DEFAULT_SPONSOR_BRANDING.sponsorLogoUrl}
              alt="Sponsor logo"
              className="max-h-7 max-w-full object-contain"
            />
            <p className="font-mono text-[10px] font-black uppercase tracking-[0.12em] text-white/70">
              {(sponsorBranding.overlayText || DEFAULT_SPONSOR_BRANDING.overlayText).toUpperCase()}
            </p>
          </div>
          <div className="absolute bottom-5 right-5 rounded-lg border border-red-500/50 bg-black/80 px-5 py-4 text-right shadow-[0_0_28px_rgba(227,24,55,0.25)]">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-red-200">Target</p>
            <p className="font-mono text-5xl font-black tabular-nums">{(result?.displayTime ?? timeLeft).toFixed(2)}</p>
          </div>
          {stage === 'COUNTDOWN' && countdown && (
            <div className="absolute inset-0 grid place-items-center bg-black/45">
              <span className="countdown-pop font-display text-[34vw] leading-none text-white md:text-[18rem]">
                {countdown}
              </span>
            </div>
          )}
          {stage === 'REVEAL' && result && (
            <div className="absolute inset-0 grid place-items-center bg-black/58 p-6 text-center">
              <div className="result-slam result-overlay">
                <p className="result-time font-mono font-black tabular-nums">{result.displayTime.toFixed(2)}</p>
                <p className="result-headline font-display text-red-500">{result.headline}</p>
                <p className="result-detail font-display text-white/78">{result.detail}</p>
              </div>
            </div>
          )}
          {stage === 'ENDCARD' && (
            <div className="absolute inset-0 grid place-items-center bg-black/92 p-6 text-center">
              <p className="animated-ellipsis font-mono text-sm uppercase tracking-[0.2em] text-white/60">Finalizing clip</p>
            </div>
          )}
        </div>

        <div className={`flex flex-col justify-center lg:order-2 ${['READY','COUNTDOWN','PLAYING','REVEAL','ENDCARD','SUBMIT'].includes(stage) ? 'order-2' : 'order-1'}`}>
          {stage === 'HOME' && (
            <section className="max-w-xl">
              <p className="mb-3 inline-flex rounded-full bg-red-600 px-4 py-2 font-mono text-xs font-black uppercase tracking-[0.2em] text-white">
                {sponsorBranding.campaignBadge || DEFAULT_SPONSOR_BRANDING.campaignBadge}
              </p>
              <h1 className="font-display text-[2.6rem] leading-[0.9] text-white sm:text-[4.2rem] lg:text-8xl">
                STOP THE TIMER AT EXACTLY 2.00
              </h1>
              <p className="mt-5 max-w-lg text-2xl font-semibold uppercase text-red-200">
                Sounds easy. It is not.
              </p>
              <button
                type="button"
                onClick={() => setStage('PERMISSION')}
                className="mt-9 inline-flex h-20 w-full max-w-sm cursor-pointer items-center justify-center gap-3 rounded-lg border-b-8 border-red-950 bg-red-600 px-7 font-display text-4xl uppercase italic text-white shadow-[0_24px_48px_rgba(227,24,55,0.26)] transition active:translate-y-2 active:border-b-0"
              >
                <Play fill="currentColor" />
                Play Now
              </button>
              <div className="mt-6 grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
                  <p className="font-display text-3xl">5.00</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-white/48">Start</p>
                </div>
                <div className="rounded-lg border border-red-500/20 bg-red-950/30 p-4">
                  <p className="font-display text-3xl text-red-300">2.00</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-white/48">Target</p>
                </div>
                {personalBest !== null ? (
                  <div className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
                    <p className="font-display text-3xl text-red-300">
                      {personalBest.toFixed(2)}
                      {personalBest === 0 && <span className="ml-1 text-lg">🏆</span>}
                    </p>
                    <p className="mt-1 text-xs uppercase tracking-wide text-white/48">Your Best Δ</p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-white/10 bg-white/[0.05] p-4">
                    <p className="font-display text-3xl">3 SEC</p>
                    <p className="mt-1 text-xs uppercase tracking-wide text-white/48">Pre-roll</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {stage === 'PERMISSION' && (
            <section className="max-w-xl rounded-lg border border-white/10 bg-white/[0.06] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.3)]">
              <Video className="text-red-400" size={42} />
              <h2 className="mt-5 font-display text-6xl leading-none">{gateCopy.title}</h2>
              <p className="mt-3 text-lg text-white/68">{gateCopy.body}</p>
              <form className="mt-6 grid gap-4" onSubmit={handleLeadGateSubmit}>
                {activeLeadField && (
                  <label className="grid gap-1">
                    <span className="font-mono text-xs uppercase tracking-[0.16em] text-white/60">
                      {gateCopy.label}
                    </span>
                    <input
                      type={gateCopy.inputType}
                      autoComplete="off"
                      value={leadInfo[activeLeadField]}
                      onChange={(event) => {
                        setLeadInfo((current) => ({
                          ...current,
                          [activeLeadField]: event.target.value,
                        }));
                      }}
                      className="h-14 rounded-lg border border-white/15 bg-black px-4 text-base text-white outline-none focus:border-red-400"
                      placeholder={gateCopy.placeholder}
                    />
                  </label>
                )}
                {activeLeadField === 'email' && (
                  <label className="flex cursor-pointer items-start gap-4 rounded-lg border border-white/10 bg-black/40 p-4">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                      className="mt-1 h-5 w-5 accent-red-600"
                    />
                    <span>
                      <span className="block font-mono text-xs uppercase tracking-[0.16em] text-white">Consent</span>
                      <span className="mt-1 block text-sm text-white/60">
                        Reaction clip may be shared on Splitflask socials.
                      </span>
                    </span>
                  </label>
                )}
                {cameraError && (
                  <p className="rounded-lg border border-red-500/40 bg-red-950/60 p-3 text-sm text-red-100">
                    {cameraError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={!canPassLeadGate}
                  className="flex h-16 w-full cursor-pointer items-center justify-center gap-3 rounded-lg border-b-8 border-red-950 bg-red-600 font-display text-3xl uppercase italic text-white transition disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-700 disabled:text-zinc-400 active:translate-y-2 active:border-b-0"
                >
                  <Camera />
                  {gateCopy.button}
                </button>
              </form>
            </section>
          )}

          {stage === 'READY' && (
            <section className="flex flex-col items-center text-center">
              <p className="mb-4 rounded-full border border-red-500/50 bg-red-950/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-red-100">
                3-second countdown starts when you hit START
              </p>
              {personalBest !== null && (
                <p className="mb-4 font-mono text-xs uppercase tracking-[0.18em] text-white/40">
                  PR: <span className="text-red-300">{personalBest.toFixed(2)}s off target</span>
                </p>
              )}
              <button
                type="button"
                onClick={startChallenge}
                disabled={!isCaptureReady}
                className="arcade-button"
                aria-label="Start Stop At 2.00 challenge"
              >
                <span className="arcade-button__label">{isCaptureReady ? 'START' : 'WAIT'}</span>
              </button>
              <p className="mt-8 max-w-sm text-sm uppercase tracking-[0.16em] text-white/50">
                Hit start, the 3-2-1 begins immediately, then slam stop at exactly 2.00.
              </p>
            </section>
          )}

          {(stage === 'COUNTDOWN' || stage === 'PLAYING' || stage === 'REVEAL' || stage === 'ENDCARD') && (
            <section className="flex flex-col items-center text-center">
              <div className="mb-8">
                <p className="font-mono text-sm uppercase tracking-[0.24em] text-red-200">
                  {stage === 'COUNTDOWN' ? '3-second countdown' : stage === 'ENDCARD' ? 'Finalizing clip' : 'Timer'}
                </p>
                <p className="font-mono text-[4rem] font-black leading-none tabular-nums text-white sm:text-[5.5rem] lg:text-[7rem]">
                  {timeLeft.toFixed(2)}
                </p>
              </div>
              <button
                type="button"
                onPointerDown={(event) => {
                  event.preventDefault();
                  setStopFlashSeq((n) => (n ?? 0) + 1);
                  stopGame();
                }}
                disabled={stage !== 'PLAYING'}
                className="arcade-button arcade-button--stop"
                aria-label="Stop timer"
              >
                <span className="arcade-button__label">STOP</span>
                {stopFlashSeq !== null && (
                  <span
                    key={stopFlashSeq}
                    className="stop-flash"
                    onAnimationEnd={() => setStopFlashSeq(null)}
                  />
                )}
              </button>
            </section>
          )}

          {stage === 'SUBMIT' && result && (
            <section className="max-w-xl rounded-lg border border-white/10 bg-white/[0.06] p-6 shadow-[0_24px_70px_rgba(0,0,0,0.3)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-display text-4xl leading-none text-white sm:text-6xl">{result.headline}</p>
                  <p className="mt-1 font-mono text-2xl font-black tabular-nums text-red-300 sm:text-3xl">{result.displayTime.toFixed(2)}</p>
                  {personalBest !== null && result.difference <= personalBest && (
                    <span className="mt-1 inline-block rounded-full bg-red-600 px-3 py-1 font-mono text-xs uppercase tracking-[0.18em] text-white">
                      New personal best!
                    </span>
                  )}
                </div>
              </div>

              {clipUrl && (
                <div className="social-playback-frame mt-5 rounded-lg border border-white/10 bg-black">
                  <video
                    ref={playbackVideoRef}
                    src={clipUrl}
                    autoPlay
                    controls
                    muted
                    playsInline
                    className="h-full w-full object-contain"
                  />
                </div>
              )}

              <form className="mt-5 grid gap-4" onSubmit={handleSubmit}>
                {clipBlob && (
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => void handleShareToSocial('instagram')}
                      className="inline-flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-b-4 border-red-950 bg-red-600 font-display text-base uppercase text-white shadow-[0_8px_24px_rgba(227,24,55,0.3)] transition active:translate-y-1 active:border-b-0"
                    >
                      IG
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleShareToSocial('tiktok')}
                      className="inline-flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-b-4 border-red-950 bg-red-600 font-display text-base uppercase text-white shadow-[0_8px_24px_rgba(227,24,55,0.3)] transition active:translate-y-1 active:border-b-0"
                    >
                      TikTok
                    </button>
                    <button
                      type="button"
                      onClick={handleShareToTwitter}
                      className="inline-flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-lg border-b-4 border-red-950 bg-red-600 font-display text-base uppercase text-white shadow-[0_8px_24px_rgba(227,24,55,0.3)] transition active:translate-y-1 active:border-b-0"
                    >
                      X
                    </button>
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="submit"
                    className="inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-lg bg-white font-display text-xl uppercase text-black"
                  >
                    <Send size={19} />
                    Save Entry
                  </button>
                  {clipUrl && (
                    <a
                      href={clipUrl}
                      download={`stop-at-2-${result.displayTime.toFixed(2)}.mp4`}
                      className="inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/15 bg-black font-display text-xl uppercase text-white"
                    >
                      <Download size={20} />
                      Download
                    </a>
                  )}
                </div>
              </form>
              {leadStatus && (
                <p className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-950/40 p-3 text-sm text-emerald-100">
                  <CheckCircle2 size={18} />
                  {leadStatus}
                </p>
              )}
              {(driveStatus === 'uploading' || driveStatus === 'done') && (
                <p className={`mt-3 flex items-center gap-2 rounded-lg border p-3 text-xs font-mono uppercase tracking-[0.14em] ${
                  driveStatus === 'uploading' ? 'border-white/10 bg-white/[0.04] text-white/40' :
                                               'border-emerald-500/30 bg-emerald-950/30 text-emerald-300'
                }`}>
                  {driveStatus === 'uploading' && <span className="h-2 w-2 animate-pulse rounded-full bg-white/40" />}
                  {driveStatus === 'done'      && <CheckCircle2 size={14} />}
                  {driveStatus === 'uploading' ? 'Saving clip…' : 'Clip saved'}
                </p>
              )}
              <button
                type="button"
                onClick={resetRound}
                className="mt-5 inline-flex h-14 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] font-display text-xl uppercase text-white"
              >
                <RefreshCw size={18} />
                Again
              </button>
              {leaderboard.length > 1 && (
                <div className="mt-5 rounded-lg border border-white/10 bg-black/40 p-4">
                  <p className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/50">
                    <Trophy size={13} />
                    Top scores this device
                  </p>
                  <ol className="grid gap-2">
                    {leaderboard.slice(0, 5).map((entry, i) => (
                      <li
                        key={`${entry.createdAt}-${i}`}
                        className="flex items-center justify-between gap-3 font-mono text-sm"
                      >
                        <span className="text-white/40">#{i + 1}</span>
                        <span className="flex-1 truncate text-white/70">{entry.headline}</span>
                        <span className={entry.difference === 0 ? 'text-red-400' : 'text-white'}>
                          {entry.displayTime.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          )}
        </div>
      </section>

      <canvas ref={canvasRef} className="hidden" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
    </main>
  );
}
