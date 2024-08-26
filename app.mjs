#!/usr/bin/env node

import { registerFont } from "canvas";

//registerFont("./ocr-a-ext.ttf", { family: "OCR A Extended" });

import { discover, HAPTIC } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { XPlane } from "./xplane.mjs";

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
    let text, text2, font, font2;
    let color_bg, color_fg;
    let color_bg2, color_fg2;

    let size = labelSize;
    if (isObject(conf)) {
        if (conf.size != null) {
            size = conf.size;
        }
        text = conf.text;
        text2 = conf.text2;
        color_bg = conf.color_bg;
        color_fg = conf.color_fg;
        color_bg2 = conf.color_bg2;
        color_fg2 = conf.color_fg2;
        font2 = `${size * 0.9}px '${labelFont}'`;
    } else {
        text = conf.toString();
    }
    font = `${size}px '${labelFont}'`;
    return {
        text,
        text2,
        font,
        font2,
        color_bg,
        color_fg,
        color_bg2,
        color_fg2,
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
            drawDoubleLineText(c, conf);
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
                if (color_bg) {
                    c.fillStyle = color_bg;
                    c.fillRect(
                        x_padding + 2,
                        y_padding + y_offset + 2,
                        w - x_padding * 2 - 2,
                        h - y_padding * 2 - 2,
                    );
                }
                c.font = font;
                const {
                    width,
                    actualBoundingBoxAscent,
                    actualBoundingBoxDescent,
                } = c.measureText(text);
                const x_axis = (h - width) / 2;
                const y_axis =
                    w / 2 +
                    (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
                c.rotate((90 * Math.PI) / 180);
                c.fillStyle = hl ? "black" : "white";
                c.fillText(text, x_axis + y_offset, -(w - y_axis));
                c.resetTransform();
            }
        }
    });
};

const drawDoubleLineText = (c, conf) => {
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { text, text2, font, font2, color_fg2 } = rectifyLabel(conf);

    c.font = font;
    const m1 = c.measureText(text);
    const x1 = (w - m1.width) / 2;
    if (text2 != null) {
        const m2 = c.measureText(text2);
        const h1 = m1.actualBoundingBoxAscent - m1.actualBoundingBoxDescent;
        const h2 = m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent;
        const sep = h1;
        const y1 = h / 2 + h1 / 2 - sep;
        const x2 = (w - m2.width) / 2;
        const y2 = y1 + h1 / 2 + sep + h2 / 2;
        c.fillText(text, x1, y1);

        if (color_fg2 != null) {
            c.fillStyle = color_fg2;
        }
        c.font = font2;
        c.fillText(text2, x2, y2);
    } else {
        const y1 =
            h / 2 +
            (m1.actualBoundingBoxAscent - m1.actualBoundingBoxDescent) / 2;
        c.fillText(text, x1, y1);
    }
};

const formatDisplayText = (formatter, value) => {
    if (isNaN(value)) {
        return "X";
    }
    if (formatter) {
        return Function(
            "$value",
            `"use strict"; return(\`${formatter}\`);`,
        )(value);
    } else {
        return value.toFixed(0).toString();
    }
};

const drawAttitudeIndicator = (c, display, values) => {
    const pitch = values[0];
    const roll = values[1];
    const raw = values[2];
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
    c.stroke();

    c.beginPath();
    c.moveTo(x0 + 30, y0);
    c.lineTo(x0 + 10, y0);
    c.lineTo(x0 + 10, y0 + 8);
    c.stroke();
};

const drawTextGauge = (c, display, values) => {
    const value = values[0];
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    const text = formatDisplayText(display.formatter, value);
    const m = c.measureText(text);

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.strokeStyle = fg;
    c.lineWidth = 1;

    drawDoubleLineText(c, {
        text,
        text2:
            display.tag != null
                ? display.tag
                : formatDisplayText(
                      display.formatter2 || display.formatter,
                      values[1],
                  ),
        color_fg2: display.color_fg2,
    });
};

const drawMeterGauge = (c, display, values) => {
    const value = values[0];
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { min, max, stops } = display || {};

    if (min == null) {
        return;
    }

    let reading = (value - min) / (max - min);
    if (isNaN(reading)) {
        reading = min;
    }

    const text = formatDisplayText(display.formatter, value);

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

const drawGauge = async (key, label, values) => {
    const types = {
        meter: drawMeterGauge,
        text: drawTextGauge,
        attitude: drawAttitudeIndicator,
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
            drawGauge(i, conf, NaN);
        }
    }
    await Promise.all(pms);
};

// Observe connect events
device.on("connect", async () => {
    console.info("connected");
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
                for (let k = 0; k < conf.display.source.length; k++) {
                    const xplane_dataref =
                        conf.display.source[k].xplane_dataref;
                    if (xplane_dataref != null) {
                        await xplane.subscribeDataRef(
                            xplane_dataref,
                            10,
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
