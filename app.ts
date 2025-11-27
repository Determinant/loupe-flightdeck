#!/usr/bin/env node

import { registerFont, CanvasRenderingContext2D, Canvas } from "canvas";
import yargs from "yargs/yargs";
import { Arguments } from "yargs";

const defaultFont = "B612"; // font.ttf uses the font from https://b612-font.com/
if (process.platform == "linux") {
    process.env.FONTCONFIG_FILE = import.meta.dirname;
    //console.warn(
    //    "node-canvas does not support directly using font file in Linux (see https://github.com/Automattic/node-canvas/issues/2097#issuecomment-1803950952), please copy ./ocr-a-ext.ttf in this folder to your local font folder (~/.fonts/) or install it system-wide.",
    //);
}
registerFont(`${import.meta.dirname}/font.ttf`, {
    family: defaultFont,
});

import { discover, HAPTIC, LoupedeckDevice } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { queue, QueueObject } from "async";
import { XPlane } from "./xplane.js";

const defaultTextSize = 18;

interface PageConfig {
    default?: number;
    keys?: KeyConfig[];
    left?: KnobConfig[];
    right?: KnobConfig[];
    color?: string;
}

interface KeyConfig {
    label?: string | string[];
    size?: number | number[];
    color_bg?: string | string[];
    color_fg?: string | string[];
    sep?: number;
    display?: DisplayConfig;
    pressed?: ActionSpec;
}

interface KnobConfig {
    label?: string | string[];
    size?: number | number[];
    color_bg?: string | string[];
    color_fg?: string | string[];
    sep?: number;
    pressed?: ActionSpec;
    inc?: ActionSpec;
    dec?: ActionSpec;
}

interface ActionSpec {
    xplane_cmd?: string;
}

interface DisplayConfig {
    type?: string;
    source?: SourceConfig[];
    freq?: number;
    min?: number;
    max?: number;
    stops?: StopConfig[];
    fmt?: string | string[];
    exp?: string | string[];
    size?: number | number[];
    color_fg?: string | string[];
    color_bg?: string | string[];
    label?: string | string[];
    navs?: Record<string, NavConfig>;
    pressed?: boolean;
}

interface SourceConfig {
    xplane_dataref?: string;
}

interface StopConfig {
    value_begin: number;
    value_end: number;
    color: string;
}

interface NavConfig {
    def: number;
    received: number;
    crs: number;
    fromto: number;
    next: string;
    color?: string;
}

interface TextStyles {
    font: string[];
    color_bg: (string | undefined)[];
    color_fg: (string | undefined)[];
}

interface RenderTask {
    key: number;
    func: (c: CanvasRenderingContext2D) => void;
}

interface TouchTarget {
    key?: number;
}

interface TouchEvent {
    target: TouchTarget;
}

interface DeviceEvent {
    id: string | number;
    delta?: number;
    changedTouches?: TouchEvent[];
    touches?: TouchEvent[];
}

const isNumber = (x: any): x is number => {
    return x != null && !isNaN(x);
};

const isObject = (obj: any): obj is Record<string, any> => {
    return obj != null && obj.constructor.name === "Object";
};

const deg2Rad = (x: number): number => (x / 180) * Math.PI;

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
const profile_file = args._[0] ? args._[0] : `${import.meta.dirname}/profile.yaml`;
const pages: PageConfig[] = parse(await readFile(profile_file, "utf8"));

// state of the controller
let currentPage =
    isObject(pages[0]) && pages[0].default != null ? pages[0].default : 0;
let pressed = new Set<number>();
let highlighted = new Set<string>();

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
        console.error(`${e}. retry in 5 secs`);
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

const getTextStyles = (conf: KeyConfig | KnobConfig | DisplayConfig): TextStyles => {
    // conf must be non-null
    let font: string[] = [];
    let color_bg: (string | undefined)[] = [];
    let color_fg: (string | undefined)[] = [];

    if (isObject(conf)) {
        const size = Array.isArray(conf.size) ? conf.size : [conf.size];
        color_bg = Array.isArray(conf.color_bg)
            ? conf.color_bg
            : [conf.color_bg];
        color_fg = Array.isArray(conf.color_fg)
            ? conf.color_fg
            : [conf.color_fg];
        for (let i = 0; i < size.length; i++) {
            font.push(
                `${size[i] ? size[i] : defaultTextSize}px '${defaultFont}'`,
            );
        }
    } else {
        font.push(`${defaultTextSize}px '${defaultFont}'`);
    }
    return {
        font,
        color_bg,
        color_fg,
    };
};

const getLabels = (conf: KeyConfig | KnobConfig | DisplayConfig | string): string[] => {
    let text: string[];
    if (isObject(conf)) {
        text = Array.isArray(conf.label) ? conf.label : [conf.label || ""];
    } else {
        text = [conf.toString()];
    }
    return text;
};

const transformValues = (conf: DisplayConfig, values: (number | null)[]): (number | null)[] => {
    const f = (exp: string, v: number | null) => Function("$d", `"use strict"; return(${exp});`)(v);
    let last: string | undefined;
    const exps = Array.isArray(conf.exp) ? conf.exp : [conf.exp];
    let res: (number | null)[] = [];
    for (let i = 0; i < values.length; i++) {
        let exp = exps[i] || last;
        if (exp) {
            res[i] = f(exp, values[i]);
        } else {
            res[i] = values[i];
        }
        last = exp;
    }
    return res;
};

const formatValues = (conf: DisplayConfig, values_: (number | null)[], n = 1): { text: string[], values: (number | null)[] } => {
    const values = transformValues(conf, values_);
    const f = (fmt?: string) => {
        if (fmt) {
            return Function("$d", `"use strict"; return(\`${fmt}\`);`)(values);
        }
        if (!isNumber(values[0])) {
            return "X";
        }
        return values[0].toFixed(0).toString();
    };

    let last: string | undefined;
    let text: string[] = [];
    const formatter = Array.isArray(conf.fmt) ? conf.fmt : [conf.fmt];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] || last;
        text.push(f(fmt));
        last = fmt;
    }
    return { text, values };
};

const formatColors = (color_name: string, conf: DisplayConfig, values: (number | null)[], n = 1): string[] => {
    const f = (fmt?: string) => {
        if (fmt) {
            return Function("$d", `"use strict"; return(\`${fmt}\`);`)(values);
        }
        return "#fff";
    };

    let last: string | undefined;
    let color: string[] = [];
    const formatter = Array.isArray((conf as any)[color_name])
        ? (conf as any)[color_name]
        : [(conf as any)[color_name]];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] || last;
        color.push(f(fmt));
        last = fmt;
    }
    return color;
};

const renderMultiLineText = (c: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, text: string[], styles: TextStyles, conf: KeyConfig | KnobConfig | Record<string, any>) => {
    const { font, color_fg } = styles;
    c.save();
    let sep = conf.sep;
    if (sep == null) {
        c.font = font[0];
        const mx = c.measureText("x");
        sep = mx.actualBoundingBoxAscent - mx.actualBoundingBoxDescent;
    }
    let ms: TextMetrics[] = [];
    let totalHeight = 0;
    for (let i = 0; i < text.length; i++) {
        c.font = font[i];
        const m = c.measureText(text[i]) as any;
        ms.push(m);
        totalHeight += m.actualBoundingBoxAscent - m.actualBoundingBoxDescent;
    }
    totalHeight += (text.length - 1) * sep;
    let yBase = y0 + (h - totalHeight) / 2;
    for (let i = 0; i < text.length; i++) {
        const x =
            x0 +
            Math.max(
                0,
                w -
                (ms[i].actualBoundingBoxRight -
                    ms[i].actualBoundingBoxLeft),
            ) /
            2;
        const textHeight =
            ms[i].actualBoundingBoxAscent - ms[i].actualBoundingBoxDescent;
        const y = yBase + textHeight;
        c.font = font[i];
        c.fillStyle = color_fg[i] || "#fff";
        c.fillText(text[i], x, y);
        yBase += textHeight + sep;
    }
    c.restore();
};

const drawKey = async (id: number, conf: KeyConfig | null, pressed: boolean): Promise<void> => {
    if (conf && isObject(conf.display)) {
        // not an input, but a display gauge
        conf.display.pressed = pressed;
        return;
    }

    await device!.drawKey(id, (c: any) => {
        const padding = 10;
        const bg = pressed ? "white" : "black";
        const fg = pressed ? "black" : "white";
        const w = c.canvas.width;
        const h = c.canvas.height;

        // draw background
        c.fillStyle = bg;
        c.fillRect(0, 0, w, h);
        c.fillStyle = fg;
        c.lineWidth = 2;
        c.strokeStyle = fg;
        c.strokeRect(padding, padding, w - padding * 2, h - padding * 2);
        if (conf != null) {
            const labels = getLabels(conf);
            const styles = getTextStyles(conf);
            for (let i = 0; i < labels.length; i++) {
                styles.color_fg[i] = fg;
            }
            renderMultiLineText(c, 0, 0, w, h, labels, styles, conf);
        }
        // otherwise the empty key style is still drawn
    });
};

const drawSideKnobs = async (side: "left" | "right", confs: KnobConfig[] | undefined, highlight?: boolean[]): Promise<void> => {
    await device!.drawScreen(side, (c: any) => {
        const page = getCurrentPage();
        const light = page.color != null ? page.color : "white";
        if (!highlight) {
            highlight = [false, false, false];
        }
        for (let i = 0; i < 3; i++) {
            const hl = highlight[i];
            const y_offset = (i * c.canvas.height) / 3;
            const x_padding = 8;
            const y_padding = 3;
            const bg = hl ? light : "black";
            const fg = hl ? "black" : light;
            const w = c.canvas.width;
            const h = c.canvas.height / 3;
            // draw background
            c.fillStyle = bg;
            c.fillRect(0, y_offset, w, h);
            c.fillStyle = fg;
            c.lineWidth = 2;
            c.strokeStyle = fg;
            c.strokeRect(
                x_padding,
                y_padding + y_offset,
                w - x_padding * 2,
                h - y_padding * 2,
            );
            if (Array.isArray(confs) && confs.length > i && confs[i] != null) {
                const { font, color_bg } = getTextStyles(confs[i]);
                const text = getLabels(confs[i]);
                if (color_bg[0]) {
                    c.fillStyle = color_bg[0];
                    c.fillRect(
                        x_padding + 2,
                        y_padding + y_offset + 2,
                        w - x_padding * 2 - 2,
                        h - y_padding * 2 - 2,
                    );
                }
                c.translate(w, y_offset);
                c.rotate(Math.PI / 2);
                renderMultiLineText(
                    c,
                    0,
                    0,
                    h,
                    w,
                    text,
                    { font, color_fg: [fg], color_bg: [] },
                    confs[i],
                );
                c.resetTransform();
            }
        }
    });
};

const renderTextGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values_: (number | null)[]): void => {
    const bg = "black";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const { text, values } = formatValues(display, values_, display.fmt ? (Array.isArray(display.fmt) ? display.fmt.length : 1) : 1);

    // TODO: cache this
    const styles = getTextStyles({
        size: display.size,
        color_fg: formatColors("color_fg", display, values, values.length),
    });
    renderMultiLineText(c, 0, 0, w, h, text, { ...styles, color_bg: [] }, {});
};

const renderMeterGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { min, max, stops } = display || {};

    if (min == null) {
        return;
    }

    let reading = (Math.max(values[0] || 0, min) - min) / (max || 0 - min);
    if (!isNumber(reading)) {
        reading = min;
    }

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = fg;
    c.lineWidth = 1;

    const x0 = w / 2;
    const y0 = h / 2 + 5;
    const outer = 40;
    const width = 5;
    const inner = outer - width;

    // draw each arc segments
    if (stops) {
        for (let i = 0; i < stops.length; i++) {
            const theta0 =
                Math.PI * (1 + (stops[i].value_begin - min) / ((max || 0) - min)) + 0.05;
            const theta1 = Math.PI * (1 + (stops[i].value_end - min) / ((max || 0) - min));

            c.beginPath();
            c.lineWidth = width;
            c.strokeStyle = stops[i].color;
            c.arc(x0, y0, outer - width / 2, theta0, theta1);
            c.stroke();

            c.beginPath();
            c.lineWidth = 2;
            const cos = Math.cos(theta1);
            const sin = Math.sin(theta1);
            c.moveTo(x0 + cos * (inner - 2), y0 + sin * (inner - 2));
            c.lineTo(x0 + cos * (outer + 2), y0 + sin * (outer + 2));
            c.stroke();
        }
    }

    // draw the needle
    c.strokeStyle = fg;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x0, y0);
    const theta = Math.PI * (1 + reading);
    c.lineTo(x0 + Math.cos(theta) * inner, y0 + Math.sin(theta) * inner);
    c.stroke();

    // show the value text
    const { text } = formatValues(display, values);
    const { font } = getTextStyles(display);
    c.font = font[0];
    c.fillStyle = fg;
    const m = c.measureText(text[0]);
    c.fillText(text[0], (w - m.width) / 2, h / 2 + 25);
};

const renderAttitudeIndicator = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const pitch = values[0] || 0;
    const roll = values[1] || 0;
    const slip = values[2] || 0;
    let src = isObject(display.navs) ? display.navs[values[3] || 0] : null;
    if (!isObject(src)) {
        src = null;
    }
    const cdi = src ? values[src.def] : null;
    const received = src ? values[src.received] : null;

    const x0 = w / 2;
    const y0 = h / 2;
    const longMark = [-10, 10];
    const shortMark = [-5, 5];
    const longSep = 18;
    const shortSep = longSep / 2;

    c.translate(x0, y0);
    c.save();
    c.rotate(deg2Rad(-roll));
    c.save();
    c.translate(0, (pitch / 10) * longSep);

    // draw horizon
    c.fillStyle = "#0077b6";
    c.fillRect(-w, -2 * h, 2 * w, 4 * h);
    c.fillStyle = "#99582a";
    c.fillRect(-w, 0, 2 * w, 4 * h);

    // draw pitch marks
    c.lineWidth = 1;
    c.strokeStyle = fg;
    c.beginPath();
    c.moveTo(-0.75 * w, 0);
    c.lineTo(0.75 * w, 0);
    c.fillStyle = fg;
    c.font = `10px ${defaultFont}`;
    const drawMark = (i: number) => {
        const y = longSep * i;
        const sign = i < 0 ? -1 : 1;
        c.fillText((sign * i * 10).toString(), longMark[0] - 15, y + 3);
        c.moveTo(longMark[0], y);
        c.lineTo(longMark[1], y);
        c.moveTo(shortMark[0], y - sign * shortSep);
        c.lineTo(shortMark[1], y - sign * shortSep);
    };
    for (let i = -6; i <= 6; i++) {
        if (i != 0) {
            drawMark(i);
        }
    }
    c.stroke();

    // draw bank angle arc
    c.restore();
    c.lineWidth = 1;
    c.strokeStyle = fg;
    c.beginPath();
    const bankR = 30;
    const theta0 = deg2Rad(-30);
    const t15 = deg2Rad(-15);
    const t10 = deg2Rad(-10);
    const bankTicks = [10, 5, 10, 5, 5, 5, 5, 5, 10, 5, 10];
    const bankSteps = [t15, t15, t10, t10, t10, t10, t10, t10, t15, t15];
    c.save();
    c.rotate(theta0);
    c.moveTo(bankR, 0);
    c.arc(0, 0, bankR, 0, deg2Rad(-120), true);
    for (let i = 0; i < bankTicks.length; i++) {
        c.moveTo(30, 0);
        c.lineTo(30 + bankTicks[i], 0);
        if (i < bankSteps.length) {
            c.rotate(bankSteps[i]);
        }
    }

    c.restore();
    c.stroke();
    c.beginPath();
    c.lineWidth = 2;
    c.moveTo(-3, -(bankR + 8));
    c.lineTo(0, -bankR);
    c.lineTo(3, -(bankR + 8));
    c.stroke();

    // draw center mark
    c.restore();
    c.lineWidth = 2;
    c.strokeStyle = "yellow";
    c.beginPath();
    c.moveTo(-30, 0);
    c.lineTo(-10, 0);
    c.lineTo(-10, 8);

    c.moveTo(30, 0);
    c.lineTo(10, 0);
    c.lineTo(10, 8);
    c.rect(-1, -1, 2, 2);

    c.moveTo(-3, -(bankR - 9));
    c.lineTo(0, -(bankR - 1));
    c.lineTo(3, -(bankR - 9));

    const slipD = -slip * 2;
    c.moveTo(-5 + slipD, -(bankR - 9));
    c.lineTo(5 + slipD, -(bankR - 9));
    c.stroke();

    // draw vertical deflection dots
    const pi2 = 2 * Math.PI;
    const vdefX = w - 10 - x0;
    const vdefR = 3;

    c.strokeStyle = "white";
    c.lineWidth = 1;
    c.beginPath();
    for (let i = -2; i <= 2; i++) {
        if (i != 0) {
            const vdefY = 13 * i;
            c.moveTo(vdefX + vdefR, vdefY);
            c.arc(vdefX, vdefY, vdefR, 0, pi2);
        }
    }
    c.stroke();

    if (isNumber(received) && received == 0) {
        // draw CDI diamond
        const cdiY = 13 * (cdi || 0);
        const cdiH = 7;
        const cdiW = 4;
        c.fillStyle = "#2dfe54";
        c.strokeStyle = "black";
        c.beginPath();
        c.moveTo(vdefX, cdiY + cdiH);
        c.lineTo(vdefX - cdiW, cdiY);
        c.lineTo(vdefX, cdiY - cdiH);
        c.lineTo(vdefX + cdiW, cdiY);
        c.stroke();
        c.fill();
    }
};

interface MechanicalNumber {
    digits: number[];
    scroll: number[];
    low10: number;
    lowDigits: number;
}

const mechanicalStyleNumber = (value: number, lowDigitStep = 1): MechanicalNumber => {
    const split = (x: number) => {
        const int = Math.trunc(x);
        const float = parseFloat((x - int).toFixed(2));
        return { int, float };
    };

    // first handle the lowest bundle of digits
    const lowDigits = Math.trunc(Math.log10(lowDigitStep)) + 1;
    const low10 = Math.pow(10, lowDigits);
    const lowMax = (low10 - lowDigitStep) / lowDigitStep;
    let t = split((value % low10) / lowDigitStep);
    let digits = [t.int];
    let scroll = [t.float];
    // remove the lowest bundle of digits
    let i = 0;
    value /= low10;
    while (true) {
        t = split(value % 10);
        if (value < 1) {
            if (value > 0.99) {
                scroll.push(scroll[i]);
                digits.push(0);
            }
            break;
        }
        if (
            ((i > 0 && digits[i] == 9) || (i == 0 && digits[i] == lowMax)) &&
            scroll[i] > 0
        ) {
            scroll.push(scroll[i]);
        } else {
            scroll.push(0);
        }
        digits.push(t.int);
        i += 1;
        value /= 10;
    }
    return { digits, scroll, low10, lowDigits };
};

const renderMechanicalDisplay = (
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    value: number | null,
    padding = 20,
    right = true,
    wideWinWidth = 2,
    lowDigitStep = 1,
    size = defaultTextSize,
): void => {
    const bg = "black";
    const fg = "white";

    c.save();
    c.font = `${size}px '${defaultFont}'`;
    const m = c.measureText("x");
    const y0 =
        h / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    let digitH = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * 2;
    let digitW = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) * 1.2;
    const sign = right ? -1 : 1;
    let x = (right ? w : 0) + sign * padding;

    c.strokeStyle = bg;
    const narrowWinY = y0 - digitH * 0.95;
    const narrowWinH = digitH * 1.25;
    const wideWinX = x + sign * (wideWinWidth + (right ? -1 : 0)) * digitW;
    const wideWinY = y0 - digitH * 1.5;
    const wideWinW = wideWinWidth * digitW;
    const wideWinH = digitH * 2.25;
    c.fillStyle = bg;
    c.fillRect(0, narrowWinY, w, narrowWinH);
    c.fillRect(wideWinX, wideWinY, wideWinW, wideWinH);

    c.rect(0, narrowWinY, w, narrowWinH);
    c.rect(wideWinX, wideWinY, wideWinW, wideWinH);
    c.stroke();
    c.clip();
    c.strokeStyle = fg;
    c.fillStyle = fg;

    if (!isNumber(value)) {
        c.beginPath();
        const y0 = narrowWinY;
        const y1 = narrowWinY + narrowWinH;
        c.moveTo(0, y0);
        c.lineTo(w, y1);
        c.moveTo(0, y1);
        c.lineTo(w, y0);
        c.stroke();
        c.restore();
        return;
    }

    let { digits, scroll, low10, lowDigits } = mechanicalStyleNumber(
        value,
        lowDigitStep,
    );
    const formatLowDigits = (x: number) => x.toFixed(0).padStart(lowDigits, "0");
    x -= (lowDigits - 1) * 12;
    for (let i = 0; i < digits.length; i++) {
        const p = right ? i : digits.length - i - 1;
        const y = y0 + scroll[p] * digitH;
        let d: string | number, m1: string | number, m2: string | number, p1: string | number;
        if (p == 0) {
            let dNum = digits[p] * lowDigitStep;
            let m1Num = (dNum == 0 ? low10 : dNum) - lowDigitStep;
            let m2Num = (m1Num == 0 ? low10 : dNum) - lowDigitStep;
            let p1Num = dNum + lowDigitStep;
            if (p1Num >= low10) {
                p1Num -= low10;
            }
            let p2Num = p1Num + lowDigitStep;
            if (p2Num >= low10) {
                p2Num -= low10;
            }
            d = formatLowDigits(dNum);
            m1 = formatLowDigits(m1Num);
            m2 = formatLowDigits(m2Num);
            p1 = formatLowDigits(p1Num);
            let p2 = formatLowDigits(p2Num);
            c.fillText(p2, x, y - digitH * 2);
        } else {
            d = digits[p];
            m1 = d == 0 ? 9 : d - 1;
            m2 = m1 == 0 ? 9 : m1 - 1;
            p1 = d == 9 ? 0 : d + 1;
        }
        c.fillText(d.toString(), x, y);
        c.fillText(m1.toString(), x, y + digitH);
        c.fillText(m2.toString(), x, y + digitH * 2);
        c.fillText(p1.toString(), x, y - digitH);
        x += sign * digitW;
    }
    c.restore();
};

const renderIAS = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "#555";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const ias = Math.max(values[0] || 0, 0);
    renderMechanicalDisplay(c, w, h, ias, 20, true, 1);
};

const renderAltimeter = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "#555";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    renderMechanicalDisplay(c, w * 0.6, h, values[0], 5, true, 2, 20, defaultTextSize * 0.8);

    // draw floating vsi window
    const vs = values[1];
    const vsiBgX = w * 0.6 + 2;
    c.fillRect(vsiBgX, 0, w - vsiBgX, h);
    c.fillStyle = "#000";
    const vsiH = 20;
    const vsiX = vsiBgX + 2;
    const vsiY =
        (1 -
            (Math.min(Math.max(isNumber(vs) ? vs : 0, -4000), 4000) + 4000) /
            8000) *
        (h - vsiH);
    c.fillRect(vsiX, vsiY, w - vsiX, vsiH);
    c.fillStyle = fg;
    if (isNumber(vs)) {
        c.font = `8px '${defaultFont}'`;
        c.fillText((Math.trunc(vs / 10) * 10).toString(), vsiX + 2, vsiY + vsiH * 0.8);
    }
    const altB = values[2];
    if (isNumber(altB)) {
        c.fillStyle = "cyan";
        c.font = `12px '${defaultFont}'`;
        c.fillText(altB.toString(), 15, 18);
    }
};

const renderHSI = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const x0 = w / 2;
    const y0 = h / 2;
    const r = w / 2 - 5;
    const f1 = 0.8;
    const f2 = 0.9;
    const cdiR = 0.4 * r;
    const vdefR = 3;

    const hdg = deg2Rad(values[0] || 0);
    const hdgB = values[1] ? deg2Rad(values[1]) : null;
    let src = isObject(display.navs) && values[2] != null ? display.navs[values[2]] : null;
    if (!isObject(src)) {
        src = null;
    }
    if (display.pressed && src) {
        display.pressed = false;
        xplane.sendCommand(src.next.toString());
    }
    const crs = src ? deg2Rad(values[src.crs] || 0) : null;
    const fromto = src ? values[src.fromto] : null;
    let def = src ? Math.min(Math.max(values[src.def] || 0, -3), 3) : null;
    if (!isNumber(def)) {
        def = 0;
    }
    const received = src ? values[src.received] : null;
    const polarXY = (theta: number, r: number) => {
        const t = -theta - Math.PI / 2;
        const dx = r * Math.cos(t);
        const dy = -r * Math.sin(t);
        return { dx, dy };
    };
    const pi2 = Math.PI * 2;

    c.translate(x0, y0);
    c.rotate(-hdg);
    c.strokeStyle = fg;
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < 36; i++) {
        const { dx, dy } = polarXY(deg2Rad(i * 10), r);
        const f = (i & 1) == 0 ? f1 : f2;
        c.moveTo(dx, dy);
        c.lineTo(dx * f, dy * f);
    }

    c.fillStyle = fg;
    c.font = `16px '${defaultFont}'`;
    c.fillText("N", -5, -0.5 * r);
    c.stroke();

    if (crs != null) {
        c.rotate(crs);

        for (let i = -2; i <= 2; i++) {
            const r = i == 0 ? 1 : vdefR;
            const x = 13 * i;
            c.moveTo(x + r, 0);
            c.arc(x, 0, r, 0, pi2);
        }
        c.stroke();

        c.beginPath();
        c.lineWidth = 3;
        c.strokeStyle = src?.color ? src.color : "magenta";

        if (isNumber(received) && received != 0) {
            // draw CDI needle
            const cdiX = 13 * def;
            c.moveTo(cdiX, -(cdiR - 1));
            c.lineTo(cdiX, cdiR - 1);
        }

        c.moveTo(0, -r);
        c.lineTo(0, -(cdiR + 1));

        // crs arrowhead
        let y0 = -f1 * r;
        let y1 = 0.8 * y0;
        c.moveTo(0, y0);
        c.lineTo(-5, y1);
        c.lineTo(5, y1);
        c.lineTo(0, y0);

        c.moveTo(0, r);
        c.lineTo(0, cdiR + 1);

        // from/to arrowhead
        if (fromto) {
            let y0 = -cdiR;
            let y1 = 0.4 * y0;
            if (fromto != 1) {
                y0 = -y0;
                y1 = -y1;
            }
            c.moveTo(0, y0);
            c.lineTo(-5, y1);
            c.lineTo(5, y1);
            c.lineTo(0, y0);
        }

        c.rotate(-crs);
    }

    if (hdgB !== null && isNumber(hdgB)) {
        const bugW = 4;
        const bugY1 = -(r - 5);
        const bugY0 = -(r - 8);
        c.stroke();
        c.rotate(hdgB);
        c.lineWidth = 1;
        c.strokeStyle = "white";
        c.fillStyle = "cyan";
        c.beginPath();
        c.moveTo(0, bugY1);
        c.lineTo(-bugW, -(r + 1));
        c.lineTo(-bugW, bugY0);
        c.lineTo(bugW, bugY0);
        c.lineTo(bugW, -(r + 1));
        c.lineTo(0, bugY1);
        c.fill();
    }

    c.stroke();
};

const renderBarGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values_: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const slotWidth = 10;
    const slotHeight = 60;
    const barWidth = slotWidth * 0.6;

    const { text, values } = formatValues(display, values_, display.fmt ? (Array.isArray(display.fmt) ? display.fmt.length : 1) : 1);
    const label = getLabels(display);
    // TODO: cache this
    const { font, color_fg } = getTextStyles({
        size: display.size,
        color_fg: formatColors("color_fg", display, values, values.length),
    });

    c.rotate(Math.PI / 2);

    let y = -(w - (slotWidth + 10) * text.length) / 2;
    let x = (h - slotHeight) / 2;
    c.strokeStyle = fg;
    for (let i = 0; i < text.length; i++) {
        c.lineWidth = 1;
        c.strokeRect(x, y - barWidth, slotHeight, barWidth);
        const r = Math.max(Math.min(values[i] || 0, 1), 0);
        c.fillStyle = color_fg[i] || fg;
        const xx = x + slotHeight * (1 - r);
        c.fillRect(xx + 1, y - barWidth + 1, slotHeight * r - 1, barWidth - 1);
        c.lineWidth = 2;
        c.moveTo(xx + 1, y + 2);
        c.lineTo(xx + 1, y - barWidth - 2);
        c.stroke();
        c.fillStyle = fg;
        c.font = font[i];
        const t = `${label[i]} ${text[i]}`;
        c.fillText(t, x, y - slotWidth + 2);
        y -= slotWidth + 10;
    }
};

const drawGauge = (key: number, label: KeyConfig, values: (number | null)[]): void => {
    const types: Record<string, (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]) => void> = {
        meter: renderMeterGauge,
        text: renderTextGauge,
        bar: renderBarGauge,
        attitude: renderAttitudeIndicator,
        ias: renderIAS,
        alt: renderAltimeter,
        hsi: renderHSI,
    };
    const display = label.display;
    if (!display || display.type == null) {
        return;
    }
    if (types[display.type]) {
        renderTasks.push({
            key,
            func: (c) => types[display.type!](c, display, values),
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

const clearStaleButton = async (touches: TouchEvent[]): Promise<void> => {
    const s = new Set(
        touches.map((o) => o.target.key).filter((k) => k !== undefined),
    );
    for (const id of pressed.keys()) {
        if (!s.has(id)) {
            const conf = getKeyConf(id);
            if (conf != null) {
                await drawKey(id, conf, false);
            }
            pressed.delete(id);
        }
    }
};

device!.on("touchstart", async ({ changedTouches }) => {
    if (!changedTouches) return;
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return;
    }
    pressed.add(target.key);
    const key = getKeyConf(target.key);
    if (key) {
        await drawKey(target.key, key, true);
        takeAction(key as any, "pressed", true);
    }
});

device!.on("touchmove", ({ changedTouches }) => {
    if (!changedTouches) return;
    clearStaleButton(changedTouches);
});

device!.on("touchend", async ({ changedTouches }) => {
    if (!changedTouches) return;
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return;
    }
    pressed.delete(target.key);
    const key = getKeyConf(target.key);
    if (key) {
        await drawKey(target.key, key, false);
    }
});

process.on("SIGINT", async () => {
    await resetRendering();
    await device!.close();
    await xplane.close();
    process.exit();
});
