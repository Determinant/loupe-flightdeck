#!/usr/bin/env node

import { registerFont } from "canvas";

//registerFont("./ocr-a-ext.ttf", { family: "OCR A Extended" });

import { discover, HAPTIC } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { subscribeDataRef, sendCommand } from "./xplane.mjs";

const labelFont = "OCR A Extended";
const labelSize = 22;
const pages = parse(await readFile("./profile.yaml", "utf8"));

// state of the controller
let currentPage = pages[0].hasOwnProperty("default") ? pages[0].default : 1;
let pressed = new Set();
let highlighted = new Set();

// detects and opens first connected device
const device = await discover();

const isNumber = (x) => {
    return !isNaN(x);
};

const isObject = (obj) => {
    return obj != null && obj.constructor.name === "Object";
};

const takeAction = (labeled, type, haptics) => {
    if (!isObject(labeled)) {
        return;
    }
    let actionSpec = labeled[type];
    if (actionSpec === undefined) {
        return;
    }
    if (actionSpec.hasOwnProperty("xplane_cmd")) {
        sendCommand(actionSpec.xplane_cmd);
    }
    if (haptics) {
        device.vibrate(HAPTIC.REV_FASTEST);
    }
};

const getKeyInfo = (i) => {
    if (!pages[currentPage].hasOwnProperty("keys")) {
        return null;
    }
    const keys = pages[currentPage].keys;
    if (Array.isArray(keys) && i < keys.length) {
        return keys[i];
    }
    return null;
};

const rectifyLabel = (label) => {
    let text;
    let text2 = null;
    let font2 = null;
    let size = labelSize;
    let color_bg = null;
    let color_fg = null;
    if (isObject(label)) {
        text = label.text;
        if (label.hasOwnProperty("size")) {
            size = label.size;
        }
        if (label.hasOwnProperty("text2")) {
            text2 = label.text2;
            font2 = `${size * 0.9}px '${labelFont}'`;
        }
        if (label.hasOwnProperty("color_bg")) {
            color_bg = label.color_bg;
        }
        if (label.hasOwnProperty("color_fg")) {
            color_fg = label.color_fg;
        }
    } else {
        text = label.toString();
    }
    let font = `${size}px '${labelFont}'`;
    return { text, text2, font, font2, color_bg, color_fg };
};

const drawKey = (key, label, down) => {
    if (label && label.hasOwnProperty("display")) {
        // not an input, but a display gauge
        return;
    }

    device.drawKey(key, (c) => {
        const padding = 10;
        const bg = down ? "white" : "black";
        const fg = down ? "black" : "white";
        const w = c.canvas.width;
        const h = c.canvas.height;

        // draw background
        c.fillStyle = bg;
        c.fillRect(0, 0, w, h);
        c.fillStyle = fg;
        c.lineWidth = 2;
        c.strokeStyle = fg;
        c.strokeRect(padding, padding, w - padding * 2, h - padding * 2);

        if (label) {
            const { text, text2, font, font2 } = rectifyLabel(label);
            // draw the label
            c.font = font;
            const m1 = c.measureText(text);
            const x1 = (w - m1.width) / 2;
            if (text2 != null) {
                const m2 = c.measureText(text2);
                const h1 =
                    m1.actualBoundingBoxAscent - m1.actualBoundingBoxDescent;
                const h2 =
                    m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent;
                const sep = h1;
                const y1 = h / 2 + h1 / 2 - sep;
                const x2 = (w - m2.width) / 2;
                const y2 = y1 + h1 / 2 + sep + h2 / 2;
                c.fillText(text, x1, y1);
                c.font = font2;
                c.fillText(text2, x2, y2);
            } else {
                const y1 =
                    h / 2 +
                    (m1.actualBoundingBoxAscent - m1.actualBoundingBoxDescent) /
                        2;
                c.fillText(text, x1, y1);
            }
        }
    });
};

const drawSideKnobs = (side, labels, highlight) => {
    device.drawScreen(side, (c) => {
        const light = pages[currentPage].hasOwnProperty("color")
            ? pages[currentPage].color
            : "white";
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
            if (labels && labels.length > i) {
                const { text, font, color_bg, color_fg } = rectifyLabel(
                    labels[i],
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

const drawGauge = (key, label, value) => {
    device.drawKey(key, (c) => {
        const display = label.display;
        const padding = 10;
        const bg = "black";
        const fg = "white";
        const w = c.canvas.width;
        const h = c.canvas.height;

        const min = display.min;
        const max = display.max;
        const stops = display.stops;

        if (isNaN(value)) {
            value = 0;
        }
        let reading = (value - min) / max;
        if (isNaN(reading)) {
            reading = 0;
        }

        const text = value.toString();

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
                Math.PI * (1 + (stops[i].value_begin - min) / max) + 0.05;
            const theta1 = Math.PI * (1 + (stops[i].value_end - min) / max);

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
    });
};

const loadPage = (page) => {
    const { left, right, keys } = page || {};
    if (!left) {
        return;
    }
    drawSideKnobs("left", left);
    drawSideKnobs("right", right);
    for (let i = 0; i < 12; i++) {
        const key = Array.isArray(keys) && keys.length > i ? keys[i] : null;
        drawKey(i, key, false);
        if (key && key.hasOwnProperty("display")) {
            drawGauge(i, key, NaN);
            if (key.display.hasOwnProperty("xplane_dataref")) {
                subscribeDataRef(key.display.xplane_dataref);
            }
        }
    }
};

// Observe connect events
device.on("connect", async () => {
    console.info("connected");
    for (let i = 0; i < pages.length; i++) {
        const color = pages[i].hasOwnProperty("color")
            ? pages[i].color
            : "white";
        await device.setButtonColor({ id: i, color: pages[i].color });
    }
    loadPage(pages[currentPage]);
});

const handleKnobEvent = (id) => {
    const { left, right } = pages[currentPage] || {};
    let pos = { T: 0, C: 1, B: 2 }[id.substring(4, 5)];
    let side = { L: ["left", left], R: ["right", right] }[id.substring(5, 6)];
    if ((side[0] == "left" && !left) || (side[0] == "right" && !right)) {
        return;
    }
    let mask = [false, false, false];
    mask[pos] = true;
    drawSideKnobs(side[0], side[1], mask);
    if (!highlighted.has(id)) {
        highlighted.add(id);
        setTimeout(() => {
            drawSideKnobs(side[0], side[1], [false, false, false]);
            highlighted.delete(id);
        }, 200);
    }
    return side[1][pos];
};

// React to button presses
device.on("down", ({ id }) => {
    if (isNumber(id)) {
        if (id >= pages.length) {
            return;
        }
        console.info(`switch to page: ${id}`);
        currentPage = id;
        loadPage(pages[currentPage]);
    } else {
        takeAction(handleKnobEvent(id), "pressed", false);
    }
});

// React to knob turns
device.on("rotate", ({ id, delta }) => {
    takeAction(handleKnobEvent(id), delta > 0 ? "inc" : "dec", false);
});

const clearStaleButton = (touches) => {
    const s = new Set(
        touches.map((o) => o.target.key).filter((k) => k !== undefined),
    );
    for (const k of pressed.keys()) {
        if (!s.has(k)) {
            const key = getKeyInfo(k);
            if (key) {
                drawKey(k, key, false);
            }
            pressed.delete(k);
        }
    }
};

device.on("touchstart", ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return;
    }
    pressed.add(target.key);
    const key = getKeyInfo(target.key);
    if (key) {
        drawKey(target.key, key, true);
        takeAction(key, "pressed", true);
    }
});

device.on("touchmove", ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
});

device.on("touchend", ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return;
    }
    pressed.delete(target.key);
    const key = getKeyInfo(target.key);
    if (key) {
        drawKey(target.key, key, false);
    }
});

process.on("SIGINT", () => {
    device.close().then(() => {
        process.exit();
    });
});
