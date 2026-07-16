declare module 'loupedeck' {
  export function discover(): Promise<LoupedeckDevice>;
  
  export enum HAPTIC {
    REV_FASTEST = 'REV_FASTEST'
  }
  
  export interface LoupedeckDevice {
    keySize: number;
    columns: number;
    visibleX: number[];
    displays?: {
      center?: {
        width: number;
        height: number;
      };
    };
    touches?: Record<string, TouchEvent>;

    on(event: 'connect', handler: () => void): void;
    on(event: 'disconnect', handler: () => void): void;
    on(event: 'down', handler: (data: { id: string | number }) => void): void;
    on(event: 'rotate', handler: (data: { id: string; delta: number }) => void): void;
    on(event: 'touchstart', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    on(event: 'touchmove', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    on(event: 'touchend', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    on(event: 'touchcancel', handler: () => void): void;
    
    drawKey(id: number, callback: (context: import("canvas").CanvasRenderingContext2D) => void): Promise<void>;
    drawScreen(side: 'left' | 'right', callback: (context: import("canvas").CanvasRenderingContext2D) => void): Promise<void>;
    drawBuffer(display: { id: string; width: number; height: number }, buffer: Buffer): Promise<void>;
    setButtonColor(options: { id: number; color: string }): Promise<void>;
    vibrate(haptic: HAPTIC): void;
    close(): Promise<void>;
  }
  
  interface TouchEvent {
    id?: number;
    target: {
      key?: number;
    };
  }
}
