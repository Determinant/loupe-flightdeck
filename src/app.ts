#!/usr/bin/env node

import { createCanvas, registerFont, CanvasRenderingContext2D } from "canvas";
import { readFile } from "fs/promises";
import { discover, HAPTIC, LoupedeckDevice } from "loupedeck";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import yargs from "yargs/yargs";
import { Arguments } from "yargs";
import type { ActionSpec, DisplayConfig, KeyConfig, KnobConfig, PageConfig } from "./config.js";
import {
    defaultFont,
    getGaugeRenderers,
    renderAeroCross,
    renderKey,
    renderSideKnobs,
} from "./graphics.js";
import {
    XPlane,
    type SubscribeDataRefOptions,
} from "./xplane.js";

const KEY_COUNT = 12;
const DISPLAY_REFRESH_HZ = 48;
const DISPLAY_REFRESH_MS = Math.max(1, Math.floor(1000 / DISPLAY_REFRESH_HZ));
const DEFAULT_XPLANE_DATAREF_HZ = 1;
const RENDER_STATS_WINDOW_MS = 5000;
const RENDER_WARN_MIN_MISSED = 3;
const CENTER_IDLE_SLEEP_MS = 5000;
const TOUCH_RECONCILE_INTERVAL_MS = 50;
const TOUCH_MAX_PRESS_MS = 1000;
const CONNECT_SETUP_RETRY_MS = 1000;

// font.ttf uses the font from https://b612-font.com/
const resourceDir = fileURLToPath(new URL("..", import.meta.url));
const fontPath = fileURLToPath(new URL("../font.ttf", import.meta.url));
if (process.platform == "linux") {
    process.env.FONTCONFIG_FILE = resourceDir;
    //console.warn(
    //    "node-canvas does not support directly using font file in Linux (see https://github.com/Automattic/node-canvas/issues/2097#issuecomment-1803950952), please copy ./ocr-a-ext.ttf in this folder to your local font folder (~/.fonts/) or install it system-wide.",
    //);
}
registerFont(fontPath, {
    family: defaultFont,
});

interface KeySurface {
    canvas: ReturnType<typeof createCanvas>;
    ctx: CanvasRenderingContext2D;
}

interface CenterSurface {
    canvas: ReturnType<typeof createCanvas>;
    ctx: CanvasRenderingContext2D;
}

interface CenterRenderStats {
    windowStart: number;
    intervalTicks: number;
    renderedFrames: number;
    droppedRequests: number;
    maxFrameMs: number;
    maxRasterMs: number;
    maxSendMs: number;
    maxHeapMb: number;
}

interface TouchTarget {
    key?: number;
}

interface TouchEvent {
    id?: number;
    target: TouchTarget;
}

interface DataRefSubscription {
    freq: number;
    handlers: Array<(value: number) => void>;
}

interface DisplayState {
    values: (number | null)[];
    aeroCrossed: boolean;
}

type ActionType = "pressed" | "inc" | "dec";
type ActionOwner = Partial<Record<ActionType, ActionSpec>>;

const isNumber = (x: unknown): x is number => {
    return typeof x === "number" && Number.isFinite(x);
};

const isSameNumber = (a: number | null, b: number): boolean => {
    return a === b || (a != null && Number.isNaN(a) && Number.isNaN(b));
};

const isObject = (obj: unknown): obj is Record<string, unknown> => {
    return typeof obj === "object" && obj != null && !Array.isArray(obj);
};

const getDisplayConfig = (conf: KeyConfig | null | undefined): DisplayConfig | null => {
    return isObject(conf?.display) ? conf.display : null;
};

const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
};

const getDisplayDataRefHz = (freq: number | undefined): number => {
    if (!isNumber(freq) || freq <= 0) {
        return DEFAULT_XPLANE_DATAREF_HZ;
    }
    return Math.max(1, Math.floor(freq));
};

const isDisplayAeroCrossed = (display: DisplayConfig, values: (number | null)[]): boolean => {
    switch (display.type) {
        case "attitude":
            return !isNumber(values[0]) || !isNumber(values[1]);
        case "ias":
        case "alt":
        case "hsi":
        case "text":
            return !isNumber(values[0]);
        default:
            return false;
    }
};

interface AppArgs {
    'xplane-port': number;
    'xplane-host': string;
    verbose: boolean;
    _: string[];
}

const args = yargs(process.argv.slice(2))
    .usage("loupe-flightdeck [--xplane-host <host>] [--xplane-port <port>] [--verbose] [profile YAML file]")
    .options({
        'xplane-port': { default: 49000, type: 'number' },
        'xplane-host': { default: "localhost", type: 'string' },
        verbose: { default: false, type: "boolean" },
    }).parse() as Arguments<AppArgs>;
const xplanePort = isNumber(args['xplane-port']) ? args['xplane-port'] : 49000;
const xplaneHost = args['xplane-host'];
const verbose = args.verbose === true;
const profile_file = args._[0] ? args._[0] : fileURLToPath(new URL("../profile.yaml", import.meta.url));
const pages: PageConfig[] = parse(await readFile(profile_file, "utf8"));

// state of the controller
let currentPage =
    isNumber(pages[0]?.default) ? pages[0].default : 0;
let highlighted = new Set<string>();
let activeTouchId: number | null = null;
let activeTouchKey: number | null = null;
let activeTouchDeadlineMs: number | null = null;
let pressedKey: number | null = null;
let touchReconcileTimer: NodeJS.Timeout | null = null;
let deviceOnline = false;
let connectGeneration = 0;
let connectSetupRetryTimer: NodeJS.Timeout | null = null;

// detects and opens first connected device
let device: LoupedeckDevice | undefined;

// Render related variables
let keySurfaces: KeySurface[] = [];
let centerSurface: CenterSurface | null = null;
let centerRenderInterval: NodeJS.Timeout | null = null;
let centerRenderInFlight = false;
let centerFrameRenderPending = false;
let centerDirty = true;
let centerSleeping = false;
let centerLastActivityMs = Date.now();
const displayStates = new WeakMap<KeyConfig, DisplayState>();
let initialized = false;
let centerRenderStats: CenterRenderStats = {
    windowStart: Date.now(),
    intervalTicks: 0,
    renderedFrames: 0,
    droppedRequests: 0,
    maxFrameMs: 0,
    maxRasterMs: 0,
    maxSendMs: 0,
    maxHeapMb: 0,
};

const xplane = new XPlane(xplaneHost, xplanePort);
console.log(`Connecting to X-Plane at ${xplaneHost}:${xplanePort}`);
if (verbose) {
    console.log("x-plane verbose subscription stats enabled");
}

while (!device) {
    try {
        device = await discover();
    } catch (e) {
        await new Promise((res) => setTimeout(res, 5000));
    }
}

const getCurrentPage = (): PageConfig => {
    return pages[currentPage] || {};
};

const getKeyConf = (i: number): KeyConfig | null => {
    const keys = getCurrentPage().keys;
    if (keys == null) {
        return null;
    }
    if (Array.isArray(keys) && i < keys.length) {
        return keys[i];
    }
    return null;
};

const isCurrentPageIndex = (pageIndex: number): boolean => {
    return pageIndex === currentPage;
};

const isStaleConnectGeneration = (generation: number): boolean => {
    return generation !== connectGeneration || !deviceOnline;
};

const clearConnectSetupRetryTimer = (): void => {
    if (!connectSetupRetryTimer) {
        return;
    }
    clearTimeout(connectSetupRetryTimer);
    connectSetupRetryTimer = null;
};

const scheduleConnectSetupRetry = (generation: number): void => {
    clearConnectSetupRetryTimer();
    connectSetupRetryTimer = setTimeout(() => {
        if (isStaleConnectGeneration(generation)) {
            return;
        }
        void runConnectSetup(generation);
    }, CONNECT_SETUP_RETRY_MS);
    connectSetupRetryTimer.unref?.();
};

const resetCenterRenderStats = (): void => {
    centerRenderStats = {
        windowStart: Date.now(),
        intervalTicks: 0,
        renderedFrames: 0,
        droppedRequests: 0,
        maxFrameMs: 0,
        maxRasterMs: 0,
        maxSendMs: 0,
        maxHeapMb: 0,
    };
};

const maybeWarnCenterRenderStats = (): void => {
    const now = Date.now();
    const elapsedMs = now - centerRenderStats.windowStart;
    if (elapsedMs < RENDER_STATS_WINDOW_MS) {
        return;
    }

    const missedFrames = Math.max(
        0,
        centerRenderStats.intervalTicks - centerRenderStats.renderedFrames,
    );
    const elapsedSeconds = elapsedMs / 1000;
    const actualHz = centerRenderStats.renderedFrames / elapsedSeconds;
    const shouldWarn = (
        missedFrames >= RENDER_WARN_MIN_MISSED
        || centerRenderStats.droppedRequests >= RENDER_WARN_MIN_MISSED
    );
    if (shouldWarn) {
        console.warn(
            "center render lag:"
            + ` rendered ${centerRenderStats.renderedFrames}/${centerRenderStats.intervalTicks}`
            + ` interval ticks in ${elapsedSeconds.toFixed(1)}s`
            + ` (${actualHz.toFixed(1)}Hz vs target ${DISPLAY_REFRESH_HZ}Hz),`
            + ` missed=${missedFrames}, dropped=${centerRenderStats.droppedRequests},`
            + ` slowest=${centerRenderStats.maxFrameMs}ms`
            + ` (raster=${centerRenderStats.maxRasterMs}ms, send=${centerRenderStats.maxSendMs}ms),`
            + ` heap=${centerRenderStats.maxHeapMb.toFixed(1)}MB`,
        );
    }

    resetCenterRenderStats();
};

const scheduleCenterFrameRender = (): void => {
    if (!centerRenderInterval) {
        startCenterRendering();
    }
    if (centerRenderInFlight) {
        centerFrameRenderPending = true;
        return;
    }
    void runCenterFrameRender();
};

const markCenterActivity = (dirty = true): void => {
    centerLastActivityMs = Date.now();
    if (dirty) {
        centerDirty = true;
    }
    if (!centerRenderInterval) {
        startCenterRendering();
    }
};

const maybeSleepCenterRendering = (): void => {
    if (!centerRenderInterval) {
        return;
    }
    if (centerRenderInFlight || centerFrameRenderPending || centerDirty) {
        return;
    }
    if (Date.now() - centerLastActivityMs < CENTER_IDLE_SLEEP_MS) {
        return;
    }
    centerSleeping = true;
    console.info(`center rendering: sleep after ${CENTER_IDLE_SLEEP_MS}ms idle`);
    stopCenterRendering();
};

const getKeyPosition = (index: number): { x: number; y: number } => {
    const dev = device!;
    const keySize = dev.keySize;
    const x = dev.visibleX[0] + (index % dev.columns) * keySize;
    const y = Math.floor(index / dev.columns) * keySize;
    return { x, y };
};

const renderCenterDisplayFrame = async (): Promise<{ rasterMs: number; sendMs: number }> => {
    const dev = device!;
    if (!centerSurface) {
        return { rasterMs: 0, sendMs: 0 };
    }

    const rasterStart = Date.now();
    const { canvas: centerCanvas, ctx: c } = centerSurface;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "black";
    c.fillRect(0, 0, centerCanvas.width, centerCanvas.height);
    c.beginPath();

    for (let i = 0; i < KEY_COUNT; i++) {
        const conf = getKeyConf(i);
        const surface = keySurfaces[i];
        if (!surface) {
            continue;
        }

        const { canvas, ctx } = surface;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.beginPath();
        ctx.save();

        const display = getDisplayConfig(conf);
        if (conf && display?.type != null) {
            const renderer = gaugeRenderers[display.type];
            if (renderer) {
                const state = displayStates.get(conf);
                renderer(ctx, display, state?.values || []);
                if (state?.aeroCrossed) {
                    renderAeroCross(ctx, canvas.width, canvas.height);
                }
            } else {
                renderKey(ctx, conf, pressedKey === i);
            }
        } else {
            renderKey(ctx, conf, pressedKey === i);
        }
        ctx.restore();
        ctx.beginPath();

        const { x, y } = getKeyPosition(i);
        c.drawImage(canvas, x, y);
    }

    const buffer = centerCanvas.toBuffer("raw");
    const rasterMs = Date.now() - rasterStart;

    const sendStart = Date.now();
    await dev.drawBuffer(
        {
            id: "center",
            width: centerCanvas.width,
            height: centerCanvas.height,
        },
        buffer,
    );
    const sendMs = Date.now() - sendStart;
    return { rasterMs, sendMs };
};

const runCenterFrameRender = async (): Promise<void> => {
    if (centerRenderInFlight) {
        if (centerFrameRenderPending) {
            centerRenderStats.droppedRequests++;
        }
        centerFrameRenderPending = true;
        maybeWarnCenterRenderStats();
        return;
    }

    centerRenderInFlight = true;
    try {
        const frameStart = Date.now();
        const { rasterMs, sendMs } = await renderCenterDisplayFrame();
        centerDirty = false;
        centerRenderStats.renderedFrames++;
        centerRenderStats.maxFrameMs = Math.max(
            centerRenderStats.maxFrameMs,
            Date.now() - frameStart,
        );
        centerRenderStats.maxRasterMs = Math.max(
            centerRenderStats.maxRasterMs,
            rasterMs,
        );
        centerRenderStats.maxSendMs = Math.max(
            centerRenderStats.maxSendMs,
            sendMs,
        );
        centerRenderStats.maxHeapMb = Math.max(
            centerRenderStats.maxHeapMb,
            process.memoryUsage().heapUsed / (1024 * 1024),
        );
    } catch (e) {
        // Hot-plug disconnect/reconnect is expected; avoid noisy per-frame errors.
    } finally {
        centerRenderInFlight = false;
        maybeWarnCenterRenderStats();
        maybeSleepCenterRendering();
        if (centerFrameRenderPending) {
            centerFrameRenderPending = false;
            void runCenterFrameRender();
        }
    }
};

const stopCenterRendering = (): void => {
    if (centerRenderInterval) {
        clearInterval(centerRenderInterval);
    }
    centerRenderInterval = null;
    centerRenderInFlight = false;
    centerFrameRenderPending = false;
    centerDirty = true;
    resetCenterRenderStats();
};

const startCenterRendering = (): void => {
    if (centerSleeping) {
        console.info("center rendering: wake");
    }
    centerSleeping = false;
    stopCenterRendering();
    centerRenderInFlight = false;
    centerFrameRenderPending = false;
    centerDirty = true;
    centerLastActivityMs = Date.now();
    resetCenterRenderStats();
    centerRenderInterval = setInterval(() => {
        centerRenderStats.intervalTicks++;
        void runCenterFrameRender();
    }, DISPLAY_REFRESH_MS);
    void runCenterFrameRender();
};

const initKeySurfaces = (): void => {
    const dev = device!;
    const centerDisplay = dev.displays?.center;
    const centerCanvas = createCanvas(
        centerDisplay?.width || 480,
        centerDisplay?.height || 270,
    );
    const centerCtx = centerCanvas.getContext("2d", { pixelFormat: "RGB16_565" });
    centerSurface = { canvas: centerCanvas, ctx: centerCtx };

    keySurfaces = [];
    for (let i = 0; i < KEY_COUNT; i++) {
        const canvas = createCanvas(dev.keySize, dev.keySize);
        const ctx = canvas.getContext("2d", { pixelFormat: "RGB16_565" });
        keySurfaces.push({ canvas, ctx });
    }
};

const drawKey = async (id: number, conf: KeyConfig | null, pressed: boolean): Promise<void> => {
    if (pressed) {
        pressedKey = id;
    } else if (pressedKey === id) {
        pressedKey = null;
    }

    const display = getDisplayConfig(conf);
    if (display) {
        // not an input, but a display gauge
        display.pressed = pressed;
    }
    markCenterActivity(true);
};

const drawSideKnobs = async (side: "left" | "right", confs: KnobConfig[] | undefined, highlight?: boolean[]): Promise<void> => {
    await device!.drawScreen(side, (c: CanvasRenderingContext2D) => {
        const page = getCurrentPage();
        const light = page.color != null ? page.color : "white";
        renderSideKnobs(c, confs, light, highlight);
    });
};

const gaugeRenderers = getGaugeRenderers({
    onHsiSourceChange: (command: string) => {
        void xplane.sendCommand(command);
    },
});

const loadPage = async (page: PageConfig): Promise<void> => {
    // page is not null
    const { left, right, keys } = page;
    pressedKey = null;
    resetActiveTouchState();

    const pms: Promise<void>[] = [];
    pms.push(drawSideKnobs("left", left));
    pms.push(drawSideKnobs("right", right));

    for (let i = 0; i < KEY_COUNT; i++) {
        const conf = Array.isArray(keys) && keys.length > i ? keys[i] : null;
        const display = getDisplayConfig(conf);
        if (display) {
            display.pressed = false;
        }
    }

    await Promise.all(pms);
    markCenterActivity(true);
    scheduleCenterFrameRender();
};

const applyPageButtonColors = async (): Promise<void> => {
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i] || {};
        const color = typeof page.color === "string" ? page.color : "white";
        await device!.setButtonColor({ id: i, color });
    }
};

const initializePages = async (): Promise<void> => {
    const subscriptions = new Map<string, DataRefSubscription>();
    let sourceRefs = 0;
    const registerDataRefHandler = (
        dataRef: string,
        freq: number,
        handler: (value: number) => void,
    ): void => {
        const existing = subscriptions.get(dataRef);
        if (existing) {
            existing.freq = Math.max(existing.freq, freq);
            existing.handlers.push(handler);
            return;
        }
        const created: DataRefSubscription = {
            freq,
            handlers: [handler],
        };
        subscriptions.set(dataRef, created);
    };

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i] || {};
        const keys = page.keys;

        for (let j = 0; j < KEY_COUNT; j++) {
            const conf =
                Array.isArray(keys) && keys.length > j ? keys[j] : null;
            const display = getDisplayConfig(conf);
            if (conf && display && Array.isArray(display.source)) {
                const freq = getDisplayDataRefHz(display.freq);
                const values: (number | null)[] = [];
                for (let k = 0; k < display.source.length; k++) {
                    values.push(null);
                }
                const state: DisplayState = {
                    values,
                    aeroCrossed: isDisplayAeroCrossed(display, values),
                };
                displayStates.set(conf, state);
                display.pressed = false;

                for (let k = 0; k < display.source.length; k++) {
                    const source = display.source[k];
                    const xplane_dataref = source.xplane_dataref;
                    if (xplane_dataref != null) {
                        sourceRefs++;
                        registerDataRefHandler(
                            xplane_dataref,
                            freq,
                            (v: number) => {
                                if (!isSameNumber(state.values[k], v)) {
                                    state.values[k] = v;
                                    state.aeroCrossed = isDisplayAeroCrossed(display, state.values);
                                    if (isCurrentPageIndex(i)) {
                                        markCenterActivity(true);
                                    }
                                }
                            },
                        );
                    }
                }
            }
        }
    }

    for (const [dataRef, subscription] of subscriptions.entries()) {
        const statsOptions: SubscribeDataRefOptions | undefined = verbose
            ? {
                stats: {
                    enabled: true,
                    label: dataRef,
                },
            }
            : undefined;
        await xplane.subscribeDataRef(
            dataRef,
            subscription.freq,
            (v: number) => {
                for (let i = 0; i < subscription.handlers.length; i++) {
                    subscription.handlers[i](v);
                }
            },
            statsOptions,
        );
    }

    console.info(
        `x-plane unique datarefs: ${subscriptions.size}/${sourceRefs}`
        + " (unique/total references)",
    );
};

const runConnectSetup = async (generation: number): Promise<void> => {
    try {
        if (!initialized) {
            await initializePages();
            if (isStaleConnectGeneration(generation)) {
                return;
            }
            initialized = true;
        }

        await applyPageButtonColors();
        if (isStaleConnectGeneration(generation)) {
            return;
        }

        initKeySurfaces();
        startCenterRendering();
        await loadPage(getCurrentPage());
        if (isStaleConnectGeneration(generation)) {
            return;
        }
        startTouchReconcileLoop();
        clearConnectSetupRetryTimer();
    } catch (e) {
        if (isStaleConnectGeneration(generation)) {
            return;
        }
        console.error(`connect setup failed: ${getErrorMessage(e)} (retrying)`);
        stopTouchReconcileLoop();
        stopCenterRendering();
        pressedKey = null;
        resetActiveTouchState();
        scheduleConnectSetupRetry(generation);
    }
};

// Observe connect events
device!.on("connect", async () => {
    if (deviceOnline) {
        return;
    }
    deviceOnline = true;
    const generation = ++connectGeneration;
    console.info("connected");
    clearConnectSetupRetryTimer();
    await runConnectSetup(generation);
});

device!.on("disconnect", () => {
    if (!deviceOnline) {
        return;
    }
    deviceOnline = false;
    connectGeneration++;
    clearConnectSetupRetryTimer();
    console.info("disconnected");
    stopTouchReconcileLoop();
    stopCenterRendering();
    pressedKey = null;
    resetActiveTouchState();
});

const handleKnobEvent = async (id: string): Promise<KnobConfig | undefined> => {
    const page = getCurrentPage();
    const knobPosition = id.substring(4, 5);
    const sideCode = id.substring(5, 6);
    const pos = knobPosition === "T" ? 0 : knobPosition === "C" ? 1 : knobPosition === "B" ? 2 : null;
    const side = sideCode === "L" ? "left" : sideCode === "R" ? "right" : null;
    if (pos == null || side == null) {
        return;
    }
    const confs = side === "left" ? page.left : page.right;
    if (!confs) {
        return;
    }
    const mask = [false, false, false];
    mask[pos] = true;
    await drawSideKnobs(side, confs, mask);
    if (!highlighted.has(id)) {
        highlighted.add(id);
        setTimeout(() => {
            void drawSideKnobs(
                side,
                confs,
                [false, false, false],
            ).catch((e: unknown) => {
                console.error(`failed to clear knob highlight: ${getErrorMessage(e)}`);
            }).finally(() => {
                highlighted.delete(id);
            });
        }, 200);
    }
    return confs[pos];
};

const takeAction = (labeled: ActionOwner | undefined, type: ActionType, haptics: boolean): void => {
    const actionSpec = labeled?.[type];
    if (actionSpec == null) {
        return;
    }
    if (actionSpec.xplane_cmd != null) {
        void xplane.sendCommand(actionSpec.xplane_cmd);
    }
    if (haptics) {
        device!.vibrate(HAPTIC.REV_FASTEST);
    }
};

// React to button presses
device!.on("down", async ({ id }) => {
    if (isNumber(id)) {
        if (id >= pages.length) {
            return;
        }
        console.info(`switch to page: ${id}`);
        currentPage = id;
        await loadPage(getCurrentPage());
    } else {
        takeAction(await handleKnobEvent(id), "pressed", false);
    }
});

// React to knob turns
device!.on("rotate", async ({ id, delta }) => {
    takeAction(await handleKnobEvent(id), delta > 0 ? "inc" : "dec", false);
});

const getTouchById = (touches: TouchEvent[] | undefined, id: number): TouchEvent | undefined => {
    if (!Array.isArray(touches)) {
        return;
    }
    return touches.find((touch) => touch.id === id);
};

const getPrimaryTouchWithKey = (touches: TouchEvent[] | undefined): TouchEvent | undefined => {
    if (!Array.isArray(touches)) {
        return;
    }
    let selected: TouchEvent | undefined;
    let selectedId = Number.POSITIVE_INFINITY;
    for (let i = 0; i < touches.length; i++) {
        const touch = touches[i];
        if (!isNumber(touch.target.key) || !isNumber(touch.id)) {
            continue;
        }
        if (touch.id < selectedId) {
            selected = touch;
            selectedId = touch.id;
        }
    }
    return selected;
};

const getPrimaryTouchFromEvents = (
    touches: TouchEvent[] | undefined,
    changedTouches: TouchEvent[] | undefined,
): TouchEvent | undefined => {
    return getPrimaryTouchWithKey(changedTouches) || getPrimaryTouchWithKey(touches);
};

const clearPressedVisualState = (): void => {
    if (!isNumber(pressedKey)) {
        return;
    }
    pressedKey = null;
    markCenterActivity(true);
};

const releaseActiveTouch = async (): Promise<void> => {
    if (!isNumber(activeTouchKey)) {
        activeTouchDeadlineMs = null;
        return;
    }
    const keyId = activeTouchKey;
    const key = getKeyConf(keyId);
    if (key) {
        await drawKey(keyId, key, false);
    } else {
        clearPressedVisualState();
    }
    activeTouchKey = null;
    activeTouchDeadlineMs = null;
};

const resetActiveTouchState = (): void => {
    activeTouchId = null;
    activeTouchKey = null;
    activeTouchDeadlineMs = null;
};

let touchEventQueue: Promise<void> = Promise.resolve();
const queueTouchEvent = (eventName: string, task: () => Promise<void>): void => {
    touchEventQueue = touchEventQueue.then(task).catch((e: unknown) => {
        console.error(`touch ${eventName} failed: ${getErrorMessage(e)}`);
    });
};

const getDeviceTouches = (): TouchEvent[] => {
    if (!device) {
        return [];
    }
    return Object.values(device.touches || {}) as TouchEvent[];
};

const isActiveTouchExpired = (): boolean => {
    return isNumber(activeTouchDeadlineMs) && Date.now() >= activeTouchDeadlineMs;
};

const reconcileActiveTouchFromDeviceState = async (): Promise<void> => {
    if (!isNumber(activeTouchId)) {
        return;
    }
    if (isActiveTouchExpired()) {
        await clearActiveTouch();
        return;
    }
    const trackedTouch = getTouchById(getDeviceTouches(), activeTouchId);
    if (!trackedTouch) {
        await clearActiveTouch();
        return;
    }
    await updateActiveTouchKey(trackedTouch, false);
};

const stopTouchReconcileLoop = (): void => {
    if (!touchReconcileTimer) {
        return;
    }
    clearInterval(touchReconcileTimer);
    touchReconcileTimer = null;
};

const startTouchReconcileLoop = (): void => {
    stopTouchReconcileLoop();
    touchReconcileTimer = setInterval(() => {
        queueTouchEvent("reconcile", async () => {
            await reconcileActiveTouchFromDeviceState();
        });
    }, TOUCH_RECONCILE_INTERVAL_MS);
    touchReconcileTimer.unref?.();
};

const clearActiveTouch = async (): Promise<void> => {
    await releaseActiveTouch();
    clearPressedVisualState();
    resetActiveTouchState();
};

const acquireActiveTouch = async (touch: TouchEvent, triggerAction: boolean): Promise<void> => {
    if (!isNumber(touch.id)) {
        return;
    }
    activeTouchId = touch.id;
    activeTouchKey = null;
    activeTouchDeadlineMs = null;
    await updateActiveTouchKey(touch, triggerAction);
};

const isTouchTracked = (touches: TouchEvent[] | undefined, id: number | null): boolean => {
    return isNumber(id) && !!getTouchById(touches, id);
};

const resyncActiveTouch = async (
    touches: TouchEvent[] | undefined,
    changedTouches: TouchEvent[] | undefined,
): Promise<void> => {
    if (!isNumber(activeTouchId)) {
        return;
    }
    if (!isTouchTracked(changedTouches, activeTouchId) && !isTouchTracked(touches, activeTouchId)) {
        await clearActiveTouch();
    }
};

const updateActiveTouchKey = async (touch: TouchEvent, triggerAction: boolean): Promise<void> => {
    if (!isNumber(touch.target.key)) {
        await releaseActiveTouch();
        return;
    }
    const nextKey = touch.target.key;
    if (activeTouchKey === nextKey) {
        return;
    }

    await releaseActiveTouch();

    activeTouchKey = nextKey;
    activeTouchDeadlineMs = Date.now() + TOUCH_MAX_PRESS_MS;
    const key = getKeyConf(nextKey);
    if (key) {
        await drawKey(nextKey, key, true);
        if (triggerAction) {
            takeAction(key, "pressed", true);
        }
    }
};

device!.on("touchstart", ({ touches, changedTouches }) => {
    queueTouchEvent("start", async () => {
        await resyncActiveTouch(touches, changedTouches);
        const selectedTouch = getPrimaryTouchFromEvents(touches, changedTouches);
        if (isNumber(activeTouchId)) {
            if (!selectedTouch || !isNumber(selectedTouch.id) || selectedTouch.id === activeTouchId) {
                return;
            }
            await clearActiveTouch();
        }
        if (!selectedTouch) {
            return;
        }
        await acquireActiveTouch(selectedTouch, true);
    });
});

device!.on("touchmove", ({ touches, changedTouches }) => {
    queueTouchEvent("move", async () => {
        await resyncActiveTouch(touches, changedTouches);
        if (!isNumber(activeTouchId)) {
            const selectedTouch = getPrimaryTouchFromEvents(touches, changedTouches);
            if (selectedTouch) {
                await acquireActiveTouch(selectedTouch, true);
            }
            return;
        }

        const trackedTouch = getTouchById(touches, activeTouchId)
            || getTouchById(changedTouches, activeTouchId);
        if (trackedTouch) {
            await updateActiveTouchKey(trackedTouch, false);
            return;
        }
        await clearActiveTouch();
    });
});

device!.on("touchend", ({ touches, changedTouches }) => {
    queueTouchEvent("end", async () => {
        if (!isNumber(activeTouchId)) {
            return;
        }

        const trackedEndedTouch = getTouchById(changedTouches, activeTouchId);
        const trackedStillActive = getTouchById(touches, activeTouchId);
        if (!trackedEndedTouch && trackedStillActive) {
            return;
        }
        await clearActiveTouch();
    });
});

device!.on("touchcancel", () => {
    queueTouchEvent("cancel", async () => {
        if (!isNumber(activeTouchId)) {
            return;
        }
        await clearActiveTouch();
    });
});

process.on("SIGINT", async () => {
    clearConnectSetupRetryTimer();
    stopTouchReconcileLoop();
    stopCenterRendering();
    await device!.close();
    await xplane.close();
    process.exit();
});
