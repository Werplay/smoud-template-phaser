/// <reference types="@smoud/playable-sdk/defines" />
/// <reference types="@smoud/playable-scripts/defines" />

declare module '*.mp4' {
  const src: string;
  export default src;
}

declare module '*.webm' {
  const src: string;
  export default src;
}