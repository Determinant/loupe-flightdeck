#!/usr/bin/env node

import { registerFont } from "canvas";

registerFont("./ocr-a-ext.ttf", { family: "ocr" });

import { discover, HAPTIC } from "loupedeck";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import { sendCommand } from "./xplane.mjs";

const pages = parse(await readFile("./profile.yaml", "utf8"));

// state of the controller
let currentPage;
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

const takeAction = (labeled, type) => {
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
};

const rectifyLabel = (label) => {
    let text;
    let font = "22px ocr";
    if (isObject(label)) {
        text = label.text;
        if (label.hasOwnProperty("size")) {
            font = `${label.size}px ocr`;
        }
    } else {
        text = label.toString();
    }
    return { text, font };
};

const drawKey = (key, label, down) => {
    device.drawKey(key, (c) => {
        const { text, font } = rectifyLabel(label);
        const padding = 10;
        const bg = down ? "white" : "black";
        const fg = down ? "black" : "white";
        const w = c.canvas.width;
        const h = c.canvas.height;
        c.fillStyle = bg;
        c.fillRect(0, 0, w, h);
        c.fillStyle = fg;
        c.lineWidth = 2;
        c.strokeStyle = fg;
        c.strokeRect(padding, padding, w - padding * 2, h - padding * 2);
        c.font = font;
        const { width, actualBoundingBoxAscent, actualBoundingBoxDescent } =
            c.measureText(text);
        const x_axis = (w - width) / 2;
        const y_axis =
            h / 2 + (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
        c.fillText(text, x_axis, y_axis);
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
            const { text, font } = rectifyLabel(labels[i]);
            c.font = font;
            const { width, actualBoundingBoxAscent, actualBoundingBoxDescent } =
                c.measureText(text);
            const x_axis = (h - width) / 2;
            const y_axis =
                w / 2 +
                (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
            c.rotate((90 * Math.PI) / 180);
            c.fillStyle = hl ? 'black' : 'white';
            c.fillText(text, x_axis + y_offset, -(w - y_axis));
            c.resetTransform();
        }
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
        drawKey(i, keys[i], false);
    }
};

// Observe connect events
device.on("connect", async () => {
    console.info("connected");
    currentPage = pages[0].hasOwnProperty('default') ? pages[0].default : 1;
    for (let i = 0; i < pages.length; i++) {
        const color = pages[i].hasOwnProperty("color")
            ? pages[i].color
            : "white";
        await device.setButtonColor({ id: i, color: pages[i].color });
    }
    loadPage(pages[currentPage]);
});

const handleKnobEvent = (id) => {
    const { left, right, keys } = pages[currentPage] || {};
    if (!left) {
        return;
    }
    let pos = { T: 0, C: 1, B: 2 }[id.substring(4, 5)];
    let side = { L: ["left", left], R: ["right", right] }[id.substring(5, 6)];
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
        console.info(`switch to page: ${id}`);
        if (id == 0) {
            return;
        }
        currentPage = id;
        loadPage(pages[currentPage]);
    } else {
        takeAction(handleKnobEvent(id), "pressed");
    }
});

// React to knob turns
device.on("rotate", ({ id, delta }) => {
    takeAction(handleKnobEvent(id), delta > 0 ? "inc" : "dec");
});

const clearStaleButton = (touches) => {
    const s = new Set(
        touches.map((o) => o.target.key).filter((k) => k !== undefined),
    );
    for (const key of pressed.keys()) {
        if (!s.has(key)) {
            drawKey(key, pages[currentPage].keys[key], false);
            pressed.delete(key);
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
    const key = pages[currentPage].keys[target.key];
    drawKey(target.key, key, true);
    takeAction(key, "pressed");
    device.vibrate(HAPTIC.REV_FASTEST);
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
    drawKey(target.key, pages[currentPage].keys[target.key], false);
});

process.on("SIGINT", () => {
    device.close().then(() => {
        process.exit();
    });
});
