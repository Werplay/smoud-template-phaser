// Opt-in export analytics. Sends fire-and-forget GETs to the editor's
// /api/track endpoints, keyed by the export id so the per-export stats page
// (impressions = gameReady, conversions = ctaCall) and heatmap pick them up.
import { PLAYCLIP_ANALYTICS } from '../playclip-analytics';

export interface PlayclipAnalyticsConfig {
  /** Editor origin, e.g. https://studio.example.com */
  base: string;
  /** Export record id. */
  adId: string;
  network: string;
}

export type AnalyticsEvent = 'gameReady' | 'ctaCall' | 'click';

function platform(): string {
  const ua = navigator.userAgent || '';
  if (/windows phone/i.test(ua)) return 'Windows Phone';
  if (/android/i.test(ua)) return 'Android';
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (/win/i.test(ua)) return 'Windows';
  if (/mac/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function send(url: string): void {
  try {
    fetch(url, { method: 'GET', mode: 'no-cors' }).catch(() => undefined);
  } catch {
    // Analytics must never break the ad.
  }
}

export function track(
  activityType: AnalyticsEvent,
  metadata: Record<string, unknown> = {},
): void {
  const cfg = PLAYCLIP_ANALYTICS;
  if (!cfg) return;
  const q = new URLSearchParams({
    adId: cfg.adId,
    network: cfg.network,
    platform: platform(),
    activityType,
    metadata: JSON.stringify(metadata),
  });
  send(`${cfg.base}/api/track?${q}`);
}

let heatmapBound = false;

/** Record every tap's normalised position for the export's heatmap. */
export function bindHeatmap(): void {
  const cfg = PLAYCLIP_ANALYTICS;
  if (!cfg || heatmapBound) return;
  heatmapBound = true;
  document.addEventListener('pointerdown', (e) => {
    const rect = document.body.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const q = new URLSearchParams({ adId: cfg.adId, x: String(x), y: String(y) });
    send(`${cfg.base}/api/track/heatmap?${q}`);
  });
}
