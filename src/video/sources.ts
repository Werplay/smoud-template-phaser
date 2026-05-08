import landscapeMp4 from 'assets/video-landscape.mp4';
import { VideoKey } from './types';

export interface VideoSources {
  portrait: string;
  landscape: string;
}

export const VIDEO_SOURCES: VideoSources = {
  // When a portrait-specific video is added, replace portrait with that import.
  portrait: landscapeMp4,
  landscape: landscapeMp4
};

export const HAS_REAL_PORTRAIT_SOURCE = VIDEO_SOURCES.portrait !== VIDEO_SOURCES.landscape;

export const ALL_VIDEO_KEYS: VideoKey[] = ['bg-landscape', 'bg-portrait'];
