#!/usr/bin/env node

import { registerFont } from "canvas";
if (process.platform == "linux") {
    console.warn(
        "node-canvas does not support directly using font file in Linux (see https://github.com/Automattic/node-canvas/issues/2097#issuecomment-1803950952), please copy ./ocr-a-ext.ttf in this folder to your local font folder (~/.fonts/) or install it system-wide.",
    );
} else {
    registerFont(`${import.meta.dirname}/ocr-a-ext.ttf`, {
        family: "OCR A Extended",
    });
}

import { discover, HAPTIC } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { queue } from "async";
import { XPlane } from "./xplane.mjs";

const defaultFont = "OCR A Extended";
const defaultTextSize = 22;
const xplane = new XPlane();

if (process.argv.length > 3) {
    console.error("./app.mjs [profile YAML file]");
}
const profile_file = process.argv[2];
const pages = parse(
    await readFile(
        profile_file ? profile_file : `${import.meta.dirname}/profile.yaml`,
        "utf8",
    ),
);

const isNumber = (x) => {
    return x != null && !isNaN(x);
};

const isObject = (obj) => {
    return obj != null && obj.constructor.name === "Object";
};

const deg2Rad = (x) => (x / 180) * Math.PI;

// state of the controller
let currentPage =
    isObject(pages[0]) && pages[0].default != null ? pages[0].default : 0;
let pressed = new Set();
let highlighted = new Set();

// detects and opens first connected device
let device;

// Render related variables
let renderStop = [];
let renderTasks;

while (!device) {
    try {
        device = await discover();
    } catch (e) {
        console.error(`${e}. retry in 5 secs`);
        await new Promise((res) => setTimeout(res, 5000));
    }
}

const getCurrentPage = () => {
    return pages[currentPage] || {};
};

const getKeyConf = (i) => {
    const keys = getCurrentPage().keys;
    if (keys == null) {
        return null;
    }
    if (Array.isArray(keys) && i < keys.length) {
        return keys[i];
    }
    return null;
};

const getTextStyles = (conf) => {
    // conf must be non-null
    let font = [];
    let color_bg = [];
    let color_fg = [];

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

const getLabels = (conf) => {
    let text;
    if (isObject(conf)) {
        text = Array.isArray(conf.label) ? conf.label : [conf.label];
    } else {
        text = [conf.toString()];
    }
    return text;
};

const transformValues = (conf, values) => {
    const f = (exp, v) => Function("$d", `"use strict"; return(${exp});`)(v);
    let last;
    const exps = Array.isArray(conf.exp) ? conf.exp : [conf.exp];
    let res = [];
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

const formatValues = (conf, values_, n = 1) => {
    const values = transformValues(conf, values_);
    const f = (fmt) => {
        if (fmt) {
            return Function("$d", `"use strict"; return(\`${fmt}\`);`)(values);
        }
        if (!isNumber(values[0])) {
            return "X";
        }
        return values[0].toFixed(0).toString();
    };

    let last;
    let text = [];
    const formatter = Array.isArray(conf.fmt) ? conf.fmt : [conf.fmt];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] || last;
        text.push(f(fmt));
        last = fmt;
    }
    return { text, values };
};

const formatColors = (color_name, conf, values, n = 1) => {
    const f = (fmt) => {
        if (fmt) {
            return Function("$d", `"use strict"; return(\`${fmt}\`);`)(values);
        }
        return "#fff";
    };

    let last;
    let color = [];
    const formatter = Array.isArray(conf[color_name])
        ? conf[color_name]
        : [conf[color_name]];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] || last;
        color.push(f(fmt));
        last = fmt;
    }
    return color;
};

const renderMultiLineText = (c, x0, y0, w, h, text, styles, conf) => {
    const { font, color_fg } = styles;
    c.save();
    let sep = conf.sep;
    if (sep == null) {
        c.font = font[0];
        const mx = c.measureText("x");
        sep = mx.actualBoundingBoxAscent - mx.actualBoundingBoxDescent;
    }
    let ms = [];
    let totalHeight = 0;
    for (let i = 0; i < text.length; i++) {
        c.font = font[i];
        const m = c.measureText(text[i]);
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

const drawKey = async (id, conf, pressed) => {
    if (conf && conf.display != null) {
        // not an input, but a display gauge
        return;
    }

    await device.drawKey(id, (c) => {
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
            renderMultiLineText(
                c,
                0,
                0,
                w,
                h,
                getLabels(conf),
                getTextStyles(conf),
                conf,
            );
        }
        // otherwise the empty key style is still drawn
    });
};

const drawSideKnobs = async (side, confs, highlight) => {
    await device.drawScreen(side, (c) => {
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
                    { font, color_fg: [fg] },
                    confs[i],
                );
                c.resetTransform();
            }
        }
    });
};

const renderTextGauge = (c, display, values_) => {
    const bg = "black";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const { text, values } = formatValues(display, values_, display.fmt.length);

    // TODO: cache this
    const styles = getTextStyles({
        size: display.size,
        color_fg: formatColors("color_fg", display, values, values.length),
    });
    renderMultiLineText(c, 0, 0, w, h, text, styles, {});
};

const renderMeterGauge = (c, display, values) => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { min, max, stops } = display || {};

    if (min == null) {
        return;
    }

    let reading = (Math.max(values[0], min) - min) / (max - min);
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
    for (let i = 0; i < stops.length; i++) {
        const theta0 =
            Math.PI * (1 + (stops[i].value_begin - min) / (max - min)) + 0.05;
        const theta1 = Math.PI * (1 + (stops[i].value_end - min) / (max - min));

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
    const m = c.measureText(text);
    c.fillText(text, (w - m.width) / 2, h / 2 + 25);
};

const renderAttitudeIndicator = (c, display, values) => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const pitch = values[0] || 0;
    const roll = values[1] || 0;
    let src = isObject(display.navs) ? display.navs[values[2]] : null;
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
    const drawMark = (i) => {
        const y = longSep * i;
        const sign = i < 0 ? -1 : 1;
        c.fillText(sign * i * 10, longMark[0] - 15, y + 3);
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
        const cdiY = 13 * cdi;
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

const mechanicalStyleNumber = (value, lowDigitStep = 1) => {
    const split = (x) => {
        const int = Math.trunc(x);
        const float = (x - int).toFixed(2);
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
        if (
            ((i > 0 && digits[i] == 9) || (i == 0 && digits[i] == lowMax)) &&
            scroll[i] > 0
        ) {
            scroll.push(scroll[i]);
        } else {
            if (value < 1) {
                break;
            }
            scroll.push(0);
        }
        digits.push(t.int);
        i += 1;
        value /= 10;
    }
    return { digits, scroll, low10, lowDigits };
};

const renderMechanicalDisplay = (
    c,
    w,
    h,
    value,
    padding = 20,
    right = true,
    wideWinWidth = 2,
    lowDigitStep = 1,
    size = defaultTextSize,
) => {
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
    const formatLowDigits = (x) => x.toFixed(0).padStart(lowDigits, "0");
    for (let i = 0; i < digits.length; i++) {
        const p = right ? i : digits.length - i - 1;
        const y = y0 + scroll[p] * digitH;
        let d, m1, m2, p1;
        if (p == 0) {
            d = digits[p] * lowDigitStep;
            m1 = (d == 0 ? low10 : d) - lowDigitStep;
            m2 = (m1 == 0 ? low10 : d) - lowDigitStep;
            p1 = d + lowDigitStep;
            if (p1 >= low10) {
                p1 -= low10;
            }
            let p2 = p1 + lowDigitStep;
            if (p2 >= low10) {
                p2 -= low10;
            }
            d = formatLowDigits(d);
            m1 = formatLowDigits(m1);
            m2 = formatLowDigits(m2);
            p1 = formatLowDigits(p1);
            p2 = formatLowDigits(p2);
            c.fillText(p2, x, y - digitH * 2);
        } else {
            d = digits[p];
            m1 = d == 0 ? 9 : d - 1;
            m2 = m1 == 0 ? 9 : m1 - 1;
            p1 = d == 9 ? 0 : d + 1;
        }
        c.fillText(d, x, y);
        c.fillText(m1, x, y + digitH);
        c.fillText(m2, x, y + digitH * 2);
        c.fillText(p1, x, y - digitH);
        x += sign * digitW;
    }
    c.restore();
};

const renderIAS = (c, display, values) => {
    const bg = "#555";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    renderMechanicalDisplay(c, w, h, values[0], 20, true, 1);
};

const renderAltimeter = (c, display, values) => {
    const bg = "#555";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    renderMechanicalDisplay(c, w, h, values[0], 5, false, 2, 20, 18);

    // draw floating vsi window
    const vs = values[1];
    const vsiBgX = w / 2 + 4;
    c.fillRect(vsiBgX, 0, w - vsiBgX, h);
    c.fillStyle = "#000";
    const vsiH = 20;
    const vsiX = vsiBgX + 2;
    const vsiY =
        (1 -
            (Math.min(Math.max(isNumber(vs) ? vs : 0, -2000), 2000) + 2000) /
                4000) *
        (h - vsiH);
    c.fillRect(vsiX, vsiY, w - vsiX, vsiH);
    c.fillStyle = fg;
    if (isNumber(vs)) {
        c.font = `12px '${defaultFont}'`;
        c.fillText(Math.trunc(vs / 10) * 10, vsiX + 2, vsiY + vsiH * 0.8);
    }
    const altB = values[2];
    if (isNumber(altB)) {
        c.fillStyle = "cyan";
        c.font = `14px '${defaultFont}'`;
        c.fillText(altB, 15, 18);
    }
};

const renderHSI = (c, display, values) => {
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

    const hdg = deg2Rad(values[0]);
    const hdgB = deg2Rad(values[1]);
    let src = isObject(display.navs) ? display.navs[values[2]] : null;
    if (!isObject(src)) {
        src = null;
    }
    const crs = src ? deg2Rad(values[src.crs]) : null;
    let def = src ? Math.min(Math.max(values[src.def], -3), 3) : null;
    if (!isNumber(def)) {
        def = 0;
    }
    const received = src ? values[src.received] : null;
    const polarXY = (theta, r) => {
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
            if (i != 0) {
                const x = 13 * i;
                c.moveTo(x + vdefR, 0);
                c.arc(x, 0, vdefR, 0, pi2);
            }
        }
        c.stroke();

        c.beginPath();
        c.lineWidth = 3;
        c.strokeStyle = src.color ? src.color : "magenta";

        if (isNumber(received) && received != 0) {
            // draw CDI needle
            const cdiX = 13 * def;
            c.moveTo(cdiX, -(cdiR - 1));
            c.lineTo(cdiX, cdiR - 1);
        }

        c.moveTo(0, -r);
        c.lineTo(0, -(cdiR + 1));
        c.moveTo(0, -r);

        // crs arrowhead
        c.lineTo(-5, -0.8 * r);
        c.lineTo(5, -0.8 * r);
        c.lineTo(0, -r);

        c.moveTo(0, r);
        c.lineTo(0, cdiR + 1);

        c.rotate(-crs);
    }

    if (isNumber(hdgB)) {
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

const renderBarGauge = (c, display, values_) => {
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

    const { text, values } = formatValues(display, values_, display.fmt.length);
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
        const r = Math.max(Math.min(values[i], 1), 0);
        c.fillStyle = color_fg[i] ? color_fg[i] : fg;
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

const drawGauge = async (key, label, values) => {
    const types = {
        meter: renderMeterGauge,
        text: renderTextGauge,
        bar: renderBarGauge,
        attitude: renderAttitudeIndicator,
        ias: renderIAS,
        alt: renderAltimeter,
        hsi: renderHSI,
    };
    const display = label.display;
    if (display.type == null) {
        return;
    }
    if (types[display.type]) {
        renderTasks.push({
            key,
            func: (c) => types[display.type](c, display, values),
        });
    }
};

const resetRendering = async () => {
    for (let i = 0; i < renderStop.length; i++) {
        renderStop[i]();
    }
    renderStop = [];
    if (renderTasks) {
        await renderTasks.pause();
    }
    renderTasks = queue(async (e) => {
        const { key, func } = e;
        await device.drawKey(key, func);
    });
};

const loadPage = async (page) => {
    await resetRendering();
    // page is not null
    const { left, right, keys } = page;
    let pms = [];
    pms.push(drawSideKnobs("left", left));
    pms.push(drawSideKnobs("right", right));
    for (let i = 0; i < 12; i++) {
        const conf = Array.isArray(keys) && keys.length > i ? keys[i] : null;
        pms.push(drawKey(i, conf, false));
        if (isObject(conf) && conf.display != null) {
            conf.renderStart();
        }
    }
    await Promise.all(pms);
};

// Observe connect events
device.on("connect", async () => {
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
        await device.setButtonColor({ id: i, color });
        // subscribe the data feeds
        for (let j = 0; j < 12; j++) {
            const conf =
                Array.isArray(keys) && keys.length > j ? keys[j] : null;
            if (
                isObject(conf) &&
                conf.display != null &&
                Array.isArray(conf.display.source)
            ) {
                let values = [];
                //conf.fps = 0;
                for (let k = 0; k < conf.display.source.length; k++) {
                    values.push(null);
                }
                const freq = isNumber(conf.display.freq)
                    ? conf.display.freq
                    : 1;

                const msPerFrame = 1000 / freq;
                conf.renderStart = () => {
                    let enabled = true;
                    let startTime = new Date();
                    let timeout;
                    function draw() {
                        if (!enabled) {
                            return;
                        }
                        drawGauge(j, conf, values);
                        //conf.fps++;
                        let frameTime = msPerFrame;
                        const elapsedTime = new Date() - startTime;
                        if (elapsedTime > 1000) {
                            startTime = new Date();
                            conf.fps = 0;
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
                            async (v) => (values[k] = v),
                        );
                    }
                }
            }
        }
    }
    loadPage(getCurrentPage());
});

const handleKnobEvent = async (id) => {
    const { left, right } = getCurrentPage();
    let pos = { T: 0, C: 1, B: 2 }[id.substring(4, 5)];
    let side = { L: ["left", left], R: ["right", right] }[id.substring(5, 6)];
    if ((side[0] == "left" && !left) || (side[0] == "right" && !right)) {
        return;
    }
    let mask = [false, false, false];
    mask[pos] = true;
    await drawSideKnobs(side[0], side[1], mask);
    if (!highlighted.has(id)) {
        highlighted.add(id);
        setTimeout(() => {
            drawSideKnobs(side[0], side[1], [false, false, false]);
            highlighted.delete(id);
        }, 200);
    }
    return side[1][pos];
};

const takeAction = (labeled, type, haptics) => {
    if (!isObject(labeled)) {
        return;
    }
    let actionSpec = labeled[type];
    if (actionSpec == null) {
        return;
    }
    if (actionSpec.xplane_cmd != null) {
        xplane.sendCommand(actionSpec.xplane_cmd);
    }
    if (haptics) {
        device.vibrate(HAPTIC.REV_FASTEST);
    }
};

// React to button presses
device.on("down", async ({ id }) => {
    if (isNumber(id)) {
        if (id >= pages.length) {
            return;
        }
        console.info(`switch to page: ${id}`);
        currentPage = id;
        loadPage(getCurrentPage());
    } else {
        takeAction(await handleKnobEvent(id), "pressed", false);
    }
});

// React to knob turns
device.on("rotate", async ({ id, delta }) => {
    takeAction(await handleKnobEvent(id), delta > 0 ? "inc" : "dec", false);
});

const clearStaleButton = async (touches) => {
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

device.on("touchstart", async ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return;
    }
    pressed.add(target.key);
    const key = getKeyConf(target.key);
    if (key) {
        await drawKey(target.key, key, true);
        takeAction(key, "pressed", true);
    }
});

device.on("touchmove", ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
});

device.on("touchend", async ({ changedTouches, touches }) => {
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
    await device.close();
    await xplane.close();
    process.exit();
});
