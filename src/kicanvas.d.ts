/**
 * Type declarations for the kicanvas custom elements.
 * kicanvas is bundled as public/kicanvas.js (loaded via <script> in index.html).
 * Not available on npm — downloaded from https://kicanvas.org/kicanvas/kicanvas.js
 * Source: https://github.com/theacodes/kicanvas
 */

import 'solid-js';

type KiCanvasControls = 'none' | 'basic' | 'full';

interface KiCanvasEmbedProps {
  src?: string;
  controls?: KiCanvasControls;
  controlslist?: string;
  theme?: string;
  zoom?: string;
  type?: 'schematic' | 'board' | 'project' | 'worksheet';
  name?: string;
  children?: any;
  style?: string | Record<string, string>;
  class?: string;
}

interface KiCanvasSourceProps {
  src?: string;
  name?: string;
  type?: string;
  children?: any;
}

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'kicanvas-embed': KiCanvasEmbedProps;
      'kicanvas-source': KiCanvasSourceProps;
    }
  }
}
