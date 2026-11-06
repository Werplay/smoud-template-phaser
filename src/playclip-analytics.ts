// Analytics config for this build.
//
// `null` by default: nothing is tracked. When an export is built with
// "add analytics", the export pipeline overwrites this file in its per-build
// copy with the tracking endpoint, this export's id and the target network.

import type { PlayclipAnalyticsConfig } from './playclip/analytics';

export const PLAYCLIP_ANALYTICS: PlayclipAnalyticsConfig | null = null;
