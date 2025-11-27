declare module 'loupedeck' {
  export function discover(): Promise<LoupedeckDevice>;
  
  export enum HAPTIC {
    REV_FASTEST = 'REV_FASTEST'
  }
  
  export interface LoupedeckDevice {
    on(event: 'connect', handler: () => void): void;
    on(event: 'down', handler: (data: { id: string | number }) => void): void;
    on(event: 'rotate', handler: (data: { id: string; delta: number }) => void): void;
    on(event: 'touchstart', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    on(event: 'touchmove', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    on(event: 'touchend', handler: (data: { changedTouches: TouchEvent[]; touches: TouchEvent[] }) => void): void;
    
    drawKey(id: number, callback: (context: any) => void): Promise<void>;
    drawScreen(side: 'left' | 'right', callback: (context: any) => void): Promise<void>;
    setButtonColor(options: { id: number; color: string }): Promise<void>;
    vibrate(haptic: HAPTIC): void;
    close(): Promise<void>;
  }
  
  interface TouchEvent {
    target: {
      key?: number;
    };
  }
}