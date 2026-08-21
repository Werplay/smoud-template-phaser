import { sdk } from '@smoud/playable-sdk';
import { Game } from './Game';
import { installEditorBridge } from './game/editor-bridge';
import './index.css';

// The editor preview's entry point. The export pipeline swaps src/index.ts for
// a one-line re-export of this file when it builds the preview bundle, so the
// bridge never reaches a customer's playable.
sdk.init((width: number, height: number) => {
  const game = new Game(width, height);

  sdk.on('resize', game.resize, game);
  sdk.on('pause', game.pause, game);
  sdk.on('resume', game.resume, game);
  sdk.on('volume', game.volume, game);
  sdk.on('finish', game.finish, game);

  installEditorBridge(game);
});
