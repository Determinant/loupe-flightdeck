#!/usr/bin/env node

import { registerFont, CanvasRenderingContext2D } from "canvas";
import { queue, QueueObject } from "async";
import { readFile } from "fs/promises";
import { discover, HAPTIC, LoupedeckDevice } from "loupedeck";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import yargs from "yargs/yargs";
import { Arguments } from "yargs";
import { KeyConfig, KnobConfig, PageConfig } from "./config.js";
import {
    defaultFont,
    getGaugeRenderers,
    renderKey,
    renderSideKnobs,
} from "./graphics.js";
import { XPlane } from "./xplane.js";

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

interface RenderTask {
    key: number;
    func: (c: CanvasRenderingContext2D) => void;
}

interface TouchTarget {
    key?: number;
}

interface TouchEvent {
    id?: number;
    target: TouchTarget;
}

const isNumber = (x: any): x is number => {
    return x != null && !isNaN(x);
};

const isObject = (obj: any): obj is Record<string, any> => {
    return obj != null && obj.constructor.name === "Object";
};

const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
};

const isDeviceNotDetectedError = (err: unknown): boolean => {
    const msg = getErrorMessage(err).toLowerCase();
    return (
        msg.includes("no devices found")
        || msg.includes("no device found")
        || msg.includes("device not found")
    );
};

interface AppArgs {
    'xplane-port': number;
    'xplane-host': string;
    _: string[];
}

const args = yargs(process.argv.slice(2))
    .usage("./app.mjs [--xplane-host <host>] [--xplane-port <port>] [profile YAML file]")
    .options({
        'xplane-port': { default: 49000, type: 'number' },
        'xplane-host': { default: "localhost", type: 'string' },
    }).parse() as Arguments<AppArgs>;
const xplanePort = isNumber(args['xplane-port']) ? args['xplane-port'] : 49000;
const xplaneHost = args['xplane-host'];
const profile_file = args._[0] ? args._[0] : fileURLToPath(new URL("../profile.yaml", import.meta.url));
const pages: PageConfig[] = parse(await readFile(profile_file, "utf8"));

// state of the controller
let currentPage =
    isObject(pages[0]) && pages[0].default != null ? pages[0].default : 0;
let highlighted = new Set<string>();
let activeTouchId: number | null = null;
let activeTouchKey: number | null = null;

// detects and opens first connected device
let device: LoupedeckDevice | undefined;

// Render related variables
let renderStop: (() => void)[] = [];
let renderTasks: QueueObject<RenderTask>;

const xplane = new XPlane(xplaneHost, xplanePort);
console.log(`Connecting to X-Plane at ${xplaneHost}:${xplanePort}`);

while (!device) {
    try {
        device = await discover();
    } catch (e) {
        if (!isDeviceNotDetectedError(e)) {
            console.error(`${getErrorMessage(e)}. retry in 5 secs`);
        }
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

const drawKey = async (id: number, conf: KeyConfig | null, pressed: boolean): Promise<void> => {
    if (conf && isObject(conf.display)) {
        // not an input, but a display gauge
        conf.display.pressed = pressed;
        return;
    }

    await device!.drawKey(id, (c: CanvasRenderingContext2D) => renderKey(c, conf, pressed));
};

const drawSideKnobs = async (side: "left" | "right", confs: KnobConfig[] | undefined, highlight?: boolean[]): Promise<void> => {
    await device!.drawScreen(side, (c: any) => {
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

const drawGauge = (key: number, label: KeyConfig, values: (number | null)[]): void => {
    const display = label.display;
    if (!display || display.type == null) {
        return;
    }
    const renderer = gaugeRenderers[display.type];
    if (renderer) {
        renderTasks.push({
            key,
            func: (c) => renderer(c, display, values),
        });
    }
};

const resetRendering = async (): Promise<void> => {
    for (let i = 0; i < renderStop.length; i++) {
        renderStop[i]();
    }
    renderStop = [];
    if (renderTasks) {
        await renderTasks.pause();
    }
    renderTasks = queue(async (e: RenderTask) => {
        const { key, func } = e;
        await device!.drawKey(key, func);
    });
};

const loadPage = async (page: PageConfig): Promise<void> => {
    await resetRendering();
    // page is not null
    const { left, right, keys } = page;
    let pms: Promise<void>[] = [];
    pms.push(drawSideKnobs("left", left as KnobConfig[]));
    pms.push(drawSideKnobs("right", right as KnobConfig[]));
    for (let i = 0; i < 12; i++) {
        const conf = Array.isArray(keys) && keys.length > i ? keys[i] : null;
        pms.push(drawKey(i, conf, false));
        if (isObject(conf) && conf.display != null) {
            (conf as any).renderStart();
        }
    }
    await Promise.all(pms);
};

// Observe connect events
device!.on("connect", async () => {
    console.info("connected");
    /*
    for (let i = 3600; i > 1000; i -= 0.1) {
        await device.drawKey(0, (c) => {
            renderAltimeter(c, null, [i, 500]);
        });
        await new Promise((res) => setTimeout(res, 10));
    }
    */
    for (let i = 0; i < pages.length; i++) {
        const page = pages[i] || {};
        const keys = page.keys;
        const color =
            isObject(page) && page.color != null ? page.color : "white";
        await device!.setButtonColor({ id: i, color });
        // subscribe the data feeds
        for (let j = 0; j < 12; j++) {
            const conf =
                Array.isArray(keys) && keys.length > j ? keys[j] : null;
            if (
                isObject(conf) &&
                conf.display != null &&
                Array.isArray(conf.display.source)
            ) {
                let values: (number | null)[] = [];
                //conf.fps = 0;
                for (let k = 0; k < conf.display.source.length; k++) {
                    values.push(null);
                }
                const freq = isNumber(conf.display.freq)
                    ? conf.display.freq
                    : 1;

                const msPerFrame = 1000 / freq;
                conf.display.pressed = false;
                (conf as any).renderStart = () => {
                    let enabled = true;
                    let startTime = new Date();
                    let timeout: NodeJS.Timeout;
                    function draw() {
                        if (!enabled) {
                            return;
                        }
                        drawGauge(j, conf!, values);
                        //conf.fps++;
                        let frameTime = msPerFrame;
                        const elapsedTime = new Date().getTime() - startTime.getTime();
                        if (elapsedTime > 1000) {
                            startTime = new Date();
                            (conf as any).fps = 0;
                        } else if (elapsedTime + frameTime > 1000) {
                            frameTime = 1000 - elapsedTime;
                        }
                        timeout = setTimeout(draw, frameTime);
                    }
                    draw();
                    renderStop.push(() => {
                        enabled = false;
                        clearTimeout(timeout);
                    });
                };

                for (let k = 0; k < conf.display.source.length; k++) {
                    const source = conf.display.source[k];
                    const xplane_dataref = source.xplane_dataref;
                    if (xplane_dataref != null) {
                        await xplane.subscribeDataRef(
                            xplane_dataref,
                            freq,
                            async (v: number) => (values[k] = v),
                        );
                    }
                }
            }
        }
    }
    await loadPage(getCurrentPage());
});

const handleKnobEvent = async (id: string): Promise<KnobConfig | undefined> => {
    const { left, right } = getCurrentPage();
    let pos = { T: 0, C: 1, B: 2 }[id.substring(4, 5) as 'T' | 'C' | 'B'];
    let side = { L: ["left", left], R: ["right", right] }[id.substring(5, 6) as 'L' | 'R'];
    if (!side || (side[0] == "left" && !left) || (side[0] == "right" && !right)) {
        return;
    }
    let mask = [false, false, false];
    mask[pos] = true;
    await drawSideKnobs(side[0] as "left" | "right", side[1] as KnobConfig[], mask);
    if (!highlighted.has(id)) {
        highlighted.add(id);
        setTimeout(() => {
            drawSideKnobs(side[0] as "left" | "right", side[1] as KnobConfig[], [false, false, false]);
            highlighted.delete(id);
        }, 200);
    }
    return (side[1] as KnobConfig[]) ? (side[1] as KnobConfig[])[pos] : undefined;
};

const takeAction = (labeled: KnobConfig | undefined, type: string, haptics: boolean): void => {
    if (!isObject(labeled)) {
        return;
    }
    let actionSpec = (labeled as any)[type];
    if (actionSpec == null) {
        return;
    }
    if (actionSpec.xplane_cmd != null) {
        xplane.sendCommand(actionSpec.xplane_cmd);
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
        takeAction(await handleKnobEvent(id as string), "pressed", false);
    }
});

// React to knob turns
device!.on("rotate", async ({ id, delta }) => {
    takeAction(await handleKnobEvent(id as string), (delta || 0) > 0 ? "inc" : "dec", false);
});

const getTouchById = (touches: TouchEvent[] | undefined, id: number): TouchEvent | undefined => {
    if (!Array.isArray(touches)) {
        return;
    }
    return touches.find((touch) => touch.id === id);
};

const getFirstTouchWithKey = (touches: TouchEvent[] | undefined): TouchEvent | undefined => {
    if (!Array.isArray(touches)) {
        return;
    }
    return touches.find((touch) => isNumber(touch.target.key));
};

const releaseActiveTouch = async (): Promise<void> => {
    if (!isNumber(activeTouchKey)) {
        return;
    }
    const key = getKeyConf(activeTouchKey);
    if (key) {
        await drawKey(activeTouchKey, key, false);
    }
    activeTouchKey = null;
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
    const key = getKeyConf(nextKey);
    if (key) {
        await drawKey(nextKey, key, true);
        if (triggerAction) {
            takeAction(key as any, "pressed", true);
        }
    }
};

device!.on("touchstart", async ({ touches, changedTouches }) => {
    if (isNumber(activeTouchId)) {
        return;
    }

    const selectedTouch = getFirstTouchWithKey(touches) || getFirstTouchWithKey(changedTouches);
    if (!selectedTouch || !isNumber(selectedTouch.id)) {
        return;
    }

    activeTouchId = selectedTouch.id;
    await updateActiveTouchKey(selectedTouch, true);
});

device!.on("touchmove", async ({ touches, changedTouches }) => {
    if (!isNumber(activeTouchId)) {
        return;
    }
    const trackedTouch = getTouchById(touches, activeTouchId) || getTouchById(changedTouches, activeTouchId);
    if (!trackedTouch) {
        return;
    }
    await updateActiveTouchKey(trackedTouch, false);
});

device!.on("touchend", async ({ changedTouches }) => {
    if (!isNumber(activeTouchId)) {
        return;
    }
    const endedTouch = getTouchById(changedTouches, activeTouchId);
    if (!endedTouch) {
        return;
    }

    await releaseActiveTouch();
    activeTouchId = null;
});

process.on("SIGINT", async () => {
    await resetRendering();
    await device!.close();
    await xplane.close();
    process.exit();
});
