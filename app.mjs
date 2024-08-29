#!/usr/bin/env node

import { registerFont } from "canvas";

//registerFont("./ocr-a-ext.ttf", { family: "OCR A Extended" });

import { discover, HAPTIC } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { XPlane } from "./xplane.mjs";
import { isArray } from "util";
import { platform } from "process";

const labelFont = "OCR A Extended";
const labelSize = 22;
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
    return !isNaN(x);
};

const isObject = (obj) => {
    return obj != null && obj.constructor.name === "Object";
};

// state of the controller
let currentPage =
    isObject(pages[0]) && pages[0].default != null ? pages[0].default : 0;
let pressed = new Set();
let highlighted = new Set();

// detects and opens first connected device
let device;
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

const rectifyLabel = (conf) => {
    // conf must be non-null
    let text, font;
    let color_bg = [],
        color_fg = [];

    if (isObject(conf)) {
        text = [conf.text];
        color_bg = [conf.color_bg];
        color_fg = [conf.color_fg];
        if (conf.text2 != null) {
            text.push(conf.text2);
        }
        if (conf.text3 != null) {
            text.push(conf.text3);
        }
        if (conf.color_bg2) {
            color_bg.push(conf.color_bg2);
        }
        if (conf.color_fg2) {
            color_fg.push(conf.color_fg2);
        }
        if (conf.color_bg3) {
            color_bg.push(conf.color_bg3);
        }
        if (conf.color_fg3) {
            color_fg.push(conf.color_fg3);
        }
        let size = [conf.size != null ? conf.size : labelSize];
        size.push(conf.size2 != null ? conf.size2 : size[0] * 0.9);
        size.push(conf.size3 != null ? conf.size3 : size[1]);
        font = [];
        for (let i = 0; i < size.length; i++) {
            font.push(`${size[i]}px '${labelFont}'`);
        }
    } else {
        text = [conf.toString()];
        font = [`${labelSize}px '${labelFont}'`];
    }
    return {
        text,
        font,
        color_bg,
        color_fg,
    };
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
            drawMultiLineText(c, conf);
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
                const { text, font, color_bg, color_fg } = rectifyLabel(
                    confs[i],
                );
                if (color_bg[0]) {
                    c.fillStyle = color_bg[0];
                    c.fillRect(
                        x_padding + 2,
                        y_padding + y_offset + 2,
                        w - x_padding * 2 - 2,
                        h - y_padding * 2 - 2,
                    );
                }
                c.font = font[0];
                const {
                    width,
                    actualBoundingBoxAscent,
                    actualBoundingBoxDescent,
                } = c.measureText(text[0]);
                const x_axis = (h - width) / 2;
                const y_axis =
                    w / 2 +
                    (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
                c.rotate((90 * Math.PI) / 180);
                c.fillStyle = hl ? "black" : "white";
                c.fillText(text[0], x_axis + y_offset, -(w - y_axis));
                c.resetTransform();
            }
        }
    });
};

const drawMultiLineText = (c, conf) => {
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { text, font, color_fg } = rectifyLabel(conf);

    c.save();
    c.font = font[0];
    let ms = [];
    let text_h = 0;
    const mx = c.measureText("x");
    const sep = conf.sep
        ? conf.sep
        : mx.actualBoundingBoxAscent - mx.actualBoundingBoxDescent;
    for (let i = 0; i < text.length; i++) {
        c.font = font[i];
        const m = c.measureText(text[i]);
        ms.push(m);
        text_h += m.actualBoundingBoxAscent - m.actualBoundingBoxDescent;
    }
    text_h += (text.length - 1) * sep;
    let y0 = (h - text_h) / 2;
    for (let i = 0; i < text.length; i++) {
        const x =
            Math.max(
                0,
                w -
                    (ms[i].actualBoundingBoxRight -
                        ms[i].actualBoundingBoxLeft),
            ) / 2;
        const hh =
            ms[i].actualBoundingBoxAscent - ms[i].actualBoundingBoxDescent;
        const y = y0 + hh;
        c.font = font[i];
        if (color_fg[i]) {
            c.fillStyle = color_fg[i];
        }
        c.fillText(text[i], x, y);
        y0 += hh + sep;
    }
    c.restore();
};

const formatDisplayText = (formatter, values) => {
    if (formatter) {
        return Function(
            "$d",
            `"use strict"; return(\`${formatter}\`);`,
        )(values);
    }
    if (isNaN(values[0])) {
        return "X";
    }
    return values[0].toFixed(0).toString();
};

const formatDisplayColor = (color, values) => {
    if (color) {
        return Function("$d", `"use strict"; return(\`${color}\`);`)(values);
    }
    return "#fff";
};

const renderAttitudeIndicator = (c, display, values) => {
    const pitch = values[0];
    const roll = values[1];
    const src = display.src[values[2]];
    const cdi = src ? values[src.def] : null;
    const received = src ? values[src.received] : null;
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.strokeStyle = fg;

    const x0 = w / 2;
    const y0 = h / 2;
    const longMark = [-10, 10];
    const shortMark = [-5, 5];
    const longSep = 18;
    const shortSep = longSep / 2;

    c.translate(x0, y0);
    c.rotate((-roll * Math.PI) / 180);
    c.translate(0, (pitch / 10) * longSep);

    c.fillStyle = "#0077b6";
    c.fillRect(-w, -2 * h, 2 * w, 4 * h);
    c.fillStyle = "#99582a";
    c.fillRect(-w, 0, 2 * w, 4 * h);

    c.lineWidth = 1;
    c.strokeStyle = fg;
    c.beginPath();
    c.moveTo(-0.75 * w, 0);
    c.lineTo(0.75 * w, 0);
    c.fillStyle = fg;
    c.font = `10px ${labelFont}`;
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
    c.resetTransform();

    c.lineWidth = 2;
    c.strokeStyle = "yellow";
    c.beginPath();
    c.moveTo(x0 - 30, y0);
    c.lineTo(x0 - 10, y0);
    c.lineTo(x0 - 10, y0 + 8);

    c.moveTo(x0 + 30, y0);
    c.lineTo(x0 + 10, y0);
    c.lineTo(x0 + 10, y0 + 8);
    c.stroke();

    // draw vertical deflection
    const pi2 = 2 * Math.PI;
    const vdef_x = w - 10;
    const vdef_r = 3;

    c.strokeStyle = "white";
    c.lineWidth = 1;
    c.beginPath();
    for (let i = -2; i <= 2; i++) {
        if (i != 0) {
            const vdef_y = y0 + 13 * i;
            c.moveTo(vdef_x + vdef_r, vdef_y);
            c.arc(vdef_x, vdef_y, vdef_r, 0, pi2);
        }
    }
    c.stroke();

    if (received == 0) {
        // draw CDI diamond
        const cdi_y = y0 + 13 * cdi;
        const cdi_h = 7;
        const cdi_w = 4;
        c.fillStyle = "#2dfe54";
        c.strokeStyle = "black";
        c.beginPath();
        c.moveTo(vdef_x, cdi_y + cdi_h);
        c.lineTo(vdef_x - cdi_w, cdi_y);
        c.lineTo(vdef_x, cdi_y - cdi_h);
        c.lineTo(vdef_x + cdi_w, cdi_y);
        c.stroke();
        c.fill();
    }
};

const renderTextGauge = (c, display, values) => {
    const value = values[0];
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.strokeStyle = fg;
    c.lineWidth = 1;

    drawMultiLineText(c, {
        text: formatDisplayText(display.formatter, values),
        text2: display.formatter2
            ? formatDisplayText(display.formatter2, values)
            : undefined,
        text3: display.formatter3
            ? formatDisplayText(display.formatter3, values)
            : undefined,
        size: display.size,
        size2: display.size2,
        size3: display.size3,
        color_fg: formatDisplayColor(display.color_fg, values),
        color_fg2: formatDisplayColor(display.color_fg2, values),
        color_fg3: formatDisplayColor(display.color_fg3, values),
    });
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

    let reading = (values[0] - min) / (max - min);
    if (isNaN(reading)) {
        reading = min;
    }

    const text = formatDisplayText(display.formatter, values);

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
    c.strokeStyle = fg;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x0, y0);
    const theta = Math.PI * (1 + reading);
    c.lineTo(x0 + Math.cos(theta) * inner, y0 + Math.sin(theta) * inner);
    c.stroke();

    const size = display.font ? display.font : labelSize;
    c.font = `${size * 0.9}px '${labelFont}'`;
    c.fillStyle = fg;
    const m = c.measureText(text);
    c.fillText(text, (w - m.width) / 2, h / 2 + 25);
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
    bigger_window_width = 2,
    lowDigitStep = 1,
    size = labelSize,
) => {
    const bg = "black";
    const fg = "white";

    c.save();
    c.font = `${size}px '${labelFont}'`;
    const m = c.measureText("x");
    const y0 =
        h / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    let digit_height =
        (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * 2;
    let digit_width =
        (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) * 1.2;
    const sign = right ? -1 : 1;
    let x = (right ? w : 0) + sign * padding;

    c.strokeStyle = bg;
    const narrow_window_y = y0 - digit_height * 0.95;
    const narrow_window_h = digit_height * 1.25;
    const bigger_window_x =
        x + sign * (bigger_window_width + (right ? -1 : 0)) * digit_width;
    const bigger_window_y = y0 - digit_height * 1.5;
    const bigger_window_w = bigger_window_width * digit_width;
    const bigger_window_h = digit_height * 2.25;
    c.fillStyle = bg;
    c.fillRect(0, narrow_window_y, w, narrow_window_h);
    c.fillRect(
        bigger_window_x,
        bigger_window_y,
        bigger_window_w,
        bigger_window_h,
    );

    c.rect(0, narrow_window_y, w, narrow_window_h);
    c.rect(bigger_window_x, bigger_window_y, bigger_window_w, bigger_window_h);
    c.stroke();
    c.clip();
    c.strokeStyle = fg;
    c.fillStyle = fg;

    if (isNaN(value)) {
        c.beginPath();
        const y0 = narrow_window_y;
        const y1 = narrow_window_y + narrow_window_h;
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
        const y = y0 + scroll[p] * digit_height;
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
            c.fillText(p2, x, y - digit_height * 2);
        } else {
            d = digits[p];
            m1 = d == 0 ? 9 : d - 1;
            m2 = m1 == 0 ? 9 : m1 - 1;
            p1 = d == 9 ? 0 : d + 1;
        }
        c.fillText(d, x, y);
        c.fillText(m1, x, y + digit_height);
        c.fillText(m2, x, y + digit_height * 2);
        c.fillText(p1, x, y - digit_height);
        x += sign * digit_width;
    }
    c.restore();
};

const renderIAS = (c, display, values) => {
    const value = values[0];
    const bg = "#555";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.strokeStyle = fg;
    c.lineWidth = 1;

    renderMechanicalDisplay(c, w, h, values[0], 20, true, 1);
};

const renderAltimeter = (c, display, values) => {
    const value = values[0];
    const bg = "#555";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    renderMechanicalDisplay(c, w, h, values[0], 5, false, 2, 20, 18);
    const vsi = values[1];
    const vsi_bg_x = w / 2 + 4;
    c.fillRect(vsi_bg_x, 0, w - vsi_bg_x, h);
    c.fillStyle = "#000";
    const vsi_h = 20;
    const vsi_x = vsi_bg_x + 2;
    const vsi_y =
        (1 -
            (Math.min(Math.max(isNumber(vsi) ? vsi : 0, -2000), 2000) + 2000) /
                4000) *
        (h - vsi_h);
    c.fillRect(vsi_x, vsi_y, w - vsi_x, vsi_h);
    c.fillStyle = fg;
    if (isNumber(vsi)) {
        c.font = `12px '${labelFont}'`;
        c.fillText(Math.trunc(vsi / 10) * 10, vsi_x + 2, vsi_y + vsi_h * 0.8);
    }
    const selected = values[2];
    if (isNumber(selected)) {
        c.fillStyle = "#6697ff";
        c.font = `14px '${labelFont}'`;
        c.fillText(selected, 15, 18);
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
    c.fillStyle = fg;
    c.strokeStyle = fg;
    c.lineWidth = 1;

    const x0 = w / 2;
    const y0 = h / 2;
    const r = w / 2 - 5;
    const f1 = 0.8;
    const f2 = 0.9;
    const cdi_r = 0.4 * r;
    const vdef_r = 3;
    const deg2Rad = (x) => (x / 180) * Math.PI;
    const hdg = deg2Rad(values[0]);
    const hdg_bug = deg2Rad(values[1]);
    const src = display.navs[values[2]];
    const crs = src ? deg2Rad(values[src.crs]) : null;
    let def = src ? Math.min(Math.max(values[src.def], -3), 3) : null;
    const received = src ? values[src.received] : null;
    if (isNaN(def)) {
        def = 0;
    }
    const polarXY = (theta, r) => {
        const t = -theta - Math.PI / 2;
        const dx = r * Math.cos(t);
        const dy = -r * Math.sin(t);
        return { dx, dy };
    };
    const pi2 = Math.PI * 2;

    c.translate(x0, y0);
    c.rotate(-hdg);
    c.beginPath();
    for (let i = 0; i < 36; i++) {
        const { dx, dy } = polarXY(deg2Rad(i * 10), r);
        const f = (i & 1) == 0 ? f1 : f2;
        c.moveTo(dx, dy);
        c.lineTo(dx * f, dy * f);
    }

    c.font = `14px '${labelFont}'`;
    c.fillText("N", -5, -0.5 * r);

    if (isNumber(hdg_bug)) {
        const bug_w = 4;
        const bug_y1 = -(r - 3);
        const bug_y0 = -(r - 8);
        c.stroke();
        c.rotate(hdg_bug);
        c.fillStyle = "cyan";
        c.beginPath();
        c.moveTo(0, bug_y1);
        c.lineTo(-bug_w, -(r + 1));
        c.lineTo(-bug_w, bug_y0);
        c.lineTo(bug_w, bug_y0);
        c.lineTo(bug_w, -(r + 1));
        c.lineTo(0, bug_y1);
        c.fill();
        c.rotate(-hdg_bug);
    }

    if (crs != null) {
        c.rotate(crs);

        for (let i = -2; i <= 2; i++) {
            if (i != 0) {
                const x = 13 * i;
                c.moveTo(x + vdef_r, 0);
                c.arc(x, 0, vdef_r, 0, pi2);
            }
        }
        c.stroke();

        c.beginPath();
        c.lineWidth = 3;
        c.strokeStyle = src.color ? src.color : "magenta";

        if (received != 0) {
            const cdi_x = 13 * def;
            c.moveTo(cdi_x, -(cdi_r - 1));
            c.lineTo(cdi_x, cdi_r - 1);
        }

        c.moveTo(0, -r);
        c.lineTo(0, -(cdi_r + 1));
        c.moveTo(0, -r);

        // crs arrowhead
        c.lineTo(-5, -0.8 * r);
        c.lineTo(5, -0.8 * r);
        c.lineTo(0, -r);

        c.moveTo(0, r);
        c.lineTo(0, cdi_r + 1);
    }
    c.stroke();
};

const drawGauge = async (key, label, values) => {
    const types = {
        meter: renderMeterGauge,
        text: renderTextGauge,
        attitude: renderAttitudeIndicator,
        ias: renderIAS,
        alt: renderAltimeter,
        hsi: renderHSI,
    };
    await device.drawKey(key, (c) => {
        const display = label.display;
        if (display.type == null) {
            return;
        }
        if (types[display.type]) {
            types[display.type](c, display, values);
        }
    });
};

const loadPage = async (page) => {
    // page is not null
    const { left, right, keys } = page;
    let pms = [];
    pms.push(drawSideKnobs("left", left));
    pms.push(drawSideKnobs("right", right));
    for (let i = 0; i < 12; i++) {
        const conf = Array.isArray(keys) && keys.length > i ? keys[i] : null;
        pms.push(drawKey(i, conf, false));
        if (isObject(conf) && conf.display != null) {
            drawGauge(i, conf, []);
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
                for (let k = 0; k < conf.display.source.length; k++) {
                    values.push(NaN);
                }
                const freq = isNumber(conf.display.freq)
                    ? conf.display.freq
                    : 1;
                for (let k = 0; k < conf.display.source.length; k++) {
                    const source = conf.display.source[k];
                    const xplane_dataref = source.xplane_dataref;
                    if (xplane_dataref != null) {
                        await xplane.subscribeDataRef(
                            xplane_dataref,
                            freq,
                            async (v) => {
                                values[k] = v;
                                if (currentPage == i) {
                                    await drawGauge(j, conf, values);
                                }
                            },
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
    await device.close();
    await xplane.close();
    process.exit();
});
