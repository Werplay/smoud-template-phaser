/// <reference types="@smoud/playable-sdk/defines" />
/// <reference types="@smoud/playable-scripts/defines" />

/** One editable text field, as the playable editor reads and writes it. */
interface GameDataText {
  label: string;
  type: 'text';
  tooltip: string;
  value: string;

  FontSize: number;
  TextColor: string;
  OriginX: number;
  OriginY: number;
  Align: string;
  StrokeColor: string;
  StrokeThickness: number;
}

/**
 * Declared by the `app-constants` script in src/index.html, which uses `var` so
 * the value is also reachable as `window.GameData`. Read it defensively - the
 * editor rewrites that script, and a stripped HTML may not have it at all.
 */
declare const GameData: { Text: GameDataText } | undefined;

interface Window {
  GameData?: { Text: GameDataText };
}